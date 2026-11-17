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
export const apiKeysPresent = () => Object.fromEntries(Object.values(API_VENDORS).map((v) => [v.keyEnv, Boolean(process.env[v.keyEnv])]));

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
    return process.env[this.v.keyEnv] ? 'paid API fallback is off in Settings' : `set ${this.v.keyEnv} in .env and enable paid API fallback in Settings to use the ${this.v.vendor} API instead`;
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
