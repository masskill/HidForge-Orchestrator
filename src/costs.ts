// Spend accounting from what the CLIs report: task runs, planner sessions and AI reviews.
// Only Claude Code reports a dollar cost (total_cost_usd); other CLIs report tokens only.
import type { Store } from './store.ts';

export interface ProviderCost { provider: string; sessions: number; usd: number; sessionsWithUsd: number; inputTokens: number; outputTokens: number }
export interface CostSummary { totalUsd: number; budgetUsd: number | null; remainingUsd: number | null; byProvider: ProviderCost[]; byKind: Record<string, number> }

type Usage = Record<string, unknown> | null | undefined;
const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

export function projectCosts(store: Store, projectId: number): CostSummary {
  const map = new Map<string, ProviderCost>();
  const byKind: Record<string, number> = { task: 0, planner: 0, review: 0 };
  const add = (provider: string, kind: string, u: Usage) => {
    const c = map.get(provider) ?? { provider, sessions: 0, usd: 0, sessionsWithUsd: 0, inputTokens: 0, outputTokens: 0 };
    c.sessions++;
    if (u && typeof u.total_cost_usd === 'number') { c.usd += u.total_cost_usd; c.sessionsWithUsd++; byKind[kind] = (byKind[kind] ?? 0) + u.total_cost_usd; }
    c.inputTokens += n(u?.input_tokens) + n(u?.cache_creation_input_tokens) + n(u?.cache_read_input_tokens) + n(u?.cached_input_tokens) + n(u?.cache_read_tokens);
    c.outputTokens += n(u?.output_tokens) + n(u?.thinking_tokens);
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
