// Task contract (prompt) given to a worker, and the verification-command policy.
import type { Project, Task } from './store.ts';

export function buildPrompt(task: Task, project: Project, attempt: number): string {
  const list = (xs: string[], empty: string) => (xs.length ? xs.map((x) => `- ${x}`).join('\n') : empty);
  return `# Task contract — HidForge task #${task.id}
Attempt: ${attempt} of ${task.maxAttempts}
Role: ${task.assignedRole}

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
${task.policy === 'read-only' ? '- modify any file at all: this is a READ-ONLY task. Report findings only.\n' : ''}
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
  return approved.includes(c) ? { decision: 'allow' } : { decision: 'ask' };
}
