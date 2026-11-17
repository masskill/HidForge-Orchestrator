// The repair attempt sees why the check failed (the agent often cannot run the check itself).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyFeedback } from '../src/orchestrator.ts';

test('failed check feedback carries its error lines, else its tail', () => {
  const out = 'Progress: resolved 448\nsrc/a.ts(3,1): error TS2345: bad type\n[ELIFECYCLE] Command failed with exit code 2.\nDone';
  const f = verifyFeedback('pnpm check', { code: 2, out });
  assert.match(f, /^verification failed: pnpm check \(exit 2\)/);
  assert.match(f, /error TS2345: bad type/);
  assert.doesNotMatch(f, /Progress|ELIFECYCLE/);
  assert.match(verifyFeedback('x', { code: 1, out: 'just some output' }), /last lines\):\njust some output$/);
});

test('a failed check blocks with its errors in the feedback; a manual retry keeps them', async () => {
  const { setup, mock, waitStatus } = await import('./helpers.ts');
  const { orch, project } = await setup();
  try {
    const cmd = 'node -e "console.log(\'src/x.ts: error TS1: boom\'), process.exit(3)"';
    orch.store.updateProject(project.id, { allowedCommands: [cmd] });
    const t = orch.createTask(project.id, { title: 'v', maxAttempts: 1, allowedPaths: ['v/**'], verifyCommands: [cmd], description: mock({ write: { 'v/v.txt': 'V' } }) });
    orch.submit(t.id);
    const b = await waitStatus(orch, t.id, ['blocked']);
    assert.match(b.feedback ?? '', /error TS1: boom/);
    orch.store.patchTask(t.id, { feedback: `verification failed: ${cmd} (exit 3)` }); // as recorded before this change
    const r = orch.retry(t.id);
    assert.match(r.feedback ?? '', /error TS1: boom/);
  } finally { await orch.stop(); }
});
