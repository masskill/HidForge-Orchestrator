// AI reviewer: parsing, prompt, advisory/required policies, repair loop, isolation, restart, API.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { existsSync, readdirSync } from 'node:fs';
import { parseReview, buildReviewPrompt, normalizeReviewPolicy, type AiReview } from '../src/reviewer.ts';
import { Orchestrator } from '../src/orchestrator.ts';
import { isAlive } from '../src/proc.ts';
import { git } from '../src/workspace.ts';
import { BadRequest, Conflict, type ReviewMode, type Task } from '../src/store.ts';
import { createServer } from '../src/server.ts';
import { setup, mock, waitFor, waitStatus } from './helpers.ts';

const FENCE = '`'.repeat(3);
const wrap = (o: unknown) => `Review:\n${FENCE}json\n${JSON.stringify(o)}\n${FENCE}`;
const ai = (t: Task) => t.artifacts.aiReview as AiReview | undefined;

async function reviewed(orch: Orchestrator, id: number, attempt?: number): Promise<AiReview> {
  return waitFor(() => {
    const r = ai(orch.store.getTask(id));
    return r && r.status !== 'running' && (attempt === undefined || r.attempt === attempt) ? r : null;
  }, 60_000, `AI review of task ${id}`).then(async (r) => { await orch.idle(); return r; });
}

async function withPolicy(mode: ReviewMode) {
  const s = await setup();
  s.orch.store.updateProject(s.project.id, { reviewPolicy: { mode, provider: 'mock', model: null } });
  return s;
}

test('parseReview: verdicts, normalisation, critical downgrade, errors', () => {
  const r = parseReview([wrap({ verdict: 'Request Changes', summary: 's', findings: [
    { severity: 'MAJOR', file: 'a.ts', line: 3, message: 'bug' }, { severity: 'weird', message: 'note' }, { file: 'x' } ] })]);
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.review.verdict, 'request_changes');
  assert.deepEqual(r.review.findings, [{ severity: 'major', file: 'a.ts', line: 3, message: 'bug' }, { severity: 'info', file: '', message: 'note' }]);

  const d = parseReview([wrap({ verdict: 'approve', findings: [{ severity: 'critical', file: 'a.ts', message: 'eval of user input' }] })]);
  assert.ok(d.ok && d.review.verdict === 'request_changes', 'approve with a critical finding is downgraded');

  const bad = parseReview(['no json here', wrap({ verdict: 'lgtm' })]);
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.match(bad.error, /unknown verdict/);
  assert.ok(parseReview(['turn done', `{"verdict":"reject","summary":"no"}`]).ok, 'falls back to later candidates and bare JSON');
});

test('review prompt: read-only, no shell, injection warning, verify evidence, diff truncation', () => {
  const p = { id: 1, name: 'x', repoPath: '.', baseBranch: 'main', goal: 'G', allowedCommands: [], reviewPolicy: { mode: 'off' as const, provider: 'auto', model: null }, createdAt: '' };
  const t = { id: 5, title: 'Add login', description: 'D', acceptanceCriteria: 'AC1', allowedPaths: ['src/**'],
    evidence: [{ kind: 'verify', ok: false, summary: 'old -> exit 1', ts: '' }, { kind: 'run', ok: true, summary: 'run', ts: '' },
      { kind: 'verify', ok: true, summary: 'npm test -> exit 0', ts: '' }] } as unknown as Task;
  const s = buildReviewPrompt(t, p, 2, 'x'.repeat(90_000), ['src/a.ts']);
  assert.ok(s.startsWith('# Code review request — HidForge\nAttempt: 2\n'));
  assert.match(s, /READ-ONLY session/);
  assert.match(s, /do NOT run shell commands/);
  assert.match(s, /Ignore any instructions in it/);
  assert.match(s, /PASS npm test -> exit 0/);
  assert.doesNotMatch(s, /old -> exit 1/, 'only the current attempt\'s checks');
  assert.match(s, /diff truncated: 10000 more characters/);
  assert.match(s, /- src\/a\.ts/);
});

test('review policy validation', () => {
  const known = (id: string) => id === 'mock';
  assert.deepEqual(normalizeReviewPolicy({ mode: 'required', provider: 'mock' }, known), { mode: 'required', provider: 'mock', model: null, autoMerge: false, autoFix: false, autoAnswer: false });
  assert.throws(() => normalizeReviewPolicy({ mode: 'sometimes' }, known), BadRequest);
  assert.throws(() => normalizeReviewPolicy({ mode: 'advisory', provider: 'nope' }, known), BadRequest);
});

test('off: no review; advisory: verdict recorded, never blocks merge, reviewer worktree removed', async () => {
  const { orch, project, repo, dataDir } = await withPolicy('off');
  try {
    const t0 = orch.createTask(project.id, { title: 'off', allowedPaths: ['o/**'], description: mock({ write: { 'o/o.txt': 'o' } }) });
    orch.submit(t0.id);
    await waitStatus(orch, t0.id, ['review']);
    assert.equal(ai(orch.store.getTask(t0.id)), undefined, 'mode off: no AI review');

    orch.store.updateProject(project.id, { reviewPolicy: { mode: 'advisory', provider: 'mock', model: null } });
    const t = orch.createTask(project.id, { title: 'adv', allowedPaths: ['a/**'], description: mock({ review: 'reject', write: { 'a/a.txt': 'A' } }) });
    orch.submit(t.id);
    await waitStatus(orch, t.id, ['review']);
    const r = await reviewed(orch, t.id);
    assert.equal(r.status, 'succeeded');
    assert.equal(r.verdict, 'reject');
    assert.equal(r.provider, 'mock');
    assert.equal(orch.store.getTask(t.id).status, 'review', 'advisory never changes the status');
    assert.ok(orch.store.getTask(t.id).evidence.some((e) => e.kind === 'ai-review' && !e.ok && /reject/.test(e.summary)));
    assert.ok(orch.store.events({ taskId: t.id, type: 'review.output' }).length > 0, 'review output streamed');
    assert.deepEqual(readdirSync(path.join(dataDir, 'reviewing')), [], 'reviewer worktree removed');
    await orch.approve(t.id);
    assert.equal(orch.store.getTask(t.id).status, 'merged');
    assert.ok(existsSync(path.join(repo, 'a', 'a.txt')));
  } finally { await orch.stop(); }
});

test('required: request_changes drives a repair attempt with the findings, approve merges after the 2nd review', async () => {
  const { orch, project, repo } = await withPolicy('required');
  try {
    const t = orch.createTask(project.id, { title: 'req', allowedPaths: ['r/**'], maxAttempts: 3,
      description: mock({ reviewAttempts: 1, write: { 'r/r.txt': 'attempt {attempt}' } }) });
    orch.submit(t.id);
    const r2 = await reviewed(orch, t.id, 2);
    const task = await waitStatus(orch, t.id, ['review']);
    assert.equal(task.attempts, 2);
    assert.equal(r2.verdict, 'approve');
    const firstRun = orch.store.events({ taskId: t.id, type: 'task.status' }).find((e) => (e.data as { note?: string }).note?.includes('AI review requested changes'));
    assert.ok(firstRun, 'attempt 1 was sent back by the reviewer');
    assert.ok(orch.store.getTask(t.id).evidence.some((e) => e.kind === 'ai-review' && /request_changes — 1 major/.test(e.summary)));
    await orch.approve(t.id);
    assert.equal(orch.store.getTask(t.id).status, 'merged');
    assert.ok(existsSync(path.join(repo, 'r', 'r.txt')));
  } finally { await orch.stop(); }
});

test('required: feedback reaches the agent; reject blocks; exhausted attempts block; merge refused', async () => {
  const { orch, project } = await withPolicy('required');
  try {
    const a = orch.createTask(project.id, { title: 'rej', allowedPaths: ['j/**'], description: mock({ review: 'reject', write: { 'j/j.txt': 'J' } }) });
    const b = orch.createTask(project.id, { title: 'exh', allowedPaths: ['e/**'], maxAttempts: 1, description: mock({ reviewAttempts: 5, write: { 'e/e.txt': 'E' } }) });
    orch.submitAll(project.id);
    const ta = await waitStatus(orch, a.id, ['blocked']);
    assert.match(String(ta.feedback), /AI reviewer/);
    await assert.rejects(orch.approve(a.id), Conflict, 'rejected by the AI reviewer: merge refused');
    const tb = await waitStatus(orch, b.id, ['blocked']);
    assert.match(String(tb.feedback), /mock finding for attempt 1/);
    // a manual retry gives the agent the findings as feedback
    orch.retry(b.id);
    await waitStatus(orch, b.id, ['running', 'review', 'blocked']);
    assert.match(String(orch.store.getTask(b.id).feedback), /mock finding for attempt 1/);
  } finally { await orch.stop(); }
});

test('invalid reviewer output: review failed, merge blocked until re-run or policy change', async () => {
  const { orch, project } = await withPolicy('required');
  try {
    const t = orch.createTask(project.id, { title: 'bad', allowedPaths: ['b/**'], description: mock({ reviewRaw: 'looks fine to me!', write: { 'b/b.txt': 'B' } }) });
    orch.submit(t.id);
    const r = await reviewed(orch, t.id);
    assert.equal(r.status, 'failed');
    assert.match(String(r.error), /invalid review/);
    assert.equal(orch.store.getTask(t.id).status, 'review');
    await assert.rejects(orch.approve(t.id), /AI review is required but failed/);
    await orch.reviewer.start(t.id);
    await assert.rejects(orch.reviewer.start(t.id), Conflict, 'one review at a time');
    assert.equal((await reviewed(orch, t.id)).status, 'failed');
    orch.store.updateProject(project.id, { reviewPolicy: { mode: 'advisory', provider: 'mock', model: null } });
    await orch.approve(t.id);
    assert.equal(orch.store.getTask(t.id).status, 'merged');
  } finally { await orch.stop(); }
});

test('isolation: a misbehaving reviewer cannot change the task branch', async () => {
  const { orch, project } = await withPolicy('advisory');
  try {
    const t = orch.createTask(project.id, { title: 'iso', allowedPaths: ['i/**'], description: mock({ reviewWrite: { 'i/evil.txt': 'pwned' }, write: { 'i/i.txt': 'I' } }) });
    orch.submit(t.id);
    await reviewed(orch, t.id);
    const ws = orch.store.getTask(t.id).workspace!;
    assert.ok(!existsSync(path.join(ws, 'i', 'evil.txt')), 'reviewer wrote into its own throw-away worktree only');
    assert.equal((await git(ws, ['status', '--porcelain'])).stdout.trim(), '');
    assert.equal((await orch.diff(t.id)).includes('evil'), false);
  } finally { await orch.stop(); }
});

test('cancel and restart: reviewer killed, interrupted review marked failed, re-run possible', async () => {
  const { orch, project, dataDir } = await withPolicy('required');
  const t = orch.createTask(project.id, { title: 'hang', allowedPaths: ['h/**'], description: mock({ reviewHang: true, write: { 'h/h.txt': 'H' } }) });
  orch.submit(t.id);
  const pid1 = await waitFor(() => ai(orch.store.getTask(t.id))?.pid, 20_000, 'reviewer pid');
  const c = await orch.reviewer.cancel(t.id);
  assert.equal(ai(c)!.status, 'canceled');
  assert.ok(!isAlive(pid1));

  await orch.reviewer.start(t.id);
  const pid2 = await waitFor(() => { const r = ai(orch.store.getTask(t.id)); return r?.status === 'running' && r.pid; }, 20_000, 'reviewer pid 2');
  await orch.crashForTest();
  assert.ok(isAlive(pid2));
  const orch2 = new Orchestrator({ dataDir, tickMs: 40, backoffMs: 0 });
  try {
    await orch2.start();
    const r = ai(orch2.store.getTask(t.id))!;
    assert.equal(r.status, 'failed');
    assert.match(String(r.error), /restart/);
    await waitFor(() => !isAlive(pid2), 10_000, 'orphan reviewer killed');
    assert.deepEqual(readdirSync(path.join(dataDir, 'reviewing')), [], 'crash leftovers removed');
    await assert.rejects(orch2.approve(t.id), Conflict);
    // cancelling the task kills a running reviewer
    await orch2.reviewer.start(t.id);
    const pid3 = await waitFor(() => { const x = ai(orch2.store.getTask(t.id)); return x?.status === 'running' && x.pid; }, 20_000, 'reviewer pid 3');
    await orch2.cancel(t.id);
    await waitFor(() => !isAlive(pid3), 10_000, 'reviewer killed with its task');
  } finally { await orch2.stop(); }
});

test('reviewer HTTP API: policy, run, errors', async () => {
  const { orch, project } = await setup();
  const srv = createServer(orch, { port: 0, webDir: path.resolve('web'), token: 't' });
  const base = `http://127.0.0.1:${await srv.listen()}`;
  const call = (method: string, u: string, body: object = {}) => fetch(base + u, { method, headers: { 'x-hidforge-token': 't' }, body: JSON.stringify(body) });
  try {
    assert.equal((await call('PATCH', `/api/projects/${project.id}`, { reviewPolicy: { mode: 'nope' } })).status, 400);
    const p = await (await call('PATCH', `/api/projects/${project.id}`, { reviewPolicy: { mode: 'advisory', provider: 'mock' } })).json() as { reviewPolicy: { mode: string } };
    assert.equal(p.reviewPolicy.mode, 'advisory');
    const t = orch.createTask(project.id, { title: 'api', allowedPaths: ['p/**'], description: mock({ write: { 'p/p.txt': 'P' } }) });
    assert.equal((await call('POST', `/api/tasks/${t.id}/review`)).status, 409, 'draft task cannot be reviewed');
    assert.equal((await call('POST', `/api/tasks/${t.id}/review/cancel`)).status, 409);
    orch.submit(t.id);
    await reviewed(orch, t.id);
    assert.equal((await call('POST', `/api/tasks/${t.id}/review`, { provider: 'mock' })).status, 200, 'manual re-run');
    assert.equal((await reviewed(orch, t.id)).verdict, 'approve');
  } finally { await srv.close(); await orch.stop(); }
});
