// Optional VPS backend over OpenSSH: the agent CLI runs on a remote Linux host.
// Before a run, the worktree files (git ls-files, never .git, never symlinks) are streamed to the host as a tar
// and committed there as a baseline. After a successful run the host returns `git diff --binary` against that
// baseline, and HidForge applies it to the local worktree. Gates, AI review and merge stay local.
// Auth is the user's own ssh key/agent: BatchMode=yes never prompts and HidForge stores no password or key;
// the host must already be in known_hosts (host-key checking is left on).
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { resolveCommand, childEnv, bareCommand } from '../proc.ts';
import { git } from '../workspace.ts';
import type { AgentAdapter, ModelInfo, StartContext, Invocation } from './types.ts';

export interface SshConfig { host: string; port: number | null; remoteDir: string; agents: string[] }

/** POSIX single-quote: the remote side always goes through the login shell, so every word is quoted. */
export const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

const HOST_RE = /^(?:[A-Za-z0-9_][\w.-]*@)?[A-Za-z0-9_][\w.-]*$/;
const DIR_RE = /^[\w.\/-]+$/;

export function normalizeSsh(raw: unknown, known: (id: string) => boolean): SshConfig | null {
  if (raw == null) return null;
  const o = raw as { host?: unknown; port?: unknown; remoteDir?: unknown; agents?: unknown };
  const host = String(o.host ?? '').trim();
  if (!host) return null;
  if (!HOST_RE.test(host) || host.length > 255) throw new Error('ssh host must be `host`, `user@host` or an alias from ~/.ssh/config (letters, digits, . _ -)');
  const port = o.port == null || o.port === '' ? null : Number(o.port);
  if (port !== null && !(Number.isInteger(port) && port > 0 && port < 65536)) throw new Error('ssh port must be 1..65535');
  const remoteDir = String(o.remoteDir ?? '').trim().replace(/\/+$/, '') || '.hidforge/work';
  if (!DIR_RE.test(remoteDir) || remoteDir.startsWith('-') || remoteDir.split('/').some((x) => x === '..') || remoteDir === '/' || remoteDir === '.')
    throw new Error('remote directory may contain only letters, digits, . _ - /, no `..`, not `/`');
  const agents = Array.isArray(o.agents) ? o.agents.map(String).filter(Boolean) : [];
  const bad = agents.find((a) => !known(a) || a === 'mock');
  if (bad) throw new Error(`unknown agent for ssh: ${bad}`);
  return { host, port, remoteDir, agents };
}

// ------------------------------------------------------------------ minimal tar (ustar + pax path)
const oct = (n: number, len: number) => n.toString(8).padStart(len - 1, '0') + '\0';
function header(name: string, size: number, mode: number, type: string): Buffer {
  const b = Buffer.alloc(512);
  b.write(name, 0, 100, 'utf8');
  b.write(oct(mode, 8), 100); b.write(oct(0, 8), 108); b.write(oct(0, 8), 116);
  b.write(oct(size, 12), 124); b.write(oct(Math.floor(Date.now() / 1000), 12), 136);
  b.write('        ', 148); b.write(type, 156); b.write('ustar\u000000', 257);
  let sum = 0; for (const x of b) sum += x;
  b.write(oct(sum, 7) + ' ', 148);
  return b;
}
const pad = (d: Buffer) => (d.length % 512 ? Buffer.concat([d, Buffer.alloc(512 - (d.length % 512))]) : d);
function paxPath(p: string): Buffer {
  const body = ` path=${p}\n`;
  const n = Buffer.byteLength(body);
  let len = n + 1;
  while (len !== n + String(len).length) len = n + String(len).length;
  return Buffer.from(`${len}${body}`);
}
export function* tarEntries(root: string, files: { path: string; mode: number }[]): Generator<Buffer> {
  for (const f of files) {
    const data = readFileSync(path.join(root, f.path));
    const plain = /^[\x20-\x7e]{1,100}$/.test(f.path);
    if (!plain) { const x = paxPath(f.path); yield header('PaxHeader', x.length, 0o644, 'x'); yield pad(x); }
    yield header(plain ? f.path : 'hidforge-long-name', data.length, f.mode, '0');
    yield pad(data);
  }
  yield Buffer.alloc(1024);
}

/** Regular files git would see in the worktree (tracked + untracked, not ignored). Symlinks and submodules are skipped. */
export async function worktreeFiles(ws: string): Promise<{ path: string; mode: number }[]> {
  const ls = await git(ws, ['ls-files', '-z', '-c', '-o', '--exclude-standard']);
  if (ls.code !== 0) throw new Error(`git ls-files failed: ${ls.stderr.trim()}`);
  const exec = new Set((await git(ws, ['ls-files', '-s', '-z'])).stdout.split('\0').filter((l) => l.startsWith('100755')).map((l) => l.split('\t')[1]));
  const out: { path: string; mode: number }[] = [];
  for (const p of new Set(ls.stdout.split('\0').filter(Boolean))) {
    let st; try { st = lstatSync(path.join(ws, p)); } catch { continue; } // deleted in the worktree
    if (st.isFile()) out.push({ path: p, mode: exec.has(p) ? 0o755 : 0o644 });
  }
  return out;
}

/** Refuse patches that would create symlinks or touch a .git directory. */
export function checkPatch(patch: string): void {
  if (/^(new file mode|new mode) 120000/m.test(patch)) throw new Error('remote changes contain a symlink; refused');
  for (const m of patch.matchAll(/^diff --git a\/(.*) b\/(.*)$/gm)) {
    if ([m[1]!, m[2]!].some((p) => p.split('/').some((s) => s.toLowerCase() === '.git'))) throw new Error(`remote changes touch .git: ${m[2]}`);
  }
}

type Out = { code: number; out: Buffer; err: string };
function pipe(cmd: string[], args: string[], o: { cwd?: string; input?: Buffer | Iterable<Buffer> | null; timeoutMs: number }): Promise<Out> {
  const r = resolveCommand(cmd[0]!);
  if (!r) return Promise.resolve({ code: 127, out: Buffer.alloc(0), err: `not found: ${cmd[0]}` });
  return new Promise((resolve) => {
    const child = spawn(r.file, [...r.prefixArgs, ...cmd.slice(1), ...args], { cwd: o.cwd, env: childEnv(), shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const out: Buffer[] = []; const err: Buffer[] = [];
    const timer = setTimeout(() => child.kill(), o.timeoutMs);
    child.stdout.on('data', (d: Buffer) => out.push(d));
    child.stderr.on('data', (d: Buffer) => err.push(d));
    child.stdin.on('error', () => {});
    child.on('error', (e) => err.push(Buffer.from(e.message)));
    child.on('close', (code) => { clearTimeout(timer); resolve({ code: code ?? 124, out: Buffer.concat(out), err: Buffer.concat(err).toString('utf8').trim() }); });
    if (o.input == null) child.stdin.end();
    else if (Buffer.isBuffer(o.input)) child.stdin.end(o.input);
    else Readable.from(o.input).pipe(child.stdin);
  });
}

const GIT_REMOTE = 'git -c user.name=HidForge -c user.email=hidforge@localhost -c commit.gpgsign=false -c core.autocrlf=false';

export class SshAdapter implements AgentAdapter {
  readonly mock = false;
  readonly id: string;
  readonly name: string;
  private readonly inner: AgentAdapter & { spec?: { bin: string } };
  private readonly cfg: SshConfig;
  /** ssh client command; tests pass a local stand-in. */
  private readonly transport: string[];
  constructor(inner: AgentAdapter & { spec?: { bin: string } }, cfg: SshConfig, transport: string[] = ['ssh']) {
    this.inner = inner; this.cfg = cfg; this.transport = transport;
    this.id = `${inner.id}-ssh`;
    this.name = `${inner.name} (SSH: ${cfg.host})`;
  }
  private get bin() { return bareCommand(this.inner.spec?.bin ?? this.inner.id); }
  private sshArgs(remoteCmd: string): string[] {
    return ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', ...(this.cfg.port ? ['-p', String(this.cfg.port)] : []), '--', this.cfg.host, remoteCmd];
  }
  private ssh(remoteCmd: string, input: Buffer | Iterable<Buffer> | null, timeoutMs: number) { return pipe(this.transport, this.sshArgs(remoteCmd), { input, timeoutMs }); }
  /** One remote directory per local workspace: <remoteDir>/<parent>-<name>, e.g. .hidforge/work/p1-t3. */
  remoteDir(workspace: string): string {
    const k = `${path.basename(path.dirname(workspace))}-${path.basename(workspace)}`.replace(/[^\w.-]/g, '_');
    return `${this.cfg.remoteDir}/${k}`;
  }

  async detect() {
    const need = ['git', 'tar'].map((c) => `command -v ${c} >/dev/null || { echo '${c} is not installed on the host' >&2; exit 127; }`).join('; ');
    const r = await this.ssh(`${need}; exec ${shq(this.bin)} --version`, null, 30_000);
    const text = (r.out.toString('utf8').trim() || r.err).split(/\r?\n/)[0] ?? '';
    return r.code === 0 ? { installed: true, version: text || null, reason: null }
      : { installed: false, version: null, reason: `ssh ${this.cfg.host}: ${r.code === 255 ? 'connection failed (key, known_hosts or network): ' : `\`${this.bin}\` not runnable: `}${text || `exit ${r.code}`}` };
  }
  async checkAuth() { return { auth: 'unknown' as const, reason: 'auth is checked by the CLI on the host; log in there once' }; }
  capabilities() { return this.inner.capabilities(); }
  notes() {
    return [`Runs on ${this.cfg.host} over ssh: worktree files are copied to ~/${this.cfg.remoteDir}/<task>, the agent's changes come back as a git diff and pass the usual local gates. Experimental: not verified on a real VPS by HidForge. Cancel closes the ssh connection; the remote CLI normally exits with it, but this is not guaranteed.`, ...this.inner.notes()];
  }

  /** Upload a fresh snapshot of the worktree and commit it as the remote baseline. Stale dirs (>2 days) are swept. */
  async prepare(workspace: string): Promise<void> {
    const d = shq(this.remoteDir(workspace)); const root = shq(this.cfg.remoteDir);
    const script = [
      'set -e', `mkdir -p ${root}`, `find ${root} -mindepth 1 -maxdepth 1 -mtime +2 -exec rm -rf {} +`,
      `rm -rf ${d}`, `mkdir -p ${d}`, `cd ${d}`, 'tar -xf -', 'git init -q', 'git add -A -f',
      `${GIT_REMOTE} commit -q --no-verify --allow-empty -m 'HidForge baseline'`,
    ].join('; ');
    const r = await this.ssh(script, tarEntries(workspace, await worktreeFiles(workspace)), 600_000);
    if (r.code !== 0) throw new Error(`uploading the worktree to ${this.cfg.host} failed (exit ${r.code}): ${r.err.slice(0, 500)}`);
  }

  /** Bring the agent's changes back as a binary git diff, check it, apply it locally, remove the remote copy. */
  async collect(workspace: string): Promise<void> {
    const d = shq(this.remoteDir(workspace));
    const script = `set -e; cd ${d}; git add -A; ${GIT_REMOTE} -c core.quotepath=false diff --cached --binary --no-color --no-ext-diff --src-prefix=a/ --dst-prefix=b/ HEAD; cd; rm -rf ${d} || true`;
    const r = await this.ssh(script, null, 300_000);
    if (r.code !== 0) throw new Error(`downloading changes from ${this.cfg.host} failed (exit ${r.code}): ${r.err.slice(0, 500)}`);
    if (!r.out.length) return;
    checkPatch(r.out.toString('utf8'));
    const a = await pipe(['git'], ['apply', '--binary', '--whitespace=nowarn', '-'], { cwd: workspace, input: r.out, timeoutMs: 120_000 });
    if (a.code !== 0) throw new Error(`applying remote changes failed: ${a.err.slice(0, 500)}`);
  }

  buildInvocation(ctx: StartContext): Invocation {
    const dir = this.remoteDir(ctx.workspace);
    const inv = this.inner.buildInvocation({ ...ctx, workspace: '.' }); // already cd'd into it (codex --cd)
    const remote = `cd ${shq(dir)} && exec ${[bareCommand(inv.command), ...inv.args].map(shq).join(' ')}`;
    return { command: this.transport[0]!, args: [...this.transport.slice(1), ...this.sshArgs(remote)], stdin: inv.stdin };
  }
  parseLine(line: string) { return this.inner.parseLine(line); }
  async listModels(): Promise<ModelInfo[]> { return []; }
}
