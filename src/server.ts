// Local HTTP API + SSE + static UI. Binds to 127.0.0.1 only.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Orchestrator } from './orchestrator.ts';
import { BadRequest, type HfEvent } from './store.ts';
import { git } from './workspace.ts';
import { DEFAULT_ROUTING } from './adapters/index.ts';
import { apiKeysPresent } from './adapters/api.ts';
import { normalizeReviewPolicy } from './reviewer.ts';
import { DEFAULT_ROLE_TEMPLATES, ROLES, normalizeRoleTemplates } from './contract.ts';
import { projectCosts, projectRuns, modelStats } from './costs.ts';
import { CATEGORIES, COMPLEXITIES, EFFORTS, DEFAULT_MATRIX, FABLE, FABLE_CATEGORIES, normalizeMatrix } from './routing.ts';
import { projectReport, adrMarkdown, decisions } from './report.ts';
import { projectPlan } from './progress.ts';
import { diagnostics, listBackups, createBackup } from './maintenance.ts';
import { normalizeWsl } from './adapters/wsl.ts';
import { normalizeSsh } from './adapters/ssh.ts';

type Handler = (m: RegExpMatchArray, body: Record<string, unknown>, url: URL, res: http.ServerResponse) => Promise<unknown> | unknown;

export interface ServerOptions { port: number; webDir: string; token?: string; onShutdown?: () => void }

export const APP_NAME = 'hidforge-orchestrator';
/** Version from package.json plus the git commit of the install (if it is a git checkout). */
export async function appVersion(appRoot: string): Promise<{ name: string; version: string; commit: string | null; node: string }> {
  let version = '0.0.0';
  try { version = String(JSON.parse(await readFile(path.join(appRoot, 'package.json'), 'utf8')).version); } catch { /* not packaged */ }
  const r = await git(appRoot, ['rev-parse', '--short', 'HEAD'], 5000).catch(() => null);
  return { name: APP_NAME, version, commit: r && r.code === 0 ? r.stdout.trim() : null, node: process.versions.node };
}

export function createServer(orch: Orchestrator, o: ServerOptions) {
  const token = o.token ?? randomBytes(24).toString('hex');
  const s = orch.store;
  const id = (m: RegExpMatchArray) => Number(m[1]);
  const routes: [string, RegExp, Handler][] = [
    ['GET', /^\/api\/health$/, () => ({ ok: true })],
    ['GET', /^\/api\/version$/, () => appVersion(path.resolve(o.webDir, '..'))],
    ['GET', /^\/api\/diagnostics$/, () => diagnostics(orch)],
    ['GET', /^\/api\/backups$/, () => ({ dir: path.join(orch.opts.dataDir, 'backups'), backups: listBackups(orch.opts.dataDir) })],
    ['POST', /^\/api\/backups$/, () => createBackup(s, orch.opts.dataDir)],
    ['POST', /^\/api\/shutdown$/, () => {
      if (!o.onShutdown) throw new BadRequest('shutdown is not available in this mode');
      setTimeout(o.onShutdown, 100);
      return { ok: true };
    }],
    ['GET', /^\/api\/agents$/, (_m, _b, u) => orch.registry.status(u.searchParams.get('refresh') === '1')],
    ['GET', /^\/api\/agents\/([\w-]+)\/models$/, async (m) => {
      const a = orch.registry.get(m[1]!);
      if (!a) throw new BadRequest(`unknown agent ${m[1]}`);
      return a.listModels ? a.listModels() : [];
    }],
    ['GET', /^\/api\/settings$/, () => ({ maxConcurrentAgents: orch.maxConcurrent, routingPolicy: orch.routingPolicy, routingTable: s.getSetting('routingTable', DEFAULT_ROUTING), agentTrust: s.getSetting('agentTrust', {}),
      roles: ROLES, roleTemplates: { ...DEFAULT_ROLE_TEMPLATES, ...orch.roleTemplates() }, roleDefaults: DEFAULT_ROLE_TEMPLATES, wsl: s.getSetting('wsl', null), ssh: s.getSetting('ssh', null),
      ...orch.routingSettings(), apiFallback: s.getSetting('apiFallback', false), apiKeys: apiKeysPresent(), routing: { categories: CATEGORIES, complexities: COMPLEXITIES, efforts: EFFORTS, defaultMatrix: DEFAULT_MATRIX, fable: FABLE, fableCategories: FABLE_CATEGORIES } })],
    ['GET', /^\/api\/model-stats$/, () => modelStats(s)],
    ['PUT', /^\/api\/settings$/, async (_m, b) => {
      if (b.maxConcurrentAgents !== undefined) s.setSetting('maxConcurrentAgents', Math.max(1, Math.min(16, Number(b.maxConcurrentAgents) || 1)));
      if (b.routingPolicy !== undefined) {
        if (!['cost-first', 'balanced', 'quality-first'].includes(String(b.routingPolicy))) throw new BadRequest('bad routingPolicy');
        s.setSetting('routingPolicy', b.routingPolicy);
      }
      if (b.agentTrust !== undefined) {
        const t = b.agentTrust as Record<string, unknown>;
        if (!t || typeof t !== 'object') throw new BadRequest('agentTrust must be an object');
        s.setSetting('agentTrust', Object.fromEntries(Object.entries(t).filter(([k]) => orch.registry.get(k)).map(([k, v]) => [k, v === true])));
      }
      if (b.wsl !== undefined) {
        try { s.setSetting('wsl', normalizeWsl(b.wsl, (p) => Boolean(orch.registry.get(p)))); }
        catch (e) { throw new BadRequest((e as Error).message); }
      }
      if (b.ssh !== undefined) {
        try { s.setSetting('ssh', normalizeSsh(b.ssh, (p) => Boolean(orch.registry.get(p)))); }
        catch (e) { throw new BadRequest((e as Error).message); }
      }
      if (b.effortCeiling !== undefined) {
        if (!(EFFORTS as readonly string[]).includes(String(b.effortCeiling))) throw new BadRequest('bad effortCeiling');
        s.setSetting('effortCeiling', b.effortCeiling);
      }
      for (const k of ['allowFable', 'selfLearning'] as const) if (b[k] !== undefined) s.setSetting(k, b[k] === true);
      if (b.apiFallback !== undefined) { s.setSetting('apiFallback', b.apiFallback === true); await orch.registry.status(true); }
      if (b.agentReadOnly !== undefined) {
        const t = b.agentReadOnly as Record<string, unknown>;
        if (!t || typeof t !== 'object') throw new BadRequest('agentReadOnly must be an object');
        s.setSetting('agentReadOnly', Object.fromEntries(Object.entries(t).filter(([k]) => orch.registry.get(k)).map(([k, v]) => [k, v === true])));
      }
      if (b.routingMatrix !== undefined) {
        // null = back to the research defaults
        try { s.setSetting('routingMatrix', b.routingMatrix === null ? {} : normalizeMatrix(b.routingMatrix)); }
        catch (e) { throw new BadRequest((e as Error).message); }
      }
      if (b.roleTemplates !== undefined) {
        try { s.setSetting('roleTemplates', normalizeRoleTemplates(b.roleTemplates, (p) => Boolean(orch.registry.get(p)))); }
        catch (e) { throw new BadRequest((e as Error).message); }
      }
      return { maxConcurrentAgents: orch.maxConcurrent, routingPolicy: orch.routingPolicy, agentTrust: s.getSetting('agentTrust', {}), roleTemplates: { ...DEFAULT_ROLE_TEMPLATES, ...orch.roleTemplates() }, ...orch.routingSettings(), apiFallback: s.getSetting('apiFallback', false) };
    }],
    ['GET', /^\/api\/projects$/, () => s.listProjects()],
    ['POST', /^\/api\/projects$/, (_m, b) => orch.addProject(str(b.repoPath, 'repoPath'), String(b.goal ?? ''))],
    ['POST', /^\/api\/demo$/, () => createDemo(orch)],
    ['GET', /^\/api\/projects\/(\d+)$/, (m) => ({ project: s.getProject(id(m)), tasks: s.listTasks(id(m)) })],
    ['PATCH', /^\/api\/projects\/(\d+)$/, (m, b) => s.updateProject(id(m), {
      goal: b.goal as string | undefined,
      allowedCommands: Array.isArray(b.allowedCommands) ? b.allowedCommands.map(String) : undefined,
      reviewPolicy: b.reviewPolicy === undefined ? undefined : normalizeReviewPolicy(b.reviewPolicy, (p) => Boolean(orch.registry.get(p))),
      budgetUsd: b.budgetUsd === undefined ? undefined : budget(b.budgetUsd),
    })],
    ['DELETE', /^\/api\/projects\/(\d+)$/, (m) => orch.deleteProject(id(m))],
    ['GET', /^\/api\/projects\/(\d+)\/plan-progress$/, (m) => projectPlan(orch, id(m))],
    ['GET', /^\/api\/projects\/(\d+)\/costs$/, (m) => projectCosts(s, id(m))],
    ['GET', /^\/api\/projects\/(\d+)\/runs$/, (m, _b, u) => { s.getProject(id(m)); return projectRuns(s, id(m), {
      before: num(u, 'before'), limit: num(u, 'limit'), status: u.searchParams.get('status') ?? undefined, provider: u.searchParams.get('provider') ?? undefined }); }],
    ['GET', /^\/api\/projects\/(\d+)\/report$/, (m) => ({ markdown: projectReport(s, id(m)) })],
    ['GET', /^\/api\/projects\/(\d+)\/adr$/, (m) => ({ markdown: adrMarkdown(s, id(m)), decisions: decisions(s, id(m)) })],
    ['POST', /^\/api\/projects\/(\d+)\/tasks$/, (m, b) => orch.createTask(id(m), { ...b, title: str(b.title, 'title') })],
    ['POST', /^\/api\/projects\/(\d+)\/submit-all$/, (m) => orch.submitAll(id(m))],
    ['GET', /^\/api\/tasks\/(\d+)$/, (m) => ({ task: s.getTask(id(m)), runs: s.runsForTask(id(m)) })],
    ['PATCH', /^\/api\/tasks\/(\d+)$/, (m, b) => orch.updateTask(id(m), b)],
    ['DELETE', /^\/api\/tasks\/(\d+)$/, (m) => { s.deleteTask(id(m)); return { ok: true }; }],
    ['POST', /^\/api\/tasks\/(\d+)\/submit$/, (m) => orch.submit(id(m))],
    ['POST', /^\/api\/tasks\/(\d+)\/cancel$/, (m) => orch.cancel(id(m))],
    ['POST', /^\/api\/tasks\/(\d+)\/retry$/, (m) => orch.retry(id(m))],
    ['POST', /^\/api\/tasks\/(\d+)\/approve$/, (m) => orch.approve(id(m))],
    ['POST', /^\/api\/tasks\/(\d+)\/reject$/, (m, b) => orch.reject(id(m), String(b.feedback ?? ''), b.retry !== false)],
    ['POST', /^\/api\/tasks\/(\d+)\/answer$/, (m, b) => orch.answer(id(m), b.allow === true)],
    ['POST', /^\/api\/tasks\/(\d+)\/review$/, (m, b) => orch.reviewer.start(id(m), {
      provider: b.provider ? String(b.provider) : undefined, model: b.model === undefined ? undefined : (b.model ? String(b.model) : null),
    })],
    ['POST', /^\/api\/tasks\/(\d+)\/review\/cancel$/, (m) => orch.reviewer.cancel(id(m))],
    ['GET', /^\/api\/tasks\/(\d+)\/diff$/, async (m) => ({ diff: await orch.diff(id(m)) })],
    ['GET', /^\/api\/projects\/(\d+)\/plans$/, (m) => s.listPlans(id(m))],
    ['POST', /^\/api\/projects\/(\d+)\/plans$/, (m, b) => orch.planner.start(id(m), {
      provider: b.provider ? String(b.provider) : undefined, model: b.model ? String(b.model) : null,
      maxTasks: b.maxTasks === undefined ? undefined : Number(b.maxTasks),
    })],
    ['GET', /^\/api\/plans\/(\d+)$/, (m) => s.getPlan(id(m))],
    ['POST', /^\/api\/plans\/(\d+)\/cancel$/, (m) => orch.planner.cancel(id(m))],
    ['GET', /^\/api\/projects\/(\d+)\/chat$/, (m) => orch.chat.state(id(m))],
    ['POST', /^\/api\/projects\/(\d+)\/chat$/, (m, b) => orch.chat.send(id(m), b)],
    ['POST', /^\/api\/projects\/(\d+)\/chat\/cancel$/, (m) => orch.chat.cancel(id(m))],
    ['DELETE', /^\/api\/projects\/(\d+)\/chat$/, (m) => orch.chat.clear(id(m))],
    ['POST', /^\/api\/plans\/(\d+)\/discard$/, (m) => orch.planner.discard(id(m))],
    ['POST', /^\/api\/plans\/(\d+)\/apply$/, (m, b) => orch.planner.apply(id(m), {
      provider: b.provider ? String(b.provider) : undefined, model: b.model ? String(b.model) : null,
    })],
    ['GET', /^\/api\/events$/, (_m, _b, u) => s.events({
      afterId: num(u, 'after') ?? 0, beforeId: num(u, 'before'), projectId: num(u, 'projectId'), taskId: num(u, 'taskId'), type: u.searchParams.get('type') ?? undefined, limit: num(u, 'limit') ?? 2000,
    })],
  ];

  const server = http.createServer(async (req, res) => {
    try {
      const host = req.headers.host ?? '';
      const port = (server.address() as { port: number } | null)?.port;
      if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return send(res, 403, { error: 'bad host' });
      const url = new URL(req.url ?? '/', `http://${host}`);
      // Token for every change, and for GETs that spawn processes (a cross-site page can fire simple GETs).
      const spawns = /^\/api\/(diagnostics|agents\/[\w-]+\/models)$/.test(url.pathname) || (url.pathname === '/api/agents' && url.searchParams.get('refresh') === '1');
      if ((req.method !== 'GET' || spawns) && req.headers['x-hidforge-token'] !== token) return send(res, 403, { error: 'missing or bad token' });

      if (url.pathname === '/api/stream') return stream(req, res, url);
      if (!url.pathname.startsWith('/api/')) return serveStatic(url.pathname, res);
      for (const [method, re, h] of routes) {
        const m = url.pathname.match(re);
        if (!m || method !== req.method) continue;
        const body = req.method === 'GET' ? {} : await readBody(req);
        return send(res, 200, await h(m, body, url, res));
      }
      send(res, 404, { error: 'not found' });
    } catch (e) {
      const status = (e as { status?: number }).status ?? 500;
      send(res, status, { error: (e as Error).message });
    }
  });

  function stream(_req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
    const projectId = num(url, 'projectId');
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.write(': connected\n\n'); // flush headers immediately
    const write = (e: HfEvent) => { if (!projectId || e.projectId === projectId || e.projectId == null) res.write(`id: ${e.id}\ndata: ${JSON.stringify(e)}\n\n`); };
    const after = Number(url.searchParams.get('after') ?? _req.headers['last-event-id'] ?? 0);
    if (after) for (const e of s.events({ afterId: after, projectId })) write(e);
    s.bus.on('event', write);
    const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
    res.on('close', () => { s.bus.off('event', write); clearInterval(ping); });
  }

  async function serveStatic(p: string, res: http.ServerResponse) {
    const rel = p === '/' ? 'index.html' : p.slice(1);
    const file = path.resolve(o.webDir, rel);
    if (!file.startsWith(path.resolve(o.webDir) + path.sep)) return send(res, 403, { error: 'forbidden' });
    try {
      let data: Buffer | string = await readFile(file);
      const type = MIME[path.extname(file)] ?? 'application/octet-stream';
      if (rel === 'index.html') data = data.toString('utf8').replace('__HIDFORGE_TOKEN__', token);
      res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:" });
      res.end(data);
    } catch { send(res, 404, { error: 'not found' }); }
  }

  return {
    server, token,
    listen: () => new Promise<number>((resolve) => server.listen(o.port, '127.0.0.1', () => resolve((server.address() as { port: number }).port))),
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

function send(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body ?? null));
}
function str(v: unknown, name: string): string {
  if (typeof v !== 'string' || !v.trim()) throw new BadRequest(`${name} is required`);
  return v;
}
function budget(v: unknown): number | null {
  if (v === null || v === '') return null;
  const x = Number(v);
  if (!Number.isFinite(x) || x <= 0) throw new BadRequest('budgetUsd must be a positive number or null');
  return x;
}
function num(u: URL, k: string): number | undefined {
  const v = u.searchParams.get(k);
  if (!v) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new BadRequest(`${k} must be a number`);
  return n;
}

async function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) { size += (c as Buffer).length; if (size > 1_000_000) throw new BadRequest('body too large'); chunks.push(c as Buffer); }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new BadRequest('invalid JSON'); }
}

/** Demo project: a throw-away git repo (path with spaces and Cyrillic) and a small mock plan. */
export async function createDemo(orch: Orchestrator) {
  const dir = path.join(orch.opts.dataDir, 'demo', `Демо проєкт ${Date.now()}`);
  mkdirSync(path.join(dir, 'src'), { recursive: true });
  writeFileSync(path.join(dir, 'README.md'), '# Demo project\n');
  writeFileSync(path.join(dir, 'src', 'index.txt'), 'entry\n');
  if (!existsSync(path.join(dir, '.git'))) {
    await git(dir, ['init', '-q', '-b', 'main']);
    await git(dir, ['add', '-A']);
    await git(dir, ['commit', '-q', '-m', 'initial']);
  }
  const p = await orch.addProject(dir, 'Demo: build a two-module app (backend + frontend) and document the integration.');
  const mock = (d: object) => `@mock ${JSON.stringify(d)}`;
  const a = orch.createTask(p.id, { title: 'Backend module', assignedRole: 'Backend', provider: 'mock', allowedPaths: ['src/backend/**'],
    description: mock({ sleepMs: 4000, steps: 8, write: { 'src/backend/api.txt': 'GET /items (attempt {attempt})\n' } }),
    acceptanceCriteria: 'src/backend/api.txt exists', verifyCommands: ['node --version'] });
  const b = orch.createTask(p.id, { title: 'Frontend module', assignedRole: 'Frontend', provider: 'mock', allowedPaths: ['src/frontend/**'],
    description: mock({ sleepMs: 4000, steps: 8, write: { 'src/frontend/ui.txt': 'Items list view\n' } }), acceptanceCriteria: 'src/frontend/ui.txt exists' });
  orch.createTask(p.id, { title: 'Integration docs', assignedRole: 'Integrator', provider: 'mock', dependsOn: [a.id, b.id], allowedPaths: ['docs/**'],
    description: mock({ sleepMs: 1500, write: { 'docs/integration.md': '# Integration\nbackend + frontend\n' } }) });
  orch.createTask(p.id, { title: 'Out-of-scope writer (gate demo)', assignedRole: 'QA', provider: 'mock', allowedPaths: ['tests/**'], maxAttempts: 1,
    description: mock({ sleepMs: 1000, write: { 'README.md': 'overwritten\n' } }) });
  return p;
}
