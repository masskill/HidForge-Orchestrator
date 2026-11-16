// VPS/ssh backend: settings validation, quoting, invocation, patch safety, and a full run through a stand-in ssh.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SshAdapter, normalizeSsh, shq, checkPatch } from '../src/adapters/ssh.ts';
import { resolveCommand } from '../src/proc.ts';
import type { AgentAdapter, AgentEvent } from '../src/adapters/types.ts';
import { setup, tmpRoot, waitStatus, waitFor, mock } from './helpers.ts';
import { MockAdapter } from '../src/adapters/index.ts';
import { git } from '../src/workspace.ts';

const FAKE_SSH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-ssh.ts');
const SH = resolveCommand('sh')?.file ?? ['C:\\Program Files\\Git\\usr\\bin\\sh.exe', '/bin/sh'].find(existsSync);

/** An "agent" that is a shell script run on the host; prints one JSON result line. */
function shellAgent(script: string): AgentAdapter & { spec: { bin: string } } {
  return {
    id: 'demo', name: 'Demo', mock: false, spec: { bin: 'sh' },
    async detect() { return { installed: true, version: '1', reason: null }; },
    async checkAuth() { return { auth: 'ok' as const, reason: null }; },
    capabilities() { return { headless: 'supported', streamEvents: 'supported', cancel: 'supported', questions: 'unsupported', usage: 'unsupported', modelSelect: 'unsupported', readOnlyMode: 'supported' }; },
    notes() { return []; },
    buildInvocation(c) { return { command: 'sh', args: ['-c', script, c.workspace], stdin: c.prompt }; },
    parseLine(l): AgentEvent | null { try { const o = JSON.parse(l); return { kind: 'result', text: o.text, isError: false }; } catch { return l.trim() ? { kind: 'log', text: l } : null; } },
  };
}
const cfg = { host: 'me@vps.example', port: 2222, remoteDir: '.hidforge/work', agents: ['demo'] };

test('ssh settings are validated; host, port and paths cannot become options or shell code', () => {
  const known = (id: string) => ['claude', 'mock'].includes(id);
  assert.equal(normalizeSsh(null, known), null);
  assert.equal(normalizeSsh({ host: ' ' }, known), null);
  assert.deepEqual(normalizeSsh({ host: 'dev@vps-1.example.com', agents: ['claude'] }, known), { host: 'dev@vps-1.example.com', port: null, remoteDir: '.hidforge/work', agents: ['claude'] });
  assert.equal(normalizeSsh({ host: 'box', port: '22', remoteDir: '/srv/hf/' }, known)?.remoteDir, '/srv/hf');
  for (const host of ['-oProxyCommand=calc', 'a b', 'x;id', 'u@-h', '$(id)']) assert.throws(() => normalizeSsh({ host }, known), /ssh host/, host);
  assert.throws(() => normalizeSsh({ host: 'h', port: 70000 }, known), /port/);
  for (const remoteDir of ['../x', 'a/../b', '-rf', 'a b', 'a;b', '$HOME']) assert.throws(() => normalizeSsh({ host: 'h', remoteDir }, known), /remote directory/, remoteDir);
  assert.throws(() => normalizeSsh({ host: 'h', agents: ['mock'] }, known), /unknown agent/);
});

test('ssh invocation: quoted remote command, prompt only on stdin, host-key checks left on', () => {
  assert.equal(shq("it's"), `'it'\\''s'`);
  const a = new SshAdapter(shellAgent('echo $(id)'), cfg);
  assert.equal(a.id, 'demo-ssh');
  assert.equal(a.remoteDir('C:\\data\\worktrees\\p1\\t3'), '.hidforge/work/p1-t3');
  const inv = a.buildInvocation({ prompt: 'SECRET', workspace: 'C:\\data\\worktrees\\p1\\t3', model: null, policy: 'workspace-write' });
  assert.equal(inv.command, 'ssh');
  assert.deepEqual(inv.args.slice(0, 9), ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-p', '2222', '--', 'me@vps.example']);
  assert.equal(inv.args[9], `cd '.hidforge/work/p1-t3' && exec 'sh' '-c' 'echo $(id)' '.'`);
  assert.equal(inv.stdin, 'SECRET');
  assert.doesNotMatch(inv.args.join(' '), /SECRET|StrictHostKeyChecking|UserKnownHostsFile/);
});

test('remote patches with symlinks or .git paths are refused', () => {
  assert.throws(() => checkPatch('diff --git a/l b/l\nnew file mode 120000\n'), /symlink/);
  assert.throws(() => checkPatch('diff --git a/x/.git/config b/x/.git/config\n'), /\.git/);
  assert.throws(() => checkPatch('diff --git a/.GIT/hooks/pre-commit b/.GIT/hooks/pre-commit\n'), /\.git/);
  checkPatch('diff --git a/src/a.ts b/src/a.ts\nindex 1..2 100644\n');
  // git quotes paths with tabs, quotes or backslashes even with core.quotepath=false
  assert.throws(() => checkPatch('diff --git "a/.git/hooks/x\\ty" "b/.git/hooks/x\\ty"\nnew file mode 100755\n'), /\.git/);
  assert.throws(() => checkPatch('diff --git a/ok b/ok\nsimilarity index 100%\nrename from ok\nrename to .git/config\n'), /\.git/);
  assert.throws(() => checkPatch('diff --git a/x b/x\n--- a/x\n+++ "b/sub/.git/x\\""\n'), /\.git/);
  // content lines that merely look like headers are not paths
  checkPatch('diff --git a/n.md b/n.md\n--- a/n.md\n+++ b/n.md\n@@ -1 +1 @@\n--- .git/config\n+++ .git/config\n');
});

test('tar stream skips a file deleted after listing; a read error fails the upload, not the server', async () => {
  const { tarEntries } = await import('../src/adapters/ssh.ts');
  const root = tmpRoot();
  writeFileSync(path.join(root, 'a.txt'), 'a');
  const size = [...tarEntries(root, [{ path: 'a.txt', mode: 0o644 }, { path: 'gone.txt', mode: 0o644 }])].reduce((n, b) => n + b.length, 0);
  assert.equal(size, 512 + 512 + 1024, 'one header + one data block + end marker');
  mkdirSync(path.join(root, 'dir'));
  assert.throws(() => [...tarEntries(root, [{ path: 'dir', mode: 0o644 }])], /EISDIR|EPERM|EACCES/);
});

/** Mock agent whose remote upload hangs until aborted. */
function hangingUpload() {
  const s = { started: 0, aborted: 0 };
  const a = Object.assign(new MockAdapter(), {
    id: 'slow',
    prepare: (_ws: string, signal?: AbortSignal) => new Promise<void>((_, reject) => {
      s.started++;
      signal?.addEventListener('abort', () => { s.aborted++; reject(new Error('upload canceled')); });
    }),
  });
  return { a, s };
}

test('a hanging upload does not block the scheduler, and cancel stops it', async () => {
  const { a, s } = hangingUpload();
  const { orch, project } = await setup({ adapters: [new MockAdapter(), a] });
  try {
    const up = orch.createTask(project.id, { title: 'up', provider: 'slow', allowedPaths: [], description: mock({ write: { 'u.txt': 'u' } }) });
    const other = orch.createTask(project.id, { title: 'other', provider: 'mock', allowedPaths: [], description: mock({ write: { 'o.txt': 'o' } }) });
    orch.submitAll(project.id);
    await waitFor(() => s.started === 1 && ['review', 'merged'].includes(orch.store.getTask(other.id).status), 20_000, 'other task finishes during the upload');
    await orch.cancel(up.id);
    assert.equal(s.aborted, 1);
    assert.equal(orch.store.runsForTask(up.id).at(-1)!.status, 'canceled');
    assert.equal(orch.store.locks().some((l) => l.workspace === orch.store.getTask(up.id).workspace), false, 'lock released');
  } finally { await orch.stop(); }
});

test('planner cancel during the upload aborts it', async () => {
  const { a, s } = hangingUpload();
  const { orch, project } = await setup({ adapters: [a] });
  try {
    const plan = await orch.planner.start(project.id, { provider: 'slow' });
    await waitFor(() => s.started === 1, 20_000, 'upload started');
    assert.equal((await orch.planner.cancel(plan.id)).status, 'canceled');
    assert.equal(s.aborted, 1);
  } finally { await orch.stop(); }
});

test('a task runs on the "host": files go up, changes (edit, delete, add, binary, Ukrainian name) come back and pass gates', { skip: !SH && 'no POSIX sh' }, async () => {
  const home = path.join(tmpRoot(), 'home');
  mkdirSync(home, { recursive: true });
  process.env.FAKE_SSH_SH = SH!;
  process.env.FAKE_SSH_HOME = home;
  const script = [
    'test -f README.md', 'test ! -e .git/HEAD.local', 'test ! -e untracked-in-repo.txt', // got the worktree snapshot only
    'echo changed >> src/index.txt', 'rm README.md',
    "mkdir -p 'нова тека'", "printf 'привіт' > 'нова тека/файл з пробілом.txt'",
    "printf '\\000\\001\\377' > bin.dat",
    `echo '{"text":"done"}'`,
  ].join(' && ');
  const ssh = new SshAdapter(shellAgent(script), { ...cfg, port: null }, [process.execPath, FAKE_SSH]);
  const { orch, project } = await setup({ adapters: [ssh] });
  try {
    const d = await ssh.detect();
    assert.equal(d.installed, true, d.reason ?? '');
    writeFileSync(path.join(project.repoPath, 'untracked-in-repo.txt'), 'not in the worktree\n');
    const t = orch.createTask(project.id, { title: 'remote', provider: 'demo-ssh' });
    orch.submitAll(project.id);
    const done = await waitStatus(orch, t.id, ['review', 'blocked', 'failed']);
    assert.equal(done.status, 'review', JSON.stringify(orch.store.evidence?.(t.id) ?? done.feedback));
    const ws = done.workspace!;
    assert.equal(readFileSync(path.join(ws, 'src', 'index.txt'), 'utf8').replace(/\r/g, ''), 'x\nchanged\n');
    assert.equal(existsSync(path.join(ws, 'README.md')), false);
    assert.equal(readFileSync(path.join(ws, 'нова тека', 'файл з пробілом.txt'), 'utf8'), 'привіт');
    assert.deepEqual([...readFileSync(path.join(ws, 'bin.dat'))], [0, 1, 255]);
    const files = (await git(ws, ['diff', '--name-only', done.baseCommit!, 'HEAD'])).stdout.split(/\r?\n/).filter(Boolean).sort();
    assert.deepEqual(files, ['README.md', 'bin.dat', 'src/index.txt', 'нова тека/файл з пробілом.txt'].sort());
    const remote = path.join(home, '.hidforge', 'work', `${path.basename(path.dirname(ws))}-${path.basename(ws)}`);
    assert.equal(existsSync(remote), false, 'remote copy removed');
  } finally { await orch.stop(); }
});
