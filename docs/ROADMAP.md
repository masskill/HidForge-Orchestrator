# Roadmap

Статуси: ✅ зроблено й перевірено · 🟡 частково · ⬜ не почато

## Етап 0 — дослідження ✅
- ✅ Клони трьох upstream із SHA, аудит коду, ліцензій, Windows-сумісності, безпеки → `UPSTREAM_AUDIT.md`
- ✅ ADR-001 (нове ядро) → `ADR-001-architecture.md`

## Етап 1 — ядро ✅
- ✅ SQLite + міграції, модель задач, state machine, events
- ✅ DAG-валідація, scheduler з concurrency/priority/retry/backoff, timeouts/stall
- ✅ DB-рівневі гарантії: один живий запуск на задачу, один writer на workspace
- ✅ Git worktree на задачу, clean-up після merge
- ✅ Mock Agent (окремий процес), e2e та concurrency-тести
- ✅ Відновлення після рестарту

## Етап 2 — реальні CLI 🟡
- ✅ Claude Code — реальний прогін пройшов (файл створено, gate OK, usage з вартістю)
- 🟡 Codex — адаптер запускає `codex exec --json`, події парсяться; реальний прогін **не пройшов** через модель у `~/.codex/config.toml` користувача (`gpt-6.1-sol` не підтримується з ChatGPT-акаунтом). Потрібно вказати підтримувану модель у задачі або в конфігу Codex.
- ✅ Antigravity `agy` — реальний прогін пройшов без bypass-прапорців
- ⬜ Cursor — адаптер є, не перевірено (CLI не встановлено)
- ✅ Capability-based degradation: недоступний CLI → лише його задача `failed`, решта працює
- ⬜ `--max-budget-usd` / ліміти вартості для Claude, `agy models` / список моделей

## Етап 3 — робочий UI 🟡
- ✅ Projects / Tasks (DAG-таблиця) / Agents / Runs / живі логи / diff / evidence / approve-reject / теми / налаштування паралелізму та політики
- ⬜ Візуальний граф DAG (зараз таблиця з колонкою залежностей)
- ⬜ Редагування ролей/шаблонів ролей, перегляд глобальної історії подій
- ⬜ Desktop-оболонка (Tauri/Electron) — Етап 5

## Етап 4 — інтелектуальна координація ⬜
- ⬜ LLM-планер у `read-only` режимі: ціль → чернетка DAG (людина редагує)
- ⬜ Агент-рецензент (Security Reviewer / QA) як окрема read-only задача з вердиктом
- ⬜ Двосторонні питання від агентів (MCP-канал, ідея CAO `send_message`)
- ⬜ Облік витрат по проєкту/провайдеру, звіти
- ⬜ Профілі агентів у Markdown+frontmatter (ідея CAO)

## Етап 5 — продукт ⬜
- ⬜ Інсталятор Windows, автозапуск без термінала, оновлення
- ⬜ Резервне копіювання `hidforge.db`, діагностика
- ⬜ Опційний WSL2 backend, плагінні JSON-адаптери (Gemini CLI, OpenCode)
