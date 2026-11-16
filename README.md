# HidForge Orchestrator

Локальний Windows-first оркестратор для AI-агентів програмування (Claude Code, Codex CLI, Antigravity `agy`, Cursor Agent CLI). Велика ціль → DAG задач → паралельні агенти в ізольованих git worktree → незалежні перевірки → ручний `Approve & Merge` → один цілісний репозиторій. Стан переживає перезапуск.

**Статус: v0.3.** Ядро, Mock Agent, реальні адаптери Claude Code та agy перевірені наскрізно; LLM-планер (ціль → DAG чернеток) перевірено на Claude Code та agy; AI-рецензент (QA + Security) перевірено на Claude Code та agy. Деталі: [docs/TEST_REPORT.md](docs/TEST_REPORT.md), [docs/ROADMAP.md](docs/ROADMAP.md).

## Вимоги
- Windows 10/11 x64 (Linux/macOS теж мають працювати, але не перевірялися)
- **Node.js ≥ 24** (вбудовані `node:sqlite` і запуск TypeScript без збірки)
- Git 2.x з підтримкою `worktree` (перевірено 2.54)
- Необов'язково: встановлені й авторизовані CLI агентів (`claude`, `codex`, `agy`, `cursor-agent`). Без них працює Mock Agent / demo mode.

Docker, tmux, WSL2 та платні API **не потрібні**.

## Встановлення й запуск без термінала (Windows)

Інсталятор лише перевіряє Node.js 24+ і Git (нічого не встановлює сам, права адміністратора не потрібні) і створює ярлик «HidForge Orchestrator» на робочому столі та в меню «Пуск»:
```powershell
powershell -ExecutionPolicy Bypass -File scripts\install.ps1
```
Ярлик запускає сервер без вікна термінала (`scripts\HidForge.vbs`) і відкриває UI у браузері; повторний запуск лише відкриває вже запущений екземпляр. Журнал сервера: `%LOCALAPPDATA%\HidForge\hidforge.log`. Зупинка: «Налаштування → Про програму → Зупинити сервер». Видалити ярлики (дані залишаться): `scripts\install.ps1 -Uninstall`.

Оновлення (лише fast-forward з origin; локальні зміни не перезаписуються):
```powershell
powershell -ExecutionPolicy Bypass -File scripts\update.ps1 -Check
```
```powershell
powershell -ExecutionPolicy Bypass -File scripts\update.ps1
```

## Команди (PowerShell)

```powershell
npm install
```

Запуск у режимі розробки (UI на http://127.0.0.1:4317):
```powershell
npm run dev
```

Запуск із демо-проєктом (Mock-агенти, без витрат квоти):
```powershell
npm run demo
```

Перевірки:
```powershell
npm run typecheck; npm run lint; npm test; npm run build
```

Зібрана версія:
```powershell
npm start
```

Смоук-тест справжніх CLI (витрачає трохи квоти вашої підписки — одна крихітна задача на провайдера):
```powershell
node scripts\smoke-real.ts claude agy
```

Смоук-тест LLM-планера на справжніх CLI (`провайдер[:модель]`):
```powershell
node scripts\smoke-planner.ts claude:haiku agy
```

Смоук-тест AI-рецензента на справжніх CLI (Mock-виконавець пише навмисно небезпечний код, справжній агент його рецензує):
```powershell
node scripts\smoke-review.ts claude:haiku agy
```

Бюджет і витрати: «Налаштування → Бюджет проєкту» (HidForge перестає запускати задачі, коли звітовані витрати досягли бюджету), ліміт на задачу передається Claude Code як `--max-budget-usd`; зведення витрат — на «Огляді». Довіра до каталогів для Cursor вмикається лише вручну в Налаштуваннях.

Налаштування — `.env` (див. [.env.example](.env.example)): каталог даних, порт, паралелізм, stall-таймаут. За замовчуванням дані лежать у `%LOCALAPPDATA%\HidForge`.

## Як користуватися
1. Ліворуч — вкажіть шлях до Git-репозиторію й натисніть «Відкрити» (або «Створити демо-проєкт»). Робоча копія має бути на гілці, без незакомічених змін під час merge.
2. Блок «Агенти» показує встановлені CLI, версії, стан авторизації та причину недоступності.
3. **AI-планер**: впишіть ціль, оберіть агента (або `mock` для демо) і натисніть «Згенерувати план». Агент у режимі лише читання пропонує DAG задач; перегляньте таблицю й натисніть «Додати як чернетки» (або «Відхилити»).
   Або вручну — «+ Задача»: назва, інструкції, критерії, роль, виконавець (`auto` = за політикою cost-first/balanced/quality-first), права (`read-only` / `workspace-write`), залежності `#id`, дозволені шляхи (glob), команди перевірки.
4. «Запустити план» — незалежні задачі стартують паралельно (за замовчуванням до 2), залежні — після merge своїх залежностей.
5. Відкрийте задачу: живий журнал, evidence, diff. Якщо gate потребує дозволу на команду перевірки — «Дозволити/Заборонити».
6. **AI-рецензент** (за потреби): політика проєкту `reviewPolicy` — `off` (типово), `advisory` (лише інформує) або `required` (merge дозволено тільки з вердиктом `approve`; `request_changes` автоматично повертає задачу агенту з findings). Налаштовується в «Налаштування → AI-рецензент». Рецензент запускається після успішних gate-ів у режимі лише читання в окремому тимчасовому worktree; вердикт і зауваження — у вкладці «AI-рецензія» задачі, там же кнопки «AI-рецензія» / «Зупинити рецензію».
7. `Approve & Merge` або `Reject` (з поясненням — агент отримає його в repair-спробі). Конфлікт merge не руйнує нічого: задача `blocked`, «Повторити» зливає базу в її гілку і просить агента розв'язати конфлікт.

## Безпека коротко
Жодних `--dangerously-skip-permissions` / `--yolo` / `danger-full-access`; процеси без shell; команди перевірки — лише після дозволу, небезпечні — заборонені завжди; токени провайдерів не зберігаються; API лише на `127.0.0.1` з токеном. Див. [docs/SECURITY.md](docs/SECURITY.md).

## Документація
- [docs/UPSTREAM_AUDIT.md](docs/UPSTREAM_AUDIT.md) — аудит Cezar, CAO, Augani
- [docs/ADR-001-architecture.md](docs/ADR-001-architecture.md) — вибір архітектури
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — компоненти та потоки даних
- [docs/SECURITY.md](docs/SECURITY.md) — політики й модель загроз
- [docs/ROADMAP.md](docs/ROADMAP.md) — етапи
- [docs/TEST_REPORT.md](docs/TEST_REPORT.md) — що перевірено й як
- [docs/DESIGN_SYSTEM.md](docs/DESIGN_SYSTEM.md) — дизайн-система UI: токени, компоненти, адаптивність
- [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)

## Структура
```
src/            ядро (TypeScript, запускається Node 24 напряму)
  orchestrator.ts  scheduler, запуски, gate-и, merge, відновлення
  planner.ts       LLM-планер: ціль → валідований DAG → чернетки задач
  reviewer.ts      AI-рецензент QA + Security: diff → вердикт → repair / блок merge
  report.ts        звіт по проєкту й журнал рішень ADR (з історії, без нового сховища)
  oneshot.ts       спільний одноразовий read-only запуск агента (планер, рецензент)
  store.ts, db.ts  SQLite: єдине джерело істини, міграції, state machine
  workspace.ts     git worktree, diff, allowedPaths, merge
  adapters/        Mock + Claude/Codex/Cursor/agy
  proc.ts          spawn без shell, kill дерева процесів, маскування секретів
  server.ts        REST + SSE + статика
web/            UI: styles/tokens.css, styles/ui.css, ui.js (компоненти), app.js (сторінки)
test/           unit + e2e (реальні процеси, git, SQLite)
scripts/        smoke-real.ts, smoke-planner.ts, smoke-review.ts, progress.ts
```

## Ліцензія
[MIT](LICENSE) © 2026 masskill. Сторонні джерела й атрибуція — [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
