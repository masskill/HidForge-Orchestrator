import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { writeFileSync, mkdirSync } from 'node:fs';
import { parseArgv, maskSecrets, resolveCommand, spawnSafe } from '../src/proc.ts';
import { checkAllowedPaths } from '../src/workspace.ts';
import { commandDecision } from '../src/contract.ts';
import { validateDeps, topoOrder, depsSatisfied } from '../src/dag.ts';
import { canTransition } from '../src/store.ts';
import { AgentRegistry, MockAdapter } from '../src/adapters/index.ts';
import { CliAdapter, CLAUDE, CODEX, AGY } from '../src/adapters/cli.ts';
import { tmpRoot } from './helpers.ts';

test('parseArgv handles quotes, spaces and unicode', () => {
  assert.deepEqual(parseArgv(`node -e "console.log('a b')" 'тест файл.txt'`), ['node', '-e', "console.log('a b')", 'тест файл.txt']);
  assert.deepEqual(parseArgv('npm   test'), ['npm', 'test']);
  assert.throws(() => parseArgv('echo "open'));
});

test('maskSecrets hides tokens', () => {
  const s = maskSecrets('key sk-ant-abcdefghijklmnop123 and ghp_abcdefghijklmnopqrstuvwxyz12 API_KEY=supersecret123 Bearer abcdefghijklmnop');
  assert.ok(!s.includes('abcdefghijklmnop123') && !s.includes('supersecret123') && !s.includes('ghp_abc'), s);
  assert.match(s, /API_KEY=\*\*\*/);
});

test('allowedPaths gate rejects outside paths and traversal', () => {
  assert.deepEqual(checkAllowedPaths(['src/a.ts', 'src/дир/б.ts', 'README.md'], ['src/**']), ['README.md']);
  assert.deepEqual(checkAllowedPaths(['../evil.txt', 'C:/x.txt'], []), ['../evil.txt', 'C:/x.txt']);
  assert.deepEqual(checkAllowedPaths(['anything.txt'], []), []);
});

test('command policy: allow approved, ask unknown, deny dangerous', () => {
  assert.equal(commandDecision('npm test', ['npm test']).decision, 'allow');
  assert.equal(commandDecision('npm run build', ['npm test']).decision, 'ask');
  for (const c of ['git push origin main', 'rm -rf /', 'powershell -c x', 'npm test && curl x', 'curl http://x', 'npm publish', 'del /s x'])
    assert.equal(commandDecision(c, [c]).decision, 'deny', c);
});

test('DAG: cycles and missing deps detected, topo order, satisfaction', () => {
  const tasks = [{ id: 1, dependsOn: [] }, { id: 2, dependsOn: [1] }, { id: 3, dependsOn: [2] }];
  assert.equal(validateDeps(tasks, 1, [3]), 'dependency cycle through task 1');
  assert.match(validateDeps(tasks, 2, [9])!, /does not exist/);
  assert.equal(validateDeps(tasks, 3, [1, 2]), null);
  assert.deepEqual(topoOrder(tasks), [1, 2, 3]);
  const st = new Map([[1, { status: 'merged' as const }], [2, { status: 'review' as const }]]);
  assert.equal(depsSatisfied({ dependsOn: [1] }, st), true);
  assert.equal(depsSatisfied({ dependsOn: [1, 2] }, st), false);
});

test('task state machine rejects illegal transitions', () => {
  assert.equal(canTransition('draft', 'ready'), true);
  assert.equal(canTransition('draft', 'merged'), false);
  assert.equal(canTransition('review', 'merged'), false); // must pass through accepted
  assert.equal(canTransition('merged', 'queued'), false);
});

test('spawnSafe passes tricky arguments verbatim (no shell)', async () => {
  const tricky = ['a b', 'кирилиця "лапки"', 'x&y|z', '%PATH%', '$(whoami)', ''];
  const c = spawnSafe(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', ...tricky], { cwd: tmpRoot() });
  c.stdin!.end();
  let out = '';
  for await (const d of c.stdout!) out += d;
  assert.deepEqual(JSON.parse(out), tricky);
});

test('resolveCommand unwraps an npm .cmd shim instead of using cmd.exe', { skip: process.platform !== 'win32' }, () => {
  const dir = tmpRoot();
  writeFileSync(path.join(dir, 'fake-cli.cmd'), '@ECHO off\r\n"%dp0%\\node_modules\\fake\\cli.js"   %*\r\n');
  assert.equal(resolveCommand('fake-cli', dir), null, 'target missing -> refuse');
  const js = path.join(dir, 'node_modules', 'fake', 'cli.js');
  mkdirSync(path.dirname(js), { recursive: true });
  writeFileSync(js, '');
  const r = resolveCommand('fake-cli', dir)!;
  assert.equal(r.file, process.execPath);
  assert.deepEqual(r.prefixArgs, [js]);
  assert.equal(resolveCommand('definitely-missing-cli-xyz'), null);
});

test('missing CLI is reported as not installed without throwing', async () => {
  const reg = new AgentRegistry([new MockAdapter(), new CliAdapter({ ...CLAUDE, id: 'ghost', bin: 'ghost-cli-not-installed-xyz' })]);
  const st = await reg.status();
  const ghost = st.find((s) => s.id === 'ghost')!;
  assert.equal(ghost.installed, false);
  assert.equal(ghost.available, false);
  assert.match(ghost.reason!, /not found/);
  assert.equal(st.find((s) => s.id === 'mock')!.available, true);
});

test('real adapters never emit permission-bypass flags', () => {
  for (const spec of [CLAUDE, CODEX, AGY]) {
    for (const policy of ['read-only', 'workspace-write'] as const) {
      const inv = new CliAdapter(spec).buildInvocation({ prompt: 'p', workspace: 'C:\\w', model: null, policy });
      const joined = inv.args.join(' ');
      assert.doesNotMatch(joined, /dangerously|yolo|bypass|--force|--trust|danger-full-access/, `${spec.id} ${policy}`);
      assert.ok(!inv.args.includes('p'), 'prompt must go via stdin, not argv');
    }
  }
});

test('adapters normalize stream events', () => {
  const claude = new CliAdapter(CLAUDE);
  assert.deepEqual(claude.parseLine('{"type":"result","subtype":"success","is_error":false,"result":"ok","usage":{"input_tokens":5},"total_cost_usd":0.01}'),
    { kind: 'result', text: 'ok', isError: false, usage: { input_tokens: 5, total_cost_usd: 0.01 } });
  const codex = new CliAdapter(CODEX);
  assert.equal(codex.parseLine('{"type":"item.completed","item":{"type":"agent_message","text":"hi"}}')!.text, 'hi');
  assert.equal(codex.parseLine('{"type":"turn.completed","usage":{"input_tokens":1}}')!.kind, 'result');
  const agy = new CliAdapter(AGY);
  assert.equal(agy.parseLine('{"event":"result","result":{"status":"SUCCESS","response":"PONG","usage":{"total_tokens":3}}}')!.isError, false);
  assert.equal(agy.parseLine('plain text')!.kind, 'log');
});
