// Smoke test of the AI reviewer against REAL installed CLIs (uses a little of your CLI subscription quota).
// A Mock worker writes deliberately unsafe code (eval of user input); the real agent must review it read-only.
// Usage: node scripts/smoke-review.ts claude:haiku agy
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync } from 'node:fs';
import { Orchestrator } from '../src/orchestrator.ts';
import { makeRepo, mock } from '../test/helpers.ts';
import { git } from '../src/workspace.ts';
import type { AiReview } from '../src/reviewer.ts';

const specs = process.argv.slice(2);
if (!specs.length) { console.error('usage: node scripts/smoke-review.ts <provider[:model]>...'); process.exit(2); }
const BUGGY = [
  "import { createInterface } from 'node:readline';",
  'const rl = createInterface({ input: process.stdin });',
  '// Evaluate the arithmetic expression typed by the user',
  "rl.on('line', (line) => console.log(eval(line)));",
  '',
].join('\n');
const root = mkdtempSync(path.join(os.tmpdir(), 'HidForge review smoke ї-'));
for (const spec of specs) {
  const [provider, model] = spec.split(':');
  const repo = await makeRepo(root, `repo ${provider}`);
  const orch = new Orchestrator({ dataDir: path.join(root, `data-${provider}`), stallTimeoutSec: 180 });
  await orch.start();
  const p = await orch.addProject(repo, 'A safe command-line calculator for untrusted user input.');
  orch.store.updateProject(p.id, { reviewPolicy: { mode: 'required', provider: provider!, model: model ?? null } });
  const t = orch.createTask(p.id, { title: 'Calculator CLI', provider: 'mock', allowedPaths: ['src/**'], maxAttempts: 1,
    acceptanceCriteria: 'Reads arithmetic expressions from stdin and prints the result. Must be safe for untrusted input.',
    description: mock({ write: { 'src/calc.js': BUGGY } }) });
  orch.submit(t.id);
  const t0 = Date.now();
  let r: AiReview | undefined;
  for (;;) {
    r = orch.store.getTask(t.id).artifacts.aiReview as AiReview | undefined;
    if (r && r.status !== 'running') break;
    if (Date.now() - t0 > 600_000) { console.log('   timeout'); break; }
    await new Promise((res) => setTimeout(res, 1000));
  }
  await orch.idle();
  const task = orch.store.getTask(t.id);
  console.log(`\n== ${spec}: review ${r?.status} in ${Math.round((Date.now() - t0) / 1000)}s ${r?.error ?? ''}`);
  console.log(`   verdict=${r?.verdict} task=${task.status} usage=${JSON.stringify(r?.usage)}`);
  console.log(`   summary: ${String(r?.summary ?? '').slice(0, 400)}`);
  for (const f of r?.findings ?? []) console.log(`   - [${f.severity}] ${f.file}${f.line ? ':' + f.line : ''} ${f.message.slice(0, 200)}`);
  const wsClean = task.workspace ? (await git(task.workspace, ['status', '--porcelain'])).stdout.trim() === '' : true;
  console.log(`   task worktree untouched by reviewer: ${wsClean}; main checkout untouched: ${(await git(repo, ['status', '--porcelain'])).stdout.trim() === ''}`);
  await orch.stop();
}
