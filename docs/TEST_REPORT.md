# Звіт про перевірку

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
