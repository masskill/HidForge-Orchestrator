// Entry point: `node src/main.ts [--port N] [--demo] [--open]`
// --open: open the UI in the default browser (used by the no-terminal launcher scripts\HidForge.vbs).
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Orchestrator } from './orchestrator.ts';
import { spawn } from 'node:child_process';
import { createServer, createDemo, APP_NAME } from './server.ts';
import { autoBackup } from './maintenance.ts';

const args = process.argv.slice(2);
const flag = (n: string) => args.includes(n);
const opt = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };

const dataDir = process.env.HIDFORGE_DATA_DIR
  || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share'), 'HidForge');
const port = Number(opt('--port') ?? process.env.HIDFORGE_PORT ?? 4317);
const here = path.dirname(fileURLToPath(import.meta.url));

function openBrowser(url: string) {
  const [cmd, a] = process.platform === 'win32' ? ['explorer.exe', [url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try { spawn(cmd, a, { detached: true, stdio: 'ignore' }).unref(); } catch { /* no browser: the URL is printed below */ }
}

// A second launch (e.g. double-clicking the shortcut again) must not start a second orchestrator on the same data:
// if HidForge already answers on this port, just open it.
try {
  const r = await fetch(`http://127.0.0.1:${port}/api/version`, { signal: AbortSignal.timeout(1500) });
  if ((await r.json() as { name?: string }).name === APP_NAME) {
    console.log(`HidForge is already running at http://127.0.0.1:${port}`);
    if (flag('--open')) openBrowser(`http://127.0.0.1:${port}`);
    process.exit(0);
  }
} catch { /* nothing there (or not HidForge): start normally */ }

const orch = new Orchestrator({
  dataDir,
  maxConcurrent: Number(process.env.HIDFORGE_MAX_CONCURRENT ?? 2),
  stallTimeoutSec: Number(process.env.HIDFORGE_STALL_TIMEOUT_SEC ?? 600),
});
await orch.start();
try {
  const b = autoBackup(orch.store, dataDir);
  if (b) console.log(`Backup: ${b.file}`);
} catch (e) { console.error(`Backup failed: ${(e as Error).message}`); }
const srv = createServer(orch, { port, webDir: path.resolve(here, '..', 'web'), onShutdown: () => void shutdown() });
const actual = await srv.listen();
if (flag('--demo')) {
  const p = await createDemo(orch);
  console.log(`Demo project created: ${p.repoPath}`);
}
console.log(`HidForge Orchestrator running at http://127.0.0.1:${actual}  (data: ${dataDir})`);
if (flag('--open')) openBrowser(`http://127.0.0.1:${actual}`);

let stopping = false;
const shutdown = async () => {
  if (stopping) return;
  stopping = true;
  console.log('Stopping…');
  await srv.close();
  await orch.stop();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
