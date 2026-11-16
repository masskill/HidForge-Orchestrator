// Task contract (prompt) given to a worker, and the verification-command policy.
import { BadRequest, type Project, type Task } from './store.ts';
import path from 'node:path';
import { parseArgv } from './proc.ts';

/** Model ids are passed as a separate argv value after `--model`; reject anything a CLI could read as a flag. */
const MODEL_RE = /^[A-Za-z0-9][\w.:/@[\],=+-]{0,127}$/;
export function cleanModel(v: unknown): string | null {
  if (v === undefined || v === null || v === '') return null;
  const m = String(v).trim();
  if (!m) return null;
  if (!MODEL_RE.test(m)) throw new BadRequest(`invalid model name "${m.slice(0, 60)}": letters, digits and . _ : / @ [ ] , = + - only, not starting with -`);
  return m;
}

export const ROLES = ['Project Manager/Planner', 'Architect', 'Frontend', 'Backend', 'QA', 'Security Reviewer', 'Integrator'] as const;

/** Per-role template: extra instructions in the contract + permissions enforced by the scheduler. */
export interface RoleTemplate { instructions: string; readOnly: boolean; providers: string[] }
export type RoleTemplates = Record<string, RoleTemplate>;

export const DEFAULT_ROLE_TEMPLATES: RoleTemplates = {
  'Project Manager/Planner': { instructions: 'Break work into small, verifiable steps. Do not implement features yourself.', readOnly: true, providers: [] },
  Architect: { instructions: 'Define contracts, interfaces and data shapes first; document decisions next to the code.', readOnly: false, providers: [] },
  Frontend: { instructions: 'Keep UI accessible (labels, focus, contrast) and consistent with the existing components.', readOnly: false, providers: [] },
  Backend: { instructions: 'Validate input at boundaries, handle errors explicitly, keep changes covered by tests.', readOnly: false, providers: [] },
  QA: { instructions: 'Write or extend automated tests for the acceptance criteria; report gaps you cannot cover.', readOnly: false, providers: [] },
  'Security Reviewer': { instructions: 'Look for injection, secrets, unsafe deserialization, weakened permissions. Report findings; do not refactor.', readOnly: true, providers: [] },
  Integrator: { instructions: 'Make the merged parts work together; prefer the smallest fix that keeps every side\'s intent.', readOnly: false, providers: [] },
};

export function roleTemplate(all: RoleTemplates | undefined, role: string): RoleTemplate {
  return all?.[role] ?? DEFAULT_ROLE_TEMPLATES[role] ?? { instructions: '', readOnly: false, providers: [] };
}

/** Validate a user-supplied templates object (unknown roles are dropped). */
export function normalizeRoleTemplates(raw: unknown, knownProvider: (id: string) => boolean): RoleTemplates {
  if (!raw || typeof raw !== 'object') throw new Error('roleTemplates must be an object');
  const out: RoleTemplates = {};
  for (const role of ROLES) {
    const r = (raw as Record<string, Record<string, unknown>>)[role];
    if (!r) continue;
    const providers = Array.isArray(r.providers) ? r.providers.map(String).filter(Boolean) : [];
    const bad = providers.find((p) => !knownProvider(p));
    if (bad) throw new Error(`role "${role}": unknown provider ${bad}`);
    out[role] = { instructions: String(r.instructions ?? '').slice(0, 4000), readOnly: r.readOnly === true, providers };
  }
  return out;
}

export function buildPrompt(task: Task, project: Project, attempt: number, tpl?: RoleTemplate): string {
  const list = (xs: string[], empty: string) => (xs.length ? xs.map((x) => `- ${x}`).join('\n') : empty);
  return `# Task contract — HidForge task #${task.id}
Attempt: ${attempt} of ${task.maxAttempts}
Role: ${task.assignedRole}
${tpl?.instructions ? `
## Role guidance
${tpl.instructions}
` : ''}
## Project goal
${project.goal || '(not set)'}

## Objective
${task.title}

${task.description}

## Acceptance criteria
${task.acceptanceCriteria || '(none given — keep the change minimal and self-consistent)'}

## Scope
You are working in an isolated git worktree of the project. Only modify files matching:
${list(task.allowedPaths, '- (any file in this repository)')}

## Do NOT
- touch files outside the allowed paths above;
- run git push, deploy, install global tools, change credentials or system settings;
- delete unrelated files or rewrite git history;
- commit secrets.
${task.policy === 'read-only' || tpl?.readOnly ? '- modify any file at all: this is a READ-ONLY task. Report findings only.\n' : ''}
## Validation (run by the orchestrator after you finish, you do not need to run them)
${list(task.verifyCommands, '- (no commands configured)')}
${task.feedback ? `\n## Feedback from the previous attempt — fix this\n${task.feedback}\n` : ''}
## Final report
Finish with a short summary: what you changed (files), what you did not do, and any open risks.
`;
}

// Never runnable, even with user approval through the UI.
const DENY: RegExp[] = [
  /^git\s+(push|reset|clean|checkout|rebase|filter-branch|update-ref)\b/i,
  /^(rm|del|erase|rmdir|rd|format|shutdown|reg|regedit|sc|net|netsh|bcdedit|diskpart|takeown|icacls|curl|wget|iwr|irm|invoke-webrequest|invoke-restmethod|powershell|pwsh|cmd|bash|sh|wsl|ssh|scp)(\.exe)?\b/i,
  /\b(npm|pnpm|yarn)\s+(publish|login|adduser|token)\b/i,
  /\bdeploy\b/i,
];
const SHELL_META = /[|&;<>`]|\$\(/;

export type CommandDecision = { decision: 'allow' } | { decision: 'ask' } | { decision: 'deny'; reason: string };

export function commandDecision(cmd: string, approved: string[]): CommandDecision {
  const c = cmd.trim();
  if (!c) return { decision: 'deny', reason: 'empty command' };
  if (SHELL_META.test(c)) return { decision: 'deny', reason: 'shell operators are not supported (commands run without a shell)' };
  if (DENY.some((re) => re.test(c))) return { decision: 'deny', reason: 'command is on the hard deny-list' };
  const why = argvDeny(c);
  if (why) return { decision: 'deny', reason: why };
  return approved.includes(c) ? { decision: 'allow' } : { decision: 'ask' };
}

const DENY_EXE = new Set(['rm', 'del', 'erase', 'rmdir', 'rd', 'format', 'shutdown', 'reg', 'regedit', 'sc', 'net', 'netsh', 'bcdedit', 'diskpart', 'takeown', 'icacls',
  'curl', 'wget', 'iwr', 'irm', 'invoke-webrequest', 'invoke-restmethod', 'powershell', 'pwsh', 'cmd', 'bash', 'sh', 'wsl', 'ssh', 'scp', 'runas', 'mshta', 'rundll32', 'cscript', 'wscript']);
const GIT_DENY = new Set(['push', 'reset', 'clean', 'checkout', 'rebase', 'filter-branch', 'update-ref']);
const GIT_OPT_WITH_ARG = new Set(['-C', '--git-dir', '--work-tree', '--namespace']);

/** The string regexes miss quoted names, full paths and git global options: check the argv the command actually runs with. */
function argvDeny(c: string): string | null {
  let argv: string[];
  try { argv = parseArgv(c); } catch (e) { return (e as Error).message; }
  const exe = path.win32.basename(argv[0] ?? '').toLowerCase().replace(/\.(exe|cmd|bat|com|ps1)$/, '');
  if (DENY_EXE.has(exe)) return 'command is on the hard deny-list';
  if (exe === 'git') {
    for (let i = 1; i < argv.length; i++) {
      const a = argv[i]!;
      if (a === '-c' || a.startsWith('--config-env') || a.startsWith('--exec-path')) return 'git config overrides are not allowed in verify commands';
      if (GIT_OPT_WITH_ARG.has(a)) { i++; continue; }
      if (a.startsWith('-')) continue;
      return GIT_DENY.has(a.toLowerCase()) ? 'command is on the hard deny-list' : null;
    }
  }
  if (['npm', 'pnpm', 'yarn'].includes(exe) && argv.some((a) => ['publish', 'login', 'adduser', 'token'].includes(a.toLowerCase()))) return 'command is on the hard deny-list';
  return null;
}
