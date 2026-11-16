// Optional WSL2 backend: run a CLI agent inside a WSL distribution on the same Windows worktree.
// `wsl.exe -d <distro> --cd <linux path> --exec <bin> ...` — no shell inside WSL, prompt still via stdin.
// HidForge itself (git, gates, merge) keeps running on Windows.
import { run, bareCommand } from '../proc.ts';
import type { AgentAdapter, ModelInfo, StartContext, Invocation } from './types.ts';

/** E:\a b\c -> /mnt/e/a b/c ; \\wsl$\Distro\home\u -> /home/u (also \\wsl.localhost\...). */
export function toWslPath(p: string): string {
  const s = p.replace(/\//g, '\\');
  const unc = /^\\\\wsl(?:\$|\.localhost)\\[^\\]+(\\.*)?$/i.exec(s);
  if (unc) return (unc[1] ?? '\\').replace(/\\/g, '/');
  const drive = /^([a-zA-Z]):(\\.*)?$/.exec(s);
  if (drive) return `/mnt/${drive[1]!.toLowerCase()}${(drive[2] ?? '').replace(/\\/g, '/')}`;
  throw new Error(`cannot map path to WSL: ${p}`);
}

export interface WslConfig { distro: string; agents: string[] }

/** WSL prints UTF-16LE: strip the NULs so the text is readable as UTF-8. */
const clean = (s: string) => s.replace(/\u0000/g, '').trim();

export async function wslDistros(): Promise<string[] | null> {
  const r = await run('wsl.exe', ['-l', '-q'], { timeoutMs: 15_000 });
  return r.code === 0 ? clean(r.stdout).split(/\r?\n/).map((x) => x.trim()).filter(Boolean) : null;
}

export class WslAdapter implements AgentAdapter {
  readonly mock = false;
  readonly id: string;
  readonly name: string;
  private readonly inner: AgentAdapter & { spec?: { bin: string } };
  private readonly distro: string;
  constructor(inner: AgentAdapter & { spec?: { bin: string } }, distro: string) {
    this.inner = inner;
    this.distro = distro;
    this.id = `${inner.id}-wsl`;
    this.name = `${inner.name} (WSL: ${distro})`;
  }
  private get bin() { return bareCommand(this.inner.spec?.bin ?? this.inner.id); }
  async detect() {
    const r = await run('wsl.exe', ['-d', this.distro, '--exec', this.bin, '--version'], { timeoutMs: 30_000 });
    const out = clean(r.stdout || r.stderr).split(/\r?\n/)[0] ?? null;
    return r.code === 0 ? { installed: true, version: out, reason: null } : { installed: false, version: null, reason: `\`${this.bin}\` not runnable in WSL distro ${this.distro}: ${out ?? `exit ${r.code}`}` };
  }
  async checkAuth() { return { auth: 'unknown' as const, reason: 'auth is checked by the CLI inside WSL; log in there once' }; }
  capabilities() { return this.inner.capabilities(); }
  notes() {
    return [`Runs inside WSL distro "${this.distro}" via \`wsl.exe --exec\` on the Windows worktree (/mnt/<drive>/...). Experimental: not verified on a real distro by HidForge; cancelling kills wsl.exe, which normally ends the Linux process.`, ...this.inner.notes()];
  }
  buildInvocation(ctx: StartContext): Invocation {
    const dir = toWslPath(ctx.workspace);
    const inv = this.inner.buildInvocation({ ...ctx, workspace: dir }); // the CLI runs in Linux (codex --cd)
    return { command: 'wsl.exe', args: ['-d', this.distro, '--cd', dir, '--exec', bareCommand(inv.command), ...inv.args], stdin: inv.stdin };
  }
  parseLine(line: string) { return this.inner.parseLine(line); }
  async listModels(): Promise<ModelInfo[]> { return []; }
}

export function normalizeWsl(raw: unknown, known: (id: string) => boolean): WslConfig | null {
  if (raw == null) return null;
  const o = raw as { distro?: unknown; agents?: unknown };
  const distro = String(o.distro ?? '').trim();
  if (!distro) return null;
  if (!/^[\w.-]{1,64}$/.test(distro)) throw new Error('WSL distro name may contain only letters, digits, . _ -');
  const agents = Array.isArray(o.agents) ? o.agents.map(String).filter(Boolean) : [];
  const bad = agents.find((a) => !known(a) || a === 'mock');
  if (bad) throw new Error(`unknown agent for WSL: ${bad}`);
  return { distro, agents };
}
