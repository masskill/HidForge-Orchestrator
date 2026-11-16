// Entry point: `node src/main.ts [--port N] [--demo]`
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Orchestrator } from './orchestrator.ts';
import { createServer, createDemo } from './server.ts';

const args = process.argv.slice(2);
const flag = (n: string) => args.includes(n);
const opt = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };

const dataDir = process.env.HIDFORGE_DATA_DIR
  || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share'), 'HidForge');
const port = Number(opt('--port') ?? process.env.HIDFORGE_PORT ?? 4317);
const here = path.dirname(fileURLToPath(import.meta.url));

const orch = new Orchestrator({
  dataDir,
  maxConcurrent: Number(process.env.HIDFORGE_MAX_CONCURRENT ?? 2),
  stallTimeoutSec: Number(process.env.HIDFORGE_STALL_TIMEOUT_SEC ?? 600),
});
await orch.start();
const srv = createServer(orch, { port, webDir: path.resolve(here, '..', 'web') });
const actual = await srv.listen();
if (flag('--demo')) {
  const p = await createDemo(orch);
  console.log(`Demo project created: ${p.repoPath}`);
}
console.log(`HidForge Orchestrator running at http://127.0.0.1:${actual}  (data: ${dataDir})`);

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
