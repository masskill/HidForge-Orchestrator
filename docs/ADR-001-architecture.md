# ADR-001: Нове мінімальне ядро на Node 24 з вибірковим повторним використанням ідей

- Статус: прийнято (2026-11-16)
- Контекст: див. `docs/UPSTREAM_AUDIT.md`

## Розглянуті варіанти

1. **Fork Cezar.** Найближчий за стеком (TypeScript), має runner-и для всіх потрібних CLI.
   Проти: ~235k LOC, моноліти по 10k рядків, check-кроки через `bash -lc`, вбивство без дерева процесів на Windows, небезпечні дефолти дозволів (`danger-full-access`, `--force --trust`, agy з bypass). Утримувати такий fork дорожче, ніж написати потрібне ядро; кожен upstream-реліз (v0.21, швидкі зміни) — злиття вручну.
2. **Плагінна інтеграція поверх CAO або Augani.** CAO не працює на Windows без WSL2 і вимагає tmux; Augani — Codex-плагін, падає на `import fcntl`. Обидва суперечать вимозі «MVP без Docker/tmux/WSL2» і «не прив'язуватися до Codex».
3. **Нове ядро + вибірковий reuse ідей/форматів.** ✅ Обрано.

## Рішення

- **Node.js 24 + TypeScript без кроку збірки для розробки** (вбудоване стирання типів), `tsc` лише для typecheck та `dist`.
- **Нуль runtime-залежностей**: `node:sqlite` (вбудований SQLite, без native addon — немає проблем зі збіркою на Windows), `node:http` + SSE, `node:child_process`. Dev-залежності: `typescript`, `@types/node`.
- **Одне джерело істини** — SQLite: `projects`, `tasks`, `runs`, `workspace_locks`, `events`, `settings`, з міграціями. Інваріанти забезпечує БД:
  - `unique index runs(task_id) where status='running'` — не буває двох живих запусків однієї задачі;
  - `workspace_locks.workspace primary key` — один writer на workspace.
- **Один scheduler** (`Orchestrator.tick`), без конкуруючих черг.
- **Адаптери** — один інтерфейс `AgentAdapter` (`detect / checkAuth / capabilities / buildInvocation / parseLine`), спільний runtime (spawn без shell, стрім, cancel із `taskkill /T /F`). Реальні CLI описані декларативно (`src/adapters/cli.ts`), Mock — окремий процес.
- **Headless-режими CLI замість емуляції терміналу** (на відміну від CAO): stream-json / `--json`. Інтерактивні питання агентів у MVP — `unsupported`.
- **Git worktree на задачу**, ручний `Approve & Merge` з `--no-ff`, при конфлікті — `merge --abort` (нічого не втрачається), задача `blocked`, повтор = merge бази у гілку задачі + repair-спроба агента.
- **UI** — статичний vanilla JS (без React/Vite) з того ж сервера; прив'язка тільки до `127.0.0.1`.

## Наслідки

- (+) Запуск на чистому Windows 10/11 з Node 24 і Git: `npm install` ставить лише TypeScript.
- (+) Мало коду (~2k рядків TS + ~0.5k JS UI), усе покрито e2e-тестами з реальними процесами.
- (−) `node:sqlite` у Node 24 позначений як release candidate; API стабільний з 22.13, але при оновленні Node варто прогнати тести.
- (−) Немає PTY/інтерактивного терміналу агента; якщо знадобиться — `node-pty` як опційний модуль (Етап 3+).
- (−) Повторне використання коду upstream дорівнює нулю — свідомо; провенанс ідей зафіксовано в `THIRD_PARTY_NOTICES.md`.

## Відхилення від ТЗ (свідомі)
- Планувальник у MVP — ручний редактор DAG (дозволено ТЗ §8); LLM-декомпозиція — Етап 4.
- Конфлікт merge не створює окрему задачу-«інтегратор», а повертає ту саму задачу на repair-спробу з конфліктними маркерами в її worktree. Це простіше й не губить контекст задачі.
- Lint = суворий `tsc` (`strict`, `noUnused*`, `erasableSyntaxOnly`), ESLint не додано.
