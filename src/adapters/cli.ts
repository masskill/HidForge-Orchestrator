// Declarative adapters for real CLIs. Flags were checked against local `--help` output
// (claude 2.1.325, codex-cli 0.153.4, agy 1.5.9, cursor-agent 2026.11.05) and recorded stream fixtures in open-mercato/cezar (MIT).
// No permission-bypass flag is ever emitted.
import { run, resolveCommand } from '../proc.ts';
import type { AgentAdapter, AgentEvent, Capabilities, Invocation, ModelInfo, StartContext } from './types.ts';

interface CliSpec {
  id: string;
  name: string;
  bin: string;
  auth: () => Promise<{ auth: 'ok' | 'missing' | 'unknown'; reason: string | null }>;
  caps: Capabilities;
  notes: string[];
  build: (ctx: StartContext) => Omit<Invocation, 'command'>;
  parse: (o: Record<string, unknown>) => AgentEvent | null;
  /** Non-JSON stdout line -> explanatory error (e.g. a trust prompt in headless mode). */
  hint?: (line: string) => string | null;
  models?: () => Promise<ModelInfo[]>;
}

/** Parse `id<sep>label` lines printed by a CLI's model-list command. */
export const MODEL_LINE = { agy: /^(\S+)\t(.+)$/, cursor: /^([\w.\-[\],=]+) - (.+)$/ };
export function parseModelList(text: string, re: RegExp): ModelInfo[] {
  return text.split(/\r?\n/).map((l) => re.exec(l.trim())).filter((m): m is RegExpExecArray => Boolean(m)).map((m) => ({ id: m[1]!, label: m[2]!.trim() }));
}
async function listFrom(bin: string, args: string[], re: RegExp): Promise<ModelInfo[]> {
  const r = await run(bin, args, { timeoutMs: 60_000 });
  return r.code === 0 ? parseModelList(r.stdout, re) : [];
}

type O = Record<string, unknown>;
const str = (v: unknown) => (typeof v === 'string' ? v : v == null ? '' : JSON.stringify(v));
const nums = (u: unknown): Record<string, number> | undefined => {
  if (!u || typeof u !== 'object') return undefined;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(u as O)) if (typeof v === 'number') out[k] = v;
  return Object.keys(out).length ? out : undefined;
};

/** Claude Code / Cursor share the stream-json shape (system/assistant/user/result). */
function parseClaudeLike(o: O): AgentEvent | null {
  if (o.type === 'assistant') {
    const content = ((o.message as O)?.content as O[]) ?? [];
    const parts = content.map((c) => (c.type === 'text' ? str(c.text) : c.type === 'tool_use' ? `[tool] ${str(c.name)} ${str(c.input).slice(0, 300)}` : '')).filter(Boolean);
    const isTool = content.some((c) => c.type === 'tool_use');
    return parts.length ? { kind: isTool ? 'tool' : 'message', text: parts.join('\n') } : null;
  }
  if (o.type === 'result') {
    const usage = nums(o.usage) ?? {};
    if (typeof o.total_cost_usd === 'number') usage.total_cost_usd = o.total_cost_usd;
    return { kind: 'result', text: str(o.result), isError: o.is_error === true || o.subtype !== 'success', usage };
  }
  if (o.type === 'system') return { kind: 'log', text: `[system] ${str(o.subtype)}` };
  return null;
}

const generic = (bin: string) => async () => {
  const r = await run(bin, ['--version'], { timeoutMs: 20_000 });
  return r;
};

export const CLAUDE: CliSpec = {
  id: 'claude', name: 'Claude Code', bin: 'claude',
  async auth() {
    const r = await run('claude', ['auth', 'status'], { timeoutMs: 30_000 });
    // Only the boolean is read; the output (it contains the account e-mail) is not stored.
    try { const ok = JSON.parse(r.stdout).loggedIn === true; return { auth: ok ? 'ok' : 'missing', reason: ok ? null : 'run `claude auth login`' }; }
    catch { return { auth: 'unknown', reason: '`claude auth status` returned unparseable output' }; }
  },
  caps: { headless: 'supported', streamEvents: 'supported', cancel: 'supported', questions: 'unsupported', usage: 'supported', modelSelect: 'supported', readOnlyMode: 'supported' },
  notes: ['Runs `claude -p --output-format stream-json --permission-mode acceptEdits|plan`; shell commands are not pre-approved, so they are denied headlessly. Verification is done by HidForge gates.'],
  build: (c) => ({
    args: ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', c.policy === 'read-only' ? 'plan' : 'acceptEdits', ...(c.model ? ['--model', c.model] : []),
      ...(c.maxBudgetUsd ? ['--max-budget-usd', String(c.maxBudgetUsd)] : [])],
    stdin: c.prompt,
  }),
  parse: parseClaudeLike,
  // `claude` has no model-list command; these are the documented aliases (a full model name also works).
  models: async () => [{ id: 'haiku', label: 'Haiku (alias)' }, { id: 'sonnet', label: 'Sonnet (alias)' }, { id: 'opus', label: 'Opus (alias)' }],
};

export const CODEX: CliSpec = {
  id: 'codex', name: 'OpenAI Codex CLI', bin: 'codex',
  async auth() {
    const r = await run('codex', ['login', 'status'], { timeoutMs: 30_000 });
    return r.code === 0 ? { auth: 'ok', reason: null } : { auth: 'missing', reason: 'run `codex login`' };
  },
  caps: { headless: 'supported', streamEvents: 'supported', cancel: 'supported', questions: 'unsupported', usage: 'supported', modelSelect: 'supported', readOnlyMode: 'supported' },
  notes: [
    'Runs `codex exec --json --sandbox workspace-write|read-only`; Codex\'s own sandbox stays on.',
    'Without a model set on the task, Codex uses `model` from ~/.codex/config.toml. If your account rejects it, pick a model from the list (`codex debug models`); HidForge never edits your Codex config.',
  ],
  models: async () => {
    const r = await run('codex', ['debug', 'models'], { timeoutMs: 60_000 });
    try {
      const j = JSON.parse(r.stdout) as { models?: O[] } | O[];
      const arr = (Array.isArray(j) ? j : j.models ?? []) as O[];
      return arr.filter((m) => m.visibility === 'list').map((m) => ({ id: str(m.slug), label: str(m.display_name ?? m.slug) })).filter((m) => m.id);
    } catch { return []; }
  },
  build: (c) => ({
    args: ['exec', '--json', '--color', 'never', '--sandbox', c.policy === 'read-only' ? 'read-only' : 'workspace-write', '--cd', c.workspace, ...(c.model ? ['--model', c.model] : []), '-'],
    stdin: c.prompt,
  }),
  parse(o) {
    const t = str(o.type);
    if (t === 'item.completed') {
      const it = (o.item as O) ?? {};
      if (it.type === 'agent_message') return { kind: 'message', text: str(it.text) };
      if (it.type === 'command_execution') return { kind: 'tool', text: `[cmd] ${str(it.command)} -> ${str(it.exit_code)}` };
      if (it.type === 'file_change') return { kind: 'tool', text: `[files] ${((it.changes as O[]) ?? []).map((c) => `${str(c.kind)} ${str(c.path)}`).join(', ')}` };
      if (it.type === 'error') return { kind: 'error', text: str(it.message) };
      return null;
    }
    if (t === 'turn.completed') return { kind: 'result', text: 'turn completed', usage: nums(o.usage) };
    if (t === 'turn.failed') return { kind: 'result', text: str((o.error as O)?.message ?? o.error), isError: true };
    if (t === 'error') return { kind: 'error', text: str(o.message) };
    return null;
  },
};

export const CURSOR: CliSpec = {
  id: 'cursor', name: 'Cursor Agent CLI', bin: 'cursor-agent',
  async auth() {
    const r = await run('cursor-agent', ['status'], { timeoutMs: 30_000 });
    const text = r.stdout + r.stderr;
    if (/not (logged|authenticated)/i.test(text)) return { auth: 'missing', reason: 'run `cursor-agent login`' };
    if (r.code === 0 && /logged in|authenticated/i.test(text)) return { auth: 'ok', reason: null };
    return { auth: 'unknown', reason: 'could not determine login state from `cursor-agent status`' };
  },
  caps: { headless: 'supported', streamEvents: 'supported', cancel: 'supported', questions: 'unsupported', usage: 'unknown', modelSelect: 'supported', readOnlyMode: 'supported' },
  notes: [
    'Launched as `versions\\<latest>\\node.exe index.js` (no PowerShell). Flags checked against cursor-agent 2026.11.05 `--help`.',
    'Headless runs require Cursor workspace trust. HidForge never passes `--trust` unless you enable it for Cursor in Settings; `--force`/`--yolo` are never passed.',
  ],
  build: (c) => ({
    args: ['-p', '--output-format', 'stream-json', ...(c.policy === 'read-only' ? ['--mode', 'plan'] : []), ...(c.model ? ['--model', c.model] : []),
      ...(c.trustWorkspace ? ['--trust'] : [])],
    stdin: c.prompt,
  }),
  parse: parseClaudeLike,
  hint: (l) => (/Workspace Trust Required/i.test(l) ? 'Cursor requires workspace trust for headless runs. Enable "trust HidForge worktrees" for Cursor in Settings (your explicit decision), or use another agent.' : null),
  models: () => listFrom('cursor-agent', ['models'], MODEL_LINE.cursor),
};

export const AGY: CliSpec = {
  id: 'agy', name: 'Google Antigravity CLI', bin: 'agy',
  async auth() { return { auth: 'unknown', reason: 'agy has no documented non-interactive auth status command' }; },
  caps: { headless: 'supported', streamEvents: 'supported', cancel: 'supported', questions: 'unsupported', usage: 'supported', modelSelect: 'supported', readOnlyMode: 'supported' },
  notes: [
    'Runs `agy --input-format stream-json --output-format stream-json --mode accept-edits|plan --sandbox -p=`, prompt as one stdin frame (format from cezar live captures of agy 1.4).',
    'Verified 2026-11-16 with agy 1.5.9: file edits work without --dangerously-skip-permissions. Tools that need approval may stall; the stall timeout then stops the run.',
  ],
  build: (c) => ({
    args: ['--input-format', 'stream-json', '--output-format', 'stream-json', '--mode', c.policy === 'read-only' ? 'plan' : 'accept-edits', '--sandbox', ...(c.model ? ['--model', c.model] : []), '-p='],
    stdin: JSON.stringify({ event: 'user', message: { content: c.prompt } }) + '\n',
  }),
  models: () => listFrom('agy', ['models'], MODEL_LINE.agy),
  parse(o) {
    if (o.event === 'step_update') {
      const s = (o.step_update as O) ?? {};
      if (s.text_delta) return { kind: 'message', text: str(s.text_delta) };
      if (s.step_type && s.step_type !== 'agent_response' && s.state === 'DONE') return { kind: 'tool', text: `[step] ${str(s.step_type)}` };
      return null;
    }
    if (o.event === 'result') {
      const r = (o.result as O) ?? {};
      return { kind: 'result', text: str(r.response), isError: r.status !== 'SUCCESS', usage: nums(r.usage) };
    }
    if (o.event === 'error') return { kind: 'error', text: str(o.message ?? o.error) };
    return null;
  },
};

export class CliAdapter implements AgentAdapter {
  readonly mock = false;
  readonly spec: CliSpec;
  constructor(spec: CliSpec) { this.spec = spec; }
  get id() { return this.spec.id; }
  get name() { return this.spec.name; }

  async detect() {
    if (!resolveCommand(this.spec.bin)) return { installed: false, version: null, reason: `\`${this.spec.bin}\` not found on PATH` };
    const r = await generic(this.spec.bin)();
    const version = (r.stdout || r.stderr).trim().split(/\r?\n/)[0] ?? null;
    return r.code === 0 ? { installed: true, version, reason: null } : { installed: true, version: null, reason: `--version failed: ${version}` };
  }
  checkAuth() { return this.spec.auth(); }
  capabilities() { return this.spec.caps; }
  notes() { return this.spec.notes; }
  buildInvocation(ctx: StartContext): Invocation { return { command: this.spec.bin, ...this.spec.build(ctx) }; }
  async listModels(): Promise<ModelInfo[]> { return this.spec.models ? this.spec.models() : []; }
  parseLine(line: string): AgentEvent | null {
    const s = line.trim();
    if (!s) return null;
    if (!s.startsWith('{')) { const h = this.spec.hint?.(s); return h ? { kind: 'error', text: h } : { kind: 'log', text: s }; }
    try { return this.spec.parse(JSON.parse(s) as O); } catch { return { kind: 'log', text: s }; }
  }
}
