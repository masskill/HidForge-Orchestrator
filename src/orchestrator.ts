// Orchestrator: DAG scheduler, run supervision, review gates, integration, restart recovery.
// One instance owns one database: it is the only scheduler.
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import type { ChildProcess } from 'node:child_process';
import { openDb } from './db.ts';
import { Store, Conflict, BadRequest, EDITABLE_FIELDS, type Task, type Project, type Run } from './store.ts';
import { validateDeps, depsSatisfied } from './dag.ts';
import { WorkspaceManager, inspectRepo, checkAllowedPaths, git } from './workspace.ts';
import { AgentRegistry, defaultAdapters, DEFAULT_ROUTING, APP_PLUGINS_DIR, type RoutingPolicy } from './adapters/index.ts';
import { loadPlugins, type PluginLoad } from './adapters/plugin.ts';
import { WslAdapter, type WslConfig } from './adapters/wsl.ts';
import { SshAdapter, type SshConfig } from './adapters/ssh.ts';
import type { AgentAdapter, AgentEvent, Invocation } from './adapters/types.ts';
import { spawnSafe, killTree, isAlive, parseArgv, run as runCmd, maskSecrets } from './proc.ts';
import { buildPrompt, cleanModel, commandDecision, roleTemplate, type RoleTemplates } from './contract.ts';
import { Planner } from './planner.ts';
import { Reviewer } from './reviewer.ts';
import { Chat } from './chat.ts';
import { projectCosts, cellStats } from './costs.ts';
import { CATEGORIES, COMPLEXITIES, EFFORTS, DEFAULT_CEILING, DEFAULT_MATRIX, resolveChain, reorderByStats, effortFlagFor, type Effort, type Link, type Matrix } from './routing.ts';

export interface OrchestratorOptions {
  dataDir: string;
  maxConcurrent?: number;
  tickMs?: number;
  backoffMs?: number;          // base retry backoff, doubled per attempt
  stallTimeoutSec?: number;    // kill a worker that prints nothing for this long
  verifyTimeoutSec?: number;
  adapters?: AgentAdapter[];
}

interface Handle {
  run: Run; taskId: number; workspace: string; child: ChildProcess; adapter: AgentAdapter;
  startedAt: number; lastOutput: number; timeoutMs: number;
  result: AgentEvent | null; killReason: string | null; canceled: boolean; done: boolean;
  exited: Promise<void>;
}

export class Orchestrator {
  readonly store: Store;
  readonly registry: AgentRegistry;
  readonly ws: WorkspaceManager;
  readonly planner: Planner;
  readonly reviewer: Reviewer;
  readonly chat: Chat;
  readonly pluginErrors: PluginLoad['errors'];
  readonly opts: Required<Omit<OrchestratorOptions, 'adapters'>>;
  private readonly handles = new Map<number, Handle>();
  /** Runs still uploading to a remote backend (adapter.prepare), by task id. */
  private readonly preparing = new Map<number, { ac: AbortController; done: Promise<void> }>();
  private readonly pending = new Set<Promise<unknown>>();
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private mergeChain: Promise<unknown> = Promise.resolve();

  constructor(o: OrchestratorOptions) {
    this.opts = { maxConcurrent: 2, tickMs: 500, backoffMs: 5_000, stallTimeoutSec: 600, verifyTimeoutSec: 900, ...o, dataDir: path.resolve(o.dataDir) };
    mkdirSync(this.opts.dataDir, { recursive: true });
    this.store = new Store(openDb(path.join(this.opts.dataDir, 'hidforge.db')));
    // Agents: built-ins + JSON plugins (unless a test passes its own), plus WSL copies chosen in settings (applied on restart).
    const plugins = o.adapters ? { adapters: [], errors: [] } : loadPlugins([APP_PLUGINS_DIR, path.join(this.opts.dataDir, 'plugins')]);
    this.pluginErrors = plugins.errors;
    const base = o.adapters ?? [...defaultAdapters(() => this.store.getSetting('apiFallback', false)), ...plugins.adapters];
    const wsl = this.store.getSetting<WslConfig | null>('wsl', null);
    const viaWsl = wsl ? base.filter((a) => wsl.agents.includes(a.id) && !a.mock).map((a) => new WslAdapter(a, wsl.distro)) : [];
    const ssh = this.store.getSetting<SshConfig | null>('ssh', null);
    const viaSsh = ssh ? base.filter((a) => ssh.agents.includes(a.id) && !a.mock).map((a) => new SshAdapter(a, ssh)) : [];
    this.registry = new AgentRegistry([...base, ...viaWsl, ...viaSsh]);
    this.ws = new WorkspaceManager(path.join(this.opts.dataDir, 'worktrees'));
    this.planner = new Planner(this);
    this.reviewer = new Reviewer(this);
    this.chat = new Chat(this);
  }

  get maxConcurrent(): number { return this.store.getSetting('maxConcurrentAgents', this.opts.maxConcurrent); }
  /** Explicit per-agent user opt-in to trust HidForge worktrees (Cursor). Off unless the user enabled it. */
  trusts(provider: string): boolean { return this.store.getSetting<Record<string, boolean>>('agentTrust', {})[provider] === true; }
  get routingPolicy(): RoutingPolicy { return this.store.getSetting('routingPolicy', 'balanced' as RoutingPolicy); }

  /** Auto-routing settings (all user-editable in Settings). */
  routingSettings() {
    const s = this.store;
    return {
      effortCeiling: s.getSetting<Effort>('effortCeiling', DEFAULT_CEILING), allowFable: s.getSetting('allowFable', false), selfLearning: s.getSetting('selfLearning', false),
      agentReadOnly: s.getSetting<Record<string, boolean>>('agentReadOnly', {}), routingMatrix: { ...DEFAULT_MATRIX, ...s.getSetting<Matrix>('routingMatrix', {}) },
    };
  }
  /** Agents the user marked as unable to write files right now. */
  readOnlyAgents(): Set<string> { const r = this.routingSettings().agentReadOnly; return new Set(Object.keys(r).filter((k) => r[k])); }

  /** Usable links for a category/complexity right now, best first. Empty = nothing from the matrix can run (callers fall back to the provider order). */
  async chainFor(category: string, complexity: string | null, o: { write: boolean; roleProviders?: string[] }): Promise<Link[]> {
    const rs = this.routingSettings();
    const available = new Set((await this.registry.status()).filter((a) => a.available && !a.mock).map((a) => a.id));
    const cx = complexity ?? 'medium';
    const chain = resolveChain(category, cx, { matrix: rs.routingMatrix, available, readOnlyAgents: this.readOnlyAgents(), write: o.write,
      roleProviders: o.roleProviders, ceiling: rs.effortCeiling, allowFable: rs.allowFable });
    return rs.selfLearning ? reorderByStats(chain, cellStats(this.store, category, cx)) : chain;
  }

  async start(): Promise<void> {
    await this.reviewer.recover(); // first: recover() may re-run gates, which can start fresh reviews
    await this.recover();
    await this.planner.recover();
    this.timer = setInterval(() => { void this.tick(); }, this.opts.tickMs);
  }

  /** Graceful stop: kills live workers (their tasks are re-queued on next start). */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.tickSettled();
    await this.planner.stop();
    await this.chat.stop();
    await this.reviewer.stop();
    for (const up of this.preparing.values()) up.ac.abort();
    await Promise.all([...this.preparing.values()].map((up) => up.done));
    await Promise.all([...this.handles.values()].map(async (h) => { if (h.child.pid) await killTree(h.child.pid); await h.exited; }));
    await this.idle();
    this.store.db.close();
  }

  private async tickSettled(): Promise<void> { while (this.ticking) await new Promise((r) => setTimeout(r, 10)); }

  /** Test hook: simulate a crash — stop scheduling and drop handles WITHOUT killing workers or updating the DB. */
  async crashForTest(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.tickSettled();
    for (const h of this.handles.values()) { h.done = true; h.child.stdout?.destroy(); h.child.stderr?.destroy(); }
    this.handles.clear();
    this.planner.abandon();
    this.reviewer.abandon();
    this.store.db.close();
  }

  /** Wait until background gate/merge work has settled. */
  async idle(): Promise<void> { while (this.pending.size) await Promise.allSettled([...this.pending]); }

  track<T>(p: Promise<T>): Promise<T> {
    this.pending.add(p);
    void p.finally(() => this.pending.delete(p)).catch(() => {});
    return p;
  }

  // ------------------------------------------------------------------ project & plan API
  async addProject(repoPath: string, goal = ''): Promise<Project> {
    const { root, branch } = await inspectRepo(repoPath);
    const existing = this.store.listProjects().find((p) => path.resolve(p.repoPath) === root);
    if (existing) return existing;
    return this.store.createProject({ name: path.basename(root), repoPath: root, baseBranch: branch, goal });
  }

  /**
   * Forget a project: HidForge's records and its task worktrees are removed. The user's repository and the task
   * branches in it are left as they are, so unmerged work is never lost. Refused while anything of the project runs.
   */
  async deleteProject(id: number): Promise<{ ok: true; removedWorktrees: number; keptBranches: string[] }> {
    const p = this.store.getProject(id);
    const tasks = this.store.listTasks(id);
    const busy = tasks.filter((t) => ['queued', 'running'].includes(t.status) || this.reviewer.isRunning(t.id));
    if (busy.length) throw new Conflict(`stop the running or queued tasks first: ${busy.map((t) => `#${t.id}`).join(', ')}`);
    if (this.store.runningPlans().some((x) => x.projectId === id)) throw new Conflict('the AI planner is running for this project; stop it first');
    if (this.chat.busy(id)) throw new Conflict('the chat assistant is answering in this project; stop it first');
    let removed = 0;
    for (const t of tasks) {
      if (!t.workspace) continue;
      await this.ws.remove(p.repoPath, t.workspace, null).catch(() => {});
      removed++;
    }
    const keptBranches = tasks.filter((t) => t.branch && t.status !== 'merged').map((t) => t.branch!);
    this.store.deleteProject(id);
    this.store.event({ type: 'project.deleted', data: { name: p.name, removedWorktrees: removed, keptBranches } });
    return { ok: true, removedWorktrees: removed, keptBranches };
  }

  createTask(projectId: number, input: Partial<Task> & { title: string }): Task {
    const clean = this.cleanTaskInput(input);
    const deps = clean.dependsOn ?? [];
    const all = this.store.listTasks(projectId);
    const err = validateDeps(all, -1, deps);
    if (err) throw new BadRequest(err);
    // Auto-routed tasks get 3 attempts by default so a failure can walk the whole chain (primary, fallback 1, fallback 2).
    if (clean.provider === 'auto' && clean.maxAttempts === undefined) clean.maxAttempts = 3;
    return this.store.createTask(projectId, { ...clean, title: input.title });
  }

  updateTask(id: number, input: Partial<Task>): Task {
    const t = this.store.getTask(id);
    if (!['draft', 'ready', 'failed', 'blocked'].includes(t.status)) throw new Conflict(`task in status ${t.status} cannot be edited`);
    const clean = this.cleanTaskInput(input);
    if (clean.dependsOn) {
      const err = validateDeps(this.store.listTasks(t.projectId), id, clean.dependsOn);
      if (err) throw new BadRequest(err);
    }
    return this.store.patchTask(id, clean);
  }

  private cleanTaskInput(input: Partial<Task>): Partial<Task> {
    const out: Record<string, unknown> = {};
    for (const k of EDITABLE_FIELDS) if (input[k] !== undefined) out[k] = input[k];
    if (out.provider !== undefined && out.provider !== 'auto' && !this.registry.get(String(out.provider))) throw new BadRequest(`unknown provider ${out.provider}`);
    if (out.model !== undefined) out.model = cleanModel(out.model);
    if (out.policy !== undefined && !['read-only', 'workspace-write'].includes(String(out.policy))) throw new BadRequest('policy must be read-only or workspace-write');
    for (const k of ['dependsOn', 'allowedPaths', 'verifyCommands'] as const) {
      if (out[k] !== undefined && !Array.isArray(out[k])) throw new BadRequest(`${k} must be an array`);
    }
    if (Array.isArray(out.dependsOn)) out.dependsOn = (out.dependsOn as unknown[]).map(Number);
    if (out.maxAttempts !== undefined) out.maxAttempts = Math.max(1, Math.min(10, Number(out.maxAttempts)));
    if (out.timeoutSec !== undefined) out.timeoutSec = Math.max(5, Number(out.timeoutSec));
    if (out.maxBudgetUsd !== undefined) out.maxBudgetUsd = out.maxBudgetUsd === null || out.maxBudgetUsd === '' ? null : Math.max(0.01, Number(out.maxBudgetUsd)) || null;
    for (const [k, allowed] of [['category', CATEGORIES], ['complexity', COMPLEXITIES], ['effort', EFFORTS]] as const) {
      if (out[k] === undefined) continue;
      if (out[k] === null || out[k] === '') out[k] = null;
      else if (!(allowed as readonly string[]).includes(String(out[k]))) throw new BadRequest(`${k} must be one of: ${allowed.join(', ')}`);
    }
    return out as Partial<Task>;
  }

  /** draft -> ready: the task is approved for execution and will start once its dependencies are merged. */
  submit(id: number): Task { return this.store.setStatus(id, 'ready'); }
  submitAll(projectId: number): Task[] {
    return this.store.listTasks(projectId).filter((t) => t.status === 'draft').map((t) => this.submit(t.id));
  }

  async cancel(id: number): Promise<Task> {
    const h = [...this.handles.values()].find((x) => x.taskId === id);
    const task = this.store.setStatus(id, 'canceled', {}, 'canceled by user');
    const up = this.preparing.get(id);
    if (up) { up.ac.abort(); await up.done; }
    if (h) { h.canceled = true; if (h.child.pid) await killTree(h.child.pid); await h.exited; }
    await this.reviewer.killFor(id);
    return task;
  }

  /** Manual retry of a failed/blocked task: grants one more attempt. */
  retry(id: number): Task {
    const t = this.store.getTask(id);
    if (!['failed', 'blocked'].includes(t.status)) throw new Conflict(`cannot retry a ${t.status} task`);
    return this.store.setStatus(id, 'queued', { maxAttempts: Math.max(t.maxAttempts, t.attempts + 1), notBefore: null }, 'manual retry');
  }

  reject(id: number, feedback: string, retry = true): Task {
    const t = this.store.getTask(id);
    if (!['review', 'needs_user_input'].includes(t.status)) throw new Conflict(`cannot reject a ${t.status} task`);
    this.store.addEvidence(id, { kind: 'human-review', ok: false, summary: `Rejected: ${feedback || '(no reason)'}` });
    void this.track(this.reviewer.killFor(id));
    if (!retry) return this.store.setStatus(id, 'blocked', {}, 'rejected');
    return this.store.setStatus(id, 'queued', { feedback: feedback || 'Rejected by reviewer', maxAttempts: Math.max(t.maxAttempts, t.attempts + 1) }, 'rejected, repair requested');
  }

  /** Answer a pending question (currently: approval of a verification command). */
  async answer(id: number, allow: boolean): Promise<Task> {
    const t = this.store.getTask(id);
    if (t.status !== 'needs_user_input') throw new Conflict('task is not waiting for input');
    const cmd = String(t.artifacts.pendingCommand ?? '');
    if (!allow) {
      this.store.addEvidence(id, { kind: 'command-approval', ok: false, summary: `User denied command: ${cmd}` });
      return this.store.setStatus(id, 'blocked', { question: null }, 'command denied');
    }
    const p = this.store.getProject(t.projectId);
    if (commandDecision(cmd, []).decision === 'deny') throw new BadRequest('this command can never be approved');
    this.store.updateProject(p.id, { allowedCommands: [...new Set([...p.allowedCommands, cmd])] });
    this.store.addEvidence(id, { kind: 'command-approval', ok: true, summary: `User approved command for this project: ${cmd}` });
    this.store.setStatus(id, 'review', { question: null, artifacts: { ...t.artifacts, pendingCommand: undefined } });
    await this.track(this.runGates(id));
    return this.store.getTask(id);
  }

  async diff(id: number): Promise<string> {
    const t = this.store.getTask(id);
    if (!t.workspace || !t.baseCommit) return '';
    if (t.status === 'merged') return String(t.artifacts.mergedDiff ?? '');
    return maskSecrets(await this.ws.diff(t.workspace, t.baseCommit));
  }

  /** Human "Approve & Merge". Merges are serialized. */
  approve(id: number): Promise<Task> {
    const p = this.mergeChain.then(() => this.doApprove(id));
    this.mergeChain = p.catch(() => {});
    return this.track(p);
  }

  private async doApprove(id: number): Promise<Task> {
    let t = this.store.getTask(id);
    const gate = t.artifacts.gate as { passed?: boolean } | undefined;
    if (!['review', 'blocked'].includes(t.status) || !gate?.passed) throw new Conflict('only tasks with passed gates (review, or blocked after a failed merge) can be merged');
    const blocker = this.reviewer.mergeBlocker(t);
    if (blocker) throw new Conflict(blocker);
    const p = this.store.getProject(t.projectId);
    t = this.store.setStatus(id, 'accepted', {}, 'approved by user');
    this.store.addEvidence(id, { kind: 'human-review', ok: true, summary: 'Approved by user' });
    if (!t.branch || !t.workspace || !t.baseCommit) return this.store.setStatus(id, 'merged', {}, 'nothing to merge');
    const changed = await this.ws.changedFiles(t.workspace, t.baseCommit);
    if (changed.length === 0) {
      await this.ws.remove(p.repoPath, t.workspace, t.branch);
      return this.store.setStatus(id, 'merged', {}, 'no changes (read-only task)');
    }
    const mergedDiff = maskSecrets(await this.ws.diff(t.workspace, t.baseCommit)).slice(0, 200_000);
    const res = await this.ws.merge(p.repoPath, p.baseBranch, t.branch, `HidForge: merge task #${t.id} ${t.title}`);
    if (!res.ok) {
      this.store.addEvidence(id, { kind: 'merge', ok: false, summary: res.conflicts.length ? `Merge conflict in: ${res.conflicts.join(', ')}` : res.reason, detail: res.reason });
      return this.store.setStatus(id, 'blocked', { artifacts: { ...t.artifacts, mergeConflict: res.conflicts, needsRebase: res.conflicts.length > 0 } },
        'merge failed; task branch preserved');
    }
    this.store.addEvidence(id, { kind: 'merge', ok: true, summary: `Merged into ${p.baseBranch} as ${res.commit.slice(0, 10)}` });
    t = this.store.setStatus(id, 'merged', { artifacts: { ...t.artifacts, mergeCommit: res.commit, mergedDiff } });
    await this.ws.remove(p.repoPath, t.workspace!, t.branch);
    await this.postMergeChecks(t, p);
    return this.store.getTask(id);
  }

  /** Integration check on the base branch after a merge (approved commands only). */
  private async postMergeChecks(t: Task, p: Project): Promise<void> {
    const failed: { cmd: string; out: string }[] = [];
    for (const cmd of t.verifyCommands) {
      if (commandDecision(cmd, p.allowedCommands).decision !== 'allow') continue;
      const r = await this.runVerify(cmd, p.repoPath);
      this.store.addEvidence(t.id, { kind: 'integration-check', ok: r.code === 0, summary: `[${p.baseBranch}] ${cmd} -> exit ${r.code}`, detail: r.out });
      if (r.code !== 0) { failed.push({ cmd, out: r.out }); this.store.event({ projectId: p.id, taskId: t.id, type: 'integration.failed', data: { cmd } }); }
    }
    if (failed.length) this.createIntegrator(t, p, failed);
  }

  /** A failed post-merge check becomes a separate Integrator task — a draft, so nothing runs without the user. */
  private createIntegrator(t: Task, p: Project, failed: { cmd: string; out: string }[]): Task {
    const it = this.createTask(p.id, {
      title: `Integrator: fix ${p.baseBranch} after #${t.id} ${t.title}`.slice(0, 200),
      assignedRole: 'Integrator', provider: t.provider, model: t.model, maxAttempts: 2, allowedPaths: [],
      verifyCommands: failed.map((f) => f.cmd),
      description: `Task #${t.id} "${t.title}" was merged into ${p.baseBranch}, and these integration checks now fail on ${p.baseBranch}:\n\n`
        + failed.map((f) => `$ ${f.cmd}\n${maskSecrets(f.out).slice(-3000)}`).join('\n\n')
        + `\n\nMake the smallest change that makes them pass again without undoing the intent of task #${t.id}.`,
      acceptanceCriteria: failed.map((f) => `\`${f.cmd}\` exits 0`).join('\n'),
    });
    this.store.patchTask(t.id, { artifacts: { ...this.store.getTask(t.id).artifacts, integratorTaskId: it.id } });
    this.store.addEvidence(t.id, { kind: 'integrator', ok: false, summary: `Integration check failed on ${p.baseBranch}; Integrator draft #${it.id} created` });
    return it;
  }

  // ------------------------------------------------------------------ scheduler
  async tick(): Promise<void> {
    if (this.ticking || !this.timer) return;
    this.ticking = true;
    try {
      this.checkTimeouts();
      // ready -> queued once dependencies are merged
      const projects = new Map<number, Map<number, Task>>();
      for (const t of this.store.tasksByStatus('ready')) {
        if (!projects.has(t.projectId)) projects.set(t.projectId, new Map(this.store.listTasks(t.projectId).map((x) => [x.id, x])));
        if (depsSatisfied(t, projects.get(t.projectId)!)) this.store.setStatus(t.id, 'queued', {}, 'dependencies merged');
      }
      const nowIso = new Date().toISOString();
      let free = this.maxConcurrent - this.store.liveRuns().length;
      for (const t of this.store.tasksByStatus('queued')) {
        if (free <= 0) break;
        if (t.notBefore && t.notBefore > nowIso) continue;
        if (await this.startRun(t)) free--;
      }
    } catch (e) {
      this.store.event({ type: 'scheduler.error', data: { message: (e as Error).message } });
    } finally {
      this.ticking = false;
    }
  }

  private checkTimeouts(): void {
    const now = Date.now();
    for (const h of this.handles.values()) {
      if (h.killReason || h.canceled) continue;
      if (now - h.startedAt > h.timeoutMs) h.killReason = `timeout: exceeded ${Math.round(h.timeoutMs / 1000)}s`;
      else if (now - h.lastOutput > this.opts.stallTimeoutSec * 1000) h.killReason = `stalled: no output for ${this.opts.stallTimeoutSec}s`;
      if (h.killReason && h.child.pid) void killTree(h.child.pid);
    }
  }

  private failTask(t: Task, reason: string): void {
    this.store.addEvidence(t.id, { kind: 'scheduler', ok: false, summary: reason });
    this.store.setStatus(t.id, 'failed', {}, reason);
  }

  /** Returns true if a worker was started. */
  roleTemplates(): RoleTemplates { return this.store.getSetting<RoleTemplates>('roleTemplates', {}); }

  private async startRun(task: Task): Promise<boolean> {
    let t = task;
    const tpl = roleTemplate(this.roleTemplates(), t.assignedRole);
// What this run will use. For 'auto' with a category: link N of the routing chain for attempt N (escalation = another model/vendor,
    // never more effort); the task itself stays 'auto'. Without a category: the first available agent in the provider order.
    let used: { provider: string; model: string | null; effort: string | null; flag: string | null } = { provider: t.provider, model: t.model, effort: t.effort, flag: t.effort };
    if (t.provider === 'auto') {
      const write = t.policy !== 'read-only' && !tpl.readOnly;
      const chain = t.category ? await this.chainFor(t.category, t.complexity, { write, roleProviders: tpl.providers }) : [];
      if (chain.length) {
        const i = Math.min(t.attempts, chain.length - 1);
        const l = chain[i]!;
        const flag = effortFlagFor(l) === null ? null : (t.effort ?? l.effort); // an effort the human wrote into the task wins over the table
        used = { provider: l.agent, model: l.model, effort: flag ?? l.effort, flag };
        this.store.event({ projectId: t.projectId, taskId: t.id, type: 'task.routed', data: { provider: l.agent, model: l.model, effort: used.effort,
          category: t.category, complexity: t.complexity ?? 'medium', link: i + 1, of: chain.length, reason: i ? `attempt ${t.attempts + 1}: escalated to link ${i + 1}` : 'primary link' } });
      } else {
        const table = this.store.getSetting('routingTable', DEFAULT_ROUTING);
        const ro = write ? this.readOnlyAgents() : new Set<string>();
        const base = table[this.routingPolicy].filter((x) => !ro.has(x));
        const order = tpl.providers.length ? [...base.filter((x) => tpl.providers.includes(x)), ...tpl.providers.filter((x) => !base.includes(x) && !ro.has(x))] : base;
        const picked = await this.registry.pick(this.routingPolicy, { ...table, [this.routingPolicy]: order });
        if (!picked) { this.failTask(t, `no available agent for routing policy '${this.routingPolicy}'${tpl.providers.length ? ` among agents allowed for role ${t.assignedRole} (${tpl.providers.join(', ')})` : ''}`); return false; }
        t = this.store.patchTask(t.id, { provider: picked });
        used = { ...used, provider: picked };
        this.store.event({ projectId: t.projectId, taskId: t.id, type: 'task.routed', data: { provider: picked, policy: this.routingPolicy } });
      }
    }
    if (tpl.providers.length && !tpl.providers.includes(used.provider)) { this.failTask(t, `role ${t.assignedRole} may only use: ${tpl.providers.join(', ')} (task asks for ${used.provider})`); return false; }
    if (tpl.readOnly && t.policy !== 'read-only') {
      t = this.store.patchTask(t.id, { policy: 'read-only' });
      this.store.addEvidence(t.id, { kind: 'scheduler', ok: true, summary: `Role ${t.assignedRole} is read-only by its template: task policy set to read-only` });
    }
    const adapter = this.registry.get(used.provider);
    const st = (await this.registry.status()).find((s) => s.id === used.provider);
    if (!adapter || !st?.available) { this.failTask(t, `agent '${used.provider}' unavailable: ${st?.reason ?? 'unknown provider'}`); return false; }
    if (t.policy === 'read-only' && adapter.capabilities().readOnlyMode !== 'supported' && !adapter.mock) {
      this.failTask(t, `agent '${used.provider}' has no read-only mode`); return false;
    }

    const p = this.store.getProject(t.projectId);
    if (p.budgetUsd != null) {
      const spent = projectCosts(this.store, p.id).totalUsd;
      if (spent >= p.budgetUsd) { this.failTask(t, `project budget exhausted: spent $${spent.toFixed(2)} of $${p.budgetUsd.toFixed(2)} (raise the budget, then retry)`); return false; }
    }
    let w: Awaited<ReturnType<WorkspaceManager['ensure']>>;
    try {
      w = await this.ws.ensure(p.repoPath, p.baseBranch, p.id, t.id, t.workspace);
    } catch (e) { this.failTask(t, `workspace error: ${(e as Error).message}`); return false; }
    t = this.store.patchTask(t.id, { workspace: w.workspace, branch: w.branch, baseCommit: w.created ? w.baseCommit : (t.baseCommit ?? w.baseCommit) });
    if (t.artifacts.needsRebase) t = await this.rebaseOntoBase(t, p);

    let run: Run;
    try { run = this.store.beginRun(t, w.workspace, adapter.mock, used); }
    catch (e) { if (e instanceof Conflict) return false; throw e; }

    const prompt = buildPrompt(t, p, run.attempt, tpl);
    const inv = adapter.buildInvocation({ prompt, workspace: w.workspace, model: used.model, effort: used.flag, policy: t.policy, maxBudgetUsd: t.maxBudgetUsd, trustWorkspace: this.trusts(used.provider) });
    this.store.event({ projectId: p.id, taskId: t.id, runId: run.id, type: 'run.started',
      data: { attempt: run.attempt, provider: used.provider, model: used.model, effort: used.effort, mock: adapter.mock, command: inv.command, args: inv.args.map((a) => (a.length > 200 ? a.slice(0, 200) + '…' : a)) } });

    if (!adapter.prepare) return this.spawnRun(t, p, run, w.workspace, adapter, inv);
    // Remote upload runs off the tick so the scheduler and timeout checks keep going; cancel/stop abort it.
    const ac = new AbortController();
    const upload = (async () => {
      let error: string | null = null;
      try { await adapter.prepare!(w.workspace, ac.signal); } catch (e) { error = (e as Error).message; }
      this.preparing.delete(t.id);
      const canceled = ac.signal.aborted || this.store.getTask(t.id).status !== 'running';
      if (!error && !canceled) { this.spawnRun(t, p, run, w.workspace, adapter, inv); return; }
      this.store.releaseLock(w.workspace);
      this.store.endRun(run.id, canceled ? 'canceled' : 'failed', { error });
      if (!canceled) this.failOrRetry(this.store.getTask(t.id), `start failed: ${error}`);
    })();
    this.preparing.set(t.id, { ac, done: this.track(upload) });
    return true;
  }

  private spawnRun(t: Task, p: Project, run: Run, workspace: string, adapter: AgentAdapter, inv: Invocation): boolean {
    let child: ChildProcess;
    try {
      child = spawnSafe(inv.command, inv.args, { cwd: workspace });
    } catch (e) {
      this.store.releaseLock(workspace);
      this.store.endRun(run.id, 'failed', { error: (e as Error).message });
      this.failOrRetry(this.store.getTask(t.id), `spawn failed: ${(e as Error).message}`);
      return false;
    }
    let resolveExit!: () => void;
    const h: Handle = {
      run, taskId: t.id, workspace, child, adapter, startedAt: Date.now(), lastOutput: Date.now(),
      timeoutMs: t.timeoutSec * 1000, result: null, killReason: null, canceled: false, done: false,
      exited: new Promise<void>((r) => { resolveExit = r; }),
    };
    this.handles.set(run.id, h);
    if (child.pid) this.store.setRunPid(run.id, child.pid);
    child.stdin?.on('error', () => {});
    child.stdin?.end(inv.stdin ?? '');

    const emit = (stream: 'stdout' | 'stderr', line: string) => {
      if (h.done) return;
      h.lastOutput = Date.now();
      const ev = stream === 'stdout' ? adapter.parseLine(line) : (line.trim() ? { kind: 'log' as const, text: line } : null);
      if (!ev) return;
      if (ev.kind === 'result') h.result = ev;
      this.store.event({ projectId: p.id, taskId: t.id, runId: run.id, type: 'run.output', data: { stream, kind: ev.kind, text: maskSecrets(ev.text).slice(0, 8000) } });
    };
    createInterface({ input: child.stdout! }).on('line', (l) => emit('stdout', l));
    createInterface({ input: child.stderr! }).on('line', (l) => emit('stderr', l));
    child.on('error', (e) => { emit('stderr', `process error: ${e.message}`); });
    child.on('close', (code) => { void this.track(this.onExit(h, code)).finally(resolveExit); });
    return true;
  }

  /** Bring the base branch into the task branch before a conflict-repair attempt. Conflicts are left for the agent. */
  private async rebaseOntoBase(t: Task, p: Project): Promise<Task> {
    const baseTip = (await git(p.repoPath, ['rev-parse', p.baseBranch])).stdout.trim();
    const r = await git(t.workspace!, ['merge', '--no-edit', p.baseBranch]);
    const conflicts = (await git(t.workspace!, ['diff', '--name-only', '--diff-filter=U'])).stdout.split('\n').filter(Boolean);
    const feedback = conflicts.length
      ? `The base branch was merged into your branch and these files contain git conflict markers (<<<<<<< ======= >>>>>>>). Resolve them, keeping both sides' intent: ${conflicts.join(', ')}`
      : (r.code === 0 ? t.feedback : `Updating from base failed: ${r.stderr.slice(0, 500)}`);
    this.store.addEvidence(t.id, { kind: 'integration', ok: conflicts.length === 0, summary: conflicts.length ? `Base merged into task branch; conflicts: ${conflicts.join(', ')}` : 'Base merged into task branch cleanly' });
    const artifacts = { ...t.artifacts, needsRebase: false, conflictFiles: conflicts };
    return this.store.patchTask(t.id, { baseCommit: baseTip, feedback, artifacts });
  }

  private async onExit(h: Handle, code: number | null): Promise<void> {
    if (h.done) return;
    h.done = true;
    this.handles.delete(h.run.id);
    const usage = h.result?.usage ?? null;
    if (h.canceled) { this.store.releaseLock(h.workspace); this.store.endRun(h.run.id, 'canceled', { exitCode: code, usage }); return; }
    let failure: string | null = null;
    if (h.killReason) failure = h.killReason;
    else if (code !== 0) failure = `agent exited with code ${code}`;
    else if (!h.result) failure = 'agent exited without a result event';
    else if (h.result.isError) failure = `agent reported an error: ${h.result.text.slice(0, 500)}`;
    if (!failure && h.adapter.collect) {
      try { await h.adapter.collect(h.workspace); } catch (e) { failure = (e as Error).message; }
    }
    this.store.releaseLock(h.workspace);
    this.store.endRun(h.run.id, failure ? (h.killReason ? 'timeout' : 'failed') : 'succeeded', { exitCode: code, error: failure, usage });
    const t = this.store.getTask(h.taskId);
    if (t.status !== 'running') return; // canceled meanwhile
    if (failure) { this.failOrRetry(t, failure); return; }
    this.store.addEvidence(t.id, { kind: 'run', ok: true, summary: `Attempt ${t.attempts} finished (${h.adapter.mock ? 'MOCK' : h.adapter.name})`, detail: h.result?.text });
    this.store.setStatus(t.id, 'review', { artifacts: { ...t.artifacts, gate: undefined } }, 'worker finished, running gates');
    await this.runGates(t.id);
  }

  private failOrRetry(t: Task, reason: string): void {
    this.store.addEvidence(t.id, { kind: 'run', ok: false, summary: `Attempt ${t.attempts} failed: ${reason}` });
    if (t.attempts < t.maxAttempts) {
      const delay = this.opts.backoffMs * 2 ** Math.max(0, t.attempts - 1);
      this.store.setStatus(t.id, 'queued', { feedback: reason, notBefore: new Date(Date.now() + delay).toISOString() }, `retry in ${delay}ms`);
    } else {
      this.store.setStatus(t.id, 'failed', { feedback: reason }, 'attempts exhausted');
    }
  }

  // ------------------------------------------------------------------ review gates
  async runGates(id: number): Promise<void> {
    let t = this.store.getTask(id);
    if (t.status !== 'review' || !t.workspace || !t.baseCommit) return;
    const p = this.store.getProject(t.projectId);
    const fail = (reason: string, retryable = true) => {
      this.store.addEvidence(id, { kind: 'gate', ok: false, summary: reason });
      t = this.store.patchTask(id, { artifacts: { ...this.store.getTask(id).artifacts, gate: { passed: false, reason } } });
      if (retryable && t.attempts < t.maxAttempts) this.store.setStatus(id, 'queued', { feedback: reason }, 'gate failed, repair attempt');
      else this.store.setStatus(id, 'blocked', { feedback: reason }, 'gate failed, needs a human decision');
    };
    try {
      await this.ws.commitAll(t.workspace, `HidForge task #${t.id} attempt ${t.attempts}: ${t.title}`);
      const files = await this.ws.changedFiles(t.workspace, t.baseCommit);
      this.store.addEvidence(id, { kind: 'changes', ok: true, summary: `${files.length} file(s) changed`, detail: files.join('\n') });
      if (t.policy === 'read-only') {
        if (files.length) return fail(`read-only task modified files: ${files.join(', ')}`, false);
      } else {
        if (!files.length) return fail('worker produced no changes');
        const bad = checkAllowedPaths(files, t.allowedPaths);
        if (bad.length) return fail(`changes outside allowedPaths: ${bad.join(', ')}`);
        const markers = await git(t.workspace, ['grep', '-l', '-E', '^(<<<<<<<|>>>>>>>) ', '--', ...files]);
        if (markers.stdout.trim()) return fail(`unresolved conflict markers in: ${markers.stdout.trim().split('\n').join(', ')}`);
      }
      for (const cmd of t.verifyCommands) {
        const d = commandDecision(cmd, p.allowedCommands);
        if (d.decision === 'deny') return fail(`verification command refused: ${cmd} (${d.reason})`, false);
        if (d.decision === 'ask') {
          this.store.setStatus(id, 'needs_user_input', {
            question: `Allow HidForge to run the verification command \`${cmd}\` (no shell, inside the task worktree) for this project?`,
            artifacts: { ...t.artifacts, pendingCommand: cmd },
          }, 'verification command needs approval');
          return;
        }
        const r = await this.runVerify(cmd, t.workspace);
        this.store.addEvidence(id, { kind: 'verify', ok: r.code === 0, summary: `${cmd} -> exit ${r.code}`, detail: r.out });
        if (r.code !== 0) return fail(`verification failed: ${cmd} (exit ${r.code})`);
      }
      this.store.patchTask(id, { feedback: null, artifacts: { ...this.store.getTask(id).artifacts, gate: { passed: true, at: new Date().toISOString() } } });
      const mode = p.reviewPolicy.mode;
      this.store.addEvidence(id, { kind: 'gate', ok: true, summary: mode === 'off' ? 'All gates passed — waiting for human Approve & Merge'
        : `All gates passed — AI review (${mode}) next, then human Approve & Merge` });
      await this.reviewer.autoStart(id);
    } catch (e) {
      fail(`gate error: ${(e as Error).message}`, false);
    }
  }

  private async runVerify(cmd: string, cwd: string): Promise<{ code: number; out: string }> {
    const argv = parseArgv(cmd);
    const r = await runCmd(argv[0]!, argv.slice(1), { cwd, timeoutMs: this.opts.verifyTimeoutSec * 1000 });
    return { code: r.code, out: maskSecrets(`${r.stdout}\n${r.stderr}`).slice(-20_000) };
  }

  // ------------------------------------------------------------------ restart recovery
  private async recover(): Promise<void> {
    for (const r of this.store.liveRuns()) {
      const t = this.store.getTask(r.taskId);
      // ponytail: PID reuse after a reboot could point at an unrelated process; we only kill when the run is younger than its timeout.
      const young = Date.now() - Date.parse(r.startedAt) < t.timeoutSec * 1000;
      if (r.pid && young && isAlive(r.pid)) await killTree(r.pid);
      this.store.endRun(r.id, 'interrupted', { error: 'orchestrator restarted while the worker was running' });
      if (t.workspace) this.store.releaseLock(t.workspace);
      this.store.event({ projectId: t.projectId, taskId: t.id, runId: r.id, type: 'run.recovered', data: { pid: r.pid, killed: Boolean(r.pid && young) } });
      if (t.status === 'running') this.failOrRetry(t, 'interrupted by orchestrator restart');
    }
    const live = new Set(this.store.liveRuns().map((r) => r.id));
    for (const l of this.store.locks()) if (!live.has(l.runId)) this.store.releaseLock(l.workspace);
    for (const t of this.store.tasksByStatus('review')) if (!(t.artifacts.gate as object | undefined)) await this.runGates(t.id);
    for (const t of this.store.tasksByStatus('accepted')) {
      const p = this.store.getProject(t.projectId);
      if (t.branch && await this.ws.isMerged(p.repoPath, t.branch, p.baseBranch)) this.store.setStatus(t.id, 'merged', {}, 'merge completed before restart');
      else this.store.setStatus(t.id, 'blocked', {}, 'merge was interrupted by restart; retry approve');
    }
  }
}
