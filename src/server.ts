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

type Handler = (m: RegExpMatchArray, body: Record<string, unknown>, url: URL, res: http.ServerResponse) => Promise<unknown> | unknown;

export interface ServerOptions { port: number; webDir: string; token?: string }

export function createServer(orch: Orchestrator, o: ServerOptions) {
  const token = o.token ?? randomBytes(24).toString('hex');
  const s = orch.store;
  const id = (m: RegExpMatchArray) => Number(m[1]);
  const routes: [string, RegExp, Handler][] = [
    ['GET', /^\/api\/health$/, () => ({ ok: true })],
    ['GET', /^\/api\/agents$/, (_m, _b, u) => orch.registry.status(u.searchParams.get('refresh') === '1')],
    ['GET', /^\/api\/settings$/, () => ({ maxConcurrentAgents: orch.maxConcurrent, routingPolicy: orch.routingPolicy, routingTable: s.getSetting('routingTable', DEFAULT_ROUTING) })],
    ['PUT', /^\/api\/settings$/, (_m, b) => {
      if (b.maxConcurrentAgents !== undefined) s.setSetting('maxConcurrentAgents', Math.max(1, Math.min(16, Number(b.maxConcurrentAgents) || 1)));
      if (b.routingPolicy !== undefined) {
        if (!['cost-first', 'balanced', 'quality-first'].includes(String(b.routingPolicy))) throw new BadRequest('bad routingPolicy');
        s.setSetting('routingPolicy', b.routingPolicy);
      }
      return { maxConcurrentAgents: orch.maxConcurrent, routingPolicy: orch.routingPolicy };
    }],
    ['GET', /^\/api\/projects$/, () => s.listProjects()],
    ['POST', /^\/api\/projects$/, (_m, b) => orch.addProject(str(b.repoPath, 'repoPath'), String(b.goal ?? ''))],
    ['POST', /^\/api\/demo$/, () => createDemo(orch)],
    ['GET', /^\/api\/projects\/(\d+)$/, (m) => ({ project: s.getProject(id(m)), tasks: s.listTasks(id(m)) })],
    ['PATCH', /^\/api\/projects\/(\d+)$/, (m, b) => s.updateProject(id(m), {
      goal: b.goal as string | undefined,
      allowedCommands: Array.isArray(b.allowedCommands) ? b.allowedCommands.map(String) : undefined,
    })],
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
    ['GET', /^\/api\/tasks\/(\d+)\/diff$/, async (m) => ({ diff: await orch.diff(id(m)) })],
    ['GET', /^\/api\/projects\/(\d+)\/plans$/, (m) => s.listPlans(id(m))],
    ['POST', /^\/api\/projects\/(\d+)\/plans$/, (m, b) => orch.planner.start(id(m), {
      provider: b.provider ? String(b.provider) : undefined, model: b.model ? String(b.model) : null,
      maxTasks: b.maxTasks === undefined ? undefined : Number(b.maxTasks),
    })],
    ['GET', /^\/api\/plans\/(\d+)$/, (m) => s.getPlan(id(m))],
    ['POST', /^\/api\/plans\/(\d+)\/cancel$/, (m) => orch.planner.cancel(id(m))],
    ['POST', /^\/api\/plans\/(\d+)\/discard$/, (m) => orch.planner.discard(id(m))],
    ['POST', /^\/api\/plans\/(\d+)\/apply$/, (m, b) => orch.planner.apply(id(m), {
      provider: b.provider ? String(b.provider) : undefined, model: b.model ? String(b.model) : null,
    })],
    ['GET', /^\/api\/events$/, (_m, _b, u) => s.events({
      afterId: Number(u.searchParams.get('after') ?? 0), projectId: num(u, 'projectId'), taskId: num(u, 'taskId'), type: u.searchParams.get('type') ?? undefined, limit: num(u, 'limit') ?? 2000,
    })],
  ];

  const server = http.createServer(async (req, res) => {
    try {
      const host = req.headers.host ?? '';
      const port = (server.address() as { port: number } | null)?.port;
      if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return send(res, 403, { error: 'bad host' });
      const url = new URL(req.url ?? '/', `http://${host}`);
      if (req.method !== 'GET' && req.headers['x-hidforge-token'] !== token) return send(res, 403, { error: 'missing or bad token' });

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
function num(u: URL, k: string): number | undefined { const v = u.searchParams.get(k); return v ? Number(v) : undefined; }

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
