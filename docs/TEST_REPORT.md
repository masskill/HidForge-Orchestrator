# Звіт про перевірку

## Виправлення після перегляду коду (2026-11-17)

| Знахідка | Результат |
|---|---|
| Помилка читання файлу під час tar-потоку на ssh-хост валила сервер (немає обробника `error`) | ✅ файл, видалений після переліку, пропускається; інша помилка завершує відправку з помилкою. Тест у `test/ssh.test.ts` |
| `checkPatch` пропускав шляхи `.git`, які git бере в лапки, а також `rename/copy to`, `+++` | ✅ перевіряються всі рядки заголовка з шляхами (у лапках і без), рядки вмісту хунків ігноруються. Тест |
| Відправка worktree на ssh-хост блокувала планувальник і перевірку таймаутів; скасування під час відправки ігнорувалось (задачі, планер, рецензент) | ✅ відправка йде поза `tick`, `cancel`/`stop` переривають її (`AbortSignal`), запуск — `canceled`, блокування знято. Планер і рецензент: сесія «жива» з початку відправки. Тести в `test/ssh.test.ts` |
| Deny-list обходився лапками, повним шляхом і глобальними опціями git | ✅ додатково перевіряється argv. Тести в `test/unit.test.ts` |
| Approve задачі без змін залишав worktree і гілку | ✅ прибираються. Тест у `test/roles.test.ts` |
| Нечислові `limit`/`before`/`after` в API давали 500 | ✅ 400. Тест у `test/costs.test.ts` |
| Огляд проєкту тягнув усі події `task.status`; витрати рахувались N+1 запитами | ✅ лише 14 останніх; один запит на всі запуски проєкту |
| Повний набір `npm test` | 🟡 73/74: один тест рецензента впав за таймаутом, бо процес простояв 20 с без жодного кроку планувальника під навантаженням комп'ютера (файли тестів ідуть послідовно, повний прогін тривав 463 с); окремо `test/reviewer.test.ts` — 10/10. На незміненому коді той самий тест займав 14–18 с із 20 с ліміту, тож очікування AI-рецензії в тестах піднято до 60 с |

## Codex через десктопний застосунок (2026-11-16)

| Перевірка | Результат |
|---|---|
| Вибір бінарника | ✅ `codexBin()`: найновіший `%LOCALAPPDATA%\OpenAI\Codex\bin\<build>\codex.exe` (тут 0.169.0-alpha), інакше `codex` з PATH (0.153.4); для WSL/ssh — гола назва `codex` (`bareCommand`). Тест у `test/plugins.test.ts` |
| Реальна задача на запис (`node scripts/smoke-real.ts codex`, без явної моделі) | 🟡 запуск `succeeded`, модель із `config.toml` прийнята (раніше 400), usage 152 967 / 414 токенів; файл не створено: `Failed to write file … sandbox initialization error` → gate «no changes» → `blocked` (нічого не злито) |
| Причина (без витрати квоти: `codex sandbox -- …`) | `helper_sandbox_lock_failed: lock sandbox bin dir ~\.codex\.sandbox-bin failed: SetNamedSecurityInfoW sandbox dir failed: 5`. Власник теки — `BUILTIN\Администраторы`, у користувача лише `(M)`, без права змінювати дозволи. Виправлення — дія користувача |

## Бекенд для сторінок «Запуски» і «Ролі», облік токенів Cursor (2026-11-16)

| Перевірка | Результат |
|---|---|
| Знайдено | ❌→✅ Cursor звітує токени в camelCase (`inputTokens`, `outputTokens`, `cacheReadTokens`), а облік витрат читав лише snake_case — токени Cursor у «Витратах» були нулями. Тепер спільний `usageTokens()`; `reasoningTokens` не додаються, бо можуть уже входити в `outputTokens` |
| `GET /api/projects/:id/runs` (`before`, `limit` ≤ 1000, `status`, `provider`) | ✅ `test/costs.test.ts`: від новіших до старіших, назва задачі, тривалість, USD, пагінація й фільтри |
| `roleDefaults` у `GET /api/settings`, скидання ролі збереженням без неї | ✅ `test/roles.test.ts` |
| Gemini CLI, OpenCode | 🟡 встановлено, без входу не перевірено (вхід свідомо відкладено) |

## Реальні прогони з вашими дозволами (2026-11-16)

| Перевірка | Результат |
|---|---|
| Cursor Agent CLI 2026.11.05 з довірою до worktree (`SMOKE_TRUST=cursor node scripts/smoke-real.ts cursor`) | ✅ задача `review`, запуск `succeeded`, exit 0; файл `hello from cursor`, gate пройдено, usage з токенами; `--force`/`--yolo` не передавались. Довіру ввімкнено й у налаштуваннях застосунку |
| Встановлення `@google/gemini-cli@0.68.0`, `opencode-ai@1.19.5` (npm, глобально) | ✅ обидва запускаються, діагностика HidForge — «готовий» |
| Gemini CLI, OpenCode: реальна задача | ⚪ не запускалась: вхід у Gemini не виконано (немає OAuth), в OpenCode 0 облікових даних; у середовищі є `AI_GATEWAY_API_KEY` (платний Vercel AI Gateway) — без вашого вибору провайдера/моделі не запускаю, щоб не створити платних викликів |
| VPS `ozon-srv` (`~/.ssh/config_ozon`) | ⚪ `ssh -o BatchMode=yes` → `Connection timed out` на порту сервера: недоступний з цього комп'ютера. Аліас лежить в окремому файлі, тож для HidForge потрібен `Include config_ozon` у `~/.ssh/config` |

## Сторінки «Проєкти» і «Журнал подій» (2026-11-16)

Код сторінок — патч GPT за промптом `docs/prompts/gpt-projects-activity-pages.md`, переглянутий і застосований.

| Перевірка | Результат |
|---|---|
| `git apply --check`, `node --check`, `npx tsc --noEmit; npm test` | ✅ патч застосовано без конфліктів; 67/67 |
| Знайдено при перевірці | ❌→✅ лічильник і футер журналу друкували текст «null» (`replaceChildren` з `null`); тепер через `clean()`. Докази з `ok:false` тепер позначаються як помилки |
| `#/projects` (вбудований браузер, 1440 і 375 px) | ✅ 2 картки з лічильниками статусів, бейдж «Активний», пошук і порожній результат, «Змінити ціль» з попереднім текстом → `PATCH` → картка оновилась (значення повернуто), без горизонтальної прокрутки |
| `#/activity` | ✅ перша сторінка `before=9007199254740991&limit=200`, від новіших до старіших, фільтри «Помилки» і вивід агентів, JSON у згортанні; жива подія `task.created`/`task.deleted` з'являється згори без перезавантаження сторінки; світла тема |
| Інші сторінки й стрічка на «Огляді» | ✅ усі 8 відкриваються без «null» і без прокрутки на 375 px; стрічка статусів огляду — 14 подій, як і раніше |

## VPS / SSH-бекенд (2026-11-16)

| Перевірка | Результат |
|---|---|
| `npx tsc --noEmit; npm test` | ✅ 66/66 (новий `test/ssh.test.ts`, 4 тести) |
| Валідація налаштувань | ✅ відхиляються хости `-oProxyCommand=…`, з пробілами, `;`, `$(…)`, `u@-h`; теки з `..`, `-rf`, `$HOME`, пробілами; порт поза 1..65535; агент `mock` |
| Виклик | ✅ `ssh -T -o BatchMode=yes -o ConnectTimeout=15 -p N -- host "cd '…' && exec '…'"`; промпт лише в stdin; `StrictHostKeyChecking` не передається |
| Повний цикл через замінник ssh (`test/fake-ssh.ts` → локальний `sh`, GNU tar, git) | ✅ задача з провайдером `demo-ssh`: файли worktree на «хості» (без `.git` і файлів поза worktree), зміна, видалення, новий файл з українським ім'ям і пробілами, бінарний файл повернулись, gate-и пройдено, віддалену копію видалено |
| Патч із symlink або `.git` | ✅ відхиляється |
| UI «Агенти» → «Плагіни агентів, WSL2 і VPS» | ✅ вбудований браузер: збереження й очищення налаштувань, помилка валідації хоста в toast; на 375 px без горизонтальної прокрутки |
| Справжній VPS | ⚪ не перевірено: сервера для перевірки немає |

Попутно виправлено: WSL-обгортка передавала Codex Windows-шлях у `--cd`; тепер — шлях `/mnt/...`.

## Аудит v0.5 (2026-11-16)

Переглянуто код оновлення, інсталятора, запуску без термінала, бекапів, діагностики, JSON-плагінів і WSL; UI перевірено у вбудованому браузері (1440 px і 375 px).

| Знахідка | Виправлення |
|---|---|
| GET `/api/diagnostics`, `/api/agents/:id/models`, `/api/agents?refresh=1` запускають процеси, а сторонній сайт міг смикнути їх простим GET без токена | ці GET тепер вимагають `x-hidforge-token`; кешований `/api/agents` лишився відкритим |
| Назва моделі не валідувалась: `--model --щось` могло прочитатися CLI як прапорець | `cleanModel()` у задачі, планері й рецензенті; 400 з поясненням |
| Журнал запуску `%LOCALAPPDATA%\HidForge\hidforge.log` ріс без меж | `HidForge.vbs`: ротація в `hidforge.log.1` після 5 МБ (пропускається, якщо файл тримає запущений екземпляр) |

Без зауважень: `install.ps1` (без прав адміністратора, лише ярлики), `update.ps1` (лише fast-forward, локальні зміни не чіпає), бекап `VACUUM INTO` з ротацією 10 копій, плагіни (заборонені прапорці обходу, промпт лише через stdin, команда лише з PATH), WSL (`wsl.exe --exec` без shell), `--trust` для Cursor лише після явного ввімкнення.

| Перевірка | Результат |
|---|---|
| `npx tsc --noEmit; npm test` | ✅ 62/62 (нові перевірки токена й назв моделей у `costs.test.ts`, `maintenance.test.ts`) |
| Ротація журналу (копія скрипта на файлі 6 МБ) | ✅ файл перенесено в `hidforge.log.1` |
| UI: таблиця / kanban / граф, звіт, налаштування, діагностика з токеном | ✅ без помилок у консолі; на 375 px сторінка без горизонтальної прокрутки |

## v0.5 — kanban/граф, Integrator, звіти й ADR, запуск без термінала, діагностика, копії, плагіни (2026-11-16)

| Перевірка | Результат |
|---|---|
| `npm run typecheck; npm run lint; npm test; npm run build` | ✅ 62/62 тести, tsc strict без помилок, збірка `dist/` |
| `node dist/main.js` (зібрана версія, тимчасові дані) | ✅ стартує, `GET /api/version`, плагіни Gemini CLI й OpenCode у списку агентів (не встановлені), зупинка через `POST /api/shutdown` |
| UI: «Таблиця / Kanban / Граф» на сторінці задач | ✅ вбудований браузер: колонки за статусами, граф із ребрами залежностей (#1, #2 → #3), клік по вузлу відкриває задачу й підсвічує її, вибір вигляду зберігається |
| UI: «Звіт і рішення» на огляді проєкту | ✅ вбудований браузер: модальне вікно зі звітом і ADR, копіювання, завантаження `.md`, без помилок у консолі |
| `test/report.test.ts` (2 тести) | ✅ задача проходить у своєму worktree, але після merge перевірка на `main` падає → чернетка Integrator із командою й виводом, не стартує сама; ADR: 2 merge + Integrator; звіт «Злито 2 з 3 (67%)»; API report/adr; відхилення стає рішенням |
| UI: «Про програму» в налаштуваннях | ✅ версія й коміт, інструкція оновлення, «Зупинити сервер» з підтвердженням |
| Ручна перевірка `wscript scripts\HidForge.vbs` (порт 4398, тимчасові дані) | ✅ сервер стартує без вікна, браузер відкривається, журнал пишеться в `%LOCALAPPDATA%\HidForge\hidforge.log`, зупинка через API |
| `test/launcher.test.ts` (3 тести) | ✅ другий запуск на тому ж порту лише повідомляє «already running» і виходить з кодом 0; `GET /api/version`; `POST /api/shutdown` без токена → 403, з токеном → процес завершується з кодом 0; `install.ps1` створює й видаляє ярлик у тимчасовій теці; `update.ps1 -Check` нічого не змінює, локальна зміна блокує оновлення (код 1), потім fast-forward |
| UI: «Діагностика й резервні копії» | ✅ вбудований браузер: таблиця перевірок з тонами стану, список копій (авто-копія при старті), «Створити копію зараз», без помилок у консолі |
| `node scripts\doctor.ts` на робочих даних UI | ✅ 12 перевірок, усі 4 реальні агенти готові, код 0 |
| `test/maintenance.test.ts` (2 тести) | ✅ копія читається окремо й містить дані; ротація лишає 3 найновіші; авто-копія не дублюється протягом доби й робиться, коли копій немає; діагностика без помилок на справному середовищі, зниклий репозиторій → `error`, без копії → `warn`; API: `POST /api/backups` без токена → 403 |
| WSL2 на реальному дистрибутиві | ⚪ не перевірено: на цьому комп'ютері WSL не ввімкнено (`wsl -l -q` → довідка, код 1); діагностика показує це явно |
| Gemini CLI, OpenCode на реальних CLI | ⚪ не перевірено: CLI не встановлені; прапорці взято з документації (gemini-cli `docs/cli/cli-reference.md`, `headless.md`; opencode.ai/docs/cli). OpenCode: читання промпту зі stdin документацією не підтверджено |
| `test/plugins.test.ts` (6 тестів) | ✅ валідація відхиляє `--yolo`, `--approval-mode=yolo`, `--dangerously-*`, `{prompt}`, шляхи в `bin`, вбудовані `id`; специфікації Gemini CLI й OpenCode завантажуються, промпт лише в stdin, мапінг подій (повідомлення, інструменти, результат з usage/USD); користувацькі плагіни з теки даних, невалідні — у `pluginErrors`; WSL: шляхи (`E:\` → `/mnt/e`, `\\wsl$\…`), обгортка `wsl.exe --exec`, валідація налаштувань, агенти `-wsl` у реєстрі |

## v0.4 — бюджети, витрати, моделі, Cursor (2026-11-16)

| Перевірка | Результат |
|---|---|
| `test/costs.test.ts` (5 тестів) | ✅ прапорець `--max-budget-usd` лише з лімітом; Cursor: `--trust` лише з дозволу, `--force`/`--yolo` ніколи, `--mode plan` для read-only, підказка про довіру; розбір списків моделей; бюджет проєкту зупиняє нові запуски й відновлюється після підвищення; API |
| Реальний `claude -p … --max-budget-usd 0.2 --model haiku` | ✅ прапорець прийнято, `total_cost_usd` = 0.09 |
| Реальні списки моделей | ✅ agy — 18, Cursor — 280, Claude — 3 аліаси; Codex не має команди списку |
| Cursor Agent CLI 2026.11.05 | ✅ знайдено без PowerShell (`versions\<latest>\node.exe index.js`), авторизація `status` = logged in; ⛔ headless-прогін вимагає довіри до каталогу — без вашого дозволу не запускався |
| Codex 0.153.4, модель `gpt-5.6-luna` (явно; модель з `~/.codex/config.toml` відсутня в каталозі акаунта) | ✅ `codex exec` відповідає; ✅ рецензент: 22 с, вердикт `reject` за `eval` (`node scripts\smoke-review.ts codex:gpt-5.6-luna`); ⛔ задача на запис: `Failed to write file` у Windows-sandbox Codex навіть для ASCII-шляху поза %TEMP% — sandbox не послаблюємо |
| `test/roles.test.ts` (4 тести) | ✅ інструкції ролі в контракті; шаблон «лише читання» примусово робить задачу read-only (gate блокує запис); роль з дозволеними агентами відхиляє іншого агента; валідація й API |
| UI: «Ролі: шаблони й дозволи» | ✅ 7 ролей, збереження через API |
| UI: стат «Витрати», таблиця витрат за агентами, бюджет проєкту, ліміт задачі, підказки моделей, перемикач довіри Cursor | ✅ вбудований браузер, без помилок у консолі |

## v0.3 — AI-рецензент QA + Security (2026-11-16)

| Перевірка | Команда | Результат |
|---|---|---|
| Typecheck / build | `npm run typecheck`, `npm run build` | ✅ |
| Усі тести | `npm test` | ✅ 40/40, з них 10 нових у `test/reviewer.test.ts` |
| Реальний рецензент: Claude Code (`haiku`) | `node scripts\smoke-review.ts claude:haiku` | ✅ 32 с, вердикт `reject`: `critical` — `eval` недовіреного вводу (src/calc.js:4), + 2 major, 1 minor; worktree задачі й main не змінено; $0.11 |
| Реальний рецензент: agy | `node scripts\smoke-review.ts agy` | ✅ 194 с, вердикт `request_changes`: `critical` — `eval` (CWE-95), + 1 major; worktree задачі й main не змінено |
| Реальний рецензент: Codex | — | not run (модель у `~/.codex/config.toml` відхиляється сервісом) |
| UI: налаштування політики, вкладка «AI-рецензія», блокування Approve у `required`, кнопки запуску/зупинки, рядки рецензента в журналі | вбудований браузер, `node src/main.ts --port 4399`, mock-рецензент | ✅ без помилок у консолі |

Тести рецензента:
- розбір вердикту (нормалізація, невідома severity → `info`, `approve` + `critical` → `request_changes`, невалідний вердикт);
- prompt лише для читання, без shell, із застереженням про ін'єкцію, лише перевірки поточної спроби, обрізання diff;
- валідація політики;
- `off` — рецензії немає; `advisory` — вердикт записано, статус не змінено, merge дозволено, тимчасовий worktree прибрано;
- `required` — `request_changes` → repair-спроба із findings → `approve` → merge; `reject` і вичерпані спроби → `blocked`, merge відхилено;
- невалідна відповідь → рецензія `failed`, merge заблоковано до повторної рецензії або зміни політики;
- ізоляція: рецензент, що пише файли, не змінює гілку задачі;
- скасування рецензії, відновлення після краху (осиротілий процес убито, залишки worktree прибрано), Cancel задачі вбиває рецензента;
- HTTP API.

---

## v0.2 — LLM-планер (2026-11-16)

| Перевірка | Команда | Результат |
|---|---|---|
| Typecheck / lint / build | `npm run typecheck`, `npm run build` | ✅ |
| Усі тести | `npm test` | ✅ 30/30 (~62 с), з них 8 нових у `test/planner.test.ts` |
| Міграція v1 → v2 на наявній БД | запуск `npm run dev` зі старою `.hidforge-data` | ✅ |
| UI: ціль → «Згенерувати план» (mock) → перегляд → «Додати як чернетки» | вбудований браузер | ✅ 4 чернетки з правильними залежностями |
| Реальний планер: Claude Code (`haiku`) | `node scripts/smoke-planner.ts claude:haiku` | ✅ 38 с, 5 задач, залежності й `npm test` як перевірка, main не змінено, $0.13 |
| Реальний планер: agy 1.5.9 | `node scripts/smoke-planner.ts agy` | ✅ 116 с, 6 задач з паралельними гілками, main не змінено |
| Реальний планер: Codex | — | not run (модель у `~/.codex/config.toml` відхиляється сервісом, див. v0.1) |

Тести планера: розбір JSON із fenced-блоку та зі склеєних stream-дельт; відхилення циклів, невідомих залежностей, дублікатів, небезпечних шляхів (`..`, `C:/`), заборонених команд, перевищення ліміту; prompt лише для читання зі списком файлів; повний цикл mock (план → apply → залежні задачі чекають → merge); невалідна відповідь агента не створює задач; скасування; відновлення після краху (осиротілий процес планера вбито); HTTP API.

Знайдено й виправлено під час реального прогону: agy у режимі `plan` намагався виконати shell-команду для огляду репозиторію, headless-режим її заборонив, і агент повернув порожню відповідь. Виправлення без bypass: prompt тепер містить `git ls-files` і просить не запускати команди; помилка планера показує останній рядок виводу агента.

---

# v0.1 (2026-11-16)

Середовище: Windows 10 Pro 10.0.19045, Node v24.18.0, npm 11.16.0, Git 2.54.0.windows.1, `core.autocrlf=true`.

| Перевірка | Команда | Результат |
|---|---|---|
| Typecheck | `npm run typecheck` | ✅ passed |
| Lint (суворий tsc: strict, noUnused*, erasableSyntaxOnly) | `npm run lint` | ✅ passed |
| Unit + e2e | `npm test` | ✅ 22/22 passed (~44 с) |
| Build | `npm run build` | ✅ passed, `dist/` |
| Запуск зібраної версії | `node dist/main.js --port 4399` | ✅ стан демо-проєкту відновлено після перезапуску |
| Ручний UI-сценарій у браузері | `npm run dev`, «Створити демо-проєкт» → «Запустити план» | ✅ див. нижче |
| Реальні CLI | `node scripts/smoke-real.ts claude codex agy` | Claude ✅ · agy ✅ · Codex ❌ (конфіг користувача) |
| ESLint | — | not run (не налаштовано, свідомо) |
| Linux/macOS | — | not run |
| Cursor Agent CLI | — | not run (не встановлено) |

## Автоматичні сценарії (ТЗ §10) → тест
Усі e2e використовують **реальні процеси** Mock Agent, реальні git worktree і SQLite у теці з **пробілами та українськими літерами** (`HidForge тест з пробілами ї-…\Мій репозиторій`, дані в `data дані`).

| Вимога ТЗ | Тест (`test/e2e.test.ts` / `test/unit.test.ts`) |
|---|---|
| Два незалежні workers перекриваються в часі; залежна задача не стартує до prerequisites | `two independent workers overlap in time; dependent task waits for both merges` (перевіряє перетин інтервалів `startedAt/endedAt`, 0 запусків C до merge A і B) |
| Два workers не пишуть в один workspace | `one writer per workspace and no duplicate live run of a task` (обмеження БД) |
| Падіння / зависання / без результату | `crashing, hanging and result-less workers are detected; retry then succeed` |
| Restart: черга й журнали збережені, без дублікатів | `restart: queue and logs survive, orphan worker is killed, no duplicate runs` (симульований краш без очищення, осиротілий процес убито, запуски `interrupted,succeeded`) |
| Зміни поза allowedPaths блокуються | `changes outside allowedPaths are blocked at the gate`; unit `allowedPaths gate rejects outside paths and traversal` |
| Failed tests → reject/retry, не merge | `failing verification -> repair attempt -> blocked, never merged` |
| Конфлікт merge не знищує роботу | `merge conflict keeps both agents' work; conflict-repair attempt integrates it` |
| Відсутній CLI = `not installed`, UI не падає | unit `missing CLI is reported as not installed without throwing`; e2e `unavailable provider fails only its task; scheduler keeps going` |
| Непідтверджена небезпечна команда не запускається | `unapproved command is not executed until the user approves; deny-listed never`; unit `command policy…` |
| Шляхи з пробілами й українськими літерами | усі e2e; unit `spawnSafe passes tricky arguments verbatim (no shell)` |
| Kill дерева процесів на Windows | `cancel kills the whole process tree (Windows taskkill /T)` (онук-процес теж зупинено) |
| Без bypass-прапорців | unit `real adapters never emit permission-bypass flags` |
| Локальний API: Host/token/SSE | `HTTP API: host check, token required for mutations, live SSE events` |

## Ручний сценарій у UI (вбудований браузер)
1. «Створити демо-проєкт» → репозиторій `…\demo\Демо проєкт <ts>`; 4 задачі.
2. «Запустити план» → #1 і #2 `виконується` одночасно, #4 `у черзі` (ліміт 2), #3 `чекає залежностей`.
3. #1 → `потрібна відповідь` (команда `node --version`) → «Дозволити» → gate пройдено → `Approve & Merge` → `злито`. Те саме для #2.
4. #3 стартувала автоматично після обох merge, diff показав `docs/integration.md`, merge → `злито`.
5. #4 (пише `README.md` при `allowedPaths: tests/**`) → `заблоковано`, README у main не змінено.
6. Перемикання світлої/темної теми працює. Історія в демо-репозиторії: 3 коміти задач + 3 merge-коміти `--no-ff`.

## Реальні CLI (одна крихітна задача: «створи smoke-<id>.txt з текстом»)
| CLI | Результат | Деталі |
|---|---|---|
| Claude Code 2.1.325 (`--model haiku`, `acceptEdits`) | ✅ review, gate passed | файл `hello from claude`, usage з `total_cost_usd: 0.0058` |
| agy 1.5.9 (`--mode accept-edits --sandbox`, без bypass) | ✅ review, gate passed | файл `hello from agy`, usage з токенами |
| codex-cli 0.153.4 (`exec --json --sandbox workspace-write`) | ❌ failed, exit 1 | адаптер спрацював коректно, але Codex відповів 400: модель `gpt-6.1-sol` із `~/.codex/config.toml` не підтримується з ChatGPT-акаунтом. Оркестратор чесно позначив задачу `failed` з причиною |

## Баги, знайдені під час перевірки й виправлені
- `commitAll` не завершував merge-коміт, якщо розв'язання конфлікту збігалося з HEAD → repair-спроба знову конфліктувала (знайдено e2e-тестом конфлікту).
- Відносний `HIDFORGE_DATA_DIR` робив шлях worktree відносним до репозиторію, а `cwd` агента — до процесу → `spawn ENOENT` (знайдено ручним UI-прогоном). Тепер шлях нормалізується, а відсутній `cwd` дає зрозумілу помилку.
- SSE не віддавав заголовки до першого ping (15 с затримки).
