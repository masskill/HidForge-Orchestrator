// Safe process utilities: no shell, Windows shim unwrapping, process-tree kill, secret masking.
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const isWin = process.platform === 'win32';

export interface Resolved { file: string; prefixArgs: string[] }

function isFile(p: string): boolean {
  try { return statSync(p).isFile(); } catch { return false; }
}

/**
 * Resolve a command name to an executable we can spawn WITHOUT a shell.
 * On Windows, `.cmd`/`.bat` npm shims are unwrapped to the `.exe` or `.js` they launch,
 * because spawning them requires cmd.exe (argument-injection risk, CVE-2024-27980).
 * Returns null when the command cannot be resolved safely.
 */
export function resolveCommand(cmd: string, envPath = process.env.PATH ?? process.env.Path ?? ''): Resolved | null {
  const candidates: string[] = [];
  const exts = isWin ? ['', '.exe', '.com', '.cmd', '.bat'] : [''];
  const hasDir = cmd.includes('/') || cmd.includes('\\');
  const dirs = hasDir ? [''] : envPath.split(path.delimiter).filter(Boolean);
  for (const dir of dirs) for (const ext of exts) candidates.push(path.resolve(dir, cmd + ext));
  for (const c of candidates) {
    if (!isFile(c)) continue;
    const ext = path.extname(c).toLowerCase();
    if (!isWin || ext === '.exe' || ext === '.com') return { file: c, prefixArgs: [] };
    if (ext === '.cmd' || ext === '.bat') {
      const target = unwrapShim(c);
      if (target) return target;
      continue; // unknown shim: refuse rather than go through cmd.exe
    }
    // extensionless file on Windows (bash shim) - skip, keep searching for .exe/.cmd
  }
  return null;
}

function unwrapShim(shimPath: string): Resolved | null {
  const text = readFileSync(shimPath, 'utf8');
  const dir = path.dirname(shimPath);
  const re = /%~?dp0%?\\?([^"%*\r\n]+?\.(?:exe|js|cjs|mjs))/gi;
  let last: string | null = null;
  for (const m of text.matchAll(re)) last = m[1]!;
  if (!last && /\.ps1\b/i.test(text)) return versionedNodeLauncher(dir);
  if (!last) return null;
  const target = path.resolve(dir, last);
  if (!existsSync(target)) return null;
  if (/\.exe$/i.test(target)) return { file: target, prefixArgs: [] };
  return { file: process.execPath, prefixArgs: [target] };
}

/**
 * Shims that call a PowerShell launcher which runs `versions\<YYYY.MM.DD-hash>\node.exe index.js`
 * (Cursor Agent CLI layout). We run the newest such version directly instead of going through powershell.
 */
function versionedNodeLauncher(dir: string): Resolved | null {
  const root = path.join(dir, 'versions');
  if (!existsSync(root)) return null;
  const key = (n: string) => n.split('-')[0]!.split('.').map((x) => x.padStart(4, '0')).join('');
  const ver = readdirSync(root).filter((n) => /^\d{4}\.\d{1,2}\.\d{1,2}(-\d{2}-\d{2}-\d{2})?-[a-f0-9]+$/.test(n))
    .filter((n) => isFile(path.join(root, n, 'node.exe')) && isFile(path.join(root, n, 'index.js')))
    .sort((a, b) => key(a).localeCompare(key(b)) || a.localeCompare(b)).at(-1);
  return ver ? { file: path.join(root, ver, 'node.exe'), prefixArgs: [path.join(root, ver, 'index.js')] } : null;
}

/** Command name for another OS (WSL, ssh host): a local absolute Windows path becomes its bare name (…\codex.exe -> codex). */
export const bareCommand = (cmd: string) => path.basename(cmd.replace(/\\/g, '/')).replace(/\.exe$/i, '');

/** Split a command line into argv (supports "double" and 'single' quotes). Never uses a shell. */
export function parseArgv(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: string | null = null;
  let has = false;
  for (const ch of line.trim()) {
    if (quote) {
      if (ch === quote) quote = null; else cur += ch;
    } else if (ch === '"' || ch === "'") { quote = ch; has = true; }
    else if (/\s/.test(ch)) { if (has || cur) { out.push(cur); cur = ''; has = false; } }
    else cur += ch;
  }
  if (quote) throw new Error('Unbalanced quote in command');
  if (has || cur) out.push(cur);
  return out;
}

/** Environment for child agents: inherit (CLIs need their own auth config) minus nested-session markers. */
export function childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env = { ...process.env, ...extra };
  for (const k of Object.keys(env)) if (k === 'CLAUDECODE' || k.startsWith('CLAUDE_CODE_')) delete env[k];
  return env;
}

export function spawnSafe(cmd: string, args: string[], opts: { cwd: string; env?: NodeJS.ProcessEnv }): ChildProcess {
  if (!existsSync(opts.cwd)) throw new Error(`working directory does not exist: ${opts.cwd}`);
  const r = resolveCommand(cmd);
  if (!r) throw new Error(`Command not found or not safely runnable: ${cmd}`);
  return spawn(r.file, [...r.prefixArgs, ...args], {
    cwd: opts.cwd,
    env: opts.env ?? childEnv(),
    shell: false,
    windowsHide: true,
    detached: !isWin, // own process group on POSIX so the tree can be killed
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

/** Run to completion, capture output. Used for git and short probes. */
export function run(cmd: string, args: string[], opts: { cwd?: string; timeoutMs?: number; input?: string } = {}):
  Promise<{ code: number; stdout: string; stderr: string }> {
  const r = resolveCommand(cmd);
  if (!r) return Promise.resolve({ code: 127, stdout: '', stderr: `not found: ${cmd}` });
  return new Promise((resolve) => {
    const child = execFile(r.file, [...r.prefixArgs, ...args], {
      cwd: opts.cwd, env: childEnv(), shell: false, windowsHide: true,
      timeout: opts.timeoutMs ?? 60_000, maxBuffer: 32 * 1024 * 1024, encoding: 'utf8',
    }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as NodeJS.ErrnoException).code === 'number' ? Number((err as NodeJS.ErrnoException).code) : (err as { killed?: boolean }).killed ? 124 : 1) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr || (err && !stderr ? err.message : '')) });
    });
    if (opts.input !== undefined) child.stdin?.end(opts.input); else child.stdin?.end();
  });
}

/** Kill a process and all its descendants. Windows: taskkill /T /F; POSIX: kill the process group. */
export async function killTree(pid: number): Promise<void> {
  if (isWin) {
    await new Promise<void>((resolve) => {
      execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve());
    });
    return;
  }
  try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
}

export function isAlive(pid: number | null | undefined): boolean {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

const SECRET_PATTERNS: RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{10,}/g,
  /sk-[A-Za-z0-9_-]{20,}/g,
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /xox[abprs]-[A-Za-z0-9-]{10,}/g,
  /AIza[0-9A-Za-z_-]{30,}/g,
  /(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi,
  /((?:api[_-]?key|token|secret|password|passwd)["']?\s*[:=]\s*["']?)[^\s"',;]{6,}/gi,
];

export function maskSecrets(s: string): string {
  let out = s;
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, (m, prefix?: string) => (typeof prefix === 'string' && m.startsWith(prefix) ? prefix : '') + '***');
  }
  return out;
}
