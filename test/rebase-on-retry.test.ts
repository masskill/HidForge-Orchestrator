// A repair attempt works on the current base branch: what was merged meanwhile (e.g. an Integrator fix) is brought in first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { existsSync, writeFileSync } from 'node:fs';
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
