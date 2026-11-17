// "CLI first, API second": wraps a CLI adapter. While the CLI is installed and logged in, everything goes through the CLI.
// When it is missing (or not logged in), the same agent id runs the API agent instead — but only if the provider's key is set
// in the environment (.env) and the user enabled paid API use in Settings. Keys are never stored in the HidForge DB.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CliAdapter } from './cli.ts';
import { MockAdapter } from './index.ts';
import type { AgentAdapter, AgentEvent, Capabilities, Invocation, ModelInfo, StartContext } from './types.ts';

const here = fileURLToPath(import.meta.url);
const API_SCRIPT = path.join(path.dirname(here), 'api-agent' + path.extname(here));

interface Vendor { vendor: 'anthropic' | 'openai' | 'gemini'; keyEnv: string; defaultModel: string; models: string[]; map: (m: string | null) => { model: string; effort: string | null } }
const EFFORT_SUFFIX = /-(low|medium|high)$/;
/** Agent id -> API that can stand in for its CLI. Model ids for OpenAI/Gemini are passed as the CLI names them; not verified against the APIs. */
export const API_VENDORS: Record<string, Vendor> = {
  claude: { vendor: 'anthropic', keyEnv: 'ANTHROPIC_API_KEY', defaultModel: 'claude-opus-5-5', models: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'],
    map: (m) => ({ model: m ? ({ opus: 'claude-opus-5-5', sonnet: 'claude-sonnet-5-5', haiku: 'claude-haiku-5-5' } as Record<string, string>)[m] ?? m : 'claude-opus-5-5', effort: null }) },
  codex: { vendor: 'openai', keyEnv: 'OPENAI_API_KEY', defaultModel: 'gpt-6.1-sol', models: ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6.1-terra', 'gpt-6-luna'], map: (m) => ({ model: m || 'gpt-6.1-sol', effort: null }) },
  agy: { vendor: 'gemini', keyEnv: 'GEMINI_API_KEY', defaultModel: 'gemini-4-argon', models: ['gemini-4-argon', 'gemini-4-hydrogen'],
    map: (m) => ({ model: (m || 'gemini-4-argon').replace(EFFORT_SUFFIX, ''), effort: EFFORT_SUFFIX.exec(m ?? '')?.[1] ?? null }) },
};
/** Which provider keys are present (booleans only — values are never read out). */
export const apiKeysPresent = () => [
  ...Object.entries(API_VENDORS).map(([id, v]) => ({ key: v.keyEnv, label: `${({ claude: 'Claude Code', codex: 'Codex', agy: 'Antigravity' } as Record<string, string>)[id]} → ${v.vendor} API (якщо немає CLI)` })),
  ...API_PROVIDERS.map((p) => ({ key: p.keyEnv, label: p.name })),
].map((k) => ({ ...k, present: Boolean(process.env[k.key]) }));

const API_CAPS: Capabilities = { headless: 'supported', streamEvents: 'supported', cancel: 'supported', questions: 'unsupported', usage: 'supported', modelSelect: 'supported', readOnlyMode: 'supported' };
let jsonLines: MockAdapter | null = null; // lazy: index.ts imports this module (circular import)

export class ApiFallbackAdapter implements AgentAdapter {
  readonly mock = false;
  private viaApi = false;
  readonly inner: CliAdapter;
  private readonly v: Vendor;
  private readonly allowed: () => boolean;
  constructor(inner: CliAdapter, v: Vendor, allowed: () => boolean) { this.inner = inner; this.v = v; this.allowed = allowed; }
  get id() { return this.inner.id; }
  get spec() { return this.inner.spec; } // WSL/SSH wrappers read the CLI binary name from here
  get name() { return this.viaApi ? `${this.inner.name} — через API (платно)` : this.inner.name; }
  private apiReady() { return Boolean(process.env[this.v.keyEnv]) && this.allowed(); }
  private apiHint() {
    return process.env[this.v.keyEnv] ? 'платні API-запити вимкнено в Налаштуваннях' : `або впишіть ${this.v.keyEnv} у .env і ввімкніть платні API-запити в Налаштуваннях — тоді працюватиме ${this.v.vendor} API`;
  }

  async detect() {
    const d = await this.inner.detect();
    this.viaApi = !d.installed && this.apiReady();
    if (this.viaApi) return { installed: true, version: `${this.v.vendor} API`, reason: null };
    return d.installed ? d : { ...d, reason: `${d.reason}; ${this.apiHint()}` };
  }
  async checkAuth() {
    if (this.viaApi) return { auth: 'ok' as const, reason: null };
    const au = await this.inner.checkAuth();
    if (au.auth === 'missing' && this.apiReady()) { this.viaApi = true; return { auth: 'ok' as const, reason: null }; }
    return au;
  }
  capabilities() { return this.viaApi ? API_CAPS : this.inner.capabilities(); }
  notes() {
    return [...this.inner.notes(), `Fallback: if the CLI is missing or not logged in, ${this.v.vendor} API is used — only with ${this.v.keyEnv} in .env and paid API enabled in Settings. The API agent reads and writes files in the worktree; it cannot run commands.`];
  }
  buildInvocation(ctx: StartContext): Invocation {
    if (!this.viaApi) return this.inner.buildInvocation(ctx);
    const m = this.v.map(ctx.model);
    const effort = ctx.effort ?? m.effort;
    return { command: process.execPath, stdin: ctx.prompt,
      args: [API_SCRIPT, '--vendor', this.v.vendor, '--model', m.model, '--policy', ctx.policy, ...(effort ? ['--effort', effort] : []), ...(ctx.maxBudgetUsd ? ['--max-usd', String(ctx.maxBudgetUsd)] : [])] };
  }
  parseLine(line: string): AgentEvent | null { return this.viaApi ? (jsonLines ??= new MockAdapter()).parseLine(line) : this.inner.parseLine(line); }
  async listModels(): Promise<ModelInfo[]> { return this.viaApi ? this.v.models.map((id) => ({ id, label: `${id} (API)` })) : this.inner.listModels(); }
}

/** API-only providers (no CLI on this PC): OpenAI-compatible Chat Completions. Facts checked 2026-11-17, sources in docs/ROUTING.md. */
/** `effort`: HidForge level -> the value this API accepts (null = the parameter is not sent: unsupported or model-dependent). */
export interface ApiProvider { id: string; name: string; keyEnv: string; base: string; defaultModel: string; models: string[]; effort: Partial<Record<string, string>> | null }
const LOW_HIGH = { low: 'low', medium: 'high', high: 'high' }; // APIs with only low|high|max
export const API_PROVIDERS: ApiProvider[] = [
  { id: 'deepseek', name: 'DeepSeek', keyEnv: 'DEEPSEEK_API_KEY', base: 'https://api.deepseek.com', defaultModel: 'deepseek-v4-pro', models: ['deepseek-v4-pro', 'deepseek-flash'], effort: LOW_HIGH },
  { id: 'kimi', name: 'Kimi (Moonshot AI)', keyEnv: 'MOONSHOT_API_KEY', base: 'https://api.moonshot.ai/v1', defaultModel: 'kimi-k3.1-pro', models: ['kimi-k3.1-pro', 'kimi-k3.1-pro-highspeed', 'kimi-k3'], effort: LOW_HIGH },
  { id: 'minimax', name: 'MiniMax', keyEnv: 'MINIMAX_API_KEY', base: 'https://api.minimax.io/v1', defaultModel: 'MiniMax-M3', models: ['MiniMax-M3', 'MiniMax-M3.1-Flash'], effort: null },
  { id: 'qwen', name: 'Qwen (Alibaba Model Studio)', keyEnv: 'DASHSCOPE_API_KEY', base: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', defaultModel: 'qwen4-max', models: ['qwen4-max', 'qwen3.8-flash'], effort: null },
  { id: 'glm', name: 'GLM (Z.ai)', keyEnv: 'ZAI_API_KEY', base: 'https://api.z.ai/api/paas/v4', defaultModel: 'glm-5.3', models: ['glm-5.3', 'glm-5.3-flash'], effort: LOW_HIGH },
  { id: 'grok', name: 'Grok (xAI)', keyEnv: 'XAI_API_KEY', base: 'https://api.x.ai/v1', defaultModel: 'grok-build-0.1', models: ['grok-build-0.1', 'grok-4.7'], effort: null },
  { id: 'mistral', name: 'Mistral', keyEnv: 'MISTRAL_API_KEY', base: 'https://api.mistral.ai/v1', defaultModel: 'mistral-large-4', models: ['mistral-large-4', 'mistral-small-latest'], effort: null },
  { id: 'openrouter', name: 'OpenRouter (моделі різних вендорів)', keyEnv: 'OPENROUTER_API_KEY', base: 'https://openrouter.ai/api/v1', defaultModel: 'deepseek/deepseek-v4.1-flash-20261017',
    models: ['deepseek/deepseek-v4.1-flash-20261017', 'anthropic/claude-opus-5.5-20260921'], effort: { low: 'low', medium: 'medium', high: 'high' } },
];

/** Runs only through the provider's API: needs the key in .env and paid API enabled in Settings. */
export class ApiOnlyAdapter implements AgentAdapter {
  readonly mock = false;
  readonly apiOnly = true;
  readonly p: ApiProvider;
  private readonly allowed: () => boolean;
  constructor(p: ApiProvider, allowed: () => boolean) { this.p = p; this.allowed = allowed; }
  get id() { return this.p.id; }
  get name() { return `${this.p.name} — API (платно)`; }
  async detect() { return { installed: true, version: 'API', reason: null }; }
  async checkAuth() {
    if (!process.env[this.p.keyEnv]) return { auth: 'missing' as const, reason: `впишіть ${this.p.keyEnv} у .env і ввімкніть платні API-запити в Налаштуваннях` };
    if (!this.allowed()) return { auth: 'missing' as const, reason: 'платні API-запити вимкнено в Налаштуваннях' };
    return { auth: 'ok' as const, reason: null };
  }
  capabilities() { return API_CAPS; }
  notes() { return [`OpenAI-compatible API at ${this.p.base}, key from ${this.p.keyEnv} (.env). Reads and writes files in the worktree; cannot run commands. Paid per request.`]; }
  buildInvocation(ctx: StartContext): Invocation {
    const effort = ctx.effort ? this.p.effort?.[ctx.effort] ?? null : null;
    return { command: process.execPath, stdin: ctx.prompt,
      args: [API_SCRIPT, '--vendor', this.p.id, '--base', this.p.base, '--key-env', this.p.keyEnv, '--model', ctx.model || this.p.defaultModel, '--policy', ctx.policy, ...(effort ? ['--effort', effort] : [])] };
  }
  parseLine(line: string): AgentEvent | null { return (jsonLines ??= new MockAdapter()).parseLine(line); }
  /** Live list from the provider's GET /models (free metadata call); falls back to the known ids. */
  async listModels(): Promise<ModelInfo[]> {
    const key = process.env[this.p.keyEnv];
    if (key) {
      try {
        const r = await fetch(`${this.p.base}/models`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(20_000) });
        const j = await r.json() as { data?: { id?: string }[] };
        const ids = (j.data ?? []).map((m) => m.id).filter((x): x is string => Boolean(x));
        if (r.ok && ids.length) return ids.map((id) => ({ id, label: id }));
      } catch { /* offline or rejected: use the known ids */ }
    }
    return this.p.models.map((id) => ({ id, label: `${id}${id === this.p.defaultModel ? ' (типова)' : ''}` }));
  }
}
