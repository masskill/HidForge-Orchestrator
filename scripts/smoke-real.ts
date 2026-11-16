// Smoke test against REAL installed CLIs (uses your CLI subscription quota: one tiny task per provider).
// Usage: node scripts/smoke-real.ts claude codex:gpt-5.6-luna agy   (provider[:model])
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { Orchestrator } from '../src/orchestrator.ts';
import { makeRepo } from '../test/helpers.ts';

const providers = process.argv.slice(2);
if (!providers.length) { console.error('usage: node scripts/smoke-real.ts <provider...>'); process.exit(2); }
const root = mkdtempSync(path.join(os.tmpdir(), 'HidForge smoke ї-'));
const repo = await makeRepo(root);
const orch = new Orchestrator({ dataDir: path.join(root, 'data'), tickMs: 200, backoffMs: 0, stallTimeoutSec: 120, maxConcurrent: 3 });
await orch.start();
const p = await orch.addProject(repo, 'Smoke test of real CLI adapters');
const st = await orch.registry.status();
const ids = new Map<string, number>();
for (const spec of providers) {
  const [prov, model] = spec.split(':') as [string, string | undefined];
  const s = st.find((x) => x.id === prov);
  console.log(`${prov}: installed=${s?.installed} auth=${s?.auth} available=${s?.available} ${s?.reason ?? ''}`);
  const file = `smoke-${prov}.txt`;
  const t = orch.createTask(p.id, {
    title: `Create ${file}`, provider: prov, model: model ?? (prov === 'claude' ? 'haiku' : null), maxAttempts: 1, timeoutSec: 300,
    allowedPaths: [file], description: `Create a file named ${file} in the repository root containing exactly the text: hello from ${prov}\nDo not create or modify any other file. Do not run shell commands.`,
  });
  ids.set(prov, t.id);
  orch.submit(t.id);
}
const end = Date.now() + 360_000;
while (Date.now() < end && [...ids.values()].some((id) => !['review', 'failed', 'blocked', 'needs_user_input'].includes(orch.store.getTask(id).status))) {
  await new Promise((r) => setTimeout(r, 1000));
}
await orch.idle();
for (const [prov, id] of ids) {
  const t = orch.store.getTask(id);
  const run = orch.store.runsForTask(id).at(-1);
  const f = t.workspace ? path.join(t.workspace, `smoke-${prov}.txt`) : '';
  console.log(`\n== ${prov}: task=${t.status} run=${run?.status} exit=${run?.exitCode} error=${run?.error ?? ''}`);
  console.log(`   usage=${JSON.stringify(run?.usage)}`);
  console.log(`   file=${f && existsSync(f) ? JSON.stringify(readFileSync(f, 'utf8')) : '(missing)'}`);
  console.log(`   gate=${JSON.stringify(t.artifacts.gate)}`);
  for (const e of orch.store.events({ taskId: id }).filter((e) => e.type === 'run.output').slice(-6)) console.log('   >', JSON.stringify(e.data).slice(0, 220));
}
await orch.stop();
