# Third-party notices

## Вихідний код upstream-проєктів
**Код зі сторонніх репозиторіїв у цей проєкт не копіювався.** Нижче — джерела, з яких запозичено ідеї, формати протоколів або архітектурні концепції (дослідження: `docs/UPSTREAM_AUDIT.md`). Бренди та логотипи цих проєктів не використовуються.

| Проєкт | Commit | Ліцензія | Що використано (лише ідеї/формати) |
|---|---|---|---|
| [open-mercato/cezar](https://github.com/open-mercato/cezar) | `d4beeb8b4512b3fe690341951185f3aed48fe7eb` | MIT, Copyright (c) 2026 Patryk Lewczuk | Формат stdin-кадру та argv для `agy` stream-json (`-p=` останнім), форма подій stream-json Claude/Cursor/agy (з записаних фікстур), ідея розгортання Windows `.cmd`-шимів без shell, worktree на запуск |
| [awslabs/cli-agent-orchestrator](https://github.com/awslabs/cli-agent-orchestrator) | `3e30ea3ed6e7fb607b13358d81123afff5a8e69f` | Apache-2.0; NOTICE: "Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved." | Концепції supervisor/worker ролей і провайдер-адаптера (заплановано на Етап 4) |
| [Augani/agent-orchestrator](https://github.com/Augani/agent-orchestrator) | `8d9b897c49500e8e1b54ec8028352544db95618d` | MIT, Copyright (c) 2026 Augustus Otu | Концепції task contract, review gate з обов'язковими доказами, звільнення залежностей лише після прийняття, прозора таблиця route selection (cost-first / quality-first) |

Якщо в майбутньому код буде скопійовано, файл має містити повний текст ліцензії, copyright і (для Apache-2.0) вміст NOTICE, а в коді — коментар із джерелом і SHA.

## Залежності

Runtime-залежностей немає (лише вбудовані модулі Node.js).

| Пакет | Призначення | Ліцензія |
|---|---|---|
| typescript | dev: typecheck і збірка `dist` | Apache-2.0 |
| @types/node | dev: типи Node.js | MIT |
| Node.js (`node:sqlite` вбудовує SQLite) | середовище виконання, не розповсюджується з проєктом | MIT; SQLite — public domain |
