// Diagnostics ("doctor") and backups of the local state (SQLite is the single source of truth).
import { mkdirSync, readdirSync, statSync, statfsSync, rmSync, accessSync, existsSync, constants } from 'node:fs';
import path from 'node:path';
import type { Orchestrator } from './orchestrator.ts';
import type { Store } from './store.ts';
import { SCHEMA_VERSION } from './db.ts';
import { git } from './workspace.ts';
import { run } from './proc.ts';

// ---------------------------------------------------------------- backups
export interface BackupInfo { name: string; file: string; sizeBytes: number; createdAt: string }
const BACKUP_RE = /^hidforge-(\d{8})-(\d{6})-(\d{3})\.db$/;
export const backupDir = (dataDir: string) => path.join(dataDir, 'backups');

export function listBackups(dataDir: string): BackupInfo[] {
  const dir = backupDir(dataDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const m = BACKUP_RE.exec(name);
    if (!m) return [];
    const [, d, t, ms] = m as unknown as [string, string, string, string];
    const createdAt = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}T${t.slice(0, 2)}:${t.slice(2, 4)}:${t.slice(4)}.${ms}Z`;
    const file = path.join(dir, name);
    return [{ name, file, sizeBytes: statSync(file).size, createdAt }];
  }).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Consistent online copy via `VACUUM INTO`; keeps the newest `keep` copies. */
export function createBackup(store: Store, dataDir: string, keep = 10): BackupInfo {
  const dir = backupDir(dataDir);
  mkdirSync(dir, { recursive: true });
  const iso = new Date().toISOString(); // 2026-11-16T15:30:12.345Z
  const name = `hidforge-${iso.slice(0, 10).replace(/-/g, '')}-${iso.slice(11, 19).replace(/:/g, '')}-${iso.slice(20, 23)}.db`;
  const file = path.join(dir, name);
  store.db.exec(`vacuum into '${file.replace(/'/g, "''")}'`);
  for (const old of listBackups(dataDir).slice(Math.max(1, keep))) rmSync(old.file, { force: true });
  return listBackups(dataDir).find((b) => b.name === name)!;
}

/** On start: one backup a day at most, and only once there is something to keep. */
export function autoBackup(store: Store, dataDir: string, maxAgeHours = 24): BackupInfo | null {
  const latest = listBackups(dataDir)[0];
  if (latest && Date.now() - Date.parse(latest.createdAt) < maxAgeHours * 3_600_000) return null;
  const n = store.db.prepare('select count(*) as n from projects').get() as { n: number };
  return n.n > 0 ? createBackup(store, dataDir) : null;
}

// ---------------------------------------------------------------- diagnostics
export type Level = 'ok' | 'info' | 'warn' | 'error';
export interface Check { id: string; label: string; level: Level; detail: string }
export interface Diagnostics { ok: boolean; generatedAt: string; checks: Check[] }

const mb = (b: number) => (b < 1048576 ? `${Math.max(1, Math.round(b / 1024))} КБ` : `${Math.round(b / 1048576)} МБ`);

export async function diagnostics(orch: Orchestrator): Promise<Diagnostics> {
  const { dataDir } = orch.opts;
  const db = orch.store.db;
  const checks: Check[] = [];
  const add = (id: string, label: string, level: Level, detail: string) => checks.push({ id, label, level, detail });
  const one = <T>(sql: string) => db.prepare(sql).get() as T;

  const major = Number(process.versions.node.split('.')[0]);
  add('node', 'Node.js', major >= 24 ? 'ok' : 'error', `${process.versions.node}${major >= 24 ? '' : ' — потрібен 24+'}`);
  const g = await run('git', ['--version'], { timeoutMs: 10_000 });
  add('git', 'Git', g.code === 0 ? 'ok' : 'error', g.code === 0 ? g.stdout.trim() : 'не знайдено в PATH');

  try {
    accessSync(dataDir, constants.W_OK);
    const fs = statfsSync(dataDir);
    const free = fs.bavail * fs.bsize;
    add('data', 'Тека даних', free < 200 * 1048576 ? 'error' : free < 1024 * 1048576 ? 'warn' : 'ok', `${dataDir} — вільно ${mb(free)}`);
  } catch (e) { add('data', 'Тека даних', 'error', `${dataDir}: ${(e as Error).message}`); }

  const qc = one<{ quick_check: string }>('pragma quick_check').quick_check;
  add('db', 'Цілісність бази', qc === 'ok' ? 'ok' : 'error', qc === 'ok' ? 'quick_check: ok' : qc);
  const v = one<{ v: number | null }>('select max(version) as v from schema_migrations').v ?? 0;
  add('schema', 'Версія схеми', v === SCHEMA_VERSION ? 'ok' : 'error', `${v} з ${SCHEMA_VERSION}`);
  const c = one<{ p: number; t: number; e: number }>('select (select count(*) from projects) p, (select count(*) from tasks) t, (select count(*) from events) e');
  const dbFile = path.join(dataDir, 'hidforge.db');
  add('size', 'Обсяг стану', 'info', `${c.p} проєктів, ${c.t} задач, ${c.e} подій; файли бази ${mb(['', '-wal'].reduce((n, x) => n + (existsSync(dbFile + x) ? statSync(dbFile + x).size : 0), 0))}`);

  const latest = listBackups(dataDir)[0];
  const ageH = latest ? (Date.now() - Date.parse(latest.createdAt)) / 3_600_000 : Infinity;
  add('backup', 'Резервна копія', !latest ? 'warn' : ageH > 48 ? 'warn' : 'ok',
    latest ? `остання ${latest.createdAt.slice(0, 16).replace('T', ' ')} UTC (${Math.round(ageH)} год тому), ${listBackups(dataDir).length} шт.` : 'ще немає');

  for (const p of orch.store.listProjects()) {
    if (!existsSync(p.repoPath)) { add(`project-${p.id}`, `Проєкт «${p.name}»`, 'error', `тека не існує: ${p.repoPath}`); continue; }
    const b = await git(p.repoPath, ['rev-parse', '--verify', '--quiet', `refs/heads/${p.baseBranch}`], 10_000).catch(() => null);
    add(`project-${p.id}`, `Проєкт «${p.name}»`, b?.code === 0 ? 'ok' : 'error', b?.code === 0 ? `${p.repoPath} (${p.baseBranch})` : `гілку ${p.baseBranch} не знайдено в ${p.repoPath}`);
  }

  for (const a of await orch.registry.status(true)) {
    if (a.mock) continue;
    add(`agent-${a.id}`, `Агент ${a.name}`, a.available ? 'ok' : a.installed ? 'warn' : 'info',
      a.available ? `${a.version ?? ''} готовий` : a.installed ? `недоступний: ${a.reason ?? 'невідомо'}` : "не встановлено (необов'язково)");
  }
  return { ok: !checks.some((x) => x.level === 'error'), generatedAt: new Date().toISOString(), checks };
}
