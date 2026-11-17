// JSON plugin adapters: a declarative spec (command, args per policy, event mapping) becomes a CliAdapter.
// Loaded from <app>/plugins/*.json (shipped examples) and <dataDir>/plugins/*.json (user; same id overrides).
// Safety is enforced at load time: prompt only via stdin, no permission-bypass flags, bare command names only.
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { run } from '../proc.ts';
import { CliAdapter } from './cli.ts';
import { API_PROVIDERS } from './api.ts';
import type { AgentEvent, Capabilities, ModelInfo } from './types.ts';

type O = Record<string, unknown>;
export interface EventRule {
  match: Record<string, string | number | boolean>;  // dot path -> expected value
  kind: AgentEvent['kind'];
  text?: string;                                      // template with {dot.path} placeholders
  usage?: string | Record<string, string>;           // path to a numbers object, or { name: path }
  okWhen?: Record<string, string | number | boolean>; // result kinds: isError unless these match
}
export interface PluginSpec {
  id: string; name: string; bin: string; verified?: boolean; notes?: string[];
  args: { base?: string[]; write?: string[]; readOnly?: string[]; model?: string[]; effort?: string[] };
  /** `args`: a command whose exit code 0 means logged in. `files` (relative to the home dir) / `env`: logged in if any exists or is set; only existence is checked, contents are never read. */
  auth?: { args?: string[]; files?: string[]; env?: string[]; hint?: string };
  models?: { args: string[]; pattern: string };
  events: EventRule[];
}

export const BUILTIN_IDS = ['mock', 'claude', 'codex', 'cursor', 'agy', ...API_PROVIDERS.map((p) => p.id)];
const FORBIDDEN = /dangerously|yolo|bypass|skip-permissions|--force|--trust|danger-full-access|full-auto|allow-all/i;
const KINDS = ['message', 'tool', 'result', 'error', 'log'];

export const getPath = (o: unknown, p: string): unknown => p.split('.').reduce<unknown>((v, k) => (v && typeof v === 'object' ? (v as O)[k] : undefined), o);
const show = (v: unknown) => (typeof v === 'string' ? v : v == null ? '' : JSON.stringify(v));
const matches = (o: O, m: Record<string, unknown>) => Object.entries(m).every(([k, v]) => getPath(o, k) === v);
const fill = (tpl: string, o: O) => tpl.replace(/\{([\w.]+)\}/g, (_, p: string) => show(getPath(o, p)));

function numbers(o: O, u: EventRule['usage']): Record<string, number> | undefined {
  if (!u) return undefined;
  const src = typeof u === 'string' ? getPath(o, u) : Object.fromEntries(Object.entries(u).map(([k, p]) => [k, getPath(o, p)]));
  if (!src || typeof src !== 'object') return undefined;
  const out = Object.fromEntries(Object.entries(src as O).filter(([, v]) => typeof v === 'number' && Number.isFinite(v))) as Record<string, number>;
  return Object.keys(out).length ? out : undefined;
}

/** Validate untrusted JSON into a PluginSpec; throws with a readable reason. */
export function validatePlugin(raw: unknown): PluginSpec {
  const s = raw as PluginSpec;
  const fail = (m: string): never => { throw new Error(m); };
  if (!s || typeof s !== 'object') fail('spec must be an object');
  if (typeof s.id !== 'string' || !/^[a-z][a-z0-9-]{1,30}$/.test(s.id)) fail('id must match ^[a-z][a-z0-9-]{1,30}$');
  if (BUILTIN_IDS.includes(s.id)) fail(`id "${s.id}" is reserved for a built-in adapter`);
  if (typeof s.name !== 'string' || !s.name.trim()) fail('name is required');
  if (typeof s.bin !== 'string' || !/^[\w.-]+$/.test(s.bin)) fail('bin must be a bare command name resolved via PATH (no paths, no spaces)');
  const lists: [string, unknown][] = [['args.base', s.args?.base], ['args.write', s.args?.write], ['args.readOnly', s.args?.readOnly], ['args.model', s.args?.model], ['args.effort', s.args?.effort], ['auth.args', s.auth?.args], ['models.args', s.models?.args]];
  for (const [where, l] of lists) {
    if (l === undefined) continue;
    if (!Array.isArray(l) || l.some((a) => typeof a !== 'string')) fail(`${where} must be an array of strings`);
    const bad = (l as string[]).find((a) => FORBIDDEN.test(a));
    if (bad) fail(`${where}: permission-bypass flag "${bad}" is not allowed`);
    if ((l as string[]).some((a) => a.includes('{prompt}'))) fail(`${where}: the prompt always goes via stdin; {prompt} is not supported`);
    if (where !== 'args.model' && (l as string[]).some((a) => a.includes('{model}'))) fail(`${where}: {model} is allowed only in args.model`);
  }
  for (const [where, l] of [['auth.files', s.auth?.files], ['auth.env', s.auth?.env]] as const) {
    if (l !== undefined && (!Array.isArray(l) || l.some((a) => typeof a !== 'string' || !a || path.isAbsolute(a) || a.split(/[\\/]/).includes('..')))) fail(`${where} must be an array of relative names without ".."`);
  }
  if (s.auth && !s.auth.args && !s.auth.files && !s.auth.env) fail('auth needs args, files or env');
  if (s.models && (typeof s.models.pattern !== 'string' || (() => { try { return !/\((?!\?)/.test(s.models.pattern) || !new RegExp(s.models.pattern); } catch { return true; } })())) fail('models.pattern must be a valid regular expression with a capture group for the model id');
  if (!Array.isArray(s.events) || !s.events.length) fail('events must be a non-empty array of rules');
  for (const [i, r] of s.events.entries()) {
    if (!r || typeof r.match !== 'object' || !KINDS.includes(r.kind)) fail(`events[${i}]: needs "match" and a kind of ${KINDS.join('|')}`);
  }
  return s;
}

/** The first matching rule maps a JSON line; unmatched lines are dropped (they are still in the raw log). */
export function parseWith(rules: EventRule[], o: O): AgentEvent | null {
  const r = rules.find((x) => matches(o, x.match));
  if (!r) return null;
  const ev: AgentEvent = { kind: r.kind, text: r.text ? fill(r.text, o) : '' };
  const usage = numbers(o, r.usage);
  if (usage) ev.usage = usage;
  if (r.kind === 'result') ev.isError = r.okWhen ? !matches(o, r.okWhen) : false;
  return ev;
}

export function pluginAdapter(s: PluginSpec): CliAdapter {
  const caps: Capabilities = { headless: 'supported', streamEvents: 'supported', cancel: 'supported', questions: 'unsupported',
    usage: s.events.some((e) => e.usage) ? 'supported' : 'unknown', modelSelect: s.args.model ? 'supported' : 'unsupported', readOnlyMode: s.args.readOnly ? 'supported' : 'unsupported' };
  return new CliAdapter({
    id: s.id, name: s.name, bin: s.bin, caps,
    notes: [`JSON plugin${s.verified ? '' : ' — NOT verified on a real CLI by HidForge; flags come from the CLI docs'}.`, ...(s.notes ?? [])],
    async auth() {
      const a = s.auth;
      if (!a) return { auth: 'unknown', reason: null };
      if (a.env?.some((k) => process.env[k]) || a.files?.some((f) => existsSync(path.join(homedir(), f)))) return { auth: 'ok', reason: null };
      if (!a.args) return { auth: 'missing', reason: a.hint ?? 'no login found' };
      const r = await run(s.bin, a.args, { timeoutMs: 30_000 });
      return r.code === 0 ? { auth: 'ok', reason: null } : { auth: 'missing', reason: a.hint ?? `\`${s.bin} ${a.args.join(' ')}\` failed` };
    },
    build: (c) => ({
      args: [...(s.args.base ?? []), ...((c.policy === 'read-only' ? s.args.readOnly : s.args.write) ?? []),
        ...(c.model && s.args.model ? s.args.model.map((a) => a.replaceAll('{model}', c.model!)) : []),
        ...(c.effort && s.args.effort ? s.args.effort.map((a) => a.replaceAll('{effort}', c.effort!)) : [])],
      stdin: c.prompt,
    }),
    parse: (o) => parseWith(s.events, o),
    models: s.models ? async (): Promise<ModelInfo[]> => {
      const r = await run(s.bin, s.models!.args, { timeoutMs: 60_000 });
      const re = new RegExp(s.models!.pattern);
      return r.code !== 0 ? [] : r.stdout.split(/\r?\n/).map((l) => re.exec(l.trim())).filter((m): m is RegExpExecArray => Boolean(m?.[1]))
        .map((m) => ({ id: m[1]!, label: (m[2] ?? m[1]!).trim() }));
    } : undefined,
  });
}

export interface PluginLoad { adapters: CliAdapter[]; errors: { file: string; error: string }[] }

export function loadPlugins(dirs: string[]): PluginLoad {
  const byId = new Map<string, CliAdapter>();
  const errors: PluginLoad['errors'] = [];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.json')).sort()) {
      const file = path.join(dir, f);
      try { const s = validatePlugin(JSON.parse(readFileSync(file, 'utf8'))); byId.set(s.id, pluginAdapter(s)); }
      catch (e) { errors.push({ file, error: (e as Error).message }); }
    }
  }
  return { adapters: [...byId.values()], errors };
}
