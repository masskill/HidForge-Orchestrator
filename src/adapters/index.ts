// Agent registry: real CLI adapters + the deterministic Mock Agent; availability detection and routing.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGY, CLAUDE, CODEX, CURSOR, CliAdapter } from './cli.ts';
import type { AgentAdapter, AgentEvent, AgentStatus, Capabilities } from './types.ts';

const here = fileURLToPath(import.meta.url);
const MOCK_SCRIPT = path.join(path.dirname(here), 'mock-agent' + path.extname(here));

export class MockAdapter implements AgentAdapter {
  readonly id = 'mock';
  readonly name = 'Mock Agent (deterministic, demo/test)';
  readonly mock = true;
  async detect() { return { installed: true, version: 'builtin', reason: null }; }
  async checkAuth() { return { auth: 'ok' as const, reason: null }; }
  capabilities(): Capabilities {
    return { headless: 'supported', streamEvents: 'supported', cancel: 'supported', questions: 'unsupported', usage: 'supported', modelSelect: 'unsupported', readOnlyMode: 'unsupported' };
  }
  notes() { return ['Does not call any AI. Behaviour is controlled by an `@mock {json}` line in the task description.']; }
  buildInvocation(ctx: { prompt: string }) { return { command: process.execPath, args: [MOCK_SCRIPT], stdin: ctx.prompt }; }
  parseLine(line: string): AgentEvent | null {
    try {
      const o = JSON.parse(line) as { type: string; text?: string; ok?: boolean; usage?: Record<string, number> };
      if (o.type === 'result') return { kind: 'result', text: o.text ?? '', isError: o.ok === false, usage: o.usage };
      return { kind: (['message', 'tool', 'error'].includes(o.type) ? o.type : 'log') as AgentEvent['kind'], text: o.text ?? '' };
    } catch { return line.trim() ? { kind: 'log', text: line } : null; }
  }
}

/** Shipped JSON plugin specs (examples); users add their own to <dataDir>/plugins. */
export const APP_PLUGINS_DIR = path.join(path.dirname(here), '..', '..', 'plugins');

export function defaultAdapters(): AgentAdapter[] {
  return [new MockAdapter(), new CliAdapter(CLAUDE), new CliAdapter(CODEX), new CliAdapter(CURSOR), new CliAdapter(AGY)];
}

export type RoutingPolicy = 'cost-first' | 'balanced' | 'quality-first';
// Transparent, user-editable rule table. These orders are defaults, NOT measured quality/cost data.
export const DEFAULT_ROUTING: Record<RoutingPolicy, string[]> = {
  'cost-first': ['agy', 'codex', 'cursor', 'claude'],
  balanced: ['codex', 'claude', 'agy', 'cursor'],
  'quality-first': ['claude', 'codex', 'cursor', 'agy'],
};

export class AgentRegistry {
  private readonly adapters = new Map<string, AgentAdapter>();
  private cache: AgentStatus[] | null = null;
  constructor(adapters: AgentAdapter[]) { for (const a of adapters) this.adapters.set(a.id, a); }

  get(id: string): AgentAdapter | undefined { return this.adapters.get(id); }

  /** Detect every adapter. A failing adapter never breaks the others. */
  async status(refresh = false): Promise<AgentStatus[]> {
    if (this.cache && !refresh) return this.cache;
    this.cache = await Promise.all([...this.adapters.values()].map(async (a): Promise<AgentStatus> => {
      const base = { id: a.id, name: a.name, mock: a.mock, capabilities: a.capabilities(), notes: a.notes() };
      try {
        const d = await a.detect();
        if (!d.installed) return { ...base, installed: false, version: null, auth: 'unknown', available: false, reason: d.reason ?? 'not installed' };
        const au = await a.checkAuth();
        return { ...base, installed: true, version: d.version, auth: au.auth, available: au.auth !== 'missing' && !d.reason, reason: d.reason ?? au.reason };
      } catch (e) {
        return { ...base, installed: false, version: null, auth: 'unknown', available: false, reason: `detection error: ${(e as Error).message}` };
      }
    }));
    return this.cache;
  }

  /** Rule-based auto selection: first available provider in the policy's order. */
  async pick(policy: RoutingPolicy, order: Record<RoutingPolicy, string[]> = DEFAULT_ROUTING): Promise<string | null> {
    const st = await this.status();
    for (const id of order[policy] ?? []) if (st.find((s) => s.id === id)?.available) return id;
    return null;
  }
}
