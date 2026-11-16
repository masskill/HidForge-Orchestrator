# Аудит upstream-проєктів (Етап 0)

Дата: 2026-11-16. Клони лежать у `research/upstreams/` (виключено з Git через `.gitignore`), `git clone --depth 1`.

| Проєкт | Commit SHA | Дата коміту | Ліцензія | Мова / стек |
|---|---|---|---|---|
| open-mercato/cezar | `d4beeb8b4512b3fe690341951185f3aed48fe7eb` | 2026-11-16 | MIT © 2026 Patryk Lewczuk | TypeScript, Hono, React 19, Tauri |
| awslabs/cli-agent-orchestrator (CAO) v2.5.4 | `3e30ea3ed6e7fb607b13358d81123afff5a8e69f` | 2026-11-16 | Apache-2.0, NOTICE: © Amazon.com, Inc. | Python ≥3.11, FastAPI, SQLAlchemy, libtmux |
| Augani/agent-orchestrator | `8d9b897c49500e8e1b54ec8028352544db95618d` | 2026-09-14 | MIT © 2026 Augustus Otu | Python 3 stdlib, Codex plugin |

Аудит проведено за вихідним кодом (runner-и, scheduler-и, схеми БД, тести), а не лише за README. Ліцензії транзитивних залежностей не перевірялися повністю, бо **код upstream не копіювався** (див. ADR-001).

## Головні знахідки

### Безпека: усі три за замовчуванням послаблюють дозволи CLI
- **CAO**: `claude --dangerously-skip-permissions`, `codex --yolo`, `cursor-agent --force`, `agy --dangerously-skip-permissions` — це **дефолт** (`providers/claude_code.py:713`, `codex.py:1773`, `cursor_cli.py:404`, `antigravity_cli.py:389`). Також мовчки змінює `~/.claude/settings.json`, щоб приховати попередження про bypass.
- **Cezar**: Claude — `--permission-mode dontAsk` + `Bash` у дозволених tools; Codex — `danger-full-access` + `approvalPolicy: never` за замовчуванням; Cursor — `--force --trust`; agy — завжди `--dangerously-skip-permissions`.
- **Augani**: жодних bypass-прапорців (явна заборона у SKILL.md), але перевірка «one writer per workspace» — це check-then-act без блокування, обходиться `--allow-concurrent-workspace`.

→ HidForge **не переймає** жодного з цих дефолтів (тест `real adapters never emit permission-bypass flags`).

### Windows
- **CAO**: Windows не підтримується за задумом (`__init__.py` кидає `ImportError` на win32), tmux, FIFO, fcntl.
- **Augani**: `import fcntl` ламає запуск на Windows, `os.killpg`, `os.execv`.
- **Cezar**: частково — є розгортання `.cmd`-шимів і `taskkill /T` у одному місці, але check-кроки запускаються через `bash -lc`, агенти вбиваються `SIGTERM` без дерева процесів (онуки залишаються на Windows).

### Розмір
Cezar ≈ 113k LOC сервера + 122k LOC UI, файли-«боги» (`workflows/run.ts` 10k рядків, `server.ts` 9.6k). CAO ≈ 82k рядків (`api/main.py` 12.5k). Augani — один файл 4.3k рядків.

## Порівняльна таблиця

| Компонент | Джерело | Повторне використання | Вартість адаптації | Windows | Ліцензія | Рішення |
|---|---|---|---|---|---|---|
| Runner-и CLI (claude/codex/cursor/agy) + записані NDJSON-фікстури | Cezar `src/core/*-runner.ts`, `__fixtures__` | Високе (як довідник протоколів) | Середня: прибрати bypass, додати tree-kill | Частково | MIT | **Ідеї/формати**: argv для agy (`-p=` останнім, prompt як stdin-кадр `{"event":"user",...}`), форма подій stream-json. Код не скопійовано. |
| Розгортання `.cmd`-шимів без shell | Cezar `core/windows-shim.ts` | Високе | Низька | Так | MIT | Власна реалізація `resolveCommand` (ідея та сама). |
| Git worktree per run | Cezar `git-worktree.ts` | Середнє | Низька | Так | MIT | Власна мінімальна реалізація `WorkspaceManager`. |
| Workflow engine | Cezar `workflows/run.ts` | Низьке | Дуже висока (моноліт, bash) | Ні | MIT | Не використовуємо. |
| Web UI | Cezar `packages/web` | Середньо-низьке (тісно зв'язаний з API) | Висока | — | MIT | Лише як референс UX. |
| Supervisor/worker, handoff/assign/send_message, inbox | CAO `mcp_server/server.py`, `docs/inbox-delivery.md` | Ідеї | Висока (tmux-центричне) | Ні | Apache-2.0 | Етап 4 (MCP-інструменти для агентів-координаторів). |
| Детекція статусу регекспами по екрану TUI | CAO `providers/*.py` + 212 фікстур | Низьке для MVP | Висока | Ні | Apache-2.0 | Не потрібно: використовуємо headless stream-json режими. |
| Профілі агентів (Markdown + frontmatter) | CAO `agent_store/` | Середнє | Низька | Так | Apache-2.0 | Пізніше (зараз ролі — шаблони в задачі). |
| Task contract (9 секцій), review gate з обов'язковими доказами, accepted = незмінний | Augani `cli_agent_job.py`, `references/task-contract.md` | Високе (концепції) | Низька | — | MIT | **Адаптовано ідею**: `contract.ts` (скорочений контракт), gate-и, «залежність відпускається лише після merge». |
| Route selection (cost-first / quality-first) | Augani `rank_executor_candidates` | Середнє | Низька | — | MIT | Прозора таблиця правил без вигаданих оцінок якості. |
| Durable jobs у JSON-файлах + polling | Augani | Низьке | — | Ні (fcntl) | MIT | Замінено SQLite з DB-обмеженнями. |
| Питання від агентів через файли + `os.execv` | Augani `channel.py` | Низьке | — | Ні | MIT | Замість цього `needs_user_input` у БД; двосторонній канал — Етап 4. |

## Що перевірено в реальних CLI на цій машині
- `claude 2.1.325`: `-p --output-format stream-json --verbose --permission-mode acceptEdits|plan`, `auth status` (JSON `loggedIn`).
- `codex-cli 0.153.4`: `exec --json --sandbox read-only|workspace-write --cd <dir> -` (prompt зі stdin), `login status`.
- `agy 1.5.9`: `--input-format stream-json --output-format stream-json --mode accept-edits|plan --sandbox -p=`; команди перевірки авторизації немає.
- `cursor-agent`: **не встановлено** — адаптер побудовано за документацією та фікстурами Cezar, локально не перевірено.
