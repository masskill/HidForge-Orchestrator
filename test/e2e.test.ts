// End-to-end scenarios with real Mock Agent processes, real git worktrees, real SQLite.
// Paths contain spaces and Ukrainian letters on purpose.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { Orchestrator } from '../src/orchestrator.ts';
import { isAlive } from '../src/proc.ts';
import { git } from '../src/workspace.ts';
import { Conflict } from '../src/store.ts';
import { createServer } from '../src/server.ts';
import { setup, mock, waitFor, waitStatus } from './helpers.ts';

const read = (f: string) => readFileSync(f, 'utf8').replace(/\r\n/g, '\n'); // core.autocrlf may be on

test('two independent workers overlap in time; dependent task waits for both merges', async () => {
  const { orch, project, repo } = await setup();
  try {
    const a = orch.createTask(project.id, { title: 'A', allowedPaths: ['a/**'], description: mock({ sleepMs: 1500, write: { 'a/a.txt': 'A' } }) });
    const b = orch.createTask(project.id, { title: 'B', allowedPaths: ['b/**'], description: mock({ sleepMs: 1500, write: { 'b/b.txt': 'B' } }) });
    const c = orch.createTask(project.id, { title: 'C', dependsOn: [a.id, b.id], allowedPaths: ['c/**'], description: mock({ sleepMs: 100, write: { 'c/c.txt': 'C' } }) });
    orch.submitAll(project.id);
    await waitStatus(orch, a.id, ['review']);
    await waitStatus(orch, b.id, ['review']);
    const [ra] = orch.store.runsForTask(a.id);
    const [rb] = orch.store.runsForTask(b.id);
    assert.ok(ra!.startedAt < rb!.endedAt! && rb!.startedAt < ra!.endedAt!, 'runs A and B must overlap in time');
    assert.notEqual(orch.store.getTask(a.id).workspace, orch.store.getTask(b.id).workspace);
    assert.equal(orch.store.getTask(c.id).status, 'ready');
    assert.equal(orch.store.runsForTask(c.id).length, 0, 'C must not start before its prerequisites are merged');

    await orch.approve(a.id);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(orch.store.runsForTask(c.id).length, 0, 'C must still wait for B');
    await orch.approve(b.id);
    await waitStatus(orch, c.id, ['review']);
    assert.ok(orch.store.runsForTask(c.id)[0]!.startedAt >= orch.store.getTask(b.id).updatedAt.slice(0, 19), 'C started after B merged');
    await orch.approve(c.id);
    for (const f of ['a/a.txt', 'b/b.txt', 'c/c.txt']) assert.ok(existsSync(path.join(repo, f)), `${f} merged into main`);
    assert.equal(orch.store.getTask(c.id).status, 'merged');
    assert.ok(!existsSync(orch.store.getTask(a.id).workspace!), 'worktree cleaned up after merge');
  } finally { await orch.stop(); }
});

test('one writer per workspace and no duplicate live run of a task', async () => {
  const { orch, project } = await setup();
  try {
    assert.equal(orch.store.acquireLock('W', 1), true);
    assert.equal(orch.store.acquireLock('W', 2), false, 'second writer refused');
    orch.store.releaseLock('W');
    const t = orch.createTask(project.id, { title: 'x' });
    orch.store.setStatus(t.id, 'ready');
    orch.store.setStatus(t.id, 'queued');
    // simulate two schedulers racing for the same task
    orch.store.beginRun(orch.store.getTask(t.id), 'WS-1', true);
    orch.store.setStatus(t.id, 'queued' as never, {}); // force back to queued (running -> queued is legal)
    assert.throws(() => orch.store.beginRun(orch.store.getTask(t.id), 'WS-2', true), Conflict, 'unique index blocks a 2nd live run');
    assert.throws(() => orch.store.beginRun({ ...orch.store.getTask(t.id) }, 'WS-1', true), Conflict);
  } finally { await orch.stop(); }
});

test('crashing, hanging and result-less workers are detected; retry then succeed', async () => {
  const { orch, project } = await setup({ stallTimeoutSec: 1 });
  try {
    const crash = orch.createTask(project.id, { title: 'crash', maxAttempts: 1, description: mock({ mode: 'crash' }) });
    const hang = orch.createTask(project.id, { title: 'hang', maxAttempts: 1, description: mock({ mode: 'hang' }) });
    const nores = orch.createTask(project.id, { title: 'nores', maxAttempts: 1, description: mock({ mode: 'noresult', write: { 'n.txt': '1' } }) });
    const flaky = orch.createTask(project.id, { title: 'flaky', maxAttempts: 2, description: mock({ failAttempts: 1, write: { 'f.txt': '{attempt}' } }) });
    orch.store.setSetting('maxConcurrentAgents', 4);
    orch.submitAll(project.id);
    assert.match(String((await waitStatus(orch, crash.id, ['failed'])).feedback), /exited with code/);
    assert.match(String((await waitStatus(orch, hang.id, ['failed'])).feedback), /stalled/);
    assert.match(String((await waitStatus(orch, nores.id, ['failed'])).feedback), /without a result/);
    const f = await waitStatus(orch, flaky.id, ['review']);
    assert.equal(f.attempts, 2);
    assert.equal(orch.store.runsForTask(flaky.id).map((r) => r.status).join(','), 'failed,succeeded');
    assert.equal(orch.store.runsForTask(hang.id)[0]!.status, 'timeout');
  } finally { await orch.stop(); }
});

test('changes outside allowedPaths are blocked at the gate', async () => {
  const { orch, project, repo } = await setup();
  try {
    const t = orch.createTask(project.id, { title: 'bad', maxAttempts: 1, allowedPaths: ['src/**'], description: mock({ write: { 'README.md': 'hacked', 'src/ok.txt': 'ok' } }) });
    orch.submit(t.id);
    const done = await waitStatus(orch, t.id, ['blocked']);
    assert.match(String(done.feedback), /outside allowedPaths: README.md/);
    await assert.rejects(orch.approve(t.id), Conflict);
    assert.equal(readFileSync(path.join(repo, 'README.md'), 'utf8'), '# test\n');
  } finally { await orch.stop(); }
});

test('failing verification -> repair attempt -> blocked, never merged', async () => {
  const { orch, project, repo } = await setup();
  try {
    const cmd = 'node -e "process.exit(3)"';
    orch.store.updateProject(project.id, { allowedCommands: [cmd] });
    const t = orch.createTask(project.id, { title: 'tests fail', maxAttempts: 2, verifyCommands: [cmd], description: mock({ write: { 'x.txt': '{attempt}' } }) });
    orch.submit(t.id);
    const done = await waitStatus(orch, t.id, ['blocked']);
    assert.equal(done.attempts, 2, 'one repair attempt was made');
    assert.ok(done.evidence.some((e) => e.kind === 'verify' && !e.ok && e.summary.includes('exit 3')));
    await assert.rejects(orch.approve(t.id), Conflict);
    assert.ok(!existsSync(path.join(repo, 'x.txt')));
  } finally { await orch.stop(); }
});

test('unapproved command is not executed until the user approves; deny-listed never', async () => {
  const { orch, project } = await setup();
  try {
    const marker = 'pwned.txt';
    const cmd = `node -e "require('fs').writeFileSync('${marker}','x')"`;
    const t = orch.createTask(project.id, { title: 'needs approval', verifyCommands: [cmd], description: mock({ write: { 'y.txt': '1' } }) });
    const d = orch.createTask(project.id, { title: 'dangerous', verifyCommands: ['git push origin main'], description: mock({ write: { 'z.txt': '1' } }) });
    orch.submitAll(project.id);
    const waiting = await waitStatus(orch, t.id, ['needs_user_input']);
    assert.match(String(waiting.question), /Allow HidForge to run/);
    assert.ok(!existsSync(path.join(waiting.workspace!, marker)), 'command must not have run');
    const blocked = await waitStatus(orch, d.id, ['blocked']);
    assert.match(String(blocked.feedback), /deny-list/);
    await assert.rejects(orch.answer(d.id, true), Conflict);

    const after = await orch.answer(t.id, true);
    assert.equal(after.status, 'review');
    assert.ok((after.artifacts.gate as { passed: boolean }).passed);
    assert.ok(orch.store.getProject(project.id).allowedCommands.includes(cmd));
  } finally { await orch.stop(); }
});

test('merge conflict keeps both agents\' work; conflict-repair attempt integrates it', async () => {
  const { orch, project, repo } = await setup();
  try {
    const a = orch.createTask(project.id, { title: 'A', description: mock({ write: { 'shared.txt': 'from A\n' } }) });
    const b = orch.createTask(project.id, { title: 'B', description: mock({ write: { 'shared.txt': 'from B\n' } }) });
    orch.submitAll(project.id);
    await waitStatus(orch, a.id, ['review']);
    await waitStatus(orch, b.id, ['review']);
    await orch.approve(a.id);
    const tb = await orch.approve(b.id);
    assert.equal(tb.status, 'blocked');
    assert.deepEqual(tb.artifacts.mergeConflict, ['shared.txt']);
    assert.equal(read(path.join(repo, 'shared.txt')), 'from A\n', 'A\'s merged work untouched');
    assert.equal((await git(repo, ['show', `${tb.branch}:shared.txt`])).stdout, 'from B\n', 'B\'s work preserved on its branch');
    assert.equal((await git(repo, ['status', '--porcelain'])).stdout, '', 'main checkout left clean (merge aborted)');

    orch.retry(b.id); // repair: base is merged into B's worktree, agent re-writes the file
    const repaired = await waitStatus(orch, b.id, ['review', 'blocked']);
    assert.equal(repaired.status, 'review', String(repaired.feedback));
    assert.ok(repaired.evidence.some((e) => e.kind === 'integration' && e.summary.includes('shared.txt')));
    const merged = await orch.approve(b.id);
    assert.equal(merged.status, "merged", JSON.stringify(merged.evidence.slice(-3)));
    assert.equal(read(path.join(repo, 'shared.txt')), 'from B\n');
  } finally { await orch.stop(); }
});

test('restart: queue and logs survive, orphan worker is killed, no duplicate runs', async () => {
  const { orch, project, dataDir } = await setup();
  const t = orch.createTask(project.id, { title: 'survivor', maxAttempts: 2, description: mock({ hangAttempts: 1, write: { 's.txt': '{attempt}' } }) });
  const waiting = orch.createTask(project.id, { title: 'queued behind', dependsOn: [t.id], description: mock({ write: { 'w.txt': '1' } }) });
  orch.submitAll(project.id);
  const run1 = await waitFor(() => orch.store.runsForTask(t.id).find((r) => r.pid), 10_000, 'run with pid');
  await waitFor(() => orch.store.events({ taskId: t.id }).some((e) => e.type === 'run.output'), 10_000, 'output');
  const eventsBefore = orch.store.events({ taskId: t.id }).length;
  await orch.crashForTest(); // process "dies": nothing is cleaned up
  assert.ok(isAlive(run1.pid!), 'orphan worker still alive after crash');

  const orch2 = new Orchestrator({ dataDir, tickMs: 40, backoffMs: 0 });
  try {
    await orch2.start();
    await waitFor(() => !isAlive(run1.pid!), 10_000, 'orphan killed');
    const done = await waitStatus(orch2, t.id, ['review']);
    const runs = orch2.store.runsForTask(t.id);
    assert.deepEqual(runs.map((r) => r.status), ['interrupted', 'succeeded']);
    assert.equal(done.attempts, 2);
    assert.ok(orch2.store.events({ taskId: t.id }).length > eventsBefore, 'old events kept, new appended');
    assert.equal(orch2.store.getTask(waiting.id).status, 'ready', 'dependent task still queued after restart');
    assert.equal(orch2.store.liveRuns().length, 0);
  } finally { await orch2.stop(); }
});

test('cancel kills the whole process tree (Windows taskkill /T)', async () => {
  const { orch, project } = await setup();
  try {
    const t = orch.createTask(project.id, { title: 'tree', description: mock({ grandchild: true, mode: 'hang' }) });
    orch.submit(t.id);
    const ev = await waitFor(() => orch.store.events({ taskId: t.id }).find((e) => String((e.data as { text?: string }).text).startsWith('grandchild pid')), 10_000, 'grandchild');
    const gpid = Number(String((ev.data as { text: string }).text).split(' ').pop());
    const run = orch.store.runsForTask(t.id)[0]!;
    assert.ok(isAlive(gpid) && isAlive(run.pid!));
    const c = await orch.cancel(t.id);
    assert.equal(c.status, 'canceled');
    await waitFor(() => !isAlive(gpid) && !isAlive(run.pid!), 10_000, 'tree killed');
    assert.equal(orch.store.runsForTask(t.id)[0]!.status, 'canceled');
    assert.equal(orch.store.locks().length, 0, 'workspace lock released');
  } finally { await orch.stop(); }
});

test('unavailable provider fails only its task; scheduler keeps going', async () => {
  const { orch, project } = await setup();
  try {
    const ghost = orch.createTask(project.id, { title: 'ghost', provider: 'cursor', description: 'x' });
    const ok = orch.createTask(project.id, { title: 'ok', description: mock({ write: { 'o.txt': '1' } }) });
    const st = (await orch.registry.status()).find((s) => s.id === 'cursor')!;
    orch.submitAll(project.id);
    await waitStatus(orch, ok.id, ['review']);
    if (!st.available) assert.match(String((await waitStatus(orch, ghost.id, ['failed'])).evidence.at(-1)!.summary), /unavailable/);
  } finally { await orch.stop(); }
});

test('HTTP API: host check, token required for mutations, live SSE events', async () => {
  const { orch, project } = await setup();
  const srv = createServer(orch, { port: 0, webDir: path.resolve('web'), token: 'tok' });
  const port = await srv.listen();
  const base = `http://127.0.0.1:${port}`;
  try {
    assert.equal((await fetch(`${base}/api/health`)).status, 200);
    assert.equal((await fetch(`${base}/api/projects/${project.id}/tasks`, { method: 'POST', body: '{"title":"x"}' })).status, 403);
    const evil = await new Promise<number>((resolve) => {
      import('node:http').then(({ request }) => {
        const r = request({ host: '127.0.0.1', port, path: '/api/health', headers: { host: 'evil.example:80' } }, (res) => { res.resume(); resolve(res.statusCode!); });
        r.end();
      });
    });
    assert.equal(evil, 403);
    const ac = new AbortController();
    const sse = await fetch(`${base}/api/stream?projectId=${project.id}`, { signal: ac.signal });
    const reader = sse.body!.getReader();
    const created = await fetch(`${base}/api/projects/${project.id}/tasks`, {
      method: 'POST', headers: { 'x-hidforge-token': 'tok', 'content-type': 'application/json' }, body: JSON.stringify({ title: 'через API' }),
    });
    assert.equal(created.status, 200);
    let text = '';
    while (!text.includes('task.created')) text += new TextDecoder().decode((await reader.read()).value);
    assert.match(text, /через API/);
    ac.abort();
    const bad = await fetch(`${base}/api/projects/${project.id}/tasks`, {
      method: 'POST', headers: { 'x-hidforge-token': 'tok' }, body: JSON.stringify({ title: 'cyc', dependsOn: [999] }),
    });
    assert.equal(bad.status, 400);
  } finally { await srv.close(); await orch.stop(); }
});
