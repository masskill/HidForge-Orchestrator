// Project chat: talk to an AI agent directly. Each reply is one read-only agent session in a fresh snapshot of the
// repository (like the planner), so the assistant can read the code but never changes files. One reply at a time per project.
import path from 'node:path';
import type { Orchestrator } from './orchestrator.ts';
import { BadRequest, Conflict, type ChatMessage, type Project, type Task } from './store.ts';
import { cleanModel } from './contract.ts';
import type { AgentAdapter } from './adapters/types.ts';
import { maskSecrets } from './proc.ts';
import { runOnce, resolveReadOnlyAgent, type OneShot } from './oneshot.ts';
import { git } from './workspace.ts';

const NL = '\n';
const MAX_TEXT = 20_000;
const HISTORY_CHARS = 30_000;

export interface ChatPending { provider: string; model: string | null; effort: string | null; mock: boolean; startedAt: string }

export function buildChatPrompt(p: Project, tasks: Task[], history: ChatMessage[], files: string[]): string {
  // Newest messages first until the budget is used, then back in order.
  const picked: ChatMessage[] = [];
  let used = 0;
  for (const m of [...history].reverse()) {
    if (m.error) continue;
    used += m.text.length;
    if (used > HISTORY_CHARS && picked.length) break;
    picked.unshift(m);
  }
  return [
    '# Chat with the HidForge assistant',
    `You are the assistant inside HidForge Orchestrator, talking with the owner of the project "${p.name}".`,
    `The current directory is a read-only snapshot of the repository (branch ${p.baseBranch}). Read files when the question needs it.`,
    'You cannot change files or run commands here. If a change is needed, propose a task for HidForge: a short title, what to do and how to check it.',
    'Answer in the language of the user\'s last message. Be concise and concrete.',
    '',
    `Project goal: ${p.goal.trim() || '(not set)'}`,
    tasks.length ? `Tasks:${NL}${tasks.slice(0, 60).map((t) => `- #${t.id} [${t.status}] ${t.title}`).join(NL)}` : 'Tasks: none yet.',
    files.length ? `Files (first ${files.length}):${NL}${files.join(NL)}` : '',
    '',
    '## Conversation',
    ...picked.map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.text}`),
    '',
    'Reply to the last user message.',
  ].join(NL);
}

export class Chat {
  private readonly orch: Orchestrator;
  private readonly live = new Map<number, { run: OneShot | null; pending: ChatPending; canceled: boolean }>();
  constructor(orch: Orchestrator) { this.orch = orch; }

  state(projectId: number): { messages: ChatMessage[]; pending: ChatPending | null } {
    return { messages: this.orch.store.listChat(projectId), pending: this.live.get(projectId)?.pending ?? null };
  }
  busy(projectId: number): boolean { return this.live.has(projectId); }

  /** Store the user message and start the assistant's reply. Returns immediately; the reply arrives as a chat.message event. */
  async send(projectId: number, o: { text?: unknown; provider?: unknown; model?: unknown }): Promise<ChatMessage> {
    const { store } = this.orch;
    const p = store.getProject(projectId);
    const text = typeof o.text === 'string' ? o.text.trim() : '';
    if (!text) throw new BadRequest('message is empty');
    if (text.length > MAX_TEXT) throw new BadRequest(`message is longer than ${MAX_TEXT} characters`);
    if (this.live.has(projectId)) throw new Conflict('the assistant is still answering; wait or stop it');
    const want = typeof o.provider === 'string' && o.provider ? o.provider : 'auto';
    // 'auto': the planning/low chain of the routing matrix (read-only, a mid-size model at modest effort).
    const links = want === 'auto' ? await this.orch.chainFor('planning', 'low', { write: false }) : [];
    const { adapter, provider, model: linkModel, effort } = await resolveReadOnlyAgent(this.orch, want, 'chat assistant', { links });
    const model = cleanModel(o.model) ?? linkModel ?? null;
    const pending: ChatPending = { provider, model, effort: effort ?? null, mock: adapter.mock, startedAt: new Date().toISOString() };
    const slot = { run: null as OneShot | null, pending, canceled: false };
    this.live.set(projectId, slot);
    const user = store.addChatMessage({ projectId, role: 'user', text, provider: null, model: null, effort: null, usage: null, error: null });
    store.event({ projectId, type: 'chat.message', data: { messageId: user.id, role: 'user', pending } });
    void this.orch.track(this.reply(p, adapter, pending, slot));
    return user;
  }

  private async reply(p: Project, adapter: AgentAdapter, pending: ChatPending, slot: { run: OneShot | null; canceled: boolean }): Promise<void> {
    const { store, ws } = this.orch;
    const dir = path.join(this.orch.opts.dataDir, 'chat', `p${p.id}-${Date.now()}`);
    let text = '';
    let error: string | null = null;
    let usage: unknown = null;
    try {
      await ws.addDetached(p.repoPath, p.baseBranch, dir);
      const files = (await git(dir, ['ls-files'])).stdout.split(NL).filter(Boolean).slice(0, 300);
      const prompt = buildChatPrompt(p, store.listTasks(p.id), store.listChat(p.id, 60), files);
      const inv = adapter.buildInvocation({ prompt, workspace: dir, model: pending.model, effort: pending.effort, policy: 'read-only', trustWorkspace: this.orch.trusts(pending.provider) });
      if (slot.canceled) throw new Error('canceled');
      const run = runOnce(adapter, inv, dir, {
        timeoutMs: 600_000, stallMs: this.orch.opts.stallTimeoutSec * 1000,
        onEvent: (ev) => { if (ev.kind === 'tool') store.event({ projectId: p.id, type: 'chat.output', data: { text: maskSecrets(ev.text).slice(0, 300) } }); },
      });
      slot.run = run;
      const r = await run.done;
      usage = r.result?.usage ?? null;
      // Codex's final event carries no text ("turn completed"); its answer is in the agent messages.
      const final = r.result?.text?.trim() && r.result.text !== 'turn completed' ? r.result.text : r.messages.join(NL);
      text = maskSecrets(final.trim());
      error = r.killReason ?? (r.code !== 0 ? `agent exited with code ${r.code}` : !r.result ? 'agent exited without a result' : r.result.isError ? `agent reported an error: ${r.result.text.slice(0, 500)}` : null);
      if (!error && !text) error = 'the agent returned an empty answer';
    } catch (e) {
      error = slot.canceled ? 'canceled' : (e as Error).message;
    } finally {
      this.live.delete(p.id);
      await ws.remove(p.repoPath, dir, null).catch(() => {});
    }
    if (error === 'canceled') error = 'зупинено користувачем';
    try {
      const m = store.addChatMessage({ projectId: p.id, role: 'assistant', text: text.slice(0, 100_000), provider: pending.provider, model: pending.model, effort: pending.effort, usage, error });
      store.event({ projectId: p.id, type: 'chat.message', data: { messageId: m.id, role: 'assistant', error } });
    } catch { /* project deleted meanwhile */ }
  }

  async cancel(projectId: number): Promise<{ ok: true }> {
    const slot = this.live.get(projectId);
    if (!slot) throw new Conflict('the assistant is not answering');
    slot.canceled = true;
    await slot.run?.kill('canceled');
    return { ok: true };
  }

  clear(projectId: number): { ok: true } {
    this.orch.store.getProject(projectId);
    if (this.live.has(projectId)) throw new Conflict('the assistant is still answering; stop it first');
    this.orch.store.clearChat(projectId);
    this.orch.store.event({ projectId, type: 'chat.cleared', data: {} });
    return { ok: true };
  }

  async stop(): Promise<void> {
    await Promise.all([...this.live.values()].map(async (s) => { s.canceled = true; await s.run?.kill('canceled'); }));
  }
}
