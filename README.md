# HidForge Orchestrator

Локальний Windows-first оркестратор для AI-агентів програмування (Claude Code, Codex CLI, Antigravity `agy`, Cursor Agent CLI). Велика ціль → DAG задач → паралельні агенти в ізольованих git worktree → незалежні перевірки → ручний `Approve & Merge` → один цілісний репозиторій. Стан переживає перезапуск.

**Статус: v0.1 MVP (вертикальний зріз).** Ядро, Mock Agent, реальні адаптери Claude Code та agy перевірені наскрізно. Деталі: [docs/TEST_REPORT.md](docs/TEST_REPORT.md), [docs/ROADMAP.md](docs/ROADMAP.md).

## Вимоги
- Windows 10/11 x64 (Linux/macOS теж мають працювати, але не перевірялися)
- **Node.js ≥ 24** (вбудовані `node:sqlite` і запуск TypeScript без збірки)
- Git 2.x з підтримкою `worktree` (перевірено 2.54)
- Необов'язково: встановлені й авторизовані CLI агентів (`claude`, `codex`, `agy`, `cursor-agent`). Без них працює Mock Agent / demo mode.

Docker, tmux, WSL2 та платні API **не потрібні**.

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

Налаштування — `.env` (див. [.env.example](.env.example)): каталог даних, порт, паралелізм, stall-таймаут. За замовчуванням дані лежать у `%LOCALAPPDATA%\HidForge`.

## Як користуватися
1. Ліворуч — вкажіть шлях до Git-репозиторію й натисніть «Відкрити» (або «Створити демо-проєкт»). Робоча копія має бути на гілці, без незакомічених змін під час merge.
2. Блок «Агенти» показує встановлені CLI, версії, стан авторизації та причину недоступності.
3. «+ Задача»: назва, інструкції, критерії, роль, виконавець (`auto` = за політикою cost-first/balanced/quality-first), права (`read-only` / `workspace-write`), залежності `#id`, дозволені шляхи (glob), команди перевірки.
4. «Запустити план» — незалежні задачі стартують паралельно (за замовчуванням до 2), залежні — після merge своїх залежностей.
5. Відкрийте задачу: живий журнал, evidence, diff. Якщо gate потребує дозволу на команду перевірки — «Дозволити/Заборонити».
6. `Approve & Merge` або `Reject` (з поясненням — агент отримає його в repair-спробі). Конфлікт merge не руйнує нічого: задача `blocked`, «Повторити» зливає базу в її гілку і просить агента розв'язати конфлікт.

## Безпека коротко
Жодних `--dangerously-skip-permissions` / `--yolo` / `danger-full-access`; процеси без shell; команди перевірки — лише після дозволу, небезпечні — заборонені завжди; токени провайдерів не зберігаються; API лише на `127.0.0.1` з токеном. Див. [docs/SECURITY.md](docs/SECURITY.md).

## Документація
- [docs/UPSTREAM_AUDIT.md](docs/UPSTREAM_AUDIT.md) — аудит Cezar, CAO, Augani
- [docs/ADR-001-architecture.md](docs/ADR-001-architecture.md) — вибір архітектури
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — компоненти та потоки даних
- [docs/SECURITY.md](docs/SECURITY.md) — політики й модель загроз
- [docs/ROADMAP.md](docs/ROADMAP.md) — етапи
- [docs/TEST_REPORT.md](docs/TEST_REPORT.md) — що перевірено й як
- [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)

## Структура
```
src/            ядро (TypeScript, запускається Node 24 напряму)
  orchestrator.ts  scheduler, запуски, gate-и, merge, відновлення
  store.ts, db.ts  SQLite: єдине джерело істини, міграції, state machine
  workspace.ts     git worktree, diff, allowedPaths, merge
  adapters/        Mock + Claude/Codex/Cursor/agy
  proc.ts          spawn без shell, kill дерева процесів, маскування секретів
  server.ts        REST + SSE + статика
web/            UI (vanilla JS, світла/темна тема)
test/           unit + e2e (реальні процеси, git, SQLite)
scripts/        smoke-real.ts
```
