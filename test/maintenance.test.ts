// Backups (VACUUM INTO, rotation, daily auto-backup) and diagnostics.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createBackup, listBackups, autoBackup, diagnostics } from '../src/maintenance.ts';
import { createServer } from '../src/server.ts';
import { setup } from './helpers.ts';

test('backup is a consistent, readable copy; rotation keeps the newest; auto-backup at most daily', async () => {
  const { orch, dataDir, project } = await setup();
  try {
    orch.createTask(project.id, { title: 'кешована задача' });
    const b = createBackup(orch.store, dataDir);
    const copy = new DatabaseSync(b.file, { readOnly: true });
    assert.equal((copy.prepare('select title from tasks').get() as { title: string }).title, 'кешована задача');
    copy.close();
    for (let i = 0; i < 4; i++) { await new Promise((r) => setTimeout(r, 5)); createBackup(orch.store, dataDir, 3); }
    const list = listBackups(dataDir);
    assert.equal(list.length, 3, 'rotation keeps 3');
    assert.ok(list[0]!.createdAt > list[2]!.createdAt, 'newest first');
    assert.equal(autoBackup(orch.store, dataDir), null, 'a fresh backup exists: no auto-backup');
    for (const x of list) rmSync(x.file);
    assert.ok(autoBackup(orch.store, dataDir), 'no backup yet: auto-backup runs');
  } finally { await orch.stop(); }
});

test('diagnostics: healthy setup has no errors; a missing project repo is an error; API', async () => {
  const { orch, project, root } = await setup();
  try {
    const d = await diagnostics(orch);
    assert.equal(d.ok, true, JSON.stringify(d.checks.filter((c) => c.level === 'error')));
    for (const id of ['node', 'git', 'data', 'db', 'schema', 'backup', `project-${project.id}`]) assert.ok(d.checks.some((c) => c.id === id), id);
    assert.equal(d.checks.find((c) => c.id === 'backup')!.level, 'warn', 'no backup yet');

    const gone = orch.store.createProject({ name: 'зниклий', repoPath: path.join(root, 'немає'), baseBranch: 'main' });
    const d2 = await diagnostics(orch);
    assert.equal(d2.ok, false);
    assert.equal(d2.checks.find((c) => c.id === `project-${gone.id}`)!.level, 'error');

    const srv = createServer(orch, { port: 0, webDir: path.resolve('web'), token: 't' });
    const base = `http://127.0.0.1:${await srv.listen()}`;
    try {
      assert.equal((await fetch(`${base}/api/backups`, { method: 'POST' })).status, 403, 'needs the UI token');
      assert.equal((await fetch(`${base}/api/backups`, { method: 'POST', headers: { 'x-hidforge-token': 't' } })).status, 200);
      const r = await (await fetch(`${base}/api/backups`)).json() as { backups: unknown[] };
      assert.equal(r.backups.length, 1);
      const x = await (await fetch(`${base}/api/diagnostics`)).json() as { checks: { id: string; level: string }[] };
      assert.equal(x.checks.find((c) => c.id === 'backup')!.level, 'ok');
    } finally { await srv.close(); }
  } finally { await orch.stop(); }
});
