// LLM planner: project goal -> draft task DAG, produced by a read-only agent session.
// The result is only a proposal: the user reviews it, then "apply" creates draft tasks.
import path from 'node:path';
import type { Orchestrator } from './orchestrator.ts';
import { BadRequest, Conflict, type PlanDoc, type PlanRun, type PlanTask, type Project, type Task } from './store.ts';
import { topoOrder } from './dag.ts';
import { ROLES, cleanModel, commandDecision } from './contract.ts';
import type { AgentAdapter } from './adapters/types.ts';
import { killTree, isAlive, maskSecrets } from './proc.ts';
import { extractJson, runOnce, resolveReadOnlyAgent, type OneShot } from './oneshot.ts';
import { git } from './workspace.ts';
import { CATEGORIES, COMPLEXITIES } from './routing.ts';

export const PLAN_HEADER = '# Planning request — HidForge';
const NL = '\n';

export function buildPlanPrompt(project: Project, existing: Task[], maxTasks: number, files: string[] = []): string {
  const ex = existing.filter((t) => t.status !== 'canceled');
  return `${PLAN_HEADER}
You are the Project Manager/Planner of a team of AI coding agents.
This is a READ-ONLY planning session: do NOT create, modify or delete any file and do not run commands that change anything. Do not run shell commands: some agents cannot get command approval in headless mode. Read files with your file-viewing tools if needed; the file list is below.

## Project goal
${project.goal}

## Repository files (git ls-files${files.length >= 400 ? ', first 400' : ''})
${files.length ? files.map((f) => `- ${f}`).join(NL) : '- (empty repository)'}

## Existing tasks (do not duplicate them; a new task may depend on one by its numeric id)
${ex.length ? ex.map((t) => `- #${t.id} [${t.status}] ${t.title} (paths: ${t.allowedPaths.join(', ') || 'any'})`).join('\n') : '- (none)'}

## Planning rules
- Split the goal into at most ${maxTasks} small tasks; each must be finishable by one coding agent in one session.
- Maximize safe parallelism: tasks that may run at the same time MUST have disjoint allowedPaths.
- Put shared contracts (API shapes, schemas, interfaces) into an early task that the others depend on.
- dependsOn: keys of tasks in this plan, or numeric ids of existing tasks, that must be merged first. No cycles.
- allowedPaths: repository-relative glob patterns such as "src/api/**". No absolute paths, no "..".
- verifyCommands: plain commands with no shell operators (no | & ; > <), only tools that already exist in this repository, e.g. "npm test". The user approves every command; leave it empty if unsure.
- role: one of ${ROLES.map((r) => `"${r}"`).join(', ')}.
- readOnly: true only for analysis/review tasks that must not change files.
- category: what kind of work it is, one of ${CATEGORIES.map((c) => `"${c}"`).join(', ')}. ui_visual = layout, styling, how a page looks; frontend_logic = client-side behaviour and state; small_edit = a rename, a typo, a one-line config change.
- complexity: "low" (mechanical, one or two files, obvious solution), "medium" (a normal feature or fix), "high" (cross-module, subtle, or easy to get wrong). Be honest: the orchestrator picks the model from category and complexity, and a higher complexity costs more.

## Output
Reply with ONLY one JSON object inside a \`\`\`json fenced block, exactly this shape:
\`\`\`json
{
  "summary": "one short paragraph: the approach",
  "risks": ["risk or open question"],
  "tasks": [
    {
      "key": "short-kebab-id",
      "title": "imperative title",
      "role": "Backend",
      "category": "backend",
      "complexity": "medium",
      "description": "what to build and how, concrete enough for an agent that has not seen this plan",
      "acceptanceCriteria": "checkable criteria",
      "dependsOn": ["other-key"],
      "allowedPaths": ["src/backend/**"],
      "verifyCommands": [],
      "readOnly": false
    }
  ]
}
\`\`\`
`;
}

type Parsed = { ok: true; plan: PlanDoc } | { ok: false; error: string };

const badPattern = (p: string) => !p.trim() || p.startsWith('/') || p.startsWith('\\') || /^[a-zA-Z]:/.test(p) || p.replace(/\\/g, '/').split('/').includes('..');
const strArr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()).map((x) => String(x).trim()) : []);

/** Parse + validate an agent's plan. Tries several candidate texts (result text, joined stream deltas). */
export function parsePlan(candidates: string[], existingIds: Set<number>, maxTasks: number): Parsed {
  let lastError = 'empty agent output';
  for (const text of candidates) {
    if (!text?.trim()) continue;
    let raw: unknown;
    try { raw = extractJson(text); } catch (e) { lastError = `could not parse JSON: ${(e as Error).message}`; continue; }
    const r = validatePlan(raw, existingIds, maxTasks);
    if (r.ok) return r;
    lastError = r.error;
  }
  return { ok: false, error: lastError };
}

export function validatePlan(raw: unknown, existingIds: Set<number>, maxTasks: number): Parsed {
  const o = raw as Record<string, unknown>;
  if (!o || typeof o !== 'object' || !Array.isArray(o.tasks)) return { ok: false, error: 'plan must be an object with a "tasks" array' };
  if (o.tasks.length === 0) return { ok: false, error: 'plan has no tasks' };
  if (o.tasks.length > maxTasks) return { ok: false, error: `plan has ${o.tasks.length} tasks, limit is ${maxTasks}` };
  const tasks: PlanTask[] = [];
  const keys = new Set<string>();
  for (const [i, t0] of (o.tasks as Record<string, unknown>[]).entries()) {
    const t = t0 ?? {};
    const key = String(t.key ?? `task-${i + 1}`).trim();
    const title = String(t.title ?? '').trim();
    if (!title) return { ok: false, error: `task ${i + 1} has no title` };
    if (keys.has(key)) return { ok: false, error: `duplicate task key "${key}"` };
    keys.add(key);
    const allowedPaths = strArr(t.allowedPaths);
    const bad = allowedPaths.find(badPattern);
    if (bad !== undefined) return { ok: false, error: `task "${key}": unsafe allowedPaths pattern "${bad}"` };
    const verifyCommands = strArr(t.verifyCommands);
    const denied = verifyCommands.find((c) => commandDecision(c, []).decision === 'deny');
    if (denied) return { ok: false, error: `task "${key}": forbidden verify command "${denied}"` };
    const role = ROLES.includes(t.role as typeof ROLES[number]) ? String(t.role) : 'Backend';
    const deps = Array.isArray(t.dependsOn) ? t.dependsOn : [];
    tasks.push({
      key, title: title.slice(0, 200), description: String(t.description ?? '').slice(0, 8000),
      acceptanceCriteria: String(t.acceptanceCriteria ?? '').slice(0, 4000),
      dependsOn: deps.map((d) => (typeof d === 'number' || /^#?\d+$/.test(String(d)) ? Number(String(d).replace('#', '')) : String(d))),
      role, allowedPaths, verifyCommands, policy: t.readOnly === true ? 'read-only' : 'workspace-write',
      category: (CATEGORIES as readonly string[]).includes(String(t.category)) ? String(t.category) : 'backend',
      complexity: (COMPLEXITIES as readonly string[]).includes(String(t.complexity)) ? String(t.complexity) : 'medium',
    });
  }
  for (const t of tasks) for (const d of t.dependsOn) {
    if (typeof d === 'number' ? !existingIds.has(d) : !keys.has(d)) return { ok: false, error: `task "${t.key}" depends on unknown "${d}"` };
    if (d === t.key) return { ok: false, error: `task "${t.key}" depends on itself` };
  }
  const idx = new Map(tasks.map((t, i) => [t.key, i + 1]));
  try { topoOrder(tasks.map((t) => ({ id: idx.get(t.key)!, dependsOn: t.dependsOn.filter((d): d is string => typeof d === 'string').map((d) => idx.get(d)!) }))); }
  catch { return { ok: false, error: 'plan contains a dependency cycle' }; }
  return { ok: true, plan: { summary: String(o.summary ?? '').slice(0, 4000), risks: strArr(o.risks).slice(0, 20), tasks } };
}

export class Planner {
  private readonly orch: Orchestrator;
  private readonly live = new Map<number, OneShot>();
  private abandoned = false; // test hook: simulated crash, the DB is gone
  constructor(orch: Orchestrator) { this.orch = orch; }

  /** Start a read-only planning session for the project goal. Returns immediately; progress is streamed as events. */
  async start(projectId: number, o: { provider?: string; model?: string | null; maxTasks?: number; timeoutSec?: number } = {}): Promise<PlanRun> {
    const { store } = this.orch;
    const p = store.getProject(projectId);
    if (!p.goal.trim()) throw new BadRequest('set the project goal first');
    const maxTasks = Math.max(1, Math.min(30, Number(o.maxTasks ?? 12)));
    // 'auto': the planning chain of the routing matrix (read-only, so agents that cannot write are fine).
    const links = (o.provider ?? 'auto') === 'auto' ? await this.orch.chainFor('planning', 'medium', { write: false }) : [];
    const { adapter, provider, model: linkModel, effort } = await resolveReadOnlyAgent(this.orch, o.provider ?? 'auto', 'planner', { links });

    const model = cleanModel(o.model) ?? linkModel ?? null;
    const plan = store.createPlan({ projectId, provider, model, goal: p.goal });
    store.event({ projectId, type: 'plan.started', data: { planId: plan.id, provider, model, effort: effort ?? null, mock: adapter.mock } });
    void this.orch.track(this.execute(plan, p, adapter, maxTasks, (o.timeoutSec ?? 900) * 1000, effort ?? null));
    return plan;
  }

  private async execute(plan: PlanRun, p: Project, adapter: AgentAdapter, maxTasks: number, timeoutMs: number, effort: string | null = null): Promise<void> {
    const { store, ws } = this.orch;
    const dir = path.join(this.orch.opts.dataDir, 'planning', `p${p.id}-plan${plan.id}`);
    const out: string[] = [];
    try {
      await ws.addDetached(p.repoPath, p.baseBranch, dir);
      const existing = store.listTasks(p.id);
      const files = (await git(dir, ['ls-files'])).stdout.split(NL).filter(Boolean).slice(0, 400);
      const inv = adapter.buildInvocation({ prompt: buildPlanPrompt(p, existing, maxTasks, files), workspace: dir, model: plan.model, effort, policy: 'read-only', trustWorkspace: this.orch.trusts(plan.provider) });
      const run = runOnce(adapter, inv, dir, {
        timeoutMs, stallMs: this.orch.opts.stallTimeoutSec * 1000,
        onEvent: (ev, stream) => {
          if (this.abandoned) return;
          const text = maskSecrets(ev.text).slice(0, 8000);
          out.push(text);
          store.event({ projectId: p.id, type: 'plan.output', data: { planId: plan.id, stream, kind: ev.kind, text } });
        },
      });
      this.live.set(plan.id, run);
      if (run.pid) store.updatePlan(plan.id, { pid: run.pid });
      const r = await run.done;
      this.live.delete(plan.id);
      if (this.abandoned) return;
      const output = out.join('\n').slice(-50_000);
      if (r.killReason === 'canceled') { store.updatePlan(plan.id, { status: 'canceled', output }); return; }
      const failure = r.killReason ?? (r.code !== 0 ? `agent exited with code ${r.code}` : !r.result ? 'agent exited without a result event'
        : r.result.isError ? `agent reported an error: ${r.result.text.slice(0, 500)}` : null);
      if (failure) { store.updatePlan(plan.id, { status: 'failed', error: failure, output, usage: r.result?.usage ?? null }); return; }
      const parsed = parsePlan([r.result!.text, r.messages.join(''), r.messages.join('\n')], new Set(existing.map((t) => t.id)), maxTasks);
      const hint = r.messages.join('').trim() || !out.length ? '' : ` (last agent output: ${out.at(-1)!.slice(0, 300)})`;
      if (!parsed.ok) { store.updatePlan(plan.id, { status: 'failed', error: `invalid plan: ${parsed.error}${hint}`, output, usage: r.result?.usage ?? null }); return; }
      store.updatePlan(plan.id, { status: 'succeeded', plan: parsed.plan, output, usage: r.result?.usage ?? null });
    } catch (e) {
      this.live.delete(plan.id);
      if (this.abandoned) return;
      store.updatePlan(plan.id, { status: 'failed', error: (e as Error).message, output: out.join('\n').slice(-50_000) });
    } finally {
      await ws.remove(p.repoPath, dir, null).catch(() => {});
    }
  }

  async cancel(planId: number): Promise<PlanRun> {
    const plan = this.orch.store.getPlan(planId);
    if (plan.status !== 'running') throw new Conflict(`plan is ${plan.status}`);
    const run = this.live.get(planId);
    if (run) { await run.kill('canceled'); await run.done; await this.orch.idle(); }
    else this.orch.store.updatePlan(planId, { status: 'canceled' });
    return this.orch.store.getPlan(planId);
  }

  discard(planId: number): PlanRun {
    const plan = this.orch.store.getPlan(planId);
    if (!['succeeded', 'failed'].includes(plan.status)) throw new Conflict(`plan is ${plan.status}`);
    return this.orch.store.updatePlan(planId, { status: 'discarded' });
  }

  /** Create draft tasks from a succeeded plan, atomically, mapping plan keys to new task ids. */
  apply(planId: number, o: { provider?: string; model?: string | null } = {}): Task[] {
    const { store } = this.orch;
    const plan = store.getPlan(planId);
    if (plan.status !== 'succeeded' || !plan.plan) throw new Conflict(`only a succeeded plan can be applied (plan is ${plan.status})`);
    const provider = o.provider ?? (plan.provider === 'mock' ? 'mock' : 'auto');
    const tasks = plan.plan.tasks;
    const idx = new Map(tasks.map((t, i) => [t.key, i + 1]));
    const order = topoOrder(tasks.map((t) => ({ id: idx.get(t.key)!, dependsOn: t.dependsOn.filter((d): d is string => typeof d === 'string').map((d) => idx.get(d)!) })));
    const created = store.tx(() => {
      const ids = new Map<string, number>();
      const out: Task[] = [];
      for (const n of order) {
        const t = tasks[n - 1]!;
        const task = this.orch.createTask(plan.projectId, {
          title: t.title, description: t.description, acceptanceCriteria: t.acceptanceCriteria, assignedRole: t.role,
          dependsOn: t.dependsOn.map((d) => (typeof d === 'number' ? d : ids.get(d)!)),
          allowedPaths: t.allowedPaths, verifyCommands: t.verifyCommands, policy: t.policy, provider, model: o.model ?? null,
          category: t.category ?? null, complexity: t.complexity ?? null,
        });
        ids.set(t.key, task.id);
        out.push(task);
      }
      store.updatePlan(planId, { status: 'applied', appliedTaskIds: out.map((t) => t.id) });
      return out;
    });
    return created;
  }

  /** On startup: planners cannot be resumed, mark them failed and kill orphans. */
  async recover(): Promise<void> {
    for (const plan of this.orch.store.runningPlans()) {
      // ponytail: same PID-reuse caveat as task recovery; only kill recently started sessions.
      if (plan.pid && Date.now() - Date.parse(plan.createdAt) < 3_600_000 && isAlive(plan.pid)) await killTree(plan.pid);
      this.orch.store.updatePlan(plan.id, { status: 'failed', error: 'interrupted by orchestrator restart' });
    }
  }

  /** Simulated crash: stop touching the DB, leave processes running. */
  abandon(): void { this.abandoned = true; }

  async stop(): Promise<void> {
    await Promise.all([...this.live.entries()].map(async ([, run]) => { await run.kill('canceled'); await run.done; }));
  }
}
