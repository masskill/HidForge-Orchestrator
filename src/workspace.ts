// Git worktree per task, change inspection, allowed-path gate, merge into base branch.
import { mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { run } from './proc.ts';

const GIT_ID = ['-c', 'user.name=HidForge', '-c', 'user.email=hidforge@localhost', '-c', 'core.quotepath=false'];

export async function git(cwd: string, args: string[], timeoutMs = 120_000) {
  return run('git', [...GIT_ID, ...args], { cwd, timeoutMs });
}

async function gitOk(cwd: string, args: string[]): Promise<string> {
  const r = await git(cwd, args);
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${(r.stderr || r.stdout).trim()}`);
  return r.stdout.trim();
}

export async function inspectRepo(dir: string): Promise<{ root: string; branch: string }> {
  const root = await gitOk(dir, ['rev-parse', '--show-toplevel']);
  const branch = await gitOk(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branch === 'HEAD') throw new Error('repository is in detached HEAD state; check out a branch first');
  return { root: path.resolve(root), branch };
}

export class WorkspaceManager {
  readonly root: string;
  constructor(root: string) { this.root = root; }

  /** Create (or reuse, for repair attempts) the task worktree on its own branch from the base branch. */
  async ensure(repo: string, baseBranch: string, projectId: number, taskId: number, existing: string | null):
    Promise<{ workspace: string; branch: string; baseCommit: string; created: boolean }> {
    const branch = `hidforge/p${projectId}-t${taskId}`;
    if (existing && existsSync(existing)) {
      const baseCommit = await gitOk(existing, ['merge-base', 'HEAD', baseBranch]);
      return { workspace: existing, branch, baseCommit, created: false };
    }
    const workspace = path.join(this.root, `p${projectId}`, `t${taskId}`);
    mkdirSync(path.dirname(workspace), { recursive: true });
    const baseCommit = await gitOk(repo, ['rev-parse', baseBranch]);
    await git(repo, ['worktree', 'prune']);
    const hasBranch = (await git(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])).code === 0;
    const args = hasBranch ? ['worktree', 'add', workspace, branch] : ['worktree', 'add', '-b', branch, workspace, baseCommit];
    await gitOk(repo, args);
    return { workspace, branch, baseCommit, created: true };
  }

  /** Throw-away detached worktree (read-only planning sessions). */
  async addDetached(repo: string, ref: string, dir: string): Promise<void> {
    mkdirSync(path.dirname(dir), { recursive: true });
    await git(repo, ['worktree', 'prune']);
    await gitOk(repo, ['worktree', 'add', '--detach', dir, ref]);
  }

  /** Commit whatever the agent left in the worktree. Returns true if a commit was made. */
  async commitAll(workspace: string, message: string): Promise<boolean> {
    await gitOk(workspace, ['add', '-A']);
    const st = await gitOk(workspace, ['status', '--porcelain']);
    // A pending merge (conflict repair) must be concluded even if the resolution equals HEAD.
    const merging = (await git(workspace, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'])).code === 0;
    if (!st && !merging) return false;
    await gitOk(workspace, ['commit', '-q', '--no-verify', '-m', message]);
    return true;
  }

  async changedFiles(workspace: string, baseCommit: string): Promise<string[]> {
    const out = await gitOk(workspace, ['diff', '--name-only', '-z', `${baseCommit}..HEAD`]);
    return out.split('\0').filter(Boolean);
  }

  async diff(workspace: string, baseCommit: string): Promise<string> {
    const r = await git(workspace, ['diff', '--no-color', '--stat', '--patch', `${baseCommit}..HEAD`]);
    return r.stdout;
  }

  /** Merge the task branch into the base branch of the main checkout. Never discards work: on conflict the merge is aborted. */
  async merge(repo: string, baseBranch: string, branch: string, message: string):
    Promise<{ ok: true; commit: string } | { ok: false; reason: string; conflicts: string[] }> {
    const cur = await gitOk(repo, ['rev-parse', '--abbrev-ref', 'HEAD']);
    if (cur !== baseBranch) return { ok: false, reason: `main checkout is on '${cur}', expected '${baseBranch}'`, conflicts: [] };
    const dirty = await gitOk(repo, ['status', '--porcelain', '--untracked-files=no']);
    if (dirty) return { ok: false, reason: 'main checkout has uncommitted changes; commit or stash them first', conflicts: [] };
    const r = await git(repo, ['merge', '--no-ff', '--no-edit', '-m', message, branch]);
    if (r.code === 0) return { ok: true, commit: await gitOk(repo, ['rev-parse', 'HEAD']) };
    const conflicts = (await git(repo, ['diff', '--name-only', '--diff-filter=U'])).stdout.split('\n').filter(Boolean);
    await git(repo, ['merge', '--abort']);
    return { ok: false, reason: (r.stdout + r.stderr).trim().slice(0, 2000), conflicts };
  }

  async isMerged(repo: string, branch: string, baseBranch: string): Promise<boolean> {
    return (await git(repo, ['merge-base', '--is-ancestor', branch, baseBranch])).code === 0;
  }

  /** Clean-up policy: worktree + branch are removed only after a successful merge or explicit discard. */
  async remove(repo: string, workspace: string, branch: string | null): Promise<void> {
    await git(repo, ['worktree', 'remove', '--force', workspace]);
    await git(repo, ['worktree', 'prune']);
    if (branch) await git(repo, ['branch', '-D', branch]);
  }
}

/**
 * Check repo-relative paths against allowed glob patterns (e.g. "src/**", "docs/*.md").
 * Also rejects absolute paths and traversal. Empty pattern list = everything allowed.
 */
export function checkAllowedPaths(files: string[], patterns: string[]): string[] {
  const bad: string[] = [];
  for (const raw of files) {
    const f = raw.replace(/\\/g, '/');
    const traversal = f.startsWith('/') || /^[a-zA-Z]:/.test(f) || f.split('/').includes('..');
    const allowed = patterns.length === 0 || patterns.some((p) => path.posix.matchesGlob(f, p.replace(/\\/g, '/')));
    if (traversal || !allowed) bad.push(raw);
  }
  return bad;
}
