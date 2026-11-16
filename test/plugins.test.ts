// JSON plugin adapters (validation, safety, event mapping, loading) and the WSL2 wrapper.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { validatePlugin, parseWith, loadPlugins, pluginAdapter } from '../src/adapters/plugin.ts';
import { APP_PLUGINS_DIR } from '../src/adapters/index.ts';
import { toWslPath, WslAdapter, normalizeWsl } from '../src/adapters/wsl.ts';
import { Orchestrator } from '../src/orchestrator.ts';
import { tmpRoot } from './helpers.ts';

const base = { id: 'demo', name: 'Demo', bin: 'demo-cli', args: { base: ['run'] }, events: [{ match: { type: 'done' }, kind: 'result' }] };

test('plugin validation rejects unsafe or broken specs', () => {
  assert.ok(validatePlugin(base));
  const bad = (patch: object, re: RegExp) => assert.throws(() => validatePlugin({ ...base, ...patch }), re);
  bad({ args: { write: ['--yolo'] } }, /permission-bypass/);
  bad({ args: { write: ['--approval-mode=yolo'] } }, /permission-bypass/);
  bad({ args: { base: ['--dangerously-skip-permissions'] } }, /permission-bypass/);
  bad({ args: { base: ['-p', '{prompt}'] } }, /stdin/);
  bad({ args: { base: ['{model}'] } }, /only in args.model/);
  bad({ bin: 'C:\\tools\\x.exe' }, /bare command/);
  bad({ bin: 'a b' }, /bare command/);
  bad({ id: 'claude' }, /reserved/);
  bad({ events: [] }, /non-empty/);
  bad({ events: [{ match: {}, kind: 'boom' }] }, /kind/);
  bad({ models: { args: ['m'], pattern: '^\\S+$' } }, /capture group/);
});

test('shipped Gemini CLI and OpenCode specs load, keep the prompt on stdin and map events', () => {
  const r = loadPlugins([APP_PLUGINS_DIR]);
  assert.deepEqual(r.errors, []);
  const byId = Object.fromEntries(r.adapters.map((a) => [a.id, a]));
  for (const id of ['gemini', 'opencode']) {
    for (const policy of ['read-only', 'workspace-write'] as const) {
      const inv = byId[id]!.buildInvocation({ prompt: 'SECRET PROMPT', workspace: 'C:\\w', model: 'm', policy });
      assert.equal(inv.stdin, 'SECRET PROMPT');
      assert.ok(!inv.args.some((a) => a.includes('SECRET')));
      assert.doesNotMatch(inv.args.join(' '), /yolo|dangerously|bypass|--force|--trust/);
    }
  }
  assert.deepEqual(byId.gemini!.buildInvocation({ prompt: 'p', workspace: 'w', model: null, policy: 'read-only' }).args, ['--output-format', 'stream-json', '--approval-mode', 'plan']);
  const g = (o: object) => byId.gemini!.parseLine(JSON.stringify(o));
  assert.deepEqual(g({ type: 'message', role: 'assistant', content: 'hi', delta: true }), { kind: 'message', text: 'hi' });
  assert.equal(g({ type: 'message', role: 'user', content: 'prompt echo' }), null);
  assert.deepEqual(g({ type: 'result', status: 'error', stats: { total_tokens: 9, x: 'no' } }), { kind: 'result', text: 'error', usage: { total_tokens: 9 }, isError: true });
  const oc = (o: object) => byId.opencode!.parseLine(JSON.stringify(o));
  assert.equal(oc({ type: 'step_finish', part: { reason: 'tool-calls' } }), null, 'only the final step is the result');
  assert.deepEqual(oc({ type: 'step_finish', part: { reason: 'stop', cost: 0.01, tokens: { input: 5, output: 2, cache: { read: 7 } } } }),
    { kind: 'result', text: 'done', usage: { input_tokens: 5, output_tokens: 2, cache_read_tokens: 7, total_cost_usd: 0.01 }, isError: false });
  assert.deepEqual(oc({ type: 'text', part: { text: 'ok' } }), { kind: 'message', text: 'ok' });
});

test('templates and rules', () => {
  const rules = [{ match: { 'a.b': 1 }, kind: 'tool' as const, text: '[{a.c}] {missing}' }];
  assert.deepEqual(parseWith(rules, { a: { b: 1, c: { x: 1 } } }), { kind: 'tool', text: '[{"x":1}] ' });
  assert.equal(parseWith(rules, { a: { b: 2 } }), null);
  const a = pluginAdapter(validatePlugin({ ...base, args: { base: ['run'], model: ['--model', '{model}'] } }));
  assert.deepEqual(a.buildInvocation({ prompt: 'p', workspace: 'w', model: 'x/y', policy: 'workspace-write' }).args, ['run', '--model', 'x/y']);
  assert.equal(a.capabilities().readOnlyMode, 'unsupported');
});

test('user plugins load from the data dir; invalid ones are reported, not fatal', async () => {
  const dataDir = path.join(tmpRoot(), 'data');
  mkdirSync(path.join(dataDir, 'plugins'), { recursive: true });
  writeFileSync(path.join(dataDir, 'plugins', 'demo.json'), JSON.stringify(base));
  writeFileSync(path.join(dataDir, 'plugins', 'evil.json'), JSON.stringify({ ...base, id: 'evil', args: { base: ['--yolo'] } }));
  writeFileSync(path.join(dataDir, 'plugins', 'broken.json'), '{ nope');
  const orch = new Orchestrator({ dataDir });
  try {
    assert.ok(orch.registry.get('demo'));
    assert.ok(orch.registry.get('gemini'), 'shipped examples too');
    assert.equal(orch.registry.get('evil'), undefined);
    assert.deepEqual(orch.pluginErrors.map((e) => path.basename(e.file)).sort(), ['broken.json', 'evil.json']);
    const st = (await orch.registry.status()).find((s) => s.id === 'demo')!;
    assert.equal(st.installed, false, 'missing CLI is reported, not faked');
  } finally { orch.store.db.close(); }
});

test('WSL: path translation, wrapped invocation without a shell, settings validation', () => {
  assert.equal(toWslPath('E:\\scripts\\Мій проєкт\\wt'), '/mnt/e/scripts/Мій проєкт/wt');
  assert.equal(toWslPath('c:/x'), '/mnt/c/x');
  assert.equal(toWslPath('\\\\wsl$\\Ubuntu\\home\\u\\repo'), '/home/u/repo');
  assert.equal(toWslPath('\\\\wsl.localhost\\Ubuntu'), '/');
  assert.throws(() => toWslPath('\\\\server\\share\\x'), /cannot map/);

  const inner = pluginAdapter(validatePlugin(base));
  const w = new WslAdapter(inner, 'Ubuntu');
  assert.equal(w.id, 'demo-wsl');
  const inv = w.buildInvocation({ prompt: 'P', workspace: 'E:\\w t', model: null, policy: 'workspace-write' });
  assert.deepEqual(inv, { command: 'wsl.exe', args: ['-d', 'Ubuntu', '--cd', '/mnt/e/w t', '--exec', 'demo-cli', 'run'], stdin: 'P' });

  const known = (id: string) => ['claude', 'mock'].includes(id);
  assert.equal(normalizeWsl(null, known), null);
  assert.equal(normalizeWsl({ distro: '' }, known), null);
  assert.deepEqual(normalizeWsl({ distro: 'Ubuntu-24.04', agents: ['claude'] }, known), { distro: 'Ubuntu-24.04', agents: ['claude'] });
  assert.throws(() => normalizeWsl({ distro: 'x; rm -rf', agents: [] }, known), /letters/);
  assert.throws(() => normalizeWsl({ distro: 'U', agents: ['mock'] }, known), /unknown agent/);
});

test('WSL agents are added to the registry from settings', () => {
  const dataDir = path.join(tmpRoot(), 'data');
  const o1 = new Orchestrator({ dataDir });
  o1.store.setSetting('wsl', { distro: 'Ubuntu', agents: ['claude'] });
  o1.store.db.close();
  const o2 = new Orchestrator({ dataDir });
  try {
    assert.ok(o2.registry.get('claude-wsl'));
    assert.match(o2.registry.get('claude-wsl')!.name, /WSL: Ubuntu/);
  } finally { o2.store.db.close(); }
});
