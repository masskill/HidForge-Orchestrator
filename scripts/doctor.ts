// Діагностика HidForge без сервера: `node scripts/doctor.ts` (код виходу 1, якщо є помилки).
// Безпечно і при запущеному сервері: оркестратор не стартує (без відновлення запусків), лише читає стан.
import os from 'node:os';
import path from 'node:path';
import { Orchestrator } from '../src/orchestrator.ts';
import { diagnostics } from '../src/maintenance.ts';

const dataDir = process.env.HIDFORGE_DATA_DIR
  || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share'), 'HidForge');
const orch = new Orchestrator({ dataDir });
const d = await diagnostics(orch);
orch.store.db.close();
const mark = { ok: '[OK]  ', info: '[i]   ', warn: '[УВАГА]', error: '[ПОМИЛКА]' } as const;
for (const c of d.checks) console.log(`${mark[c.level]} ${c.label}: ${c.detail}`);
console.log(d.ok ? '\nПомилок не знайдено.' : '\nЗнайдено помилки — див. рядки [ПОМИЛКА].');
process.exit(d.ok ? 0 : 1);
