// Project chat: talk to an AI agent about the project. Each reply is one read-only agent session in a fresh snapshot of the
// repository (like the planner), so the assistant can read the code but never changes files. It sees the plan stages, the
// tasks with their state and recent failures. When asked for a plan it answers with the planner's JSON format; HidForge
// validates it like a planner result and stores it as a plan proposal, which the user reviews and applies on the planner page.
import path from 'node:path';
import type { Orchestrator } from './orchestrator.ts';
import { BadRequest, Conflict, type ChatMessage, type PlanRun, type Project, type Run, type Task } from './store.ts';
import { cleanModel } from './contract.ts';
import type { AgentAdapter } from './adapters/types.ts';
import { maskSecrets } from './proc.ts';
import { runOnce, resolveReadOnlyAgent, type OneShot } from './oneshot.ts';
import { git } from './workspace.ts';
import { planFormat, parsePlan } from './planner.ts';
import { projectPlan, type PlanView } from './progress.ts';

const NL = '\n';
const MAX_TEXT = 20_000;
const HISTORY_CHARS = 30_000;
const PLAN_MAX_TASKS = 20;
export const CHAT_HEADER = '# Chat with the HidForge assistant';

export interface ChatPending { provider: string; model: string | null; effort: string | null; mock: boolean; startedAt: string }
/** What the assistant is told about the project besides the conversation. */
export interface ChatContext { tasks: Task[]; view: PlanView | null; lastRuns: Map<number, Run>; files: string[] }
/** A chat message as the UI gets it: with a short summary of the plan it proposed. */
export type ChatMessageView = ChatMessage & { plan: { id: number; status: PlanRun['status']; tasks: number; summary: string } | null };

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

function taskLine(t: Task, run: Run | undefined): string {
  const bits = [`#${t.id} [${t.status}] ${t.title}`];
  const meta = [t.category, t.complexity, t.assignedRole, t.provider === 'auto' ? null : t.provider, t.model].filter(Boolean);
  if (meta.length) bits.push(`(${meta.join(', ')})`);
  if (t.dependsOn.length) bits.push(`depends on ${t.dependsOn.map((d) => `#${d}`).join(', ')}`);
  if (t.attempts) bits.push(`attempts ${t.attempts}/${t.maxAttempts}`);
  const lines = [`- ${bits.join(' · ')}`];
  if (t.description.trim()) lines.push(`  what: ${clip(oneLine(t.description), 240)}`);
  if (t.question) lines.push(`  agent asks: ${clip(oneLine(t.question), 240)}`);
  if (t.feedback) lines.push(`  user feedback: ${clip(oneLine(t.feedback), 200)}`);
  if (run && run.status !== 'succeeded' && run.status !== 'running') lines.push(`  last run ${run.status}${run.error ? `: ${clip(oneLine(maskSecrets(run.error)), 240)}` : ''}`);
  return lines.join(NL);
}

export function buildChatPrompt(p: Project, ctx: ChatContext, history: ChatMessage[]): string {
  // Newest messages first until the budget is used, then back in order. Failed replies are not fed back.
  const picked: ChatMessage[] = [];
  let used = 0;
  for (const m of [...history].reverse()) {
    if (m.error) continue;
    used += m.text.length;
    if (used > HISTORY_CHARS && picked.length) break;
    picked.unshift(m);
  }
  const { tasks, view, lastRuns, files } = ctx;
  const live = tasks.filter((t) => t.status !== 'canceled');
  const stages = view?.stages.length
    ? [`Overall about ${view.pct}% done (${view.done}/${view.total} tasks merged)${view.currentStage ? `, current stage ${view.currentStage}` : ''}.`,
      ...view.stages.map((s) => `- Stage ${s.n}${s.current ? ' (current)' : ''}: ${s.pct}%, ${s.done}/${s.total} merged — ${s.tasks.map((t) => `#${t.id}`).join(', ')}`)].join(NL)
    : 'No tasks yet, so there are no stages.';
  return [
    CHAT_HEADER,
    `You are the assistant inside HidForge Orchestrator, talking with the owner of the project "${p.name}".`,
    'HidForge runs AI coding agents on tasks: each task works in its own git worktree, passes checks, and the user approves the merge. Tasks form stages by their dependencies.',
    `The current directory is a read-only snapshot of the repository (branch ${p.baseBranch}). Read files when the question needs it.`,
    'You cannot change files, run commands or start tasks here. Help the user understand the project, review stages and tasks, find problems and decide what to do next.',
    'Answer in the language of the user\'s last message. Be concise and concrete; refer to tasks as #id.',
    '',
    `## Project goal${NL}${p.goal.trim() || '(not set)'}`,
    '',
    `## Stages${NL}${stages}`,
    '',
    `## Tasks${NL}${live.length ? live.slice(0, 80).map((t) => taskLine(t, lastRuns.get(t.id))).join(NL) : '(none)'}`,
    '',
    files.length ? `## Repository files (first ${files.length})${NL}${files.join(NL)}` : '## Repository files\n(empty repository)',
    '',
    '## When the user asks for a plan',
    'Only if the user asks to make, extend or change a plan, or to split work into tasks: explain the plan briefly in the user\'s language, then add exactly one ```json block in the format below.',
    'New tasks must not duplicate existing ones; they may depend on existing tasks by numeric id. HidForge validates the plan and shows it as a proposal; nothing is created until the user applies it.',
    'Write titles, descriptions and acceptance criteria in the language of the user\'s message. Otherwise never output a JSON plan.',
    planFormat(PLAN_MAX_TASKS, 'One JSON object inside a ```json fenced block, exactly this shape:'),
    '## Conversation',
    ...picked.map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.text}`),
    '',
    'Reply to the last user message.',
  ].join(NL);
}

/** If the reply contains a ```json plan, validate it like a planner result. Returns the text to show without the JSON. */
export function splitPlan(text: string, existingIds: Set<number>) {
  if (!/```json/i.test(text)) return { text, plan: null, error: null };
  const parsed = parsePlan([text], existingIds, PLAN_MAX_TASKS);
  if (!parsed.ok) return { text, plan: null, error: parsed.error };
  const shown = text.replace(/```json\s*\n[\s\S]*?```/gi, '').trim();
  return { text: shown || parsed.plan.summary || 'План запропоновано.', plan: parsed.plan, error: null };
}

export class Chat {
  private readonly orch: Orchestrator;
  private readonly live = new Map<number, { run: OneShot | null; pending: ChatPending; canceled: boolean }>();
  constructor(orch: Orchestrator) { this.orch = orch; }

  state(projectId: number): { messages: ChatMessageView[]; pending: ChatPending | null } {
    const { store } = this.orch;
    const messages = store.listChat(projectId).map((m): ChatMessageView => {
      if (m.planId == null) return { ...m, plan: null };
      const pl = store.getPlan(m.planId);
      return { ...m, plan: { id: pl.id, status: pl.status, tasks: pl.plan?.tasks.length ?? 0, summary: pl.plan?.summary ?? '' } };
    });
    return { messages, pending: this.live.get(projectId)?.pending ?? null };
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
    void this.orch.track(this.reply(p, adapter, pending, slot, text));
    return user;
  }

  private async reply(p: Project, adapter: AgentAdapter, pending: ChatPending, slot: { run: OneShot | null; canceled: boolean }, question: string): Promise<void> {
    const { store, ws } = this.orch;
    const dir = path.join(this.orch.opts.dataDir, 'chat', `p${p.id}-${Date.now()}`);
    let text = '';
    let error: string | null = null;
    let usage: unknown = null;
    let planId: number | null = null;
    try {
      await ws.addDetached(p.repoPath, p.baseBranch, dir);
      const files = (await git(dir, ['ls-files'])).stdout.split(NL).filter(Boolean).slice(0, 300);
      const tasks = store.listTasks(p.id);
      const lastRuns = new Map(tasks.flatMap((t) => { const r = store.runsForTask(t.id).at(-1); return r ? [[t.id, r] as const] : []; }));
      const view = tasks.length ? await projectPlan(this.orch, p.id).catch(() => null) : null;
      const prompt = buildChatPrompt(p, { tasks, view, lastRuns, files }, store.listChat(p.id, 60));
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
      if (!error) {
        const sp = splitPlan(text, new Set(tasks.map((t) => t.id)));
        if (sp.plan) {
          const plan = store.createPlan({ projectId: p.id, provider: pending.provider, model: pending.model, goal: p.goal.trim() || question });
          store.updatePlan(plan.id, { status: 'succeeded', plan: sp.plan, output: text.slice(-50_000), usage });
          planId = plan.id;
          text = sp.text;
          store.event({ projectId: p.id, type: 'plan.proposed', data: { planId, source: 'chat', tasks: sp.plan.tasks.length } });
        } else if (sp.error) text += `\n\n(HidForge: план у відповіді не пройшов перевірку — ${sp.error}. Попросіть асистента виправити.)`;
      }
    } catch (e) {
      error = slot.canceled ? 'canceled' : (e as Error).message;
    } finally {
      this.live.delete(p.id);
      await ws.remove(p.repoPath, dir, null).catch(() => {});
    }
    if (error === 'canceled') error = 'зупинено користувачем';
    try {
      const m = store.addChatMessage({ projectId: p.id, role: 'assistant', text: text.slice(0, 100_000), provider: pending.provider, model: pending.model, effort: pending.effort, usage, error, planId });
      store.event({ projectId: p.id, type: 'chat.message', data: { messageId: m.id, role: 'assistant', error, planId } });
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
