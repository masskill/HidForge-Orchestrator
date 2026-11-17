// SQLite persistence (built-in node:sqlite, no native addon) with ordered migrations.
import { DatabaseSync } from 'node:sqlite';

const MIGRATIONS: string[] = [
  // v1
  `
  create table projects (
    id integer primary key,
    name text not null,
    repo_path text not null unique,
    base_branch text not null,
    goal text not null default '',
    allowed_commands text not null default '[]',
    created_at text not null
  );
  create table tasks (
    id integer primary key,
    project_id integer not null references projects(id) on delete cascade,
    title text not null,
    description text not null default '',
    acceptance_criteria text not null default '',
    depends_on text not null default '[]',
    priority integer not null default 0,
    assigned_role text not null default 'Backend',
    provider text not null default 'mock',
    model text,
    policy text not null default 'workspace-write',
    allowed_paths text not null default '[]',
    verify_commands text not null default '[]',
    status text not null default 'draft',
    attempts integer not null default 0,
    max_attempts integer not null default 2,
    timeout_sec integer not null default 1800,
    workspace text,
    branch text,
    base_commit text,
    artifacts text not null default '{}',
    evidence text not null default '[]',
    question text,
    feedback text,
    not_before text,
    created_at text not null,
    updated_at text not null
  );
  create table runs (
    id integer primary key,
    task_id integer not null references tasks(id) on delete cascade,
    attempt integer not null,
    provider text not null,
    is_mock integer not null,
    pid integer,
    status text not null,
    exit_code integer,
    error text,
    usage text,
    started_at text not null,
    ended_at text,
    last_output_at text
  );
  -- DB-level guarantee: never two live runs of one task.
  create unique index runs_one_running_per_task on runs(task_id) where status = 'running';
  -- DB-level guarantee: one writer per workspace.
  create table workspace_locks (
    workspace text primary key,
    run_id integer not null,
    acquired_at text not null
  );
  create table events (
    id integer primary key,
    project_id integer,
    task_id integer,
    run_id integer,
    type text not null,
    data text not null,
    ts text not null
  );
  create index events_task on events(task_id, id);
  create table settings (key text primary key, value text not null);
  `,
  // v2: LLM planner runs (goal -> draft DAG)
  `
  create table plans (
    id integer primary key,
    project_id integer not null references projects(id) on delete cascade,
    provider text not null,
    model text,
    status text not null,
    goal text not null,
    pid integer,
    output text,
    plan text,
    error text,
    usage text,
    applied_task_ids text,
    created_at text not null,
    finished_at text
  );
  -- one running planner per project
  create unique index plans_one_running_per_project on plans(project_id) where status = 'running';
  `,
  // v3: AI reviewer policy per project (JSON: { mode: off|advisory|required, provider, model })
  `alter table projects add column review_policy text;`,
  // v4: spend limits (USD): per project (HidForge stops starting runs) and per task (passed to CLIs with a native cap)
  `alter table projects add column budget_usd real; alter table tasks add column max_budget_usd real;`,
  // v5: auto-routing — task category/complexity/effort; what each run actually used (stats must not depend on later task edits)
  `alter table tasks add column category text; alter table tasks add column complexity text; alter table tasks add column effort text;
   alter table runs add column model text; alter table runs add column effort text; alter table runs add column category text;
   alter table runs add column complexity text; alter table runs add column review_verdict text;`,
  // v6: chat with the assistant (one thread per project; the assistant runs read-only)
  `create table chat_messages (
    id integer primary key, project_id integer not null references projects(id) on delete cascade,
    role text not null, text text not null, provider text, model text, effort text, usage text, error text, created_at text not null
  );
  create index chat_messages_project on chat_messages(project_id, id);`,
  // v7: a chat reply can carry a plan proposal (validated like the planner's, stored in plans)
  `alter table chat_messages add column plan_id integer references plans(id) on delete set null;`,
];

export function openDb(file: string): DatabaseSync {
  const db = new DatabaseSync(file);
  db.exec('pragma journal_mode = WAL; pragma foreign_keys = ON; pragma busy_timeout = 5000;');
  db.exec('create table if not exists schema_migrations (version integer primary key, applied_at text not null)');
  const done = new Set(db.prepare('select version from schema_migrations').all().map((r) => Number(r.version)));
  MIGRATIONS.forEach((sql, i) => {
    const v = i + 1;
    if (done.has(v)) return;
    db.exec('begin');
    try {
      db.exec(sql);
      db.prepare('insert into schema_migrations (version, applied_at) values (?, ?)').run(v, new Date().toISOString());
      db.exec('commit');
    } catch (e) {
      db.exec('rollback');
      throw e;
    }
  });
  return db;
}

export const SCHEMA_VERSION = MIGRATIONS.length;
