# Архітектура HidForge Orchestrator (v0.3)

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
| Planner | `planner.ts` — LLM-планер (див. нижче) + ручний DAG-редактор у UI; `dag.ts` (валідація циклів, topo order) |
| Scheduler | `Orchestrator.tick` — DAG, concurrency limit, priority, retry з експоненційним backoff |
| AgentRegistry | `adapters/index.ts` — detect/auth/capabilities, rule-based routing |
| AgentAdapter | `adapters/types.ts`; `cli.ts` (декларативні специфікації), `MockAdapter` |
| SessionManager | `Handle` в orchestrator: pid, stdout/stderr → events, timeout, stall, cancel, recovery |
| WorkspaceManager | `workspace.ts` — worktree на задачу, commit, diff, allowedPaths, clean-up після merge |
| ReviewEngine | `Orchestrator.runGates` — зміни є, allowedPaths, маркери конфліктів, команди перевірки, repair loop; `reviewer.ts` — AI-рецензент QA + Security (див. нижче) |
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
review ─AI review (required): request_changes→ queued (repair із findings) / reject→ blocked
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

## LLM-планер (`src/planner.ts`)

```
ціль проєкту ─▶ Planner.start ─▶ git worktree --detach (тимчасовий) ─▶ агент у read-only режимі
   (claude --permission-mode plan / codex --sandbox read-only / agy --mode plan / mock)
   prompt: ціль + git ls-files + наявні задачі + правила + JSON-схема відповіді
─▶ parsePlan: JSON з ```json-блоку → валідація ─▶ plans.status = succeeded (лише пропозиція)
─▶ людина: «Додати як чернетки» ─▶ apply(): в одній транзакції, у топологічному порядку,
   ключі плану → id нових draft-задач ─▶ звичайний цикл (редагування → «Запустити план»)
```
- Валідація плану: ≤ `maxTasks`, унікальні ключі, залежності лише на ключі плану або наявні id, без циклів, `allowedPaths` без абсолютних шляхів і `..`, команди перевірки не з deny-list, невідома роль → `Backend`.
- Таблиця `plans` (міграція v2): статус `running → succeeded | failed | canceled`, далі `applied | discarded`; унікальний індекс — один активний планер на проєкт.
- Потік виводу — події `plan.output` / `plan.status` через той самий SSE.
- Після рестарту активний планер позначається `failed` (його процес убивається) — сесії планування не відновлюються.
- API: `POST/GET /api/projects/:id/plans`, `GET /api/plans/:id`, `POST /api/plans/:id/{apply,cancel,discard}`.

## Шаблони ролей (`src/contract.ts`)
- Налаштування `roleTemplates`: для кожної з 7 ролей — `instructions` (розділ «Role guidance» у контракті задачі), `readOnly` (планувальник примусово ставить задачі політику `read-only` і записує це в evidence), `providers` (дозволені агенти; `auto` обирає лише серед них за політикою маршрутизації, явний недозволений агент → задача `failed`).
- Типові шаблони: «Project Manager/Planner» і «Security Reviewer» — лише читання.

## AI-рецензент (`src/reviewer.ts`)

```
gates OK ─▶ reviewPolicy.mode ≠ off ─▶ Reviewer.autoStart ─▶ git worktree --detach <гілка задачі> (тимчасовий, dataDir\reviewing)
   агент у read-only режимі (той самий вибір, що й у планера: resolveReadOnlyAgent + runOnce з src/oneshot.ts)
   prompt: роль «QA + Security Reviewer», ціль, контракт задачі, критерії, allowedPaths, результати перевірок
           поточної спроби, змінені файли, diff (≤ 80 000 символів), застереження про prompt injection, без shell
─▶ parseReview: {verdict: approve | request_changes | reject, summary, findings[{severity, file, line?, message}]}
─▶ task.artifacts.aiReview + evidence `ai-review` + події review.output / review.status
```
- Політика на проєкт (`projects.review_policy`, міграція v3): `mode` = `off` (типово) | `advisory` | `required`, `provider` (`auto` за політикою маршрутизації або конкретний CLI), `model`.
- `advisory`: вердикт лише інформує, статус задачі не змінюється.
- `required`: `Approve & Merge` дозволено лише з вердиктом `approve` для поточної спроби; `request_changes` → `queued` із findings як feedback (repair-спроба; якщо спроби вичерпано — `blocked`); `reject` → `blocked`; збій/невалідна відповідь рецензента → merge заблоковано до повторної рецензії або зміни політики.
- `approve` з `critical`-знахідкою автоматично знижується до `request_changes`.
- Наслідки застосовуються лише якщо задача ще в `review` на тій самій спробі; Cancel/Reject задачі вбиває рецензента.
- Після рестарту активна рецензія → `failed` (процес убивається, тимчасові worktree прибираються), повтор — вручну.
- API: `PATCH /api/projects/:id {reviewPolicy}`, `POST /api/tasks/:id/review`, `POST /api/tasks/:id/review/cancel`.

## Розміщення даних
`HIDFORGE_DATA_DIR` (за замовчуванням `%LOCALAPPDATA%\HidForge`): `hidforge.db`, `worktrees\p<project>\t<task>`, тимчасові `planning\` і `reviewing\`, `demo\`. Worktree-и лежать поза репозиторієм користувача; гілки — `hidforge/p<project>-t<task>`.
