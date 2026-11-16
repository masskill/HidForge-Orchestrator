// Spend limits, cost summary, model lists, Cursor launch/trust flags.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { CliAdapter, CLAUDE, CURSOR, MODEL_LINE, parseModelList } from '../src/adapters/cli.ts';
import { projectCosts, projectRuns, usageTokens } from '../src/costs.ts';
import { createServer } from '../src/server.ts';
import { setup, mock, waitStatus } from './helpers.ts';

const ctx = { prompt: 'p', workspace: 'w', model: null, policy: 'workspace-write' as const };

test('claude gets --max-budget-usd only when a task budget is set', () => {
  const c = new CliAdapter(CLAUDE);
  assert.ok(!c.buildInvocation(ctx).args.includes('--max-budget-usd'));
  const a = c.buildInvocation({ ...ctx, maxBudgetUsd: 0.5 }).args;
  assert.equal(a[a.indexOf('--max-budget-usd') + 1], '0.5');
});

test('cursor: --trust only on explicit opt-in, plan mode for read-only, trust prompt becomes a clear error', () => {
  const c = new CliAdapter(CURSOR);
  const forbidden = ['--trust', '--force', '-f', '--yolo'];
  assert.ok(!c.buildInvocation(ctx).args.some((x) => forbidden.includes(x)), 'no trust/bypass by default');
  assert.ok(c.buildInvocation({ ...ctx, trustWorkspace: true }).args.includes('--trust'));
  assert.ok(!c.buildInvocation({ ...ctx, trustWorkspace: true }).args.some((x) => ['--force', '-f', '--yolo'].includes(x)), 'never bypass');
  const ro = c.buildInvocation({ ...ctx, policy: 'read-only' }).args;
  assert.equal(ro[ro.indexOf('--mode') + 1], 'plan');
  const ev = c.parseLine('⚠ Workspace Trust Required');
  assert.equal(ev?.kind, 'error');
  assert.match(ev!.text, /Settings/);
});

test('model lists are parsed from the CLI output formats', () => {
  assert.deepEqual(parseModelList('Fetching available models...\ngemini-4-argon-high\tGemini 4 Argon (High)\n', MODEL_LINE.agy),
    [{ id: 'gemini-4-argon-high', label: 'Gemini 4 Argon (High)' }]);
  assert.deepEqual(parseModelList('Available models\n\nauto - Auto (default)\ngpt-5.3-codex - Codex 5.3\n', MODEL_LINE.cursor),
    [{ id: 'auto', label: 'Auto (default)' }, { id: 'gpt-5.3-codex', label: 'Codex 5.3' }]);
});

test('project budget: spend is summed from reported costs and stops new runs once exhausted', async () => {
  const { orch, project } = await setup();
  try {
    orch.store.updateProject(project.id, { budgetUsd: 0.05 });
    const a = orch.createTask(project.id, { title: 'A', allowedPaths: ['a/**'], description: mock({ costUsd: 0.06, write: { 'a/a.txt': 'A' } }) });
    orch.submit(a.id);
    await waitStatus(orch, a.id, ['review']);
    const c = projectCosts(orch.store, project.id);
    assert.equal(c.totalUsd, 0.06);
    assert.equal(c.remainingUsd, 0);
    assert.equal(c.byProvider[0]!.provider, 'mock');
    assert.equal(c.byKind.task, 0.06);
    const b = orch.createTask(project.id, { title: 'B', allowedPaths: ['b/**'], description: mock({ write: { 'b/b.txt': 'B' } }) });
    orch.submit(b.id);
    const tb = await waitStatus(orch, b.id, ['failed']);
    assert.match(tb.evidence.at(-1)!.summary, /budget exhausted/);
    assert.equal(orch.store.runsForTask(b.id).length, 0, 'no run was started');
    orch.store.updateProject(project.id, { budgetUsd: 1 });
    orch.retry(b.id);
    await waitStatus(orch, b.id, ['review']);
  } finally { await orch.stop(); }
});

test('costs/budget/models HTTP API', async () => {
  const { orch, project } = await setup();
  const srv = createServer(orch, { port: 0, webDir: path.resolve('web'), token: 't' });
  const base = `http://127.0.0.1:${await srv.listen()}`;
  const call = (method: string, u: string, body?: object) => fetch(base + u, { method, headers: { 'x-hidforge-token': 't' }, body: body && JSON.stringify(body) });
  try {
    assert.equal((await call('PATCH', `/api/projects/${project.id}`, { budgetUsd: -1 })).status, 400);
    assert.equal(((await (await call('PATCH', `/api/projects/${project.id}`, { budgetUsd: 2.5 })).json()) as { budgetUsd: number }).budgetUsd, 2.5);
    const c = await (await call('GET', `/api/projects/${project.id}/costs`)).json() as { budgetUsd: number; totalUsd: number };
    assert.deepEqual([c.budgetUsd, c.totalUsd], [2.5, 0]);
    assert.deepEqual(await (await call('GET', '/api/agents/mock/models')).json(), []);
    assert.equal((await fetch(base + '/api/agents/mock/models')).status, 403, 'model listing spawns a CLI: needs the token');
    assert.equal((await fetch(base + '/api/agents?refresh=1')).status, 403);
    assert.equal((await fetch(base + '/api/agents')).status, 200, 'cached status stays readable');
    const bad = await call('POST', `/api/projects/${project.id}/tasks`, { title: 'x', model: '--dangerously-skip-permissions' });
    assert.equal(bad.status, 400, 'a model that looks like a flag is rejected');
    const ok = await (await call('POST', `/api/projects/${project.id}/tasks`, { title: 'y', model: 'gpt-5.1-codex[high]' })).json() as { model: string };
    assert.equal(ok.model, 'gpt-5.1-codex[high]');
    assert.equal((await call('GET', '/api/agents/nope/models')).status, 400);
    const st = await (await call('PUT', '/api/settings', { agentTrust: { cursor: true, bogus: true } })).json() as { agentTrust: object };
    assert.deepEqual(st.agentTrust, { cursor: true });
    assert.equal(orch.trusts('cursor'), true);
    assert.equal(orch.trusts('claude'), false);
    for (const u of [`/api/projects/${project.id}/runs?limit=abc`, '/api/events?before=x', '/api/events?after=NaN'])
      assert.equal((await call('GET', u)).status, 400, `${u}: bad number is a 400, not a 500`);
  } finally { await srv.close(); await orch.stop(); }
});

test('usage tokens are read from snake_case and camelCase (Cursor) reports', () => {
  assert.deepEqual(usageTokens({ inputTokens: 10, outputTokens: 4, cacheReadTokens: 5, cacheWriteTokens: 1, reasoningTokens: 3 }), { input: 16, output: 4, usd: null });
  assert.deepEqual(usageTokens({ input_tokens: 2, cache_read_input_tokens: 3, output_tokens: 1, total_cost_usd: 0.01 }), { input: 5, output: 1, usd: 0.01 });
  assert.deepEqual(usageTokens(null), { input: 0, output: 0, usd: null });
});

test('project runs: newest first with task title, duration, cost; paging and filters', async () => {
  const { orch, project } = await setup();
  try {
    const a = orch.createTask(project.id, { title: 'Перша', allowedPaths: ['a/**'], description: mock({ costUsd: 0.02, write: { 'a/a.txt': 'A' } }) });
    const b = orch.createTask(project.id, { title: 'Друга', maxAttempts: 1, description: mock({ mode: 'crash' }) });
    orch.submit(a.id); await waitStatus(orch, a.id, ['review']);
    orch.submit(b.id); await waitStatus(orch, b.id, ['failed']);
    const all = projectRuns(orch.store, project.id);
    assert.deepEqual(all.map((r) => r.taskTitle), ['Друга', 'Перша']);
    assert.equal(all[1]!.usd, 0.02);
    assert.ok(all[1]!.durationMs! >= 0 && all[1]!.status === 'succeeded');
    assert.equal(all[0]!.status, 'failed');
    assert.deepEqual(projectRuns(orch.store, project.id, { before: all[0]!.id }).map((r) => r.id), [all[1]!.id]);
    assert.deepEqual(projectRuns(orch.store, project.id, { status: 'failed' }).map((r) => r.taskTitle), ['Друга']);
    assert.equal(projectRuns(orch.store, project.id, { provider: 'claude' }).length, 0);
    assert.equal(projectRuns(orch.store, project.id, { limit: 1 }).length, 1);
  } finally { await orch.stop(); }
});
