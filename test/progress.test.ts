// Project plan view (stages, approximate %) and project deletion.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { stageOf, projectPlan } from '../src/progress.ts';
import { git } from '../src/workspace.ts';
import { setup, mock, waitStatus } from './helpers.ts';

test('stages follow the longest dependency chain', () => {
  const s = stageOf([{ id: 1, dependsOn: [] }, { id: 2, dependsOn: [] }, { id: 3, dependsOn: [1] }, { id: 4, dependsOn: [3, 2] }, { id: 5, dependsOn: [99] }]);
  assert.deepEqual([1, 2, 3, 4, 5].map((i) => s.get(i)), [1, 1, 2, 3, 1]);
});

test('plan view: weighted % per stage and overall; current stage; agent of the last run', async () => {
  const { orch, project } = await setup();
  try {
    const a = orch.createTask(project.id, { title: 'a', provider: 'mock', complexity: 'high', allowedPaths: ['a/**'], description: mock({ write: { 'a/a.txt': 'A' } }) });
    const b = orch.createTask(project.id, { title: 'b', provider: 'mock', complexity: 'low', dependsOn: [a.id] });
    orch.submit(a.id);
    await waitStatus(orch, a.id, ['review']);
    const v = await projectPlan(orch, project.id);
    assert.equal(v.stages.length, 2);
    assert.deepEqual(v.stages.map((s) => [s.n, s.pct, s.current]), [[1, 75, true], [2, 0, false]]);
    // weights: a (high, 3) at 75%, b (low, 1) at 0% -> 56%
    assert.equal(v.pct, 56);
    assert.equal(v.currentStage, 1);
    assert.deepEqual(v.stages[0]!.tasks[0]!.agent, { provider: 'mock', model: null, effort: null, source: 'last' });
    assert.equal(v.stages[1]!.tasks[0]!.id, b.id);
  } finally { await orch.stop(); }
});

test('deleting a project removes its records and worktrees, keeps the repository and task branches; refused while a task runs', async () => {
  const { orch, project, repo } = await setup();
  try {
    const t = orch.createTask(project.id, { title: 'w', provider: 'mock', allowedPaths: ['w/**'], description: mock({ write: { 'w/w.txt': 'W' } }) });
    const slow = orch.createTask(project.id, { title: 'slow', provider: 'mock', allowedPaths: ['s/**'], description: mock({ sleepMs: 4000, write: { 's/s.txt': 'S' } }) });
    orch.submit(t.id); orch.submit(slow.id);
    const done = await waitStatus(orch, t.id, ['review']);
    await waitStatus(orch, slow.id, ['running']);
    await assert.rejects(orch.deleteProject(project.id), /stop the running or queued tasks first/);
    await orch.cancel(slow.id);
    const r = await orch.deleteProject(project.id);
    assert.ok(r.removedWorktrees >= 1);
    assert.ok(r.keptBranches.includes(done.branch!));
    assert.throws(() => orch.store.getProject(project.id), /not found|project/);
    assert.equal(orch.store.events({ projectId: project.id }).length, 0);
    assert.equal(orch.store.events({ taskId: t.id }).length, 0);
    assert.ok(!existsSync(done.workspace!), 'worktree removed');
    assert.ok(existsSync(repo), 'repository untouched');
    assert.equal((await git(repo, ['rev-parse', '--verify', done.branch!])).code, 0, 'task branch kept');
  } finally { await orch.stop(); }
});
