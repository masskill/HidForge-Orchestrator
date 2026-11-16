// Spend accounting from what the CLIs report: task runs, planner sessions and AI reviews.
// Only Claude Code reports a dollar cost (total_cost_usd); other CLIs report tokens only.
import type { Store } from './store.ts';

export interface ProviderCost { provider: string; sessions: number; usd: number; sessionsWithUsd: number; inputTokens: number; outputTokens: number }
export interface CostSummary { totalUsd: number; budgetUsd: number | null; remainingUsd: number | null; byProvider: ProviderCost[]; byKind: Record<string, number> }

type Usage = Record<string, unknown> | null | undefined;
const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** Tokens in/out from any CLI's usage: snake_case (Claude, Codex, agy, plugins) or camelCase (Cursor). */
export function usageTokens(u: Usage): { input: number; output: number; usd: number | null } {
  return {
    input: n(u?.input_tokens) + n(u?.cache_creation_input_tokens) + n(u?.cache_read_input_tokens) + n(u?.cached_input_tokens) + n(u?.cache_read_tokens)
      + n(u?.inputTokens) + n(u?.cacheReadTokens) + n(u?.cacheWriteTokens),
    output: n(u?.output_tokens) + n(u?.thinking_tokens) + n(u?.outputTokens), // reasoningTokens: may already be in outputTokens, not added
    usd: u && typeof u.total_cost_usd === 'number' ? u.total_cost_usd : null,
  };
}

export function projectCosts(store: Store, projectId: number): CostSummary {
  const map = new Map<string, ProviderCost>();
  const byKind: Record<string, number> = { task: 0, planner: 0, review: 0 };
  const add = (provider: string, kind: string, u: Usage) => {
    const c = map.get(provider) ?? { provider, sessions: 0, usd: 0, sessionsWithUsd: 0, inputTokens: 0, outputTokens: 0 };
    c.sessions++;
    const t = usageTokens(u);
    if (t.usd !== null) { c.usd += t.usd; c.sessionsWithUsd++; byKind[kind] = (byKind[kind] ?? 0) + t.usd; }
    c.inputTokens += t.input;
    c.outputTokens += t.output;
    map.set(provider, c);
  };
  for (const t of store.listTasks(projectId)) {
    for (const r of store.runsForTask(t.id)) add(r.provider, 'task', r.usage as Usage);
    const rv = t.artifacts.aiReview as { provider?: string; usage?: Usage; status?: string } | undefined;
    if (rv?.provider && rv.status !== 'running') add(rv.provider, 'review', rv.usage);
  }
  for (const p of store.listPlans(projectId, 100_000)) add(p.provider, 'planner', p.usage as Usage);
  const totalUsd = [...map.values()].reduce((a, c) => a + c.usd, 0);
  const budgetUsd = store.getProject(projectId).budgetUsd;
  return {
    totalUsd, budgetUsd, remainingUsd: budgetUsd == null ? null : Math.max(0, budgetUsd - totalUsd),
    byProvider: [...map.values()].sort((a, b) => b.usd - a.usd || b.sessions - a.sessions), byKind,
  };
}

export interface RunRow { id: number; taskId: number; taskTitle: string; attempt: number; provider: string; isMock: boolean; status: string;
  exitCode: number | null; error: string | null; startedAt: string; endedAt: string | null; durationMs: number | null; usd: number | null; inputTokens: number; outputTokens: number }

/** Task runs of a project, newest first, for the Runs page. `before` pages backwards by run id. */
export function projectRuns(store: Store, projectId: number, f: { before?: number; limit?: number; status?: string; provider?: string } = {}): RunRow[] {
  return store.runsForProject(projectId, f).map((r) => {
    const t = usageTokens(r.usage as Usage);
    const end = r.endedAt ? Date.parse(r.endedAt) : r.status === 'running' ? Date.now() : NaN;
    return { id: r.id, taskId: r.taskId, taskTitle: r.taskTitle, attempt: r.attempt, provider: r.provider, isMock: r.isMock, status: r.status,
      exitCode: r.exitCode, error: r.error, startedAt: r.startedAt, endedAt: r.endedAt,
      durationMs: Number.isFinite(end) ? Math.max(0, end - Date.parse(r.startedAt)) : null, usd: t.usd, inputTokens: t.input, outputTokens: t.output };
  });
}
