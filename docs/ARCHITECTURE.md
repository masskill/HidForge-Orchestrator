# Архітектура HidForge Orchestrator (v0.5)

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
| UI | `web/` — проєкти, агенти, задачі (таблиця / kanban / SVG-граф DAG), форма задачі, живий журнал, evidence, diff, approve/reject, теми |

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
running/queued/ready ─Пауза задачі→ draft (спроба не зараховується, зроблене лишається у worktree)
running ─Зупинити все (проєкт)→ queued + проєкт на паузі (спроба не зараховується)
review ─без змін, агент лишив «OWNER QUESTION:»→ blocked з питанням ─відповідь власника→ queued
blocked/failed ─автовиправлення (retry)→ queued   ─(ask_owner)→ питання власнику
review ─AI review approve + autoMerge→ accepted → merged
```
Переходи валідуються таблицею `TRANSITIONS` у `store.ts`.

## Потоки даних
- **Запуск**: `beginRun` в одній транзакції бере `workspace_locks`, створює `runs` (унікальний індекс), переводить задачу в `running`. Будь-яке порушення → `Conflict`, запуск не відбувається.
- **Prompt** іде агенту через **stdin**, ніколи через argv (немає обмеження 32K і не видно в списку процесів).
- **Події**: кожен рядок stdout → `adapter.parseLine` → нормалізований `AgentEvent` → таблиця `events` (з маскуванням секретів) → `EventEmitter` → SSE.
- **Відновлення** (`recover`): живі `runs` позначаються `interrupted`, осиротілі процеси вбиваються (`taskkill /T /F`), блокування знімаються, задачі повертаються в чергу (з урахуванням ліміту спроб); незавершені gate-и та merge-і доводяться до кінця.

## Чат з ШІ (`src/chat.ts`)

Користувач пише повідомлення → `Chat.send` зберігає його в `chat_messages` і запускає відповідь. Кожна відповідь — окремий
read-only запуск агента (`runOnce`) у тимчасовому `git worktree --detach` (`dataDir/chat/…`), як у планера: агент може читати код,
але не змінює файли й не запускає команди. У промт ідуть ціль проєкту, етапи з відсотками (`progress.ts`), задачі (опис, залежності,
тип і складність, агент, спроби, запитання агента, остання невдала спроба з помилкою), список файлів і останні повідомлення (до ~30K символів,
невдалі відповіді пропускаються).

**План із чату.** Якщо користувач просить план, асистент додає JSON у форматі планера (`planFormat`, спільний із `planner.ts`).
`splitPlan` перевіряє його тим самим `parsePlan` (≤ 20 задач, без циклів, безпечні шляхи); валідний план зберігається в `plans`
зі статусом `succeeded` і посиланням `chat_messages.plan_id` (міграція v7), JSON прибирається з тексту відповіді. Далі все як у планера:
«Створити чернетки» = `Planner.apply`, «Відхилити» = `discard`. Невалідний план не зберігається, користувач бачить причину. Одна відповідь за раз на проєкт; `cancel` вбиває процес, відповідь зберігається з позначкою
«зупинено користувачем». Події: `chat.message`, `chat.output` (кроки інструментів), `chat.cleared`. Проєкт не видаляється, поки асистент відповідає.

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

## Запуск, встановлення, оновлення
- `src/main.ts --open` відкриває UI у браузері за замовчуванням (`explorer.exe <url>` на Windows, без shell). Перед стартом оркестратора `main.ts` перевіряє `GET /api/version` на своєму порту: якщо там уже HidForge, другий процес лише відкриває браузер і завершується — два оркестратори на одних даних не запускаються.
- `scripts/HidForge.vbs` — запуск без вікна (WSH `Run …, 0`), вивід у `%LOCALAPPDATA%\HidForge\hidforge.log`; `POST /api/shutdown` (з токеном) — коректна зупинка з UI.
- `scripts/install.ps1` — ярлики користувача на `wscript.exe HidForge.vbs`; `scripts/update.ps1` — `git fetch` + `merge --ff-only`, `npm install` лише якщо є `node_modules` (для роботи залежності не потрібні).

## JSON-плагіни агентів і WSL2 (`src/adapters/plugin.ts`, `src/adapters/wsl.ts`)
- Специфікація плагіна: `id`, `name`, `bin`, `args.base|write|readOnly|model` (`{model}` лише в `args.model`), необов'язкові `auth.args` (код 0 → увійдено) і `models.args` + `pattern`, `events` — правила `{match: {шлях: значення}, kind, text: "шаблон {шлях}", usage, okWhen}`; перше правило, що збіглося, перетворює рядок JSONL у подію. Плагін стає звичайним `CliAdapter` — запуск, стрім, скасування, gate-и спільні.
- Завантаження: `plugins/*.json` (приклади Gemini CLI, OpenCode) і `<dataDir>/plugins/*.json` (користувацькі, той самий `id` перевизначає приклад). Вбудовані `id` зарезервовано. Невалідний файл не ламає запуск — помилка видна в діагностиці.
- Безпека при завантаженні: промпт лише через stdin (`{prompt}` заборонено), прапорці обходу дозволів (`--yolo`, `--approval-mode=yolo`, `--dangerously-*`, `--force`, `--trust`, `full-auto`, `allow-all` …) відхиляються, `bin` — лише ім'я команди з PATH.
- WSL2: налаштування `wsl: {distro, agents}` додає агентів `<id>-wsl`, що запускаються як `wsl.exe -d <distro> --cd <шлях /mnt/...> --exec <bin> <args>` на тому ж Windows-worktree; git, gate-и й merge лишаються на Windows. Діє після перезапуску.

## VPS через SSH (`src/adapters/ssh.ts`)
- Налаштування `ssh: {host, port, remoteDir, agents}` додає агентів `<id>-ssh` (діє після перезапуску). Хост — `host`, `user@host` або аліас з `~/.ssh/config`; вхід лише ключем/агентом користувача (`-o BatchMode=yes`), пароль і ключі HidForge не зберігає, перевірку known_hosts не вимикає.
- Перед запуском (`prepare`): файли worktree (`git ls-files -c -o --exclude-standard`, без `.git`, symlink і підмодулів) пакуються власним мінімальним tar-писачем (ustar + pax для довгих і неASCII-імен) і потоком ідуть у `ssh` → на хості `<remoteDir>/<pN-tN>`, `git init` і базовий коміт. Теки старші за 2 доби прибираються.
- Запуск: `ssh -T … -- host "cd '<dir>' && exec '<bin>' '<args>'…"` — кожне слово в одинарних лапках, промпт лише через stdin.
- Після успіху (`collect`): хост віддає `git diff --cached --binary` відносно базового коміту; патч без symlink і шляхів `.git` застосовується `git apply` у локальному worktree, віддалена копія видаляється. Далі — звичайні gate-и, AI-рецензія й merge локально.
- Планер і рецензент на `-ssh` агентах теж отримують копію (лише `prepare`).
- Обмеження: скасування закриває з'єднання ssh, але гарантії, що віддалений CLI завершиться, немає; PATH на хості — неінтерактивної оболонки.

## Діагностика й резервні копії (`src/maintenance.ts`)
- `createBackup` — `VACUUM INTO` у `dataDir/backups/hidforge-YYYYMMDD-HHMMSS-mmm.db` (узгоджена копія при працюючому сервері, без WAL), ротація — 10 останніх. `autoBackup` у `main.ts`: при запуску, якщо остання копія старша за добу і є хоч один проєкт.
- `diagnostics` — список перевірок `{id, label, level: ok|info|warn|error, detail}`; `scripts/doctor.ts` створює `Orchestrator` без `start()` (жодного відновлення запусків), тож безпечний і поряд із запущеним сервером. Код виходу 1, якщо є `error`.
- Відновлення свідомо ручне (зупинка сервера + заміна файлу): автоматична заміна живої бази з UI ризикованіша за користь.

## Integrator, звіти й ADR (`src/orchestrator.ts`, `src/report.ts`)
- Після merge задачі її перевірки запускаються на базовій гілці. Якщо хоч одна падає, `createIntegrator` створює **чернетку** задачі ролі Integrator: опис містить вивід перевірки (секрети замасковано, останні 3000 символів), `verifyCommands` — ті самі команди, критерій — exit 0. Задача лише пропонується: запускає її користувач. Зв'язок — `artifacts.integratorTaskId` і evidence `integrator`.
- `projectReport` — markdown-звіт: підсумок (% злитих), статуси, таблиця задач з AI-вердиктом і останнім доказом, «Потребує уваги», витрати за агентами, перелік рішень.
- `decisions` / `adrMarkdown` — журнал рішень у форматі ADR (Контекст / Рішення / Наслідки), що виводиться з уже записаного: застосовані плани, merge (з перевірками й вердиктом рецензента), відхилення, створення Integrator. Нового сховища немає, тож журнал завжди узгоджений з історією. У репозиторій користувача нічого не пишеться — лише завантаження з UI.

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

## Автопілот: автоприйняття, автовиправлення, пауза (`src/doctor.ts`, `src/orchestrator.ts`)

- `reviewPolicy.autoMerge`: після вердикту `approve` HidForge сам робить Approve & Merge (`approve(id, 'auto')`, доказ
  «Approved automatically»). Вмикання автоприйняття вмикає обов'язкову рецензію. Рецензія, що не змогла відпрацювати,
  повторюється один раз на спробу іншим агентом (`exclude` у `resolveReadOnlyAgent`).
- `reviewPolicy.autoFix`: задача, що стала `blocked`/`failed` (не з рішення людини), отримує діагноз: read-only агент
  (рецензент проєкту або ланцюжок planning/medium) читає задачу, докази й останні слова агентів і відповідає JSON
  `{action: retry | ask_owner | give_up, explanation (укр., для не-програміста), question, feedback, changes}`.
  `retry` — виправлені поля задачі + feedback, ще 2 спроби; `ask_owner` — питання власнику; не більше 2 діагнозів
  на задачу, по одному за раз.
- Контракт задачі просить агента не чекати погодження: якщо без власника не можна, нічого не змінювати й залишити
  рядки `OWNER QUESTION: …`. Gate бачить це й одразу ставить питання власнику замість марних повторів.
  Відповідь (`POST /api/tasks/:id/owner-answer`) дописується в опис задачі, і задача запускається знову.
- Пауза: `POST /api/projects/:id/pause {stop?}` / `resume` (налаштування `pausedProjects`; планувальник пропускає
  задачі проєкту), `POST /api/tasks/:id/pause` (у чернетки). Перерваний власником запуск — `canceled`, спроба не
  зараховується.

## Змінні .env для перевірок

Перемикач проєкту «Передавати перевіркам змінні з .env проєкту» (налаштування `verifyEnvProjects`, `PATCH /api/projects/:id {verifyEnv}`):
у момент запуску команди перевірки HidForge читає `.env` з теки проєкту (`node:util` `parseEnv`) і додає змінні лише до
процесу цієї команди. Файл не копіюється у worktree, агенту не передається, значення (≥ 6 символів) замінюються на `***`
у виводі перевірки. Обмеження: перевірка виконує код, який написав агент, тож зловмисний код теоретично може прочитати
змінні під час перевірки — вмикати лише для своїх проєктів.

## Розміщення даних
`HIDFORGE_DATA_DIR` (за замовчуванням `%LOCALAPPDATA%\HidForge`): `hidforge.db`, `worktrees\p<project>\t<task>`, тимчасові `planning\` і `reviewing\`, `demo\`. Worktree-и лежать поза репозиторієм користувача; гілки — `hidforge/p<project>-t<task>`.
