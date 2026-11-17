// Auto-routing: task category x complexity -> chain of (agent, model, effort) links: primary, fallback 1, fallback 2.
// Pure rules, no AI call. The default matrix is a STARTING HYPOTHESIS from public research (2026-11-17, see docs/ROUTING.md),
// not measured by HidForge; the user can edit it in Settings and own run statistics can reorder it.

export const CATEGORIES = ['ui_visual', 'frontend_logic', 'backend', 'bugfix', 'refactor', 'architecture', 'tests', 'docs', 'small_edit', 'planning'] as const;
export type Category = typeof CATEGORIES[number];
export const COMPLEXITIES = ['low', 'medium', 'high'] as const;
export type Complexity = typeof COMPLEXITIES[number];
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = typeof EFFORTS[number];
/** Default effort ceiling: xhigh/max burn subscription limits several times faster for a small quality gain. */
export const DEFAULT_CEILING: Effort = 'high';

/** One chain link. `effort` is null when the model has no levels (Cursor Composer). */
export interface Link { agent: string; model: string; effort: Effort | null }
export type Matrix = Record<string, Link[]>; // key: `${category}/${complexity}`
export const cell = (category: string, complexity: string) => `${category}/${complexity}`;

/** Agents whose model id already carries the effort level; no effort flag is passed to them. */
const EFFORT_IN_MODEL = new Set(['agy', 'cursor']);
export const effortFlagFor = (l: Link): Effort | null => (EFFORT_IN_MODEL.has(l.agent) ? null : l.effort);

const claude = (model: string, effort: Effort): Link => ({ agent: 'claude', model, effort });
const codex = (model: string, effort: Effort): Link => ({ agent: 'codex', model, effort });
const agy = (model: string, effort: Effort): Link => ({ agent: 'agy', model: `${model}-${effort}`, effort });
const SOL = 'gpt-6.1-sol', ASTRA = 'gpt-6-astra', TERRA = 'gpt-6.1-terra', LUNA = 'gpt-6-luna', H = 'gemini-4-hydrogen', A = 'gemini-4-argon';
const COMPOSER: Link = { agent: 'cursor', model: 'composer-2.5', effort: null };
export const FABLE: Link = { agent: 'claude', model: 'claude-fable-5-2', effort: 'high' };
/** Fable is an opt-in last link, and only for these categories at high complexity. */
export const FABLE_CATEGORIES: readonly string[] = ['bugfix', 'architecture', 'planning', 'backend'];

const rows: [Category, Link[], Link[], Link[]][] = [
  ['ui_visual', [claude('sonnet', 'medium'), agy(H, 'high'), codex(TERRA, 'medium')], [claude('opus', 'high'), codex(ASTRA, 'high'), agy(H, 'high')], [claude('opus', 'high'), codex(ASTRA, 'high'), agy(A, 'high')]],
  ['frontend_logic', [codex(SOL, 'medium'), claude('haiku', 'high'), agy(H, 'medium')], [codex(SOL, 'high'), claude('sonnet', 'high'), agy(A, 'high')], [claude('opus', 'high'), codex(SOL, 'high'), agy(A, 'high')]],
  ['backend', [codex(SOL, 'medium'), claude('haiku', 'high'), agy(H, 'medium')], [codex(SOL, 'high'), claude('sonnet', 'high'), agy(H, 'high')], [claude('opus', 'high'), codex(ASTRA, 'high'), agy(A, 'high')]],
  ['bugfix', [codex(SOL, 'medium'), claude('sonnet', 'medium'), agy(H, 'medium')], [codex(SOL, 'high'), claude('opus', 'medium'), agy(H, 'high')], [claude('opus', 'high'), codex(ASTRA, 'high'), agy(A, 'high')]],
  ['refactor', [codex(SOL, 'medium'), claude('sonnet', 'medium'), COMPOSER], [codex(SOL, 'high'), claude('sonnet', 'high'), agy(A, 'high')], [codex(ASTRA, 'high'), claude('opus', 'high'), agy(A, 'high')]],
  ['architecture', [claude('opus', 'medium'), codex(SOL, 'high'), agy(A, 'medium')], [claude('opus', 'high'), codex(ASTRA, 'medium'), agy(A, 'high')], [claude('opus', 'high'), codex(ASTRA, 'high'), agy(A, 'high')]],
  ['tests', [codex(SOL, 'medium'), claude('haiku', 'high'), COMPOSER], [codex(SOL, 'high'), claude('sonnet', 'high'), agy(H, 'high')], [claude('opus', 'high'), codex(SOL, 'high'), agy(A, 'high')]],
  ['docs', [claude('haiku', 'medium'), codex(LUNA, 'high'), COMPOSER], [codex(TERRA, 'medium'), claude('haiku', 'high'), agy(H, 'medium')], [claude('opus', 'medium'), codex(TERRA, 'high'), agy(A, 'high')]],
  ['small_edit', [claude('haiku', 'medium'), codex(LUNA, 'high'), COMPOSER], [claude('haiku', 'high'), codex(SOL, 'low'), COMPOSER], [claude('sonnet', 'medium'), codex(SOL, 'medium'), agy(H, 'medium')]],
  ['planning', [claude('sonnet', 'medium'), codex(SOL, 'medium'), agy(A, 'medium')], [claude('opus', 'medium'), codex(SOL, 'high'), agy(A, 'high')], [claude('opus', 'high'), codex(ASTRA, 'high'), agy(A, 'high')]],
];
export const DEFAULT_MATRIX: Matrix = Object.fromEntries(rows.flatMap(([cat, ...chains]) => COMPLEXITIES.map((cx, i) => [cell(cat, cx), chains[i]!])));

/** Who trained the model: the reviewer must come from another vendor than the code author. */
export function vendorOf(agent: string, model: string | null): string {
  const m = (model ?? '').toLowerCase();
  if (/claude|opus|sonnet|haiku|fable/.test(m)) return 'anthropic';
  if (/gpt|codex/.test(m)) return 'openai';
  if (/gemini/.test(m)) return 'google';
  if (/grok/.test(m)) return 'xai';
  if (/composer/.test(m)) return 'cursor';
  const base = agent.replace(/^(wsl|ssh)[-:]/, '');
  return ({ claude: 'anthropic', codex: 'openai', agy: 'google', gemini: 'google', cursor: 'cursor' } as Record<string, string>)[base] ?? base;
}

/** Reviewer candidates by the vendor of the code author, in priority order. */
export function reviewLinks(authorVendor: string, complexity: string | null): Link[] {
  const low = complexity === 'low';
  if (authorVendor === 'anthropic') return [codex(SOL, low ? 'medium' : 'high'), agy(A, 'high')];
  if (authorVendor === 'openai') return [claude('opus', low ? 'medium' : 'high'), agy(A, 'high')];
  return [codex(SOL, 'high'), claude('sonnet', 'high')].filter((l) => vendorOf(l.agent, l.model) !== authorVendor);
}

export interface RouteContext {
  matrix?: Matrix;
  /** Agent ids that are installed and logged in. */
  available: ReadonlySet<string>;
  /** Agents that currently cannot write files (user-marked); skipped for tasks that write. */
  readOnlyAgents?: ReadonlySet<string>;
  write: boolean;
  /** Role template restriction; empty = any agent. */
  roleProviders?: string[];
  ceiling?: Effort;
  allowFable?: boolean;
}

const rank = (e: Effort | null) => (e ? EFFORTS.indexOf(e) : 0);
export const usable = (l: Link, c: RouteContext): boolean =>
  c.available.has(l.agent) && !(c.write && c.readOnlyAgents?.has(l.agent))
  && (!c.roleProviders?.length || c.roleProviders.includes(l.agent)) && rank(l.effort) <= rank(c.ceiling ?? DEFAULT_CEILING);

/** The chain for a task: matrix cell minus links that cannot be used right now. Attempt N uses link N (the last one repeats). */
export function resolveChain(category: string, complexity: string, c: RouteContext): Link[] {
  const chain = [...((c.matrix ?? DEFAULT_MATRIX)[cell(category, complexity)] ?? [])];
  if (c.allowFable && complexity === 'high' && FABLE_CATEGORIES.includes(category)) chain.push(FABLE);
  return chain.filter((l) => usable(l, c));
}

const AGENT_RE = /^[a-z][a-z0-9-]{1,30}$/;
const MODEL_RE = /^[A-Za-z0-9][\w.:/@[\],=+-]{0,127}$/;
/** Validate a user-edited matrix (unknown cells are dropped, missing ones keep the default). Throws with a readable reason. */
export function normalizeMatrix(raw: unknown): Matrix {
  if (!raw || typeof raw !== 'object') throw new Error('routingMatrix must be an object');
  const out: Matrix = {};
  for (const key of Object.keys(DEFAULT_MATRIX)) {
    const links = (raw as Record<string, unknown>)[key];
    if (links === undefined) continue;
    if (!Array.isArray(links) || links.length > 6) throw new Error(`${key}: expected up to 6 links`);
    out[key] = links.map((l0) => {
      const l = (l0 ?? {}) as Record<string, unknown>;
      const agent = String(l.agent ?? ''), model = String(l.model ?? ''), effort = l.effort == null || l.effort === '' ? null : String(l.effort);
      if (!AGENT_RE.test(agent)) throw new Error(`${key}: bad agent "${agent.slice(0, 40)}"`);
      if (!MODEL_RE.test(model)) throw new Error(`${key}: bad model "${model.slice(0, 60)}"`);
      if (effort !== null && !EFFORTS.includes(effort as Effort)) throw new Error(`${key}: bad effort "${effort.slice(0, 20)}"`);
      return { agent, model, effort: effort as Effort | null };
    });
  }
  return out;
}

export interface LinkStat { agent: string; model: string | null; runs: number; succeeded: number }
/** Self-learning: once every link of the chain has >= minRuns measured runs in this cell, order links by success rate. Stable otherwise. */
export function reorderByStats(chain: Link[], stats: LinkStat[], minRuns = 5): Link[] {
  const of = (l: Link) => stats.find((s) => s.agent === l.agent && s.model === l.model);
  if (chain.length < 2 || !chain.every((l) => (of(l)?.runs ?? 0) >= minRuns)) return chain;
  const rate = (l: Link) => of(l)!.succeeded / of(l)!.runs;
  return [...chain].sort((a, b) => rate(b) - rate(a)); // Array.prototype.sort is stable: ties keep the matrix order
}
