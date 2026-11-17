// Full autopilot: after the owner accepts a plan nothing waits for them — conflicts, a broken base branch and restarts are handled.
import { test } from 'node:test';
import path from 'node:path';
import { writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { setup, mock, waitFor, waitStatus } from './helpers.ts';
import { normalizeReviewPolicy } from '../src/reviewer.ts';
import { git } from '../src/workspace.ts';

const policy = (o: object) => normalizeReviewPolicy({ provider: 'mock', ...o }, () => true);

test('auto-fix: a merge conflict goes back to the agent by itself; a broken base gets one Integrator that starts by itself', async () => {
  const { orch, project, repo } = await setup();
  try {
    orch.store.updateProject(project.id, { reviewPolicy: policy({ mode: 'off', autoFix: true }) });
    // two tasks change the same file: the second merge conflicts and is repaired without the owner
    const c = orch.createTask(project.id, { title: 'c', provider: 'mock', allowedPaths: ['c/**'], description: mock({ write: { 'c/x.txt': 'C' } }) });
    const d = orch.createTask(project.id, { title: 'd', provider: 'mock', allowedPaths: ['c/**'], description: mock({ write: { 'c/x.txt': 'D' } }) });
    orch.submit(c.id); orch.submit(d.id);
    await waitStatus(orch, c.id, ['review']); await waitStatus(orch, d.id, ['review']);
    await orch.approve(c.id);
    assert.equal((await orch.approve(d.id)).status, 'queued', 'the conflict is sent back for repair at once');
    const dr = await waitStatus(orch, d.id, ['review', 'blocked', 'failed']);
    assert.equal(dr.status, 'review', JSON.stringify(dr.evidence.map((e) => e.summary)));
    assert.ok(dr.evidence.some((e) => /^Auto-fix: the conflict goes back/.test(e.summary)));

    // checks pass in the task worktrees but fail on main after the merge (main broke meanwhile)
    const cmd = 'node -e "process.exit(require(\'fs\').existsSync(\'broken.txt\') ? 1 : 0)"';
    orch.store.updateProject(project.id, { allowedCommands: [cmd] });
    const a = orch.createTask(project.id, { title: 'a', provider: 'mock', allowedPaths: ['a/**'], verifyCommands: [cmd], description: mock({ write: { 'a/a.txt': 'A' } }) });
    const b = orch.createTask(project.id, { title: 'b', provider: 'mock', allowedPaths: ['b/**'], verifyCommands: [cmd], description: mock({ write: { 'b/b.txt': 'B' } }) });
    orch.submit(a.id); orch.submit(b.id);
    await waitStatus(orch, a.id, ['review']); await waitStatus(orch, b.id, ['review']);
    await orch.approve(d.id);
    writeFileSync(path.join(repo, 'broken.txt'), 'x');
    await git(repo, ['add', '-A']); await git(repo, ['commit', '-q', '-m', 'break main']);
    await orch.approve(a.id);
    await orch.approve(b.id);
    const its = orch.store.listTasks(project.id).filter((t) => t.assignedRole === 'Integrator');
    assert.equal(its.length, 1, 'one Integrator for one broken base');
    assert.notEqual(its[0]!.status, 'draft', 'it starts by itself under auto-fix');
    assert.equal(its[0]!.category, 'bugfix');
    assert.equal(orch.store.getTask(b.id).artifacts.integratorTaskId, its[0]!.id);
  } finally { await orch.stop(); }
});

test('auto-answer: an accepted plan starts at once; a diagnosis interrupted by a restart is diagnosed again, never twice at once', async () => {
  const { orch, project } = await setup();
  try {
    orch.store.updateProject(project.id, { goal: 'Build an items app with backend and frontend', reviewPolicy: policy({ mode: 'off', autoAnswer: true }) });
    const plan = await orch.planner.start(project.id, { provider: 'mock' });
    await waitFor(() => orch.store.getPlan(plan.id).status === 'succeeded', 15_000, 'plan');
    const tasks = orch.planner.apply(plan.id);
    assert.ok(tasks.length && tasks.every((t) => t.status !== 'draft'), 'nothing left as a draft');

    const t = orch.createTask(project.id, { title: 'x', provider: 'mock', maxAttempts: 1, allowedPaths: ['x/**'], description: mock({ failAttempts: 9 }) });
    orch.store.patchTask(t.id, { artifacts: { doctor: { status: 'running', at: new Date().toISOString(), provider: 'mock', model: null } } });
    orch.doctor.recover();
    assert.equal((orch.store.getTask(t.id).artifacts.doctor as { status: string }).status, 'failed');
    orch.store.patchTask(t.id, { artifacts: {} });
    orch.submit(t.id);
    await waitStatus(orch, t.id, ['failed']);
    await orch.doctor.maybeStart(t.id); await orch.doctor.maybeStart(t.id); // a second start while one is queued must not throw
  } finally { await orch.stop(); }
});

test('a diagnosis with unescaped Windows paths in its JSON still parses', async () => {
  const { extractJson } = await import('../src/oneshot.ts');
  const raw = String.raw`{"action":"retry","feedback":"use C:\Users\x and \d, keep \Server and a\nb"}`;
  assert.deepEqual(extractJson(raw), { action: 'retry', feedback: String.raw`use C:\Users\x and \d, keep \Server and a` + '\nb' });
  assert.throws(() => extractJson('{"a": }'));
});

test('auto-fix may give a task that must edit files a writable role', async () => {
  const { parseAdvice } = await import('../src/doctor.ts');
  const a = parseAdvice({ action: 'retry', explanation: 'x', changes: { assignedRole: '', policy: 'workspace-write' } });
  assert.deepEqual(a.changes, { assignedRole: '', policy: 'workspace-write' });
  assert.deepEqual(parseAdvice({ action: 'retry', explanation: 'x', changes: { assignedRole: 'Boss', policy: 'workspace-write' } }).changes, {}, 'unknown roles are ignored');
});
