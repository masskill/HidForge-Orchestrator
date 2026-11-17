// Auto-routing: the priority matrix, its hard rules, and escalation along the chain.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CATEGORIES, COMPLEXITIES, DEFAULT_MATRIX, EFFORTS, FABLE, cell, normalizeMatrix, reorderByStats, resolveChain, reviewLinks, vendorOf } from '../src/routing.ts';
import { AGY, CLAUDE, CODEX, CURSOR, CliAdapter } from '../src/adapters/cli.ts';
import { MockAdapter } from '../src/adapters/index.ts';
import { validatePlugin, pluginAdapter } from '../src/adapters/plugin.ts';
import { validatePlan } from '../src/planner.ts';
import { modelStats } from '../src/costs.ts';
import { setup, mock, waitFor, waitStatus } from './helpers.ts';

const ALL = new Set(['claude', 'codex', 'agy', 'cursor']);
const HIGH = EFFORTS.indexOf('high');

test('default matrix: 30 cells, no link above "high", at least two vendors per cell, no Fable, no Gemini CLI', () => {
  assert.equal(Object.keys(DEFAULT_MATRIX).length, CATEGORIES.length * COMPLEXITIES.length);
  for (const [key, chain] of Object.entries(DEFAULT_MATRIX)) {
    assert.equal(chain.length, 3, key);
    for (const l of chain) {
      assert.ok(l.effort === null || EFFORTS.indexOf(l.effort) <= HIGH, `${key}: ${l.model} uses ${l.effort}`);
      assert.doesNotMatch(l.model, /fable/, key);
      assert.notEqual(l.agent, 'gemini', key);
      assert.doesNotMatch(l.model, /xhigh|max|ultra/, key);
    }
    assert.ok(new Set(chain.map((l) => vendorOf(l.agent, l.model))).size >= 2, `${key}: one vendor only`);
  }
});

test('reviewer is never from the vendor of the code author', () => {
  for (const [agent, model] of [['claude', 'opus'], ['codex', 'gpt-6.1-sol'], ['agy', 'gemini-4-argon-high'], ['cursor', 'composer-2.5'], ['cursor', 'claude-opus-5-5-high'], ['agy', 'claude-sonnet-5-5-high']] as const) {
    const author = vendorOf(agent, model);
    for (const cx of COMPLEXITIES) {
      const links = reviewLinks(author, cx);
      assert.ok(links.length, `${agent}/${model}: no reviewer`);
      for (const l of links) assert.notEqual(vendorOf(l.agent, l.model), author, `${agent}/${model} reviewed by ${l.agent}/${l.model}`);
    }
  }
  assert.equal(vendorOf('cursor', 'claude-opus-5-5-high'), 'anthropic', 'the model decides the vendor, not the CLI');
  assert.equal(reviewLinks('anthropic', 'low')[0]!.effort, 'medium');
  assert.equal(reviewLinks('anthropic', 'high')[0]!.effort, 'high');
});

test('resolveChain: skips unavailable, read-only-for-writes and role-forbidden agents; the ceiling trims links; Fable only when allowed', () => {
  const full = resolveChain('backend', 'medium', { available: ALL, write: true });
  assert.deepEqual(full.map((l) => l.agent), ['codex', 'claude', 'agy']);
  // Codex cannot write: a write task starts from fallback 1, a read-only task still uses Codex
  const ro = new Set(['codex']);
  assert.deepEqual(resolveChain('backend', 'medium', { available: ALL, readOnlyAgents: ro, write: true }).map((l) => l.agent), ['claude', 'agy']);
  assert.equal(resolveChain('planning', 'medium', { available: ALL, readOnlyAgents: ro, write: false })[1]!.agent, 'codex');
  assert.deepEqual(resolveChain('backend', 'medium', { available: new Set(['agy']), write: true }).map((l) => l.agent), ['agy']);
  assert.deepEqual(resolveChain('backend', 'medium', { available: ALL, write: true, roleProviders: ['claude'] }).map((l) => l.agent), ['claude']);
  // ceiling "medium" removes every "high" link
  assert.deepEqual(resolveChain('backend', 'high', { available: ALL, write: true, ceiling: 'medium' }), []);
  assert.deepEqual(resolveChain('backend', 'low', { available: ALL, write: true, ceiling: 'medium' }).map((l) => l.agent), ['codex', 'agy']);
  // a user matrix with xhigh is cut by the default ceiling
  const m = { ...DEFAULT_MATRIX, [cell('docs', 'low')]: [{ agent: 'claude', model: 'opus', effort: 'xhigh' as const }, { agent: 'claude', model: 'haiku', effort: 'medium' as const }] };
  assert.deepEqual(resolveChain('docs', 'low', { matrix: m, available: ALL, write: true }).map((l) => l.model), ['haiku']);
  assert.equal(resolveChain('docs', 'low', { matrix: m, available: ALL, write: true, ceiling: 'xhigh' }).length, 2);
  // Fable: off by default; when on, last link, high complexity of four categories only
  assert.ok(!resolveChain('bugfix', 'high', { available: ALL, write: true }).includes(FABLE));
  assert.equal(resolveChain('bugfix', 'high', { available: ALL, write: true, allowFable: true }).at(-1), FABLE);
  assert.ok(!resolveChain('bugfix', 'medium', { available: ALL, write: true, allowFable: true }).includes(FABLE));
  assert.ok(!resolveChain('docs', 'high', { available: ALL, write: true, allowFable: true }).includes(FABLE));
});

test('matrix validation and self-learning order', () => {
  assert.deepEqual(normalizeMatrix({ 'docs/low': [{ agent: 'claude', model: 'haiku', effort: 'medium' }], 'nope/low': [] }), { 'docs/low': [{ agent: 'claude', model: 'haiku', effort: 'medium' }] });
  assert.throws(() => normalizeMatrix({ 'docs/low': [{ agent: 'claude', model: '--dangerously-skip-permissions', effort: 'low' }] }), /bad model/);
  assert.throws(() => normalizeMatrix({ 'docs/low': [{ agent: 'claude', model: 'haiku', effort: 'ultra' }] }), /bad effort/);
  const chain = resolveChain('backend', 'medium', { available: ALL, write: true });
  const st = (runs: number[], ok: number[]) => chain.map((l, i) => ({ agent: l.agent, model: l.model, runs: runs[i]!, succeeded: ok[i]! }));
  assert.deepEqual(reorderByStats(chain, st([9, 9, 4], [1, 9, 4])), chain, 'not enough runs on one link: order unchanged');
  assert.deepEqual(reorderByStats(chain, st([5, 5, 5], [1, 5, 3])).map((l) => l.agent), ['claude', 'agy', 'codex']);
});

test('effort reaches the CLI: claude --effort, codex -c model_reasoning_effort, nothing for agy/cursor, {effort} in plugins', () => {
  const ctx = { prompt: 'p', workspace: 'C:\\w', model: 'm', policy: 'workspace-write' as const, effort: 'high' };
  const args = (spec: typeof CLAUDE, c = ctx) => new CliAdapter(spec).buildInvocation(c).args;
  const claude = args(CLAUDE);
  assert.equal(claude[claude.indexOf('--effort') + 1], 'high');
  const codex = args(CODEX);
  assert.equal(codex[codex.indexOf('-c') + 1], 'model_reasoning_effort=high');
  assert.equal(codex.at(-1), '-', 'stdin marker stays last');
  for (const spec of [AGY, CURSOR]) assert.ok(!args(spec).some((a) => /effort/.test(a)), spec.id);
  for (const spec of [CLAUDE, CODEX]) assert.ok(!args(spec, { ...ctx, effort: null as never }).some((a) => /effort/.test(a)), `${spec.id}: no flag without an effort`);
  const plugin = pluginAdapter(validatePlugin({ id: 'xcli', name: 'X', bin: 'xcli', args: { base: ['run'], effort: ['--think', '{effort}'] }, events: [{ match: { type: 'done' }, kind: 'result' }] }));
  assert.deepEqual(plugin.buildInvocation(ctx).args, ['run', '--think', 'high']);
});

test('planner output: category and complexity are kept, unknown values fall back to backend/medium', () => {
  const r = validatePlan({ tasks: [{ key: 'a', title: 'A', category: 'ui_visual', complexity: 'high' }, { key: 'b', title: 'B', category: 'magic', complexity: 'extreme' }, { key: 'c', title: 'C' }] }, new Set(), 10);
  assert.ok(r.ok);
  assert.deepEqual(r.plan.tasks.map((t) => [t.category, t.complexity]), [['ui_visual', 'high'], ['backend', 'medium'], ['backend', 'medium']]);
});

/** The mock process under a real agent's id, so the matrix can be exercised end to end without calling any AI. */
class Fake extends MockAdapter {
  override readonly id: string;
  override readonly mock = false as never;
  constructor(id: string) { super(); this.id = id; }
}

test('escalation: a failed attempt goes to the next link; the task stays auto; runs record agent, model and effort', async () => {
  const { orch, project } = await setup({ adapters: [new MockAdapter(), new Fake('claude'), new Fake('codex'), new Fake('agy')] });
  try {
    assert.throws(() => orch.createTask(project.id, { title: 'x', category: 'magic' }), /category must be one of/);
    assert.throws(() => orch.createTask(project.id, { title: 'x', effort: 'ultra' }), /effort must be one of/);
    const t = orch.createTask(project.id, { title: 'esc', provider: 'auto', category: 'backend', complexity: 'medium', allowedPaths: ['b/**'],
      description: mock({ failAttempts: 1, write: { 'b/b.txt': 'B' } }) });
    assert.equal(t.maxAttempts, 3, 'auto tasks get 3 attempts: one per link');
    orch.submit(t.id);
    const done = await waitStatus(orch, t.id, ['review']);
    assert.equal(done.provider, 'auto', 'the task keeps auto so the next attempt can escalate');
    const runs = orch.store.runsForTask(t.id);
    assert.deepEqual(runs.map((r) => [r.provider, r.model, r.effort, r.status]), [['codex', 'gpt-6.1-sol', 'high', 'failed'], ['claude', 'sonnet', 'high', 'succeeded']]);
    assert.deepEqual(runs.map((r) => [r.category, r.complexity]), [['backend', 'medium'], ['backend', 'medium']]);
    const routed = orch.store.events({ taskId: t.id, type: 'task.routed' }).map((e) => e.data as { provider: string; link: number; of: number });
    assert.deepEqual(routed.map((r) => [r.provider, r.link, r.of]), [['codex', 1, 3], ['claude', 2, 3]]);

    // Codex marked "cannot write": a write task starts from fallback 1; an effort written into the task wins over the table
    orch.store.setSetting('agentReadOnly', { codex: true });
    const t2 = orch.createTask(project.id, { title: 'ro', provider: 'auto', category: 'backend', complexity: 'low', effort: 'low', allowedPaths: ['c/**'], description: mock({ write: { 'c/c.txt': 'C' } }) });
    orch.submit(t2.id);
    await waitStatus(orch, t2.id, ['review']);
    assert.deepEqual(orch.store.runsForTask(t2.id).map((r) => [r.provider, r.model, r.effort]), [['claude', 'haiku', 'low']]);

    // no category: the old provider order still works (and skips the read-only agent for a write task)
    const t3 = orch.createTask(project.id, { title: 'old', provider: 'auto', allowedPaths: ['d/**'], description: mock({ write: { 'd/d.txt': 'D' } }) });
    orch.submit(t3.id);
    assert.equal((await waitStatus(orch, t3.id, ['review'])).provider, 'claude');

    const stats = modelStats(orch.store);
    const sol = stats.find((s) => s.agent === 'codex')!;
    assert.deepEqual([sol.category, sol.complexity, sol.model, sol.effort, sol.runs, sol.succeeded, sol.firstTry], ['backend', 'medium', 'gpt-6.1-sol', 'high', 1, 0, 0]);
    assert.equal(stats.find((s) => s.model === 'sonnet')!.succeeded, 1);
  } finally { await orch.stop(); }
});

test('usage limit: the agent is paused, the attempt is not counted, the next link takes over; an explicit agent hands over; all paused = wait', async () => {
  const { orch, project } = await setup({ adapters: [new MockAdapter(), new Fake('claude'), new Fake('codex'), new Fake('agy')] });
  try {
    const t = orch.createTask(project.id, { title: 'lim', provider: 'auto', category: 'backend', complexity: 'medium', allowedPaths: ['b/**'],
      description: mock({ limitModels: ['gpt-6.1-sol'], write: { 'b/b.txt': 'B' } }) });
    orch.submit(t.id);
    const done = await waitStatus(orch, t.id, ['review']);
    assert.deepEqual(orch.store.runsForTask(t.id).map((r) => [r.provider, r.status]), [['codex', 'failed'], ['claude', 'succeeded']]);
    assert.equal(done.attempts, 1, 'the limit attempt is not counted');
    assert.equal(done.artifacts.limitHandovers, 1);
    const p = orch.pauses().codex!;
    assert.ok(p && new Date(p.until).getTime() - Date.now() > 100 * 60_000, 'paused for ~2 hours, as the message said');
    const st = (await orch.registry.status()).find((s) => s.id === 'codex')!;
    assert.equal(st.available, false);
    assert.equal(st.paused?.until, p.until);
    assert.equal(orch.store.events({ type: 'agent.paused' }).length, 1);

    // an explicitly chosen agent that is paused: the task goes to the best link that is not
    const t2 = orch.createTask(project.id, { title: 'explicit', provider: 'codex', category: 'backend', complexity: 'medium', allowedPaths: ['c/**'], description: mock({ write: { 'c/c.txt': 'C' } }) });
    orch.submit(t2.id);
    await waitStatus(orch, t2.id, ['review']);
    assert.deepEqual(orch.store.runsForTask(t2.id).map((r) => [r.provider, r.model]), [['claude', 'sonnet']]);

    // every agent paused: the task waits in the queue until the earliest pause ends, it does not fail
    const soon = new Date(Date.now() + 30 * 60_000).toISOString();
    orch.pauseAgent('claude', { until: soon, reason: 'test' });
    orch.pauseAgent('agy', { until: new Date(Date.now() + 90 * 60_000).toISOString(), reason: 'test' });
    const t3 = orch.createTask(project.id, { title: 'wait', provider: 'auto', category: 'backend', complexity: 'low', allowedPaths: ['d/**'], description: mock({}) });
    orch.submit(t3.id);
    await waitFor(() => orch.store.events({ taskId: t3.id, type: 'task.waiting' }).length > 0, 5000, 'task.waiting');
    const w = orch.store.getTask(t3.id);
    assert.equal(w.status, 'queued');
    assert.equal(w.notBefore, soon);
    // the human lifts a pause: the agent is usable again
    orch.resumeAgent('claude');
    assert.equal(orch.pauses().claude, undefined);
    assert.equal((await orch.registry.status()).find((s) => s.id === 'claude')!.available, true);
  } finally { await orch.stop(); }
});
