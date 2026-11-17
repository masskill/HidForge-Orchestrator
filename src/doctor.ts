// Auto-fix ("doctor"): when a task ends up blocked or failed, a read-only agent reads what happened and either corrects the
// task and retries it, or turns the problem into a plain question for the owner. The explanation is written in Ukrainian for an
// owner who is not a programmer. At most MAX_FIXES diagnoses per task, one diagnosis at a time, so it never loops or floods.
import path from 'node:path';
import type { Orchestrator } from './orchestrator.ts';
import { COMPLEXITIES } from './routing.ts';
import { Conflict, type Task } from './store.ts';
import { maskSecrets } from './proc.ts';
import { extractJson, runOnce, resolveReadOnlyAgent } from './oneshot.ts';

const NL = '\n';
export const MAX_FIXES = 2;
/** Statuses set by a human decision: the doctor never overrides them. */
const HUMAN_NOTES = ['rejected', 'command denied', 'canceled by user'];

export interface Diagnosis {
  status: 'running' | 'succeeded' | 'failed'; at: string; provider: string; model: string | null;
  action?: 'retry' | 'ask_owner' | 'give_up'; explanation?: string; question?: string; changed?: string[]; decisions?: string; error?: string;
}
export interface DoctorAdvice {
  action: 'retry' | 'ask_owner' | 'give_up'; explanation: string; question: string; feedback: string;
  changes: { description?: string; acceptanceCriteria?: string; allowedPaths?: string[]; complexity?: string };
  /** Auto-answer: the decisions taken on the owner's behalf, appended to the task description. */
  decisions: string;
}

export function parseAdvice(raw: unknown): DoctorAdvice {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const action = String(o.action);
  if (!['retry', 'ask_owner', 'give_up'].includes(action)) throw new Error(`unknown action ${o.action}`);
  const s = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  const c = (o.changes && typeof o.changes === 'object' ? o.changes : {}) as Record<string, unknown>;
  const changes: DoctorAdvice['changes'] = {};
  if (s(c.description, 20_000)) changes.description = s(c.description, 20_000);
  if (s(c.acceptanceCriteria, 5000)) changes.acceptanceCriteria = s(c.acceptanceCriteria, 5000);
  if (Array.isArray(c.allowedPaths) && c.allowedPaths.length) {
    const paths = c.allowedPaths.map(String).map((p) => p.trim()).filter(Boolean);
    // repository-relative globs only
    if (paths.every((p) => !/^([a-z]:|[\\/])/i.test(p) && !p.split(/[\\/]/).includes('..'))) changes.allowedPaths = paths.slice(0, 50);
  }
  if ((COMPLEXITIES as readonly string[]).includes(String(c.complexity))) changes.complexity = String(c.complexity);
  const explanation = s(o.explanation, 2000);
  if (!explanation) throw new Error('explanation is missing');
  const question = s(o.question, 4000);
  if (action === 'ask_owner' && !question) throw new Error('ask_owner without a question');
  return { action: action as DoctorAdvice['action'], explanation, question, feedback: s(o.feedback, 5000), changes, decisions: s(o.decisions, 10_000) };
}

export function buildDoctorPrompt(t: Task, reason: string, endings: string, autoAnswer = false): string {
  const list = (xs: string[], empty: string) => (xs.length ? xs.map((x) => `- ${x}`).join(NL) : empty);
  const ev = t.evidence.slice(-15).map((e) => `- [${e.kind} ${e.ok ? 'ok' : 'FAIL'}] ${e.summary}${e.detail && !e.ok ? NL + '  ' + e.detail.slice(-800).replace(/\n/g, NL + '  ') : ''}`);
  return `# Task diagnosis request — HidForge task #${t.id}
A task in an automated coding pipeline ended up "${t.status}". Find out why and decide how to get it done.
You are READ-ONLY: do not modify any file. Read the repository as needed (project rules such as CLAUDE.md / AGENTS.md included).

## Task
Title: ${t.title}
Type / complexity: ${t.category ?? '—'} / ${t.complexity ?? '—'}
Attempts used: ${t.attempts} of ${t.maxAttempts}
Allowed paths:
${list(t.allowedPaths, '- (any file)')}
Verification commands:
${list(t.verifyCommands, '- (none)')}
Acceptance criteria: ${t.acceptanceCriteria || '(none)'}

### Description
${t.description}

## Why HidForge stopped it
${reason || '(no reason recorded)'}

## Evidence (oldest first)
${ev.join(NL) || '(none)'}

## What the agents said at the end of their last attempts
${endings || '(no output recorded)'}

## How HidForge works
- Each attempt runs one coding agent unattended in an isolated git worktree; nobody can answer it during the run.
- After a run: files must change (unless the task is read-only), only inside the allowed paths, verification commands must pass,
  then an AI reviewer checks the diff.
- "worker produced no changes" usually means the agent stopped to ask for approval or data, could not write files, or
  found the allowed paths too narrow for the work.

## Decide
- "retry": an agent can do it once the task is corrected. Give only the fields you change, and precise feedback for the next
  attempt. Stay within the task's intent; allowedPaths are repository-relative globs.
${autoAnswer ? `- THE OWNER HAS DELEGATED DECISIONS TO YOU. When the blocker is a question, a choice or an approval of a plan (including
  approvals the project rules ask for), decide yourself as a careful senior engineer would: read the repository, docs and
  open owner questions, pick the safest sensible option (the recommended / default one when offered), and answer with
  "retry". Write every decision, with a one-line reason, in "decisions" — it is added to the task description and the
  owner can change it later. Widen allowedPaths when the work needs it.
- "ask_owner" ONLY for what nobody but the owner can supply or should do: passwords, keys, tokens or other secrets;
  payments or purchases; signing in to or creating accounts; a manual step on their computer or a service; deleting,
  publishing or sending real data in a way that cannot be undone. Ask short, concrete questions (yes/no where possible).` : `- "ask_owner": only the owner can unblock it — an approval the project rules require, a missing decision or data, an account,
  a credential or a manual step. Ask short, concrete questions a non-programmer can answer (yes/no where possible).`}
- "give_up": the task is wrong, a duplicate, or already done.

Reply with ONLY one JSON object inside a \`\`\`json fenced block:
{ "action": "retry" | "ask_owner" | "give_up",
  "explanation": "2-4 short sentences IN UKRAINIAN for a non-programmer: what happened and what happens next",
  "question": "ask_owner only: the questions to the owner, IN UKRAINIAN",
  "feedback": "retry only: instructions for the next attempt",
  "decisions": "decisions taken on the owner's behalf, one per line with its reason (auto-answer only)",
  "changes": { "description": "…", "acceptanceCriteria": "…", "allowedPaths": ["…"], "complexity": "low|medium|high" } }
`;
}

export class Doctor {
  private orch: Orchestrator;
  private queue: Promise<void> = Promise.resolve();
  private waiting = new Set<number>();
  constructor(orch: Orchestrator) { this.orch = orch; }

  /** Called when a task becomes blocked/failed: diagnose it when the project has auto-fix on. */
  maybeStart(taskId: number, note?: string): Promise<void> {
    const { store } = this.orch;
    let t: Task;
    try { t = store.getTask(taskId); } catch { return Promise.resolve(); }
    if (!['blocked', 'failed'].includes(t.status) || !store.getProject(t.projectId).reviewPolicy.autoFix) return Promise.resolve();
    if (note && HUMAN_NOTES.some((n) => note.startsWith(n))) return Promise.resolve();
    if (t.artifacts.ownerQuestion || this.orch.isPaused(t.projectId)) return Promise.resolve();
    if (Number(t.artifacts.autoFixes ?? 0) >= MAX_FIXES) {
      if (!t.artifacts.autoFixExhausted) {
        store.patchTask(t.id, { artifacts: { ...t.artifacts, autoFixExhausted: true } });
        store.addEvidence(t.id, { kind: 'doctor', ok: false, summary: `Auto-fix already tried ${MAX_FIXES} times — the task needs a human decision` });
      }
      return Promise.resolve();
    }
    return this.start(taskId).then(() => {}, () => {});
  }

  /** Queue a diagnosis (also the manual "auto-fix" button). One diagnosis runs at a time. */
  start(taskId: number): Promise<Task> {
    const { store } = this.orch;
    const t = store.getTask(taskId);
    if (!['blocked', 'failed'].includes(t.status)) throw new Conflict(`auto-fix works on blocked or failed tasks, not ${t.status}`);
    if (this.waiting.has(taskId) || (t.artifacts.doctor as Diagnosis | undefined)?.status === 'running') throw new Conflict('auto-fix is already working on this task');
    this.waiting.add(taskId);
    const job = this.queue.then(() => this.run(taskId)).finally(() => this.waiting.delete(taskId));
    this.queue = job.catch(() => {});
    void this.orch.track(job.catch(() => {}));
    return Promise.resolve(store.getTask(taskId));
  }

  private save(id: number, d: Diagnosis, extra: Record<string, unknown> = {}): void {
    const t = this.orch.store.getTask(id);
    this.orch.store.patchTask(id, { artifacts: { ...t.artifacts, ...extra, doctor: d } });
  }

  private async run(taskId: number): Promise<void> {
    const { store, ws } = this.orch;
    let t = store.getTask(taskId);
    if (!['blocked', 'failed'].includes(t.status)) return;
    const p = store.getProject(t.projectId);
    const at = new Date().toISOString();
    let meta = { provider: 'auto', model: null as string | null };
    const dir = path.join(this.orch.opts.dataDir, 'doctor', `t${t.id}-${Date.now()}`);
    try {
      // the reviewer agent the owner picked for this project, else the planning/medium chain (a strong model at modest effort)
      const want = p.reviewPolicy.provider || 'auto';
      const links = want === 'auto' ? await this.orch.chainFor('planning', 'medium', { write: false }) : [];
      const { adapter, provider, model, effort } = await resolveReadOnlyAgent(this.orch, want, 'auto-fix', { links });
      meta = { provider, model: model ?? null };
      this.save(t.id, { status: 'running', at, ...meta });
      store.event({ projectId: p.id, taskId: t.id, type: 'doctor.started', data: meta });
      await ws.addDetached(p.repoPath, p.baseBranch, dir);
      const pending = t.artifacts.pendingQuestion ? `\n\nOpen question that was waiting for the owner:\n${String(t.artifacts.pendingQuestion)}` : '';
      const prompt = buildDoctorPrompt(t, (t.feedback ?? '') + pending, this.endings(t), p.reviewPolicy.autoAnswer);
      const inv = adapter.buildInvocation({ prompt, workspace: dir, model: model ?? null, effort: effort ?? null, policy: 'read-only', trustWorkspace: this.orch.trusts(provider) });
      const r = await runOnce(adapter, inv, dir, { timeoutMs: 900_000, stallMs: this.orch.opts.stallTimeoutSec * 1000, onEvent: () => {} }).done;
      const final = r.result?.text?.trim() && r.result.text !== 'turn completed' ? r.result.text : r.messages.join(NL);
      const failure = r.killReason ?? (r.code !== 0 ? `agent exited with code ${r.code}` : !final.trim() ? 'empty answer' : null);
      if (failure) {
        if (!r.killReason) this.orch.noteLimit(provider, [failure, final, ...r.messages.slice(-20)].join(NL), { projectId: p.id, taskId: t.id });
        throw new Error(failure);
      }
      this.apply(t.id, parseAdvice(extractJson(maskSecrets(final))), { at, ...meta });
    } catch (e) {
      const msg = (e as Error).message;
      try {
        this.save(taskId, { status: 'failed', at, ...meta, error: msg });
        store.addEvidence(taskId, { kind: 'doctor', ok: false, summary: `Auto-fix could not diagnose the task: ${msg}` });
      } catch { /* task deleted */ }
    } finally {
      await ws.remove(p.repoPath, dir, null).catch(() => {});
    }
  }

  /** The last words of the last two runs: the final report usually says why nothing was done. */
  private endings(t: Task): string {
    const runs = this.orch.store.runsForTask(t.id).slice(-2);
    return runs.map((run) => {
      const out = this.orch.store.events({ taskId: t.id, type: 'run.output' })
        .filter((e) => e.runId === run.id && ['message', 'result', 'error'].includes(String((e.data as { kind?: string })?.kind)))
        .slice(-3).map((e) => String((e.data as { text?: string }).text ?? '').slice(-1500));
      return `### Attempt ${run.attempt} — ${run.provider}${run.model ? ' ' + run.model : ''} (${run.status}${run.error ? ': ' + run.error : ''})${NL}${out.join(NL + '---' + NL) || '(no output)'}`;
    }).join(NL + NL);
  }

  private apply(id: number, a: DoctorAdvice, meta: { at: string; provider: string; model: string | null }): void {
    const { store } = this.orch;
    const cur = store.getTask(id);
    if (!['blocked', 'failed'].includes(cur.status)) return; // the owner acted meanwhile
    const autoFixes = Number(cur.artifacts.autoFixes ?? 0) + 1;
    let changed: string[] = [];
    const auto = this.orch.store.getProject(cur.projectId).reviewPolicy.autoAnswer;
    if (a.action === 'retry' && auto && a.decisions) {
      const base = a.changes.description ?? cur.description;
      a.changes.description = `${base}\n\n## Decisions taken on the owner's behalf (auto-answer, ${new Date().toISOString().slice(0, 16).replace('T', ' ')})\n${a.decisions}`;
    }
    if (a.action === 'retry' && Object.keys(a.changes).length) {
      try { this.orch.updateTask(id, a.changes as Partial<Task>); changed = Object.keys(a.changes); }
      catch (e) { store.addEvidence(id, { kind: 'doctor', ok: false, summary: `Auto-fix proposed invalid task changes, kept the task as it was: ${(e as Error).message}` }); }
    }
    const d: Diagnosis = { status: 'succeeded', ...meta, action: a.action, explanation: a.explanation, question: a.question || undefined, changed, decisions: a.decisions || undefined };
    store.addEvidence(id, { kind: 'doctor', ok: a.action === 'retry', detail: a.feedback || undefined,
      summary: `Auto-fix (${meta.provider}): ${a.action === 'retry' ? `${auto && a.decisions ? 'decided for the owner and ' : ''}retrying${changed.length ? ` with corrected ${changed.join(', ')}` : ''}` : a.action === 'ask_owner' ? 'the owner has to answer first' : 'the task cannot be done as written'} — ${a.explanation}` });
    const t = store.getTask(id);
    if (a.action === 'retry') {
      store.setStatus(id, 'queued', { feedback: a.feedback || t.feedback, question: null, notBefore: null, maxAttempts: Math.max(t.maxAttempts, t.attempts + 2),
        artifacts: { ...t.artifacts, autoFixes, doctor: d, ownerQuestion: undefined, pendingQuestion: undefined, chainFrom: t.attempts } }, 'auto-fix: retry');
    } else if (a.action === 'ask_owner') {
      // with auto-answer on, what still reaches the owner is owner-only (secrets, payments, accounts, manual steps)
      store.patchTask(id, { question: a.question, artifacts: { ...t.artifacts, autoFixes, doctor: d, ownerQuestion: true, ownerOnly: auto || undefined, pendingQuestion: undefined } });
      store.event({ projectId: t.projectId, taskId: id, type: 'task.question', data: { question: a.question } });
    } else {
      store.patchTask(id, { artifacts: { ...t.artifacts, autoFixes, doctor: d } });
    }
  }
}

/** "OWNER QUESTION: …" lines an agent leaves when it must not continue without the owner (see the task contract). */
export function ownerQuestions(texts: (string | null | undefined)[]): string[] {
  const qs = texts.flatMap((x) => [...String(x ?? '').matchAll(/^[\s>*_-]*OWNER QUESTION[:*_\s]*(.+)$/gim)].map((m) => m[1]!.replace(/[*_]+$/, '').trim()));
  return [...new Set(qs)].filter(Boolean).slice(0, 10);
}
