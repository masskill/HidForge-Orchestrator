// Watchdog for the no-terminal launcher (scripts\HidForge.vbs): runs src/main.ts and starts it again when it stops
// unexpectedly (killed, crashed). A deliberate stop (Settings -> Stop server, or "already running") exits with 0 and
// ends the watchdog too. Gives up after 5 unexpected stops within 10 minutes, so a server that cannot start does not spin.
// Usage: node scripts/supervise.ts [main.ts arguments]
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const stamp = () => new Date().toISOString();
const stops: number[] = [];

function start(first: boolean): void {
  // --open only on the first start: a restart must not pop up a new browser tab
  const a = first ? args : args.filter((x) => x !== '--open');
  const child = spawn(process.execPath, [path.join(root, 'src', 'main.ts'), ...a], { cwd: root, stdio: 'inherit', windowsHide: true });
  child.on('exit', (code, signal) => {
    if (code === 0) { console.log(`[${stamp()}] HidForge stopped (exit 0); watchdog ends`); process.exit(0); }
    const now = Date.now();
    stops.push(now);
    while (stops.length && now - stops[0]! > 10 * 60_000) stops.shift();
    if (stops.length > 5) { console.error(`[${stamp()}] HidForge stopped ${stops.length} times in 10 minutes; watchdog gives up`); process.exit(1); }
    const wait = 2_000 * stops.length;
    console.error(`[${stamp()}] HidForge stopped unexpectedly (code ${code}, signal ${signal}); restarting in ${wait / 1000}s`);
    setTimeout(() => start(false), wait);
  });
}

start(true);
