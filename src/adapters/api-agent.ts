// API agent: a small file-editing tool loop run as a child process, used only when a provider's CLI is missing
// and the user both set the provider's API key (environment / .env, never the HidForge DB) and allowed paid API use.
// Prints the same JSON lines as the mock agent: {type: message|tool|error|result}.
// Tools: list_files, read_file, write_file (write only when --policy is not read-only). No shell: verification is done by HidForge gates.
import { readdirSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import type Anthropic from '@anthropic-ai/sdk';

const { values: a } = parseArgs({ options: { vendor: { type: 'string' }, model: { type: 'string' }, effort: { type: 'string' }, policy: { type: 'string' }, 'max-usd': { type: 'string' }, base: { type: 'string' }, 'key-env': { type: 'string' } } });
const READ_ONLY = a.policy === 'read-only';
const MAX_TURNS = 60;
const MAX_READ = 200_000;
const out = (o: unknown) => process.stdout.write(JSON.stringify(o) + '\n');

// Anthropic API prices, USD per 1M tokens (input, output), from the Claude API reference cached 2026-11-03. Used only to estimate cost and stop at --max-usd.
const PRICES: Record<string, [number, number]> = { 'claude-opus-5-5': [4, 20], 'claude-sonnet-5-5': [2, 10], 'claude-haiku-5-5': [0.1, 0.5] };

const SYSTEM = [
  'You are a coding agent working inside a git worktree (the current directory). Use the tools to inspect files' + (READ_ONLY ? '. You must not change any file.' : ' and to create or change them.'),
  'There is no shell: you cannot run commands or tests. Paths are relative to the worktree root.',
  'When you are done, reply with a short summary of what you did, without calling a tool.',
].join('\n');

// ---------------------------------------------------------------- tools (paths confined to the worktree)
interface ToolDef { name: string; description: string; parameters: { type: 'object'; properties: Record<string, { type: 'string'; description: string }>; required: string[]; additionalProperties: false } }
const p = (description: string) => ({ type: 'string' as const, description });
const TOOLS: ToolDef[] = [
  { name: 'list_files', description: 'List the entries of a directory in the worktree (directories end with /).', parameters: { type: 'object', properties: { path: p('Directory, relative; "." for the root') }, required: ['path'], additionalProperties: false } },
  { name: 'read_file', description: 'Read a UTF-8 text file from the worktree.', parameters: { type: 'object', properties: { path: p('File path, relative') }, required: ['path'], additionalProperties: false } },
  ...(READ_ONLY ? [] : [{ name: 'write_file', description: 'Create or overwrite a UTF-8 text file in the worktree with the full new content.', parameters: { type: 'object' as const, properties: { path: p('File path, relative'), content: p('Complete file content') }, required: ['path', 'content'], additionalProperties: false as const } }]),
];

const root = process.cwd();
function inside(rel: unknown): string {
  if (typeof rel !== 'string' || !rel) throw new Error('path is required');
  const abs = path.resolve(root, rel);
  const r = path.relative(root, abs);
  if (r.startsWith('..') || path.isAbsolute(r) || r.split(/[\\/]/)[0] === '.git') throw new Error(`path outside the worktree: ${rel}`);
  return abs;
}
function runTool(name: string, input: Record<string, unknown>): string {
  if (name === 'list_files') return readdirSync(inside(input.path || '.'), { withFileTypes: true }).filter((d) => d.name !== '.git').slice(0, 500).map((d) => d.name + (d.isDirectory() ? '/' : '')).join('\n') || '(empty)';
  if (name === 'read_file') {
    const f = inside(input.path);
    if (statSync(f).size > MAX_READ) throw new Error(`file is larger than ${MAX_READ} bytes`);
    return readFileSync(f, 'utf8');
  }
  if (name === 'write_file' && !READ_ONLY) {
    const f = inside(input.path);
    if (typeof input.content !== 'string') throw new Error('content must be a string');
    mkdirSync(path.dirname(f), { recursive: true });
    writeFileSync(f, input.content, 'utf8');
    return `wrote ${input.path} (${input.content.length} chars)`;
  }
  throw new Error(`unknown tool ${name}`);
}
function call(name: string, input: Record<string, unknown>): { text: string; isError: boolean } {
  out({ type: 'tool', text: `[${name}] ${String(input.path ?? '')}` });
  try { return { text: runTool(name, input), isError: false }; } catch (e) { return { text: `error: ${(e as Error).message}`, isError: true }; }
}

// ---------------------------------------------------------------- Anthropic (official SDK)
async function anthropic(prompt: string) {
  const { default: AnthropicClient } = await import('@anthropic-ai/sdk');
  const client = new AnthropicClient(); // ANTHROPIC_API_KEY (and optional ANTHROPIC_BASE_URL) from the environment
  const model = a.model || 'claude-opus-5-5';
  const price = PRICES[model];
  const maxUsd = Number(a['max-usd']) || 0;
  const usage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  const usd = () => (price ? (usage.input_tokens * price[0] + usage.cache_creation_input_tokens * price[0] * 1.25 + usage.cache_read_input_tokens * price[0] * 0.1 + usage.output_tokens * price[1]) / 1e6 : undefined);
  const tools: Anthropic.Beta.BetaTool[] = TOOLS.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters, strict: true }));
  const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: 'user', content: prompt }];
  // Server-side refusal fallback exists for Opus/Sonnet 5.5, not for Haiku 5.5.
  const fallback = /^claude-(opus|sonnet)-5-5/.test(model);
  let last = '';
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const r = await client.beta.messages.create({
      model, max_tokens: 16000, system: SYSTEM, tools, messages, cache_control: { type: 'ephemeral' },
      ...(a.effort ? { output_config: { effort: a.effort as 'low' | 'medium' | 'high' } } : {}),
      ...(fallback ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
    });
    for (const k of Object.keys(usage) as (keyof typeof usage)[]) usage[k] += r.usage[k] ?? 0;
    const text = r.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n').trim();
    if (text) { last = text; out({ type: 'message', text }); }
    const done = (ok: boolean, t: string) => out({ type: 'result', ok, text: t, usage: { ...usage, billing: 'api', ...(usd() !== undefined ? { total_cost_usd: usd() } : {}) } });
    if (r.stop_reason === 'refusal') return done(false, `model refused: ${r.stop_details?.category ?? 'unknown'}`);
    if (r.stop_reason === 'max_tokens') return done(false, 'response hit max_tokens');
    if (r.stop_reason !== 'tool_use') return done(true, last);
    messages.push({ role: 'assistant', content: r.content });
    const results: Anthropic.Beta.BetaToolResultBlockParam[] = r.content.flatMap((b) => {
      if (b.type !== 'tool_use') return [];
      const res = call(b.name, b.input as Record<string, unknown>);
      return [{ type: 'tool_result' as const, tool_use_id: b.id, content: res.text, is_error: res.isError }];
    });
    messages.push({ role: 'user', content: results });
    if (maxUsd && (usd() ?? 0) > maxUsd) return done(false, `stopped: estimated cost $${usd()!.toFixed(2)} exceeded the task budget $${maxUsd}`);
  }
  return out({ type: 'result', ok: false, text: `stopped after ${MAX_TURNS} turns`, usage: { ...usage, billing: 'api' } });
}

// ---------------------------------------------------------------- OpenAI-compatible chat completions (OpenAI, Gemini)
const COMPAT: Record<string, { key: string; base: string; baseEnv: string }> = {
  openai: { key: 'OPENAI_API_KEY', base: 'https://api.openai.com/v1', baseEnv: 'OPENAI_BASE_URL' },
  gemini: { key: 'GEMINI_API_KEY', base: 'https://generativelanguage.googleapis.com/v1beta/openai', baseEnv: 'GEMINI_BASE_URL' },
};
interface ChatMsg { role: string; content: string | null; reasoning_content?: string; tool_calls?: { id: string; function: { name: string; arguments: string } }[]; tool_call_id?: string }
async function compat(vendor: string, prompt: string) {
  // Other OpenAI-compatible providers (DeepSeek, Kimi, MiniMax, ...) pass --base and --key-env.
  const c = COMPAT[vendor] ?? { key: a['key-env']!, base: a.base!, baseEnv: '' };
  const base = ((c.baseEnv && process.env[c.baseEnv]) || c.base).replace(/\/$/, '');
  const usage = { input_tokens: 0, output_tokens: 0 };
  const messages: ChatMsg[] = [{ role: 'system', content: SYSTEM }, { role: 'user', content: prompt }];
  let last = '';
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env[c.key]}` },
      body: JSON.stringify({ model: a.model, messages, tools: TOOLS.map((t) => ({ type: 'function', function: t })), ...(a.effort ? { reasoning_effort: a.effort } : {}) }),
    });
    if (!res.ok) throw new Error(`${vendor} API ${res.status}: ${(await res.text()).slice(0, 500)}`);
    const j = await res.json() as { choices: { message: ChatMsg; finish_reason: string }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } };
    usage.input_tokens += j.usage?.prompt_tokens ?? 0;
    usage.output_tokens += j.usage?.completion_tokens ?? 0;
    const m = j.choices[0]!.message;
    if (m.content?.trim()) { last = m.content.trim(); out({ type: 'message', text: last }); }
    if (!m.tool_calls?.length) return out({ type: 'result', ok: j.choices[0]!.finish_reason !== 'length', text: last, usage: { ...usage, billing: 'api' } });
    // DeepSeek, MiniMax and Kimi thinking models require their reasoning_content back after tool calls.
    messages.push({ role: 'assistant', content: m.content ?? null, tool_calls: m.tool_calls, ...(m.reasoning_content ? { reasoning_content: m.reasoning_content } : {}) });
    for (const tc of m.tool_calls) {
      let input: Record<string, unknown> = {};
      try { input = JSON.parse(tc.function.arguments || '{}'); } catch { /* reported by the tool as a missing path */ }
      messages.push({ role: 'tool', tool_call_id: tc.id, content: call(tc.function.name, input).text });
    }
  }
  return out({ type: 'result', ok: false, text: `stopped after ${MAX_TURNS} turns`, usage: { ...usage, billing: 'api' } });
}

let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { prompt += c; });
process.stdin.on('end', () => {
  out({ type: 'message', text: `API agent (${a.vendor} · ${a.model ?? 'default'}${a.effort ? ` · ${a.effort}` : ''}, ${READ_ONLY ? 'read-only' : 'read/write'}) — paid API call` });
  (a.vendor === 'anthropic' ? anthropic(prompt) : COMPAT[a.vendor ?? ''] || (a.base && a['key-env']) ? compat(a.vendor!, prompt) : Promise.reject(new Error(`unknown vendor ${a.vendor}`)))
    .then(() => process.exit(0), (e: Error) => { out({ type: 'result', ok: false, text: `API error: ${e.message}` }); process.exit(1); });
});
