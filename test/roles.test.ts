// Role templates: instructions in the contract, read-only roles, allowed agents per role.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { buildPrompt, normalizeRoleTemplates, roleTemplate, DEFAULT_ROLE_TEMPLATES } from '../src/contract.ts';
import { createServer } from '../src/server.ts';
import { setup, mock, waitStatus } from './helpers.ts';

test('role guidance goes into the contract; read-only template adds the read-only rule', () => {
  const p = { goal: 'G' } as never;
  const t = { id: 1, title: 'T', description: 'D', acceptanceCriteria: '', allowedPaths: [], verifyCommands: [], maxAttempts: 1, assignedRole: 'QA', policy: 'workspace-write', feedback: null } as never;
  const s = buildPrompt(t, p, 1, { instructions: 'Always add tests.', readOnly: true, providers: [] });
  assert.match(s, /## Role guidance\nAlways add tests\./);
  assert.match(s, /READ-ONLY task/);
  assert.doesNotMatch(buildPrompt(t, p, 1, roleTemplate({}, 'Backend')), /READ-ONLY task/);
});

test('template validation', () => {
  const known = (id: string) => ['mock', 'claude'].includes(id);
  const r = normalizeRoleTemplates({ QA: { instructions: 'x', readOnly: true, providers: ['claude'] }, Wizard: { instructions: 'y' } }, known);
  assert.deepEqual(r, { QA: { instructions: 'x', readOnly: true, providers: ['claude'] } });
  assert.throws(() => normalizeRoleTemplates({ QA: { providers: ['nope'] } }, known), /unknown provider/);
  assert.equal(DEFAULT_ROLE_TEMPLATES['Security Reviewer']!.readOnly, true);
});

test('scheduler enforces role templates: read-only role, allowed agents', async () => {
  const { orch, project } = await setup();
  try {
    orch.store.setSetting('roleTemplates', { QA: { instructions: 'Only tests.', readOnly: true, providers: [] }, Backend: { instructions: '', readOnly: false, providers: ['claude'] } });
    const qa = orch.createTask(project.id, { title: 'qa', assignedRole: 'QA', allowedPaths: ['q/**'], maxAttempts: 1, description: mock({ write: { 'q/q.txt': 'Q' } }) });
    const be = orch.createTask(project.id, { title: 'be', assignedRole: 'Backend', provider: 'mock', allowedPaths: ['b/**'], description: mock({ write: { 'b/b.txt': 'B' } }) });
    orch.submitAll(project.id);
    const tq = await waitStatus(orch, qa.id, ['blocked']);
    assert.equal(tq.policy, 'read-only', 'role template forced read-only');
    assert.match(String(tq.feedback), /read-only task modified files/);
    const tb = await waitStatus(orch, be.id, ['failed']);
    assert.match(tb.evidence.at(-1)!.summary, /role Backend may only use: claude/);
  } finally { await orch.stop(); }
});

test('role templates API', async () => {
  const { orch } = await setup();
  const srv = createServer(orch, { port: 0, webDir: path.resolve('web'), token: 't' });
  const base = `http://127.0.0.1:${await srv.listen()}`;
  const put = (body: object) => fetch(`${base}/api/settings`, { method: 'PUT', headers: { 'x-hidforge-token': 't' }, body: JSON.stringify(body) });
  try {
    const s0 = await (await fetch(`${base}/api/settings`)).json() as { roles: string[]; roleTemplates: Record<string, { readOnly: boolean }> };
    assert.equal(s0.roles.length, 7);
    assert.equal(s0.roleTemplates['Security Reviewer']!.readOnly, true);
    assert.equal((await put({ roleTemplates: { QA: { providers: ['nope'] } } })).status, 400);
    const s1 = await (await put({ roleTemplates: { QA: { instructions: 'tests', readOnly: false, providers: ['mock'] } } })).json() as { roleTemplates: Record<string, { providers: string[] }> };
    assert.deepEqual(s1.roleTemplates.QA!.providers, ['mock']);
    // reset = save without the role: the default comes back, and roleDefaults lets the UI tell edited roles apart
    await put({ roleTemplates: {} });
    const s2 = await (await fetch(`${base}/api/settings`)).json() as { roleTemplates: Record<string, { instructions: string }>; roleDefaults: Record<string, { instructions: string }> };
    assert.equal(s2.roleTemplates.QA!.instructions, s2.roleDefaults.QA!.instructions);
  } finally { await srv.close(); await orch.stop(); }
});
