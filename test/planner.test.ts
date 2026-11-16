import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { existsSync, readdirSync } from 'node:fs';
import { parsePlan, buildPlanPrompt } from '../src/planner.ts';
import { Orchestrator } from '../src/orchestrator.ts';
import { isAlive } from '../src/proc.ts';
import { createServer } from '../src/server.ts';
import { BadRequest, Conflict } from '../src/store.ts';
import { setup, mock, waitFor, waitStatus } from './helpers.ts';

const FENCE = '`'.repeat(3);
const wrap = (o: unknown) => `Here is the plan:\n${FENCE}json\n${JSON.stringify(o)}\n${FENCE}\nDone.`;
const T = (key: string, extra: object = {}) => ({ key, title: `Task ${key}`, role: 'Backend', allowedPaths: [`src/${key}/**`], ...extra });

test('parsePlan: fenced JSON, key deps, existing-id deps, defaults', () => {
  const r = parsePlan([wrap({ summary: 's', tasks: [T('a'), T('b', { dependsOn: ['a', 7], role: 'Wizard', readOnly: true })] })], new Set([7]), 10);
  assert.ok(r.ok, !r.ok ? r.error : '');
  if (!r.ok) return;
  assert.deepEqual(r.plan.tasks[1]!.dependsOn, ['a', 7]);
  assert.equal(r.plan.tasks[1]!.role, 'Backend', 'unknown role falls back');
  assert.equal(r.plan.tasks[1]!.policy, 'read-only');
});

test('parsePlan rejects invalid plans', () => {
  const bad = (o: unknown, re: RegExp, maxTasks = 10) => {
    const r = parsePlan([typeof o === 'string' ? o : wrap(o)], new Set([1]), maxTasks);
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, re);
  };
  bad('not json at all', /could not parse JSON/);
  bad({ tasks: [] }, /no tasks/);
  bad({ tasks: [T('a', { dependsOn: ['b'] }), T('b', { dependsOn: ['a'] })] }, /cycle/);
  bad({ tasks: [T('a', { dependsOn: ['zzz'] })] }, /unknown "zzz"/);
  bad({ tasks: [T('a', { dependsOn: [99] })] }, /unknown "99"/);
  bad({ tasks: [T('a'), T('a')] }, /duplicate/);
  bad({ tasks: [T('a', { allowedPaths: ['../outside/**'] })] }, /unsafe allowedPaths/);
  bad({ tasks: [T('a', { allowedPaths: ['C:/Windows/**'] })] }, /unsafe allowedPaths/);
  bad({ tasks: [T('a', { verifyCommands: ['git push origin main'] })] }, /forbidden verify command/);
  bad({ tasks: [T('a'), T('b'), T('c')] }, /limit is 2/, 2);
  bad({ tasks: [{ key: 'x' }] }, /no title/);
});

test('parsePlan falls back to joined stream deltas (agy/codex style)', () => {
  const full = wrap({ tasks: [T('a')] });
  const r = parsePlan(['turn completed', full.slice(0, 20) + full.slice(20)], new Set(), 5);
  assert.ok(r.ok);
});

test('plan prompt is read-only and lists existing tasks', async () => {
  const p = { id: 1, name: 'x', repoPath: '.', baseBranch: 'main', goal: 'Build it', allowedCommands: [], createdAt: '' };
  const s = buildPlanPrompt(p, [{ id: 3, status: 'merged', title: 'Old', allowedPaths: ['a/**'] } as never], 5, ['src/дані.ts']);
  assert.match(s, /- src\/дані\.ts/);
  assert.match(s, /Do not run shell commands/);
  assert.match(s, /READ-ONLY planning session/);
  assert.match(s, /#3 \[merged\] Old/);
  assert.match(s, /at most 5 small tasks/);
});

test('mock planner: goal -> plan -> apply -> draft DAG that runs', async () => {
  const { orch, project, repo, dataDir } = await setup();
  try {
    orch.store.updateProject(project.id, { goal: '' });
    await assert.rejects(orch.planner.start(project.id, { provider: 'mock' }), BadRequest, 'goal is required');
    orch.store.updateProject(project.id, { goal: 'Build an items app with backend and frontend' });
    const plan = await orch.planner.start(project.id, { provider: 'mock' });
    await assert.rejects(orch.planner.start(project.id, { provider: 'mock' }), Conflict, 'one planner per project');
    const done = await waitFor(() => { const p = orch.store.getPlan(plan.id); return p.status !== 'running' ? p : null; }, 15_000, 'plan finished');
    await orch.idle();
    assert.equal(done.status, 'succeeded', String(done.error));
    assert.equal(done.plan!.tasks.length, 4);
    assert.ok(orch.store.events({ projectId: project.id }).some((e) => e.type === 'plan.output'), 'planner output streamed as events');
    assert.equal(readdirSync(path.join(dataDir, 'planning')).length, 0, 'planning worktree removed');
    assert.equal(orch.store.listTasks(project.id).length, 0, 'nothing created before apply');

    const tasks = orch.planner.apply(plan.id);
    assert.equal(tasks.length, 4);
    assert.ok(tasks.every((t) => t.status === 'draft' && t.provider === 'mock'));
    const byTitle = new Map(tasks.map((t) => [t.title, t]));
    const contract = byTitle.get('Define the API contract')!;
    assert.deepEqual(byTitle.get('Implement the backend')!.dependsOn, [contract.id]);
    assert.deepEqual(byTitle.get('Integration tests')!.dependsOn.sort(), [byTitle.get('Implement the backend')!.id, byTitle.get('Implement the frontend')!.id].sort());
    assert.equal(orch.store.getPlan(plan.id).status, 'applied');
    assert.throws(() => orch.planner.apply(plan.id), Conflict, 'cannot apply twice');

    orch.submitAll(project.id);
    await waitStatus(orch, contract.id, ['review']);
    assert.equal(orch.store.getTask(byTitle.get('Implement the backend')!.id).status, 'ready', 'dependents wait');
    await orch.approve(contract.id);
    assert.ok(existsSync(path.join(repo, 'docs', 'api-contract.md')));
  } finally { await orch.stop(); }
});

test('invalid planner output fails the plan and creates nothing', async () => {
  const { orch, project } = await setup();
  try {
    orch.store.updateProject(project.id, { goal: `Goal ${mock({ planRaw: 'I could not decide, sorry.' })}` });
    const plan = await orch.planner.start(project.id, { provider: 'mock' });
    const done = await waitFor(() => { const p = orch.store.getPlan(plan.id); return p.status !== 'running' ? p : null; }, 15_000);
    assert.equal(done.status, 'failed');
    assert.match(String(done.error), /invalid plan/);
    assert.throws(() => orch.planner.apply(plan.id), Conflict);
    assert.equal(orch.store.listTasks(project.id).length, 0);
    assert.equal(orch.planner.discard(plan.id).status, 'discarded');
  } finally { await orch.stop(); }
});

test('planner: cancel kills it; restart marks an orphaned planner failed', async () => {
  const { orch, project, dataDir } = await setup();
  orch.store.updateProject(project.id, { goal: `Goal ${mock({ mode: 'hang' })}` });
  const p1 = await orch.planner.start(project.id, { provider: 'mock' });
  await waitFor(() => orch.store.getPlan(p1.id).pid, 10_000, 'pid');
  assert.equal((await orch.planner.cancel(p1.id)).status, 'canceled');

  const p2 = await orch.planner.start(project.id, { provider: 'mock' });
  const pid = await waitFor(() => orch.store.getPlan(p2.id).pid, 10_000, 'pid');
  await orch.crashForTest();
  assert.ok(isAlive(pid));
  const orch2 = new Orchestrator({ dataDir, tickMs: 40, backoffMs: 0 });
  try {
    await orch2.start();
    const after = orch2.store.getPlan(p2.id);
    assert.equal(after.status, 'failed');
    assert.match(String(after.error), /restart/);
    await waitFor(() => !isAlive(pid), 10_000, 'orphan planner killed');
    assert.equal(orch2.store.runningPlans().length, 0);
  } finally { await orch2.stop(); }
});

test('planner HTTP API: start, read, apply', async () => {
  const { orch, project } = await setup();
  const srv = createServer(orch, { port: 0, webDir: path.resolve('web'), token: 't' });
  const base = `http://127.0.0.1:${await srv.listen()}`;
  const post = (u: string, body: object = {}) => fetch(base + u, { method: 'POST', headers: { 'x-hidforge-token': 't' }, body: JSON.stringify(body) });
  try {
    const plan = await (await post(`/api/projects/${project.id}/plans`, { provider: 'mock', maxTasks: 6 })).json() as { id: number };
    const done = await waitFor(() => { const p = orch.store.getPlan(plan.id); return p.status !== 'running' ? p : null; }, 15_000);
    assert.equal(done.status, 'succeeded');
    const list = await (await fetch(`${base}/api/projects/${project.id}/plans`)).json() as { id: number }[];
    assert.equal(list[0]!.id, plan.id);
    const tasks = await (await post(`/api/plans/${plan.id}/apply`)).json() as unknown[];
    assert.equal(tasks.length, 4);
    assert.equal((await post(`/api/projects/${project.id}/plans`, { provider: 'nope' })).status, 400);
  } finally { await srv.close(); await orch.stop(); }
});
