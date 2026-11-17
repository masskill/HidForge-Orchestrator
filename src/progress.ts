// Project plan view: tasks grouped into stages by dependency depth, approximate completion, and which agent/model/effort
// is working on (or will take) each task. Pure read model; nothing here starts or changes work.
import type { Orchestrator } from './orchestrator.ts';
import type { Task } from './store.ts';
import { roleTemplate } from './contract.ts';

/**
 * Approximate share of a task's work by status. A rule of thumb, not a measurement:
 * merged = done; accepted/review = the agent finished, only checks and merge remain; blocked = work exists but is stuck; running = in progress.
 */
export const STATUS_DONE: Record<string, number> = {
  merged: 1, accepted: 0.9, review: 0.75, needs_user_input: 0.75, running: 0.4,
  queued: 0, ready: 0, draft: 0, failed: 0, blocked: 0.5,
};
/** Weight by complexity, so one hard task counts more than one typo fix. */
export const COMPLEXITY_WEIGHT: Record<string, number> = { low: 1, medium: 2, high: 3 };

export interface AgentPick { provider: string; model: string | null; effort: string | null; source: 'running' | 'last' | 'next' }
export interface PlanTaskView {
  id: number; title: string; status: string; category: string | null; complexity: string | null; weight: number; pct: number;
  attempts: number; maxAttempts: number; agent: AgentPick | null;
}
export interface PlanStage { n: number; pct: number; done: number; total: number; current: boolean; tasks: PlanTaskView[] }
export interface PlanView { pct: number; done: number; total: number; currentStage: number | null; running: number; stages: PlanStage[] }

const round = (x: number) => Math.round(x * 100);

/** Stage = 1 + longest chain of dependencies inside the project (tasks of one stage can run in parallel). */
export function stageOf(tasks: Pick<Task, 'id' | 'dependsOn'>[]): Map<number, number> {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const memo = new Map<number, number>();
  const depth = (id: number, seen: Set<number>): number => {
    if (memo.has(id)) return memo.get(id)!;
    if (seen.has(id)) return 1; // cycles are rejected on input; guard anyway
    seen.add(id);
    const deps = (byId.get(id)?.dependsOn ?? []).filter((d) => byId.has(d));
    const d = deps.length ? 1 + Math.max(...deps.map((x) => depth(x, seen))) : 1;
    memo.set(id, d);
    return d;
  };
  for (const t of tasks) depth(t.id, new Set());
  return memo;
}

export async function projectPlan(orch: Orchestrator, projectId: number): Promise<PlanView> {
  const { store } = orch;
  store.getProject(projectId);
  const tasks = store.listTasks(projectId).filter((t) => t.status !== 'canceled');
  const stage = stageOf(tasks);
  const runs = store.allProjectRuns(projectId);
  const views: (PlanTaskView & { stage: number })[] = [];
  for (const t of tasks) {
    const own = runs.filter((r) => r.taskId === t.id);
    const live = own.find((r) => r.status === 'running');
    const last = own.at(-1);
    let agent: AgentPick | null = null;
    if (live) agent = { provider: live.provider, model: live.model, effort: live.effort, source: 'running' };
    else if (!['merged', 'accepted', 'review', 'needs_user_input'].includes(t.status) && t.provider === 'auto' && t.category) {
      // What the scheduler would pick for the next attempt (same rule as startRun).
      const tpl = roleTemplate(orch.roleTemplates(), t.assignedRole);
      const chain = await orch.chainFor(t.category, t.complexity, { write: t.policy !== 'read-only' && !tpl.readOnly, roleProviders: tpl.providers });
      const l = chain[Math.min(t.attempts, chain.length - 1)];
      if (l) agent = { provider: l.agent, model: l.model, effort: l.effort, source: 'next' };
    } else if (last) agent = { provider: last.provider, model: last.model, effort: last.effort, source: 'last' };
    else if (t.provider !== 'auto') agent = { provider: t.provider, model: t.model, effort: t.effort, source: 'next' };
    views.push({
      id: t.id, title: t.title, status: t.status, category: t.category, complexity: t.complexity, attempts: t.attempts, maxAttempts: t.maxAttempts,
      weight: COMPLEXITY_WEIGHT[t.complexity ?? 'medium'] ?? 2, pct: round(STATUS_DONE[t.status] ?? 0), agent, stage: stage.get(t.id) ?? 1,
    });
  }
  const sum = (xs: PlanTaskView[]) => {
    const w = xs.reduce((a, x) => a + x.weight, 0);
    return w ? Math.round(xs.reduce((a, x) => a + x.weight * x.pct, 0) / w) : 0;
  };
  const n = Math.max(0, ...views.map((v) => v.stage));
  const stages: PlanStage[] = [];
  for (let i = 1; i <= n; i++) {
    const ts = views.filter((v) => v.stage === i).map(({ stage: _s, ...v }) => v);
    if (!ts.length) continue;
    stages.push({ n: i, pct: sum(ts), done: ts.filter((t) => t.status === 'merged').length, total: ts.length, current: false, tasks: ts });
  }
  const cur = stages.find((s) => s.done < s.total);
  if (cur) cur.current = true;
  return {
    pct: sum(views), done: views.filter((v) => v.status === 'merged').length, total: views.length,
    currentStage: cur?.n ?? null, running: views.filter((v) => v.status === 'running').length, stages,
  };
}
