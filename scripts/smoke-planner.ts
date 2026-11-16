// Smoke test of the LLM planner against REAL installed CLIs (uses a little of your CLI subscription quota).
// Usage: node scripts/smoke-planner.ts claude:haiku agy
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { Orchestrator } from '../src/orchestrator.ts';
import { makeRepo } from '../test/helpers.ts';
import { git } from '../src/workspace.ts';

const specs = process.argv.slice(2);
if (!specs.length) { console.error('usage: node scripts/smoke-planner.ts <provider[:model]>...'); process.exit(2); }
const root = mkdtempSync(path.join(os.tmpdir(), 'HidForge planner smoke ї-'));
for (const spec of specs) {
  const [provider, model] = spec.split(':');
  const repo = await makeRepo(root, `repo ${provider}`);
  writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'calc', type: 'module', scripts: { test: 'node --test' } }, null, 2));
  await git(repo, ['add', '-A']);
  await git(repo, ['commit', '-q', '-m', 'package.json']);
  const orch = new Orchestrator({ dataDir: path.join(root, `data-${provider}`), stallTimeoutSec: 180 });
  await orch.start();
  const p = await orch.addProject(repo, 'Build a small Node.js command-line calculator: an expression parser module, an arithmetic operations module, a CLI entry point, and node:test unit tests.');
  const plan = await orch.planner.start(p.id, { provider, model: model ?? null, maxTasks: 6, timeoutSec: 400 });
  const t0 = Date.now();
  let cur = plan;
  while ((cur = orch.store.getPlan(plan.id)).status === 'running') await new Promise((r) => setTimeout(r, 1000));
  await orch.idle();
  console.log(`\n== ${spec}: ${cur.status} in ${Math.round((Date.now() - t0) / 1000)}s ${cur.error ?? ''}`);
  console.log(`   usage=${JSON.stringify(cur.usage)}`);
  if (cur.plan) {
    console.log(`   summary: ${cur.plan.summary.slice(0, 300)}`);
    for (const t of cur.plan.tasks) console.log(`   - [${t.key}] ${t.title} (${t.role}) deps=${JSON.stringify(t.dependsOn)} paths=${t.allowedPaths.join(',')} verify=${t.verifyCommands.join(';')}`);
    const tasks = orch.planner.apply(plan.id);
    console.log(`   applied -> draft tasks ${tasks.map((t) => `#${t.id}${t.dependsOn.length ? '<-' + t.dependsOn.join('+') : ''}`).join(' ')}`);
  } else console.log(`   output tail: ${(cur.output ?? '').slice(-600)}`);
  const st = (await git(repo, ['status', '--porcelain'])).stdout.trim();
  console.log(`   main checkout untouched: ${st === ''}`);
  await orch.stop();
}
