// A repair attempt works on the current base branch: what was merged meanwhile (e.g. an Integrator fix) is brought in first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { setup, mock, waitStatus } from './helpers.ts';
import { git } from '../src/workspace.ts';

test('a retry after the base branch moved merges the base into the task branch first', async () => {
  const { orch, project, repo } = await setup();
  try {
    const t = orch.createTask(project.id, { title: 'r', provider: 'mock', maxAttempts: 1, allowedPaths: ['r/**'], description: mock({ failAttempts: 1, write: { 'r/r.txt': 'R' } }) });
    orch.submit(t.id);
    await waitStatus(orch, t.id, ['failed']);
    writeFileSync(path.join(repo, 'fix.txt'), 'merged meanwhile');
    await git(repo, ['add', '-A']);
    await git(repo, ['commit', '-q', '-m', 'fix on main']);
    orch.retry(t.id);
    const r = await waitStatus(orch, t.id, ['review', 'blocked', 'failed']);
    assert.equal(r.status, 'review', JSON.stringify(r.evidence.map((e) => e.summary)));
    assert.ok(r.evidence.some((e) => e.kind === 'integration' && e.summary === 'Base merged into task branch cleanly'));
    assert.ok(existsSync(path.join(r.workspace!, 'fix.txt')), 'the fix from main is in the worktree');
    assert.match(orch.store.getTask(t.id).evidence.find((e) => e.kind === 'changes' && e.ok && e.summary !== '0 file(s) changed')!.detail ?? '', /^r\/r\.txt$/m);
  } finally { await orch.stop(); }
});

test('work left by an interrupted attempt does not make the base merge fail silently (base files never count as task changes)', async () => {
  const { orch, project, repo } = await setup();
  try {
    const t = orch.createTask(project.id, { title: 'wip', provider: 'mock', maxAttempts: 1, allowedPaths: ['r/**'], description: mock({ failAttempts: 1, write: { 'r/r.txt': 'R' } }) });
    orch.submit(t.id);
    const f = await waitStatus(orch, t.id, ['failed']);
    mkdirSync(path.join(f.workspace!, 'r'), { recursive: true });
    writeFileSync(path.join(f.workspace!, 'r', 'r.txt'), 'left by an interrupted attempt'); // uncommitted
    mkdirSync(path.join(repo, 'r'), { recursive: true });
    writeFileSync(path.join(repo, 'r', 'r.txt'), 'from main');
    writeFileSync(path.join(repo, 'main-only.txt'), 'merged meanwhile by another task');
    await git(repo, ['add', '-A']); await git(repo, ['commit', '-q', '-m', 'main moved']);
    orch.retry(t.id);
    const r = await waitStatus(orch, t.id, ['review', 'blocked', 'failed']);
    assert.equal(r.status, 'review', JSON.stringify(r.evidence.map((e) => e.summary)));
    const changed = r.evidence.filter((e) => e.kind === 'changes').at(-1)!.detail ?? '';
    assert.doesNotMatch(changed, /main-only\.txt/, 'a file merged into main is not a change of the task');
    assert.ok(existsSync(path.join(r.workspace!, 'main-only.txt')), 'the base really was merged in');
  } finally { await orch.stop(); }
});
