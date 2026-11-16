# Архітектура HidForge Orchestrator (v0.1)

```
 Browser UI (web/*.js)  ── REST + SSE (127.0.0.1, token for mutations) ──┐
                                                                       │
 src/server.ts ──────────────── API ───────────────▶ src/orchestrator.ts
                                                     │  tick(): ready→queued (deps merged)
                                                     │          queued→running (≤ maxConcurrent)
                                                     │          timeouts / stall detection
                                                     │  onExit → review gates → human approve → merge
                                                     │  recover() on start
          ┌──────────────────────┬───────────────────┼──────────────────────┐
   src/store.ts (+db.ts)   src/workspace.ts     src/adapters/*        src/contract.ts
   SQLite: single source   git worktree/task,   AgentAdapter:         task prompt,
   of truth, state machine,diff, allowedPaths,  mock | claude | codex verification-
   events → EventEmitter   merge/abort          | cursor | agy        command policy
                                                     │
                                              src/proc.ts: spawn без shell, .cmd-шими,
                                              taskkill /T /F, маскування секретів
```

## Відповідність компонентам ТЗ

| ТЗ | Реалізація |
|---|---|
| ProjectManager | `Orchestrator.addProject`, таблиця `projects` (repo, base branch, goal, allowedCommands) |
| Planner | Ручний DAG-редактор у UI; `dag.ts` (валидація циклів, topo order). LLM-планер — Етап 4 |
| Scheduler | `Orchestrator.tick` — DAG, concurrency limit, priority, retry з експоненційним backoff |
| AgentRegistry | `adapters/index.ts` — detect/auth/capabilities, rule-based routing |
| AgentAdapter | `adapters/types.ts`; `cli.ts` (декларативні специфікації), `MockAdapter` |
| SessionManager | `Handle` в orchestrator: pid, stdout/stderr → events, timeout, stall, cancel, recovery |
| WorkspaceManager | `workspace.ts` — worktree на задачу, commit, diff, allowedPaths, clean-up після merge |
| ReviewEngine | `Orchestrator.runGates` — зміни є, allowedPaths, маркери конфліктів, команди перевірки, repair loop |
| IntegrationManager | `doApprove` (серіалізований merge `--no-ff`, abort при конфлікті), post-merge checks, `rebaseOntoBase` |
| Persistence | `db.ts` — `node:sqlite`, WAL, міграції `schema_migrations` |
| API | `server.ts` — REST + SSE `/api/stream` з replay `after`/`Last-Event-ID` |
| UI | `web/` — проєкти, агенти, DAG-таблиця, форма задачі, живий журнал, evidence, diff, approve/reject, теми |

## Життєвий цикл задачі

```
draft ─submit→ ready ─(усі deps merged)→ queued ─(слот)→ running
running ─exit 0 + result→ review ─gates OK→ (людина) Approve → accepted → merged
running ─crash/timeout/stall/no result→ queued (retry, backoff)  або failed (спроби вичерпано)
review ─gate fail→ queued (repair з feedback) або blocked
review ─невідома команда перевірки→ needs_user_input ─дозволити→ review / ─заборонити→ blocked
accepted ─конфлікт merge→ blocked ─Retry→ queued (база зливається у гілку задачі, агент розв'язує)
будь-який активний ─Cancel→ canceled (kill дерева процесів)
```
Переходи валідуються таблицею `TRANSITIONS` у `store.ts`.

## Потоки даних
- **Запуск**: `beginRun` в одній транзакції бере `workspace_locks`, створює `runs` (унікальний індекс), переводить задачу в `running`. Будь-яке порушення → `Conflict`, запуск не відбувається.
- **Prompt** іде агенту через **stdin**, ніколи через argv (немає обмеження 32K і не видно в списку процесів).
- **Події**: кожен рядок stdout → `adapter.parseLine` → нормалізований `AgentEvent` → таблиця `events` (з маскуванням секретів) → `EventEmitter` → SSE.
- **Відновлення** (`recover`): живі `runs` позначаються `interrupted`, осиротілі процеси вбиваються (`taskkill /T /F`), блокування знімаються, задачі повертаються в чергу (з урахуванням ліміту спроб); незавершені gate-и та merge-і доводяться до кінця.

## Розміщення даних
`HIDFORGE_DATA_DIR` (за замовчуванням `%LOCALAPPDATA%\HidForge`): `hidforge.db`, `worktrees\p<project>\t<task>`, `demo\`. Worktree-и лежать поза репозиторієм користувача; гілки — `hidforge/p<project>-t<task>`.
