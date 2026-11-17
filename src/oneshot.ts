// Shared one-shot agent session (planner, reviewer): spawn, stream events, timeout/stall kill, JSON extraction.
import { createInterface } from 'node:readline';
import type { Orchestrator } from './orchestrator.ts';
import { BadRequest } from './store.ts';
import { DEFAULT_ROUTING } from './adapters/index.ts';
import type { AgentAdapter, AgentEvent, Invocation } from './adapters/types.ts';
import { spawnSafe, killTree } from './proc.ts';
import { effortFlagFor, vendorOf, type Link } from './routing.ts';

export function extractJson(text: string): unknown {
  const fences = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)].map((m) => m[1]!);
  for (const f of fences.reverse()) { try { return parseLenient(f); } catch { /* next */ } }
  const a = text.indexOf('{');
  const b = text.lastIndexOf('}');
  if (a >= 0 && b > a) return parseLenient(text.slice(a, b + 1));
  throw new Error('no JSON object found');
}

/** JSON.parse, then once more with stray backslashes escaped: models write Windows paths like "C:\Users" unescaped. */
function parseLenient(s: string): unknown {
  try { return JSON.parse(s); } catch (e) {
    const fixed = s.replace(/\\(["\\/bfnrtu])|\\/g, (m, ok: string | undefined) => (ok ? m : '\\\\')); // valid pairs stay as they are
    if (fixed === s) throw e;
    return JSON.parse(fixed);
  }
}

/** Resolve 'auto' via routing policy and make sure the agent is available and can run read-only. */
export async function resolveReadOnlyAgent(orch: Orchestrator, provider: string, purpose: string, auto: { links?: Link[]; avoidVendor?: string; exclude?: string } = {}):
  Promise<{ adapter: AgentAdapter; provider: string; model?: string; effort?: string | null }> {
  const { store, registry } = orch;
  let link: Link | undefined;
  if (provider === 'auto') {
    const st = await registry.status();
    const ok = (id: string) => Boolean(st.find((s) => s.id === id)?.available) && registry.get(id)?.capabilities().readOnlyMode === 'supported';
    link = auto.links?.find((l) => ok(l.agent) && l.agent !== auto.exclude);
    if (link) provider = link.agent;
    else {
      const table = store.getSetting('routingTable', DEFAULT_ROUTING);
      const order = (table[orch.routingPolicy] ?? []).filter((id) => id !== auto.exclude);
      const other = auto.avoidVendor ? order.filter((id) => vendorOf(id, null) !== auto.avoidVendor) : order;
      const picked = (await registry.pick(orch.routingPolicy, { ...table, [orch.routingPolicy]: other })) ?? (await registry.pick(orch.routingPolicy, table));
      if (!picked) throw new BadRequest(`no available agent for routing policy '${orch.routingPolicy}'`);
      provider = picked;
    }
  }
  const adapter = registry.get(provider);
  const st = (await registry.status()).find((s) => s.id === provider);
  if (!adapter || !st?.available) throw new BadRequest(`agent '${provider}' unavailable: ${st?.reason ?? 'unknown provider'}`);
  if (!adapter.mock && adapter.capabilities().readOnlyMode !== 'supported') throw new BadRequest(`agent '${provider}' has no read-only mode; it cannot be used as ${purpose}`);
  return link ? { adapter, provider, model: link.model, effort: effortFlagFor(link) } : { adapter, provider };
}

export type OneShotResult = { code: number | null; result: AgentEvent | null; messages: string[]; killReason: string | null };
export interface OneShot { pid: number | undefined; done: Promise<OneShotResult>; kill(reason: string): Promise<void> }

type RunOpts = { timeoutMs: number; stallMs: number; onEvent: (e: AgentEvent, stream: string) => void };

/** Runs adapter.prepare (remote upload) first when there is one; the session is live — and killable — from the start. */
export function runOnce(adapter: AgentAdapter, inv: Invocation, cwd: string, o: RunOpts): OneShot {
  if (!adapter.prepare) return spawnOnce(adapter, inv, cwd, o);
  const ac = new AbortController();
  let inner: OneShot | null = null;
  let killReason: string | null = null;
  const killed = (): OneShotResult => ({ code: null, result: null, messages: [], killReason });
  const done = (async () => {
    try { await adapter.prepare!(cwd, ac.signal); } catch (e) { if (killReason) return killed(); throw e; }
    if (killReason) return killed();
    inner = spawnOnce(adapter, inv, cwd, o);
    return inner.done;
  })();
  // ponytail: no pid while uploading; the caller records it only if present.
  return { get pid() { return inner?.pid; }, done, kill: async (r) => { killReason ??= r; ac.abort(); await inner?.kill(r); } };
}

// ponytail: task runs in orchestrator.ts have their own supervision (locks, recovery); merge the runners if needed.
function spawnOnce(adapter: AgentAdapter, inv: Invocation, cwd: string, o: RunOpts): OneShot {
  const child = spawnSafe(inv.command, inv.args, { cwd });
  let result: AgentEvent | null = null;
  let killReason: string | null = null;
  const messages: string[] = [];
  let last = Date.now();
  const started = Date.now();
  const kill = async (reason: string) => { killReason ??= reason; if (child.pid) await killTree(child.pid); };
  const timer = setInterval(() => {
    if (Date.now() - started > o.timeoutMs) void kill(`timeout: exceeded ${Math.round(o.timeoutMs / 1000)}s`);
    else if (Date.now() - last > o.stallMs) void kill(`stalled: no output for ${Math.round(o.stallMs / 1000)}s`);
  }, 250);
  const onLine = (stream: string) => (line: string) => {
    last = Date.now();
    const ev = stream === 'stdout' ? adapter.parseLine(line) : (line.trim() ? { kind: 'log' as const, text: line } : null);
    if (!ev) return;
    if (ev.kind === 'result') result = ev;
    if (ev.kind === 'message') messages.push(ev.text);
    o.onEvent(ev, stream);
  };
  createInterface({ input: child.stdout! }).on('line', onLine('stdout'));
  createInterface({ input: child.stderr! }).on('line', onLine('stderr'));
  child.stdin?.on('error', () => {});
  child.stdin?.end(inv.stdin ?? '');
  const done = new Promise<OneShotResult>((resolve) => {
    child.on('error', (e) => { onLine('stderr')(`process error: ${e.message}`); });
    child.on('close', (code) => { clearInterval(timer); resolve({ code, result, messages, killReason }); });
  });
  return { pid: child.pid, done, kill };
}
