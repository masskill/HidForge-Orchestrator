// Owner automation: auto-merge after an approving AI review, owner questions, auto-fix of stuck tasks, pause / stop.
import { test } from 'node:test';
import path from 'node:path';
import { existsSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { setup, mock, waitFor, waitStatus } from './helpers.ts';
import { normalizeReviewPolicy } from '../src/reviewer.ts';
import { parseAdvice, ownerQuestions } from '../src/doctor.ts';

const policy = (o: object) => normalizeReviewPolicy({ provider: 'mock', ...o }, () => true);

test('auto-merge: gates pass, the AI review approves, the task merges by itself; auto-merge implies a required review', async () => {
  assert.equal(policy({ mode: 'off', autoMerge: true }).mode, 'required');
  assert.equal(policy({ mode: 'off' }).autoMerge, false);
  const { orch, project } = await setup();
  try {
    orch.store.updateProject(project.id, { reviewPolicy: policy({ mode: 'off', autoMerge: true }) });
    const t = orch.createTask(project.id, { title: 'am', provider: 'mock', allowedPaths: ['a/**'], description: mock({ write: { 'a/a.txt': 'A' } }) });
    orch.submit(t.id);
    const done = await waitStatus(orch, t.id, ['merged', 'blocked', 'failed']);
    assert.equal(done.status, 'merged');
    assert.ok(done.evidence.some((e) => e.summary.startsWith('Approved automatically')));
    // a review that crashes is re-run once (after the crashed session has finished) and the task still merges
    const r = orch.createTask(project.id, { title: 'crash', provider: 'mock', allowedPaths: ['r/**'], description: mock({ reviewFailOnce: `t${Date.now()}`, write: { 'r/r.txt': 'R' } }) });
    orch.submit(r.id);
    const m = await waitStatus(orch, r.id, ['merged', 'blocked', 'failed'], 30_000).catch(() => orch.store.getTask(r.id));
    assert.equal(m.status, 'merged', JSON.stringify(m.evidence.map((e) => e.summary)));
    assert.ok(m.evidence.some((e) => /AI review failed/.test(e.summary)));
  } finally { await orch.stop(); }
});

test('owner question: an agent that must ask stops the task at once; the answer goes into the task and it runs again', async () => {
  assert.deepEqual(ownerQuestions(['done', '**OWNER QUESTION:** Чи погоджуєте план?\nOWNER QUESTION: Який порт?', null]), ['Чи погоджуєте план?', 'Який порт?']);
  const { orch, project } = await setup();
  try {
    const t = orch.createTask(project.id, { title: 'ask', provider: 'mock', allowedPaths: ['q/**'], description: mock({ ask: 'Чи погоджуєте план?', write: { 'q/q.txt': 'Q' } }) });
    orch.submit(t.id);
    const b = await waitStatus(orch, t.id, ['blocked', 'failed', 'review']);
    assert.equal(b.status, 'blocked');
    assert.equal(b.attempts, 1, 'no retries wasted on a question');
    assert.equal(b.question, 'Чи погоджуєте план?');
    assert.throws(() => orch.answerOwner(t.id, '  '), /empty/);
    orch.answerOwner(t.id, 'Так, роби');
    const r = await waitStatus(orch, t.id, ['review', 'blocked', 'failed']);
    assert.equal(r.status, 'review');
    assert.match(r.description, /Owner's answer[\s\S]*Answer: Так, роби/);
    assert.equal(r.question, null);
  } finally { await orch.stop(); }
});

test('auto-fix: a failed task is diagnosed and retried; "ask the owner" turns into a question; off by default', async () => {
  assert.throws(() => parseAdvice({ action: 'ask_owner', explanation: 'x' }), /question/);
  assert.equal(parseAdvice({ action: 'retry', explanation: 'x', changes: { allowedPaths: ['../etc/**'] } }).changes.allowedPaths, undefined, 'no path escapes');
  const { orch, project } = await setup();
  try {
    const off = orch.createTask(project.id, { title: 'off', provider: 'mock', maxAttempts: 1, allowedPaths: ['o/**'], description: mock({ failAttempts: 1, write: { 'o/o.txt': 'O' } }) });
    orch.submit(off.id);
    await waitStatus(orch, off.id, ['failed']);
    assert.equal(orch.store.getTask(off.id).artifacts.doctor, undefined, 'auto-fix is off by default');

    orch.store.updateProject(project.id, { reviewPolicy: policy({ mode: 'off', autoFix: true }) });
    const t = orch.createTask(project.id, { title: 'fix', provider: 'mock', maxAttempts: 1, allowedPaths: ['f/**'], description: mock({ failAttempts: 1, write: { 'f/f.txt': 'F' } }) });
    orch.submit(t.id);
    const fixed = await waitStatus(orch, t.id, ['review'], 30_000);
    assert.equal((fixed.artifacts.doctor as { action: string }).action, 'retry');
    assert.equal(fixed.artifacts.autoFixes, 1);
    assert.ok(fixed.evidence.some((e) => e.kind === 'doctor' && e.ok));

    const q = orch.createTask(project.id, { title: 'q', provider: 'mock', maxAttempts: 1, allowedPaths: ['g/**'],
      description: mock({ failAttempts: 9, doctor: { action: 'ask_owner', explanation: 'Потрібен ключ доступу.', question: 'Де взяти ключ?' } }) });
    orch.submit(q.id);
    const asked = await waitFor(() => { const x = orch.store.getTask(q.id); return x.question ? x : null; }, 20_000, 'doctor question');
    assert.equal(asked.status, 'failed');
    assert.equal(asked.question, 'Де взяти ключ?');
    assert.equal((asked.artifacts.doctor as { explanation: string }).explanation, 'Потрібен ключ доступу.');
  } finally { await orch.stop(); }
});

test('pause / stop: a paused project starts nothing; stop interrupts without counting the attempt; task pause parks a draft', async () => {
  const { orch, project } = await setup();
  try {
    const slow = (dir: string) => mock({ sleepMs: 4000, steps: 8, write: { [`${dir}/x.txt`]: 'X' } });
    const t = orch.createTask(project.id, { title: 'stop', provider: 'mock', allowedPaths: ['s/**'], description: slow('s') });
    orch.submit(t.id);
    await waitStatus(orch, t.id, ['running']);
    assert.deepEqual(await orch.pauseProject(project.id, true), { paused: true, stopped: 1 });
    let s = orch.store.getTask(t.id);
    assert.equal(s.status, 'queued');
    assert.equal(s.attempts, 0, 'the stopped attempt is not counted');
    assert.equal(orch.store.runsForTask(t.id)[0]!.status, 'canceled');
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(orch.store.getTask(t.id).status, 'queued', 'paused: nothing starts');
    await orch.resumeProject(project.id);
    s = await waitStatus(orch, t.id, ['review']);
    assert.equal(s.attempts, 1);

    const p2 = orch.createTask(project.id, { title: 'pause', provider: 'mock', allowedPaths: ['p/**'], description: slow('p') });
    orch.submit(p2.id);
    await waitStatus(orch, p2.id, ['running']);
    assert.equal((await orch.pauseTask(p2.id)).status, 'draft');
    assert.equal(orch.store.getTask(p2.id).attempts, 0);
    orch.submit(p2.id);
    assert.equal((await waitStatus(orch, p2.id, ['review'])).attempts, 1);
  } finally { await orch.stop(); }
});

test('project .env reaches verification commands only when switched on; never the worktree; values are masked in the log', async () => {
  const { orch, project, repo } = await setup();
  try {
    writeFileSync(path.join(repo, '.env'), 'DB_URL=postgres://owner:s3cretpass@localhost/db\n# comment\n');
    const cmd = 'node -e "console.log(\'url=\' + process.env.DB_URL), process.exit(process.env.DB_URL ? 0 : 4)"';
    orch.store.updateProject(project.id, { allowedCommands: [cmd] });
    const off = orch.createTask(project.id, { title: 'off', maxAttempts: 1, allowedPaths: ['e/**'], verifyCommands: [cmd], description: mock({ write: { 'e/1.txt': '1' } }) });
    orch.submit(off.id);
    const o = await waitStatus(orch, off.id, ['blocked']);
    assert.ok(o.evidence.some((e) => e.kind === 'verify' && e.summary.endsWith('exit 4')), 'off by default: the check runs but does not see the variable');

    orch.setVerifyEnv(project.id, true);
    const on = orch.createTask(project.id, { title: 'on', maxAttempts: 1, allowedPaths: ['e2/**'], verifyCommands: [cmd], description: mock({ write: { 'e2/1.txt': '1' } }) });
    orch.submit(on.id);
    const t = await waitStatus(orch, on.id, ['review', 'blocked']);
    assert.equal(t.status, 'review', JSON.stringify(t.evidence.map((e) => [e.kind, e.summary, (e.detail ?? '').slice(0, 300)])));
    const ev = t.evidence.find((e) => e.kind === 'verify')!;
    assert.ok(ev.ok);
    assert.doesNotMatch(ev.detail ?? '', /s3cretpass/, 'the value is masked in the evidence');
    assert.match(ev.detail ?? '', /url=\*\*\*/);
    assert.ok(!existsSync(path.join(t.workspace!, '.env')), 'the .env is not copied into the worktree');
  } finally { await orch.stop(); }
});

test('auto-answer: the AI decides the agent\'s question and the task goes on; waiting questions are handed over; owner-only stays with the owner', async () => {
  const { orch, project } = await setup();
  try {
    const decide = { action: 'retry', explanation: 'Обрано рекомендований варіант.', decisions: '1) План погоджено — це рекомендований варіант.', feedback: 'The plan is approved, implement it.' };
    // a question already waiting for the owner, then auto-answer is switched on
    const w = orch.createTask(project.id, { title: 'waiting', provider: 'mock', allowedPaths: ['w/**'], description: mock({ ask: 'Погоджуєте план?', doctor: decide, write: { 'w/w.txt': 'W' } }) });
    orch.submit(w.id);
    assert.equal((await waitStatus(orch, w.id, ['blocked'])).question, 'Погоджуєте план?');
    orch.store.updateProject(project.id, { reviewPolicy: policy({ mode: 'off', autoAnswer: true }) });
    assert.equal(orch.store.getProject(project.id).reviewPolicy.autoFix, true, 'auto-answer implies auto-fix');
    await orch.autopilot(project.id);
    const wd = await waitStatus(orch, w.id, ['review'], 30_000);
    assert.match(wd.description, /Decisions taken on the owner's behalf[\s\S]*План погоджено/);
    assert.equal(wd.question, null);

    // with auto-answer on, an agent's question never reaches the owner
    const t = orch.createTask(project.id, { title: 'live', provider: 'mock', allowedPaths: ['l/**'], description: mock({ ask: 'Яку теку взяти?', doctor: decide, write: { 'l/l.txt': 'L' } }) });
    orch.submit(t.id);
    const td = await waitStatus(orch, t.id, ['review'], 30_000);
    assert.equal(td.attempts, 2);
    assert.ok(!orch.store.events({ taskId: t.id, type: 'task.question' }).length, 'the owner was not asked');

    // owner-only questions still reach the owner and are not handed back to the AI
    const k = orch.createTask(project.id, { title: 'key', provider: 'mock', maxAttempts: 1, allowedPaths: ['k/**'],
      description: mock({ failAttempts: 9, doctor: { action: 'ask_owner', explanation: 'Потрібен пароль.', question: 'Введіть пароль бази в .env' } }) });
    orch.submit(k.id);
    const kd = await waitFor(() => { const x = orch.store.getTask(k.id); return x.question ? x : null; }, 20_000, 'owner-only question');
    assert.equal(kd.artifacts.ownerOnly, true);
    await orch.autopilot(project.id);
    assert.equal(orch.store.getTask(k.id).question, 'Введіть пароль бази в .env', 'not handed back to the AI');
  } finally { await orch.stop(); }
});
