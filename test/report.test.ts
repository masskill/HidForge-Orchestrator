// Integrator draft on a failed post-merge check; project report and decision log (ADR).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { projectReport, adrMarkdown, decisions } from '../src/report.ts';
import { createServer } from '../src/server.ts';
import { setup, mock, waitStatus } from './helpers.ts';

test('post-merge integration failure creates an Integrator draft; report and ADR reflect it', async () => {
  const { orch, project } = await setup();
  try {
    // B passes in its own worktree (no a.txt there) but fails on main once A is merged.
    const check = `node -e "process.exit(require('fs').existsSync('a.txt') ? 4 : 0)"`;
    orch.store.updateProject(project.id, { allowedCommands: [check] });
    const a = orch.createTask(project.id, { title: 'adds a', allowedPaths: ['a.txt'], description: mock({ write: { 'a.txt': 'A' } }) });
    const b = orch.createTask(project.id, { title: 'needs no a', allowedPaths: ['b.txt'], verifyCommands: [check], description: mock({ write: { 'b.txt': 'B' } }) });
    orch.submitAll(project.id);
    await waitStatus(orch, a.id, ['review']);
    await waitStatus(orch, b.id, ['review']);
    await orch.approve(a.id);
    const tb = await orch.approve(b.id);
    assert.equal(tb.status, 'merged');
    const itId = tb.artifacts.integratorTaskId as number;
    assert.ok(itId, 'integrator task linked');
    const it = orch.store.getTask(itId);
    assert.equal(it.status, 'draft', 'integrator never starts on its own');
    assert.equal(it.assignedRole, 'Integrator');
    assert.deepEqual(it.verifyCommands, [check]);
    assert.match(it.description, /integration checks now fail on main/);

    const d = decisions(orch.store, project.id);
    assert.deepEqual(d.map((x) => x.title.split(' ')[0]), ['Злито', 'Злито', 'Інтеграційна']);
    const adr = adrMarkdown(orch.store, project.id);
    assert.match(adr, /## ADR-001: Злито задачу #1 adds a/);
    assert.match(adr, new RegExp(`Створено чернетку Інтегратора #${itId}`));
    const rep = projectReport(orch.store, project.id);
    assert.match(rep, /Злито 2 з 3 задач \(67%\)/);
    assert.match(rep, /\| 3 \| Integrator: fix main after #2 needs no a \| Integrator \|/);

    const srv = createServer(orch, { port: 0, webDir: path.resolve('web'), token: 't' });
    const base = `http://127.0.0.1:${await srv.listen()}`;
    try {
      const r = await (await fetch(`${base}/api/projects/${project.id}/report`)).json() as { markdown: string };
      assert.match(r.markdown, /# Звіт по проєкту/);
      const x = await (await fetch(`${base}/api/projects/${project.id}/adr`)).json() as { decisions: unknown[] };
      assert.equal(x.decisions.length, 3);
    } finally { await srv.close(); }
  } finally { await orch.stop(); }
});

test('a rejection becomes a decision; an empty project has none', async () => {
  const { orch, project } = await setup();
  try {
    assert.match(adrMarkdown(orch.store, project.id), /Рішень ще немає/);
    const t = orch.createTask(project.id, { title: 'meh', allowedPaths: ['m.txt'], description: mock({ write: { 'm.txt': 'M' } }) });
    orch.submit(t.id);
    await waitStatus(orch, t.id, ['review']);
    orch.reject(t.id, 'use a better name', false);
    const d = decisions(orch.store, project.id);
    assert.equal(d.length, 1);
    assert.match(d[0]!.decision, /use a better name/);
  } finally { await orch.stop(); }
});
