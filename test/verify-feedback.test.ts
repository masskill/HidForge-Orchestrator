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
