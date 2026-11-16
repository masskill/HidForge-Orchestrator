// Deterministic Mock Agent process. Reads the task contract on stdin, obeys an `@mock {json}` directive
// found in it, writes files in cwd and prints NDJSON events. Used for demo mode and e2e tests.
// Planner mode: when the prompt is a planning request, it prints a fixed JSON plan and writes nothing.
import { writeFileSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';

interface Directive {
  sleepMs?: number; steps?: number; write?: Record<string, string>;
  exit?: number; mode?: 'ok' | 'hang' | 'crash' | 'noresult';
  failAttempts?: number; hangAttempts?: number; grandchild?: boolean; echoArgs?: boolean;
  plan?: unknown; planRaw?: string; // planner-mode overrides
}

const NL = '\n';
const FENCE = '`'.repeat(3);

function defaultPlan() {
  const m = (write: Record<string, string>) => '@mock ' + JSON.stringify({ sleepMs: 2500, steps: 5, write });
  return {
    summary: 'MOCK plan: API contract first, then backend and frontend in parallel, then integration tests.',
    risks: ['Produced by the Mock Agent, not by an AI model.'],
    tasks: [
      { key: 'contract', title: 'Define the API contract', role: 'Architect', dependsOn: [], allowedPaths: ['docs/**'],
        description: 'Write docs/api-contract.md.' + NL + m({ 'docs/api-contract.md': '# API contract' + NL + 'GET /items -> Item[]' + NL }),
        acceptanceCriteria: 'docs/api-contract.md exists' },
      { key: 'backend', title: 'Implement the backend', role: 'Backend', dependsOn: ['contract'], allowedPaths: ['src/backend/**'],
        description: 'Implement GET /items.' + NL + m({ 'src/backend/items.txt': 'GET /items implemented' + NL }),
        acceptanceCriteria: 'endpoint exists' },
      { key: 'frontend', title: 'Implement the frontend', role: 'Frontend', dependsOn: ['contract'], allowedPaths: ['src/frontend/**'],
        description: 'Render the items list.' + NL + m({ 'src/frontend/items-view.txt': 'Items list view' + NL }),
        acceptanceCriteria: 'view exists' },
      { key: 'tests', title: 'Integration tests', role: 'QA', dependsOn: ['backend', 'frontend'], allowedPaths: ['tests/**'],
        description: 'Cover the items flow.' + NL + m({ 'tests/items.test.txt': 'items flow covered' + NL }),
        acceptanceCriteria: 'tests exist' },
    ],
  };
}

const out = (o: unknown) => process.stdout.write(JSON.stringify(o) + NL);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { input += c; });
process.stdin.on('end', () => { main().catch((e) => { out({ type: 'error', text: String(e) }); process.exit(3); }); });

async function main() {
  const m = /@mock\s+(\{.*\})/.exec(input);
  const d: Directive = m ? JSON.parse(m[1]!) : {};
  const planning = input.startsWith('# Planning request');
  const attempt = Number(/Attempt:\s*(\d+)/.exec(input)?.[1] ?? 1);
  out({ type: 'message', text: `mock agent started (${planning ? 'planner' : `attempt ${attempt}`}) in ${path.basename(process.cwd())}` });
  if (d.echoArgs) out({ type: 'message', text: JSON.stringify(process.argv.slice(2)) });
  if (d.grandchild) {
    const c = spawn(process.execPath, ['-e', 'setInterval(()=>{}, 1000)'], { stdio: 'ignore', windowsHide: true });
    out({ type: 'message', text: `grandchild pid ${c.pid}` });
  }
  if (d.mode === 'hang' || (d.hangAttempts ?? 0) >= attempt) {
    out({ type: 'message', text: 'hanging (no further output)' });
    await new Promise(() => {}); // never resolves
  }
  const steps = d.steps ?? 3;
  for (let i = 1; i <= steps; i++) {
    await sleep(Math.round((d.sleepMs ?? 300) / steps));
    out({ type: 'message', text: planning ? `analysing repository ${i}/${steps}` : `step ${i}/${steps}` });
  }
  if (d.mode === 'crash') process.exit(139);
  if (planning) {
    if (d.mode !== 'noresult') {
      const text = d.planRaw ?? FENCE + 'json' + NL + JSON.stringify(d.plan ?? defaultPlan(), null, 2) + NL + FENCE;
      out({ type: 'result', ok: true, text, usage: { input_tokens: 0, output_tokens: 0 } });
    }
    process.exit(0);
  }
  for (const [rel, content] of Object.entries(d.write ?? {})) {
    const p = path.resolve(process.cwd(), rel);
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, content.replace('{attempt}', String(attempt)), 'utf8');
    out({ type: 'tool', text: `wrote ${rel}` });
  }
  if ((d.failAttempts ?? 0) >= attempt) { out({ type: 'result', ok: false, text: 'simulated failure' }); process.exit(1); }
  if (d.mode !== 'noresult') out({ type: 'result', ok: true, text: 'done', usage: { input_tokens: 0, output_tokens: 0 } });
  process.exit(d.exit ?? 0);
}

// Keep the process alive while hanging (a pending promise alone does not).
setInterval(() => {}, 1 << 30);
