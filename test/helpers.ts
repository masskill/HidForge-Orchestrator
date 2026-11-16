import os from 'node:os';
import path from 'node:path';
import { mkdirSync, writeFileSync, mkdtempSync } from 'node:fs';
import { Orchestrator, type OrchestratorOptions } from '../src/orchestrator.ts';
import { git } from '../src/workspace.ts';
import type { TaskStatus } from '../src/store.ts';

/** Temp dir whose path contains spaces and Ukrainian letters on purpose. */
export function tmpRoot(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'HidForge тест з пробілами ї-'));
}

export async function makeRepo(root: string, name = 'Мій репозиторій'): Promise<string> {
  const repo = path.join(root, name);
  mkdirSync(path.join(repo, 'src'), { recursive: true });
  writeFileSync(path.join(repo, 'README.md'), '# test\n');
  writeFileSync(path.join(repo, 'src', 'index.txt'), 'x\n');
  await git(repo, ['init', '-q', '-b', 'main']);
  await git(repo, ['add', '-A']);
  await git(repo, ['commit', '-q', '-m', 'init']);
  return repo;
}

export async function setup(o: Partial<OrchestratorOptions> = {}) {
  const root = tmpRoot();
  const repo = await makeRepo(root);
  const dataDir = path.join(root, 'data дані');
  const orch = new Orchestrator({ dataDir, tickMs: 40, backoffMs: 0, ...o });
  await orch.start();
  const project = await orch.addProject(repo, 'test goal');
  return { root, repo, dataDir, orch, project };
}

export const mock = (d: object) => `@mock ${JSON.stringify(d)}`;

export async function waitFor<T>(fn: () => T | undefined | false | null, ms = 20_000, what = 'condition'): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 30));
  }
}

export async function waitStatus(orch: Orchestrator, id: number, statuses: TaskStatus[], ms = 20_000) {
  const t = await waitFor(() => { const t = orch.store.getTask(id); return statuses.includes(t.status) ? t : null; }, ms,
    `task ${id} -> ${statuses.join('|')} (now ${orch.store.getTask(id).status})`);
  await orch.idle();
  return orch.store.getTask(id).status === t.status ? orch.store.getTask(id) : waitStatus(orch, id, statuses, ms);
}
