// Paid API fallback: the API agent's tool loop against a fake local API server (no real API, no cost) and the CLI-first switch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGY, CLAUDE, CliAdapter } from '../src/adapters/cli.ts';
import { API_VENDORS, ApiFallbackAdapter, ApiOnlyAdapter } from '../src/adapters/api.ts';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'adapters', 'api-agent.ts');
type Body = Record<string, any>;

/** Fake API: answers each request with the next canned reply and records the request bodies. */
async function fakeApi(replies: Body[]) {
  const bodies: Body[] = [];
  const srv = http.createServer((req, res) => {
    let s = '';
    req.on('data', (c) => { s += c; });
    req.on('end', () => {
      bodies.push({ url: req.url, auth: req.headers.authorization ?? req.headers['x-api-key'], ...JSON.parse(s) });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(replies[Math.min(bodies.length - 1, replies.length - 1)]));
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  return { url: `http://127.0.0.1:${(srv.address() as { port: number }).port}`, bodies, close: () => srv.close() };
}

function runAgent(args: string[], env: Record<string, string>, cwd: string): Promise<Body[]> {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [SCRIPT, ...args], { cwd, env: { ...process.env, ...env } });
    let out = '';
    c.stdout.on('data', (d) => { out += d; });
    c.on('close', () => resolve(out.split('\n').filter(Boolean).map((l) => JSON.parse(l))));
    c.stdin.end('Create hello.txt');
  });
}

const msg = (content: Body[], stop_reason: string) => ({ id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content, stop_reason, stop_sequence: null,
  usage: { input_tokens: 1000, output_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } });

test('Anthropic API agent: writes inside the worktree, refuses paths outside it, passes effort and refusal fallback', async () => {
  const api = await fakeApi([
    msg([{ type: 'tool_use', id: 't1', name: 'write_file', input: { path: 'hello.txt', content: 'hi' } }, { type: 'tool_use', id: 't2', name: 'write_file', input: { path: '../evil.txt', content: 'x' } }], 'tool_use'),
    msg([{ type: 'text', text: 'Done: created hello.txt' }], 'end_turn'),
  ]);
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hf-api-'));
  const ev = await runAgent(['--vendor', 'anthropic', '--model', 'claude-opus-5-5', '--effort', 'high', '--policy', 'write'], { ANTHROPIC_API_KEY: 'test-key', ANTHROPIC_BASE_URL: api.url }, dir);
  api.close();
  assert.equal(readFileSync(path.join(dir, 'hello.txt'), 'utf8'), 'hi');
  assert.equal(existsSync(path.join(dir, '..', 'evil.txt')), false);
  const [first, second] = api.bodies;
  assert.equal(first!.output_config.effort, 'high');
  assert.equal(first!.fallbacks, 'default');
  assert.deepEqual(first!.tools.map((t: Body) => t.name), ['list_files', 'read_file', 'write_file']);
  const results = second!.messages.at(-1).content;
  assert.equal(results[0].is_error, false);
  assert.equal(results[1].is_error, true, 'path outside the worktree is refused');
  const r = ev.at(-1)!;
  assert.equal(r.type, 'result'); assert.equal(r.ok, true); assert.equal(r.text, 'Done: created hello.txt');
  assert.equal(r.usage.input_tokens, 2000);
  assert.ok(Math.abs(r.usage.total_cost_usd - (2000 * 4 + 200 * 20) / 1e6) < 1e-9, 'cost estimated from the Opus 5.5 price');
});

test('OpenAI-compatible API agent (Codex/Gemini fallback): read-only policy has no write tool', async () => {
  const api = await fakeApi([
    { choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'write_file', arguments: '{"path":"x.txt","content":"no"}' } }] } }], usage: { prompt_tokens: 10, completion_tokens: 5 } },
    { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'Reviewed.' } }], usage: { prompt_tokens: 20, completion_tokens: 5 } },
  ]);
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hf-api-'));
  const ev = await runAgent(['--vendor', 'gemini', '--model', 'gemini-4-argon', '--effort', 'medium', '--policy', 'read-only'], { GEMINI_API_KEY: 'test-key', GEMINI_BASE_URL: api.url }, dir);
  api.close();
  assert.equal(existsSync(path.join(dir, 'x.txt')), false, 'read-only run cannot write');
  assert.equal(api.bodies[0]!.url, '/chat/completions');
  assert.equal(api.bodies[0]!.auth, 'Bearer test-key');
  assert.equal(api.bodies[0]!.reasoning_effort, 'medium');
  assert.deepEqual(api.bodies[0]!.tools.map((t: Body) => t.function.name), ['list_files', 'read_file']);
  assert.match(api.bodies[1]!.messages.at(-1).content, /unknown tool write_file/);
  assert.deepEqual(ev.at(-1), { type: 'result', ok: true, text: 'Reviewed.', usage: { input_tokens: 30, output_tokens: 10, billing: 'api' } });
});

test('CLI first, API second: API only when the CLI is missing, the key is set and paid API is allowed', async (t) => {
  const saved = process.env.ANTHROPIC_API_KEY;
  t.after(() => { if (saved === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = saved; });
  let allowed = false;
  const missing = new ApiFallbackAdapter(new CliAdapter({ ...CLAUDE, bin: 'hidforge-no-such-cli' }), API_VENDORS.claude!, () => allowed);

  delete process.env.ANTHROPIC_API_KEY;
  let d = await missing.detect();
  assert.equal(d.installed, false); assert.match(d.reason!, /ANTHROPIC_API_KEY/);

  process.env.ANTHROPIC_API_KEY = 'test-key';
  d = await missing.detect();
  assert.equal(d.installed, false, 'key alone is not enough: paid API must be enabled'); assert.match(d.reason!, /вимкнено/);

  allowed = true;
  d = await missing.detect();
  assert.equal(d.installed, true); assert.match(missing.name, /API/);
  const inv = missing.buildInvocation({ prompt: 'p', workspace: '.', model: 'opus', effort: 'high', policy: 'write' as never, maxBudgetUsd: 2 });
  assert.equal(inv.command, process.execPath);
  assert.deepEqual(inv.args.slice(1), ['--vendor', 'anthropic', '--model', 'claude-opus-5-5', '--policy', 'write', '--effort', 'high', '--max-usd', '2']);
  assert.equal(inv.stdin, 'p');

  const agy = new ApiFallbackAdapter(new CliAdapter({ ...AGY, bin: 'hidforge-no-such-cli' }), API_VENDORS.agy!, () => true);
  process.env.GEMINI_API_KEY = 'test-key';
  t.after(() => { delete process.env.GEMINI_API_KEY; });
  await agy.detect();
  const a = agy.buildInvocation({ prompt: 'p', workspace: '.', model: 'gemini-4-hydrogen-high', effort: null, policy: 'read-only' as never });
  assert.deepEqual(a.args.slice(1, 5), ['--vendor', 'gemini', '--model', 'gemini-4-hydrogen'], 'effort suffix is moved out of the model id');
  assert.deepEqual(a.args.slice(-2), ['--effort', 'high']);

  // An installed CLI is always used, even with a key and paid API allowed.
  const node = new ApiFallbackAdapter(new CliAdapter({ ...CLAUDE, bin: 'node' }), API_VENDORS.claude!, () => true);
  assert.equal((await node.detect()).installed, true);
  assert.equal(node.buildInvocation({ prompt: 'p', workspace: '.', model: null, policy: 'write' as never }).command, 'node');
});

test('API-only provider (DeepSeek, Kimi, ...): any OpenAI-compatible base URL and key variable; effort only where the API takes it', async (t) => {
  const api = await fakeApi([{ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }]);
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hf-api-'));
  const ev = await runAgent(['--vendor', 'example', '--base', api.url + '/v1', '--key-env', 'EXAMPLE_API_KEY', '--model', 'm1', '--policy', 'write'], { EXAMPLE_API_KEY: 'k' }, dir);
  api.close();
  assert.equal(api.bodies[0]!.url, '/v1/chat/completions');
  assert.equal(api.bodies[0]!.auth, 'Bearer k');
  assert.equal(api.bodies[0]!.model, 'm1');
  assert.equal(ev.at(-1)!.ok, true);

  const p = { id: 'example', name: 'Example', keyEnv: 'EXAMPLE_API_KEY', base: 'https://api.example.test/v1', defaultModel: 'm-default', models: ['m-default'], effort: null };
  let allowed = false;
  const ad = new ApiOnlyAdapter(p, () => allowed);
  t.after(() => { delete process.env.EXAMPLE_API_KEY; });
  delete process.env.EXAMPLE_API_KEY;
  assert.match((await ad.checkAuth()).reason!, /EXAMPLE_API_KEY/);
  process.env.EXAMPLE_API_KEY = 'k';
  assert.match((await ad.checkAuth()).reason!, /вимкнено/);
  allowed = true;
  assert.equal((await ad.checkAuth()).auth, 'ok');
  const inv = ad.buildInvocation({ prompt: 'p', workspace: '.', model: null, effort: 'high', policy: 'write' as never });
  assert.deepEqual(inv.args.slice(1), ['--vendor', 'example', '--base', p.base, '--key-env', 'EXAMPLE_API_KEY', '--model', 'm-default', '--policy', 'write'], 'no --effort for an API without it');
});

test('thinking APIs (DeepSeek, MiniMax, Kimi): reasoning_content goes back with the tool call', async () => {
  const api = await fakeApi([
    { choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null, reasoning_content: 'think', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'list_files', arguments: '{"path":"."}' } }] } }] },
    { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'done' } }] },
  ]);
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hf-api-'));
  await runAgent(['--vendor', 'deepseek', '--base', api.url, '--key-env', 'K', '--model', 'm', '--policy', 'read-only'], { K: 'k' }, dir);
  api.close();
  assert.equal(api.bodies[1]!.messages[2].reasoning_content, 'think');
});
