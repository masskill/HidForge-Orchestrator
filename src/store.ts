// Single source of truth: projects, tasks, runs, locks, events. All state changes go through here.
import { EventEmitter } from 'node:events';
import type { DatabaseSync } from 'node:sqlite';
import { maskSecrets } from './proc.ts';

export const TASK_STATUSES = [
  'draft', 'ready', 'queued', 'running', 'review', 'accepted', 'merged',
  'blocked', 'failed', 'canceled', 'needs_user_input',
] as const;
export type TaskStatus = typeof TASK_STATUSES[number];
export type Policy = 'read-only' | 'workspace-write';

// Allowed transitions of the task state machine.
const TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  draft: ['ready', 'canceled'],
  ready: ['queued', 'draft', 'canceled'],
  queued: ['running', 'ready', 'canceled', 'failed'],
  running: ['review', 'queued', 'failed', 'blocked', 'canceled'],
  review: ['accepted', 'queued', 'blocked', 'failed', 'needs_user_input', 'canceled'],
  needs_user_input: ['review', 'queued', 'blocked', 'canceled'],
  accepted: ['merged', 'blocked'],
  blocked: ['queued', 'accepted', 'canceled'],
  failed: ['queued', 'canceled'],
  canceled: ['draft'],
  merged: [],
};

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export type ReviewMode = 'off' | 'advisory' | 'required';
export interface ReviewPolicy { mode: ReviewMode; provider: string; model: string | null }
export const DEFAULT_REVIEW_POLICY: ReviewPolicy = { mode: 'off', provider: 'auto', model: null };

export interface Project {
  id: number; name: string; repoPath: string; baseBranch: string; goal: string;
  allowedCommands: string[]; reviewPolicy: ReviewPolicy; budgetUsd: number | null; createdAt: string;
}

export interface Evidence { ts: string; kind: string; ok: boolean; summary: string; detail?: string }

export interface Task {
  id: number; projectId: number; title: string; description: string; acceptanceCriteria: string;
  dependsOn: number[]; priority: number; assignedRole: string; provider: string; model: string | null;
  policy: Policy; allowedPaths: string[]; verifyCommands: string[]; status: TaskStatus; maxBudgetUsd: number | null;
  /** Auto-routing inputs (src/routing.ts); effort is an explicit per-task override, null = from the routing chain. */
  category: string | null; complexity: string | null; effort: string | null;
  attempts: number; maxAttempts: number; timeoutSec: number;
  workspace: string | null; branch: string | null; baseCommit: string | null;
  artifacts: Record<string, unknown>; evidence: Evidence[];
  question: string | null; feedback: string | null; notBefore: string | null;
  createdAt: string; updatedAt: string;
}

export interface Run {
  id: number; taskId: number; attempt: number; provider: string; isMock: boolean; pid: number | null;
  status: 'running' | 'succeeded' | 'failed' | 'timeout' | 'canceled' | 'interrupted';
  exitCode: number | null; error: string | null; usage: unknown; startedAt: string; endedAt: string | null;
  lastOutputAt: string | null;
  /** What this run actually used; category/complexity are copied from the task at start. */
  model: string | null; effort: string | null; category: string | null; complexity: string | null; reviewVerdict: string | null;
}

export interface PlanTask {
  key: string; title: string; description: string; acceptanceCriteria: string; dependsOn: (string | number)[];
  role: string; allowedPaths: string[]; verifyCommands: string[]; policy: Policy; category?: string; complexity?: string;
}
export interface PlanDoc { summary: string; risks: string[]; tasks: PlanTask[] }
export interface PlanRun {
  id: number; projectId: number; provider: string; model: string | null;
  status: 'running' | 'succeeded' | 'failed' | 'canceled' | 'applied' | 'discarded';
  goal: string; pid: number | null; output: string | null; plan: PlanDoc | null; error: string | null;
  usage: unknown; appliedTaskIds: number[] | null; createdAt: string; finishedAt: string | null;
}

export interface HfEvent { id: number; projectId: number | null; taskId: number | null; runId: number | null; type: string; data: unknown; ts: string }

type Row = Record<string, unknown>;
const now = () => new Date().toISOString();
const j = (v: unknown) => JSON.stringify(v);
const pj = <T>(v: unknown, d: T): T => { try { return v == null ? d : JSON.parse(String(v)) as T; } catch { return d; } };

function toProject(r: Row): Project {
  return {
    id: Number(r.id), name: String(r.name), repoPath: String(r.repo_path), baseBranch: String(r.base_branch),
    goal: String(r.goal), allowedCommands: pj(r.allowed_commands, []),
    reviewPolicy: { ...DEFAULT_REVIEW_POLICY, ...pj(r.review_policy, {}) }, budgetUsd: r.budget_usd == null ? null : Number(r.budget_usd),
    createdAt: String(r.created_at),
  };
}

function toTask(r: Row): Task {
  return {
    id: Number(r.id), projectId: Number(r.project_id), title: String(r.title), description: String(r.description),
    acceptanceCriteria: String(r.acceptance_criteria), dependsOn: pj(r.depends_on, []), priority: Number(r.priority),
    assignedRole: String(r.assigned_role), provider: String(r.provider), model: (r.model as string) ?? null,
    policy: r.policy as Policy, allowedPaths: pj(r.allowed_paths, []), verifyCommands: pj(r.verify_commands, []),
    status: r.status as TaskStatus, attempts: Number(r.attempts), maxAttempts: Number(r.max_attempts),
    timeoutSec: Number(r.timeout_sec), workspace: (r.workspace as string) ?? null, branch: (r.branch as string) ?? null,
    baseCommit: (r.base_commit as string) ?? null, artifacts: pj(r.artifacts, {}), evidence: pj(r.evidence, []),
    question: (r.question as string) ?? null, feedback: (r.feedback as string) ?? null,
    notBefore: (r.not_before as string) ?? null, maxBudgetUsd: r.max_budget_usd == null ? null : Number(r.max_budget_usd),
    category: (r.category as string) ?? null, complexity: (r.complexity as string) ?? null, effort: (r.effort as string) ?? null, createdAt: String(r.created_at), updatedAt: String(r.updated_at),
  };
}

function toRun(r: Row): Run {
  return {
    id: Number(r.id), taskId: Number(r.task_id), attempt: Number(r.attempt), provider: String(r.provider),
    isMock: Boolean(r.is_mock), pid: r.pid == null ? null : Number(r.pid), status: r.status as Run['status'],
    exitCode: r.exit_code == null ? null : Number(r.exit_code), error: (r.error as string) ?? null,
    usage: pj(r.usage, null), startedAt: String(r.started_at), endedAt: (r.ended_at as string) ?? null,
    lastOutputAt: (r.last_output_at as string) ?? null, model: (r.model as string) ?? null, effort: (r.effort as string) ?? null,
    category: (r.category as string) ?? null, complexity: (r.complexity as string) ?? null, reviewVerdict: (r.review_verdict as string) ?? null,
  };
}

function toPlan(r: Row): PlanRun {
  return {
    id: Number(r.id), projectId: Number(r.project_id), provider: String(r.provider), model: (r.model as string) ?? null,
    status: r.status as PlanRun['status'], goal: String(r.goal), pid: r.pid == null ? null : Number(r.pid),
    output: (r.output as string) ?? null, plan: pj(r.plan, null), error: (r.error as string) ?? null, usage: pj(r.usage, null),
    appliedTaskIds: pj(r.applied_task_ids, null), createdAt: String(r.created_at), finishedAt: (r.finished_at as string) ?? null,
  };
}

const TASK_COLUMNS: Record<string, string> = {
  title: 'title', description: 'description', acceptanceCriteria: 'acceptance_criteria', dependsOn: 'depends_on',
  priority: 'priority', assignedRole: 'assigned_role', provider: 'provider', model: 'model', policy: 'policy',
  allowedPaths: 'allowed_paths', verifyCommands: 'verify_commands', maxAttempts: 'max_attempts', timeoutSec: 'timeout_sec',
  workspace: 'workspace', branch: 'branch', baseCommit: 'base_commit', artifacts: 'artifacts', evidence: 'evidence',
  question: 'question', feedback: 'feedback', notBefore: 'not_before', attempts: 'attempts', maxBudgetUsd: 'max_budget_usd',
  category: 'category', complexity: 'complexity', effort: 'effort',
};
const JSON_FIELDS = new Set(['dependsOn', 'allowedPaths', 'verifyCommands', 'artifacts', 'evidence']);
export const EDITABLE_FIELDS = ['title', 'description', 'acceptanceCriteria', 'dependsOn', 'priority', 'assignedRole',
  'provider', 'model', 'policy', 'allowedPaths', 'verifyCommands', 'maxAttempts', 'timeoutSec', 'maxBudgetUsd', 'category', 'complexity', 'effort'] as const;

export class Store {
  readonly bus = new EventEmitter();
  readonly db: DatabaseSync;
  constructor(db: DatabaseSync) { this.db = db; this.bus.setMaxListeners(100); }

  tx<T>(fn: () => T): T {
    this.db.exec('begin immediate');
    try { const r = fn(); this.db.exec('commit'); return r; } catch (e) { this.db.exec('rollback'); throw e; }
  }

  // ---- projects
  createProject(p: { name: string; repoPath: string; baseBranch: string; goal?: string }): Project {
    const r = this.db.prepare('insert into projects (name, repo_path, base_branch, goal, created_at) values (?,?,?,?,?) returning *')
      .get(p.name, p.repoPath, p.baseBranch, p.goal ?? '', now()) as Row;
    const proj = toProject(r);
    this.event({ projectId: proj.id, type: 'project.created', data: { name: proj.name } });
    return proj;
  }
  listProjects(): Project[] { return this.db.prepare('select * from projects order by id').all().map((r) => toProject(r as Row)); }
  getProject(id: number): Project {
    const r = this.db.prepare('select * from projects where id = ?').get(id) as Row | undefined;
    if (!r) throw new NotFound(`project ${id}`);
    return toProject(r);
  }
  updateProject(id: number, patch: { goal?: string; name?: string; allowedCommands?: string[]; reviewPolicy?: ReviewPolicy; budgetUsd?: number | null }): Project {
    const p = this.getProject(id);
    this.db.prepare('update projects set goal = ?, name = ?, allowed_commands = ?, review_policy = ?, budget_usd = ? where id = ?')
      .run(patch.goal ?? p.goal, patch.name ?? p.name, j(patch.allowedCommands ?? p.allowedCommands), j(patch.reviewPolicy ?? p.reviewPolicy),
        patch.budgetUsd === undefined ? p.budgetUsd : patch.budgetUsd, id);
    return this.getProject(id);
  }

  /** Remove a project and everything HidForge stored about it (tasks, runs, plans cascade; events by id). */
  deleteProject(id: number): void {
    this.getProject(id);
    this.tx(() => {
      this.db.prepare('delete from events where project_id = ? or task_id in (select id from tasks where project_id = ?)').run(id, id);
      this.db.prepare('delete from projects where id = ?').run(id);
    });
  }

  // ---- tasks
  createTask(projectId: number, t: Partial<Task> & { title: string }): Task {
    this.getProject(projectId);
    const ts = now();
    const r = this.db.prepare(`insert into tasks (project_id, title, created_at, updated_at) values (?,?,?,?) returning id`)
      .get(projectId, t.title, ts, ts) as Row;
    const id = Number(r.id);
    const patch: Record<string, unknown> = {};
    for (const k of EDITABLE_FIELDS) if (t[k] !== undefined) patch[k] = t[k];
    if (Object.keys(patch).length) this.patchTask(id, patch);
    const task = this.getTask(id);
    this.event({ projectId, taskId: id, type: 'task.created', data: { title: task.title } });
    return task;
  }
  getTask(id: number): Task {
    const r = this.db.prepare('select * from tasks where id = ?').get(id) as Row | undefined;
    if (!r) throw new NotFound(`task ${id}`);
    return toTask(r);
  }
  listTasks(projectId: number): Task[] {
    return this.db.prepare('select * from tasks where project_id = ? order by id').all(projectId).map((r) => toTask(r as Row));
  }
  tasksByStatus(...statuses: TaskStatus[]): Task[] {
    const q = `select * from tasks where status in (${statuses.map(() => '?').join(',')}) order by priority desc, id`;
    return this.db.prepare(q).all(...statuses).map((r) => toTask(r as Row));
  }
  /** Low-level field update (no status change). */
  patchTask(id: number, patch: Record<string, unknown>): Task {
    const sets: string[] = [];
    const vals: (string | number | null)[] = [];
    for (const [k, v] of Object.entries(patch)) {
      const col = TASK_COLUMNS[k];
      if (!col) throw new Error(`unknown task field ${k}`);
      sets.push(`${col} = ?`);
      vals.push(JSON_FIELDS.has(k) ? j(v) : (v as string | number | null) ?? null);
    }
    if (!sets.length) return this.getTask(id);
    sets.push('updated_at = ?');
    vals.push(now(), id);
    this.db.prepare(`update tasks set ${sets.join(', ')} where id = ?`).run(...vals);
    return this.getTask(id);
  }
  /** Status change, validated against the state machine. */
  setStatus(id: number, to: TaskStatus, patch: Record<string, unknown> = {}, note?: string): Task {
    const t = this.getTask(id);
    if (t.status !== to && !canTransition(t.status, to)) throw new Conflict(`task ${id}: ${t.status} -> ${to} not allowed`);
    this.db.prepare('update tasks set status = ?, updated_at = ? where id = ?').run(to, now(), id);
    const task = this.patchTask(id, patch);
    this.event({ projectId: t.projectId, taskId: id, type: 'task.status', data: { from: t.status, to, note } });
    return task;
  }
  addEvidence(id: number, e: Omit<Evidence, 'ts'>): Task {
    const t = this.getTask(id);
    const ev: Evidence = { ts: now(), ...e, summary: maskSecrets(e.summary), detail: e.detail && maskSecrets(e.detail).slice(-20_000) };
    const task = this.patchTask(id, { evidence: [...t.evidence, ev] });
    this.event({ projectId: t.projectId, taskId: id, type: 'task.evidence', data: { kind: ev.kind, ok: ev.ok, summary: ev.summary } });
    return task;
  }
  deleteTask(id: number): void {
    const t = this.getTask(id);
    if (!['draft', 'canceled'].includes(t.status)) throw new Conflict('only draft/canceled tasks can be deleted');
    for (const other of this.listTasks(t.projectId)) {
      if (other.dependsOn.includes(id)) throw new Conflict(`task ${other.id} depends on ${id}`);
    }
    this.db.prepare('delete from tasks where id = ?').run(id);
    this.event({ projectId: t.projectId, taskId: id, type: 'task.deleted', data: {} });
  }

  // ---- runs & locks
  /** Atomically: take the workspace lock, create the run, mark the task running. Throws Conflict if anything is taken. */
  beginRun(task: Task, workspace: string, isMock: boolean, used: { provider?: string; model?: string | null; effort?: string | null } = {}): Run {
    return this.tx(() => {
      const cur = this.getTask(task.id);
      if (cur.status !== 'queued') throw new Conflict(`task ${task.id} is ${cur.status}, not queued`);
      const ts = now();
      let run: Row;
      try {
        run = this.db.prepare(`insert into runs (task_id, attempt, provider, is_mock, status, started_at, last_output_at, model, effort, category, complexity)
          values (?,?,?,?, 'running', ?, ?, ?,?,?,?) returning *`).get(task.id, cur.attempts + 1, used.provider ?? cur.provider, isMock ? 1 : 0, ts, ts,
          used.model === undefined ? cur.model : used.model, used.effort === undefined ? cur.effort : used.effort, cur.category, cur.complexity) as Row;
        this.db.prepare('insert into workspace_locks (workspace, run_id, acquired_at) values (?,?,?)').run(workspace, Number(run.id), ts);
      } catch (e) {
        if (String((e as Error).message).includes('UNIQUE')) throw new Conflict(`workspace or task already has an active run: ${workspace}`);
        throw e;
      }
      this.setStatus(task.id, 'running', { attempts: cur.attempts + 1, notBefore: null, question: null });
      return toRun(run);
    });
  }
  acquireLock(workspace: string, runId: number): boolean {
    try { this.db.prepare('insert into workspace_locks (workspace, run_id, acquired_at) values (?,?,?)').run(workspace, runId, now()); return true; }
    catch { return false; }
  }
  releaseLock(workspace: string): void { this.db.prepare('delete from workspace_locks where workspace = ?').run(workspace); }
  setRunPid(runId: number, pid: number): void { this.db.prepare('update runs set pid = ? where id = ?').run(pid, runId); }
  touchRun(runId: number): void { this.db.prepare('update runs set last_output_at = ? where id = ?').run(now(), runId); }
  endRun(runId: number, status: Run['status'], f: { exitCode?: number | null; error?: string | null; usage?: unknown } = {}): Run {
    const r = this.db.prepare(`update runs set status = ?, exit_code = ?, error = ?, usage = ?, ended_at = ? where id = ? returning *`)
      .get(status, f.exitCode ?? null, f.error ?? null, f.usage === undefined ? null : j(f.usage), now(), runId) as Row;
    return toRun(r);
  }
  /** The AI reviewer's verdict on the attempt this run produced (model statistics). */
  setRunVerdict(taskId: number, attempt: number, verdict: string): void {
    this.db.prepare('update runs set review_verdict = ? where task_id = ? and attempt = ?').run(verdict, taskId, attempt);
  }
  /** Finished real (non-mock) runs that carry a category: the raw data for per-model statistics. */
  routedRuns(): Run[] {
    return this.db.prepare(`select * from runs where is_mock = 0 and category is not null and status != 'running' order by id`).all().map((r) => toRun(r as Row));
  }
  getRun(id: number): Run { return toRun(this.db.prepare('select * from runs where id = ?').get(id) as Row); }
  runsForTask(taskId: number): Run[] { return this.db.prepare('select * from runs where task_id = ? order by id').all(taskId).map((r) => toRun(r as Row)); }
  /** Every run of a project in one query (cost totals). */
  allProjectRuns(projectId: number): Run[] {
    return this.db.prepare('select r.* from runs r join tasks t on t.id = r.task_id where t.project_id = ? order by r.id').all(projectId).map((r) => toRun(r as Row));
  }
  runsForProject(projectId: number, f: { before?: number; limit?: number; status?: string; provider?: string } = {}): (Run & { taskTitle: string })[] {
    const where = ['t.project_id = ?']; const vals: (number | string)[] = [projectId];
    if (f.before) { where.push('r.id < ?'); vals.push(f.before); }
    if (f.status) { where.push('r.status = ?'); vals.push(f.status); }
    if (f.provider) { where.push('r.provider = ?'); vals.push(f.provider); }
    vals.push(Math.min(Math.max(f.limit ?? 100, 1), 1000));
    return this.db.prepare(`select r.*, t.title as task_title from runs r join tasks t on t.id = r.task_id where ${where.join(' and ')} order by r.id desc limit ?`)
      .all(...vals).map((r) => ({ ...toRun(r as Row), taskTitle: String((r as Row).task_title) }));
  }
  liveRuns(): Run[] { return this.db.prepare(`select * from runs where status = 'running'`).all().map((r) => toRun(r as Row)); }
  locks(): { workspace: string; runId: number }[] {
    return this.db.prepare('select * from workspace_locks').all().map((r) => ({ workspace: String(r.workspace), runId: Number(r.run_id) }));
  }

  // ---- planner runs
  createPlan(p: { projectId: number; provider: string; model: string | null; goal: string }): PlanRun {
    try {
      const r = this.db.prepare(`insert into plans (project_id, provider, model, status, goal, created_at) values (?,?,?, 'running', ?, ?) returning *`)
        .get(p.projectId, p.provider, p.model, p.goal, now()) as Row;
      return toPlan(r);
    } catch (e) {
      if (String((e as Error).message).includes('UNIQUE')) throw new Conflict('a planner is already running for this project');
      throw e;
    }
  }
  getPlan(id: number): PlanRun {
    const r = this.db.prepare('select * from plans where id = ?').get(id) as Row | undefined;
    if (!r) throw new NotFound(`plan ${id}`);
    return toPlan(r);
  }
  listPlans(projectId: number, limit = 20): PlanRun[] {
    return this.db.prepare('select * from plans where project_id = ? order by id desc limit ?').all(projectId, limit).map((r) => toPlan(r as Row));
  }
  runningPlans(): PlanRun[] { return this.db.prepare(`select * from plans where status = 'running'`).all().map((r) => toPlan(r as Row)); }
  updatePlan(id: number, f: Partial<Pick<PlanRun, 'status' | 'pid' | 'output' | 'plan' | 'error' | 'usage' | 'appliedTaskIds' | 'provider'>>): PlanRun {
    const cols: Record<string, string> = { status: 'status', pid: 'pid', output: 'output', plan: 'plan', error: 'error', usage: 'usage', appliedTaskIds: 'applied_task_ids', provider: 'provider' };
    const sets: string[] = [];
    const vals: (string | number | null)[] = [];
    for (const [k, v] of Object.entries(f)) {
      sets.push(`${cols[k]} = ?`);
      vals.push(['plan', 'usage', 'appliedTaskIds'].includes(k) ? (v == null ? null : j(v)) : (v as string | number | null) ?? null);
    }
    if (f.status && f.status !== 'running') { sets.push('finished_at = coalesce(finished_at, ?)'); vals.push(now()); }
    vals.push(id);
    this.db.prepare(`update plans set ${sets.join(', ')} where id = ?`).run(...vals);
    const plan = this.getPlan(id);
    if (f.status) this.event({ projectId: plan.projectId, type: 'plan.status', data: { planId: id, status: f.status, error: plan.error } });
    return plan;
  }

  // ---- events
  event(e: { projectId?: number | null; taskId?: number | null; runId?: number | null; type: string; data: unknown }): HfEvent {
    const data = typeof e.data === 'string' ? maskSecrets(e.data) : e.data;
    const r = this.db.prepare('insert into events (project_id, task_id, run_id, type, data, ts) values (?,?,?,?,?,?) returning id, ts')
      .get(e.projectId ?? null, e.taskId ?? null, e.runId ?? null, e.type, j(data), now()) as Row;
    const ev: HfEvent = { id: Number(r.id), projectId: e.projectId ?? null, taskId: e.taskId ?? null, runId: e.runId ?? null, type: e.type, data, ts: String(r.ts) };
    this.bus.emit('event', ev);
    return ev;
  }
  /** Oldest first after `afterId`; with `beforeId`, the newest events below it, still returned oldest first (log paging). */
  events(f: { afterId?: number; beforeId?: number; projectId?: number; taskId?: number; type?: string; limit?: number }): HfEvent[] {
    const where: string[] = ['id > ?'];
    const vals: (number | string)[] = [f.afterId ?? 0];
    if (f.beforeId) { where.push('id < ?'); vals.push(f.beforeId); }
    if (f.projectId) { where.push('project_id = ?'); vals.push(f.projectId); }
    if (f.taskId) { where.push('task_id = ?'); vals.push(f.taskId); }
    if (f.type) { where.push('type = ?'); vals.push(f.type); }
    vals.push(f.limit ?? 2000);
    const rows = this.db.prepare(`select * from events where ${where.join(' and ')} order by id ${f.beforeId ? 'desc' : ''} limit ?`).all(...vals);
    if (f.beforeId) rows.reverse();
    return rows.map((r) => ({
      id: Number(r.id), projectId: r.project_id as number | null, taskId: r.task_id as number | null, runId: r.run_id as number | null,
      type: String(r.type), data: pj(r.data, null), ts: String(r.ts),
    }));
  }

  // ---- settings
  getSetting<T>(key: string, d: T): T {
    const r = this.db.prepare('select value from settings where key = ?').get(key) as Row | undefined;
    return r ? pj(r.value, d) : d;
  }
  setSetting(key: string, value: unknown): void {
    this.db.prepare('insert into settings (key, value) values (?, ?) on conflict(key) do update set value = excluded.value').run(key, j(value));
  }
}

export class NotFound extends Error { readonly status = 404; }
export class Conflict extends Error { readonly status = 409; }
export class BadRequest extends Error { readonly status = 400; }
