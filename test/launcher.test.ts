// No-terminal launch (second start only reuses the running instance, shutdown from the UI API),
// per-user installer shortcuts and the fast-forward-only updater.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { existsSync, mkdirSync, copyFileSync, writeFileSync } from 'node:fs';
import { git } from '../src/workspace.ts';
import { tmpRoot } from './helpers.ts';

const win = process.platform === 'win32';
const ps = (file: string, args: string[]) => new Promise<number>((resolve) => {
  execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file, ...args], { windowsHide: true }, (err) =>
    resolve(err ? Number((err as { code?: number }).code ?? 1) : 0));
});

test('second start reuses the running instance; POST /api/shutdown stops the server', async () => {
  const port = 41000 + Math.floor(Math.random() * 2000);
  const env = { ...process.env, HIDFORGE_DATA_DIR: path.join(tmpRoot(), 'data') };
  const first = spawn(process.execPath, ['src/main.ts', '--port', String(port)], { env, windowsHide: true });
  const exited = new Promise<number | null>((r) => first.on('exit', r));
  try {
    await new Promise<void>((resolve, reject) => {
      let out = '';
      first.stdout.on('data', (d) => { out += d; if (out.includes('running at')) resolve(); });
      first.on('exit', () => reject(new Error(`server exited early: ${out}`)));
    });
    const second = spawn(process.execPath, ['src/main.ts', '--port', String(port)], { env, windowsHide: true });
    let out2 = '';
    second.stdout.on('data', (d) => { out2 += d; });
    const code2 = await new Promise<number | null>((r) => second.on('exit', r));
    assert.equal(code2, 0);
    assert.match(out2, /already running/);

    const base = `http://127.0.0.1:${port}`;
    const v = await (await fetch(`${base}/api/version`)).json() as { name: string; version: string };
    assert.equal(v.name, 'hidforge-orchestrator');
    assert.equal((await fetch(`${base}/api/shutdown`, { method: 'POST' })).status, 403, 'needs the UI token');
    const token = (await (await fetch(base)).text()).match(/name="hidforge-token" content="([^"]+)"/)![1]!;
    assert.equal((await fetch(`${base}/api/shutdown`, { method: 'POST', headers: { 'x-hidforge-token': token } })).status, 200);
    assert.equal(await exited, 0);
  } finally { first.kill(); }
});

test('installer creates and removes per-user shortcuts', { skip: !win && 'Windows only' }, async () => {
  const dir = path.join(tmpRoot(), 'ярлики');
  const lnk = path.join(dir, 'HidForge Orchestrator.lnk');
  assert.equal(await ps(path.resolve('scripts/install.ps1'), ['-ShortcutDir', dir]), 0);
  assert.ok(existsSync(lnk));
  assert.equal(await ps(path.resolve('scripts/install.ps1'), ['-ShortcutDir', dir, '-Uninstall']), 0);
  assert.ok(!existsSync(lnk));
});

test('updater: -Check changes nothing, local edits block, then fast-forward', { skip: !win && 'Windows only' }, async () => {
  const root = tmpRoot();
  const origin = path.join(root, 'origin.git');
  const app = path.join(root, 'app');
  const other = path.join(root, 'other');
  await git(root, ['init', '-q', '--bare', '-b', 'main', origin]);
  await git(root, ['clone', '-q', origin, app]);
  mkdirSync(path.join(app, 'scripts'));
  copyFileSync('scripts/update.ps1', path.join(app, 'scripts', 'update.ps1'));
  writeFileSync(path.join(app, 'a.txt'), '1\n');
  await git(app, ['add', '-A']);
  await git(app, ['commit', '-q', '-m', 'v1']);
  await git(app, ['push', '-q', 'origin', 'main']);
  await git(root, ['clone', '-q', origin, other]);
  writeFileSync(path.join(other, 'b.txt'), 'new\n');
  await git(other, ['add', '-A']);
  await git(other, ['commit', '-q', '-m', 'v2']);
  await git(other, ['push', '-q', 'origin', 'main']);
  const head = async () => (await git(app, ['rev-parse', 'HEAD'])).stdout.trim();
  const v1 = await head();
  const upd = path.join(app, 'scripts', 'update.ps1');

  assert.equal(await ps(upd, ['-Check']), 0);
  assert.equal(await head(), v1, '-Check does not update');
  writeFileSync(path.join(app, 'a.txt'), 'local edit\n');
  assert.equal(await ps(upd, []), 1, 'local changes block the update');
  assert.equal(await head(), v1);
  await git(app, ['checkout', '--', 'a.txt']);
  assert.equal(await ps(upd, []), 0);
  assert.equal(await head(), (await git(other, ['rev-parse', 'HEAD'])).stdout.trim());
  assert.ok(existsSync(path.join(app, 'b.txt')));
});
