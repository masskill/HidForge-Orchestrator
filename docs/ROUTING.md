# Автовибір агента, моделі й зусиль

Для задачі з виконавцем `auto` і заданим типом HidForge сам вибирає агента, модель і рівень зусиль.
Вибір робить таблиця правил (`src/routing.ts`), без жодного виклику AI — токени на це не витрачаються.

> **Таблиця — стартова гіпотеза, а не вимір.** Її складено 17.11.2026 із семи звітів-досліджень
> (публічні бенчмарки й відгуки) і з того, які моделі реально показали CLI на ПК автора.
> HidForge цих цифр не перевіряв. Власні виміри збирає сторінка «Аналітика моделей».
> Назви моделей застарівають: якщо у вашому CLI їх немає, відредагуйте таблицю в Налаштуваннях.

## Як це працює

1. AI-планер позначає кожну задачу типом (`category`) і складністю (`complexity`). У формі задачі їх можна змінити.
2. Для пари «тип / складність» таблиця дає ланцюжок: **головний → заміна 1 → заміна 2**.
3. Спроба 1 іде до головного. Якщо спроба невдала (помилка агента, непройдена перевірка, вимога рецензента),
   наступна спроба йде до наступної ланки. Остання ланка повторюється.
4. Сама задача лишається `auto`; що саме використав кожен запуск, записано в запуску (агент, модель, зусилля).
5. Задача без типу працює як раніше: перший доступний агент за політикою автовибору.

## Вичерпаний ліміт

Коли запуск падає, HidForge перевіряє текст помилки й останні рядки виводу (`src/limits.ts`): «usage limit»,
«hit your limit», «quota exceeded», `RESOURCE_EXHAUSTED`, `insufficient_quota`, «credit balance is too low»,
`429` / «too many requests» тощо. Це евристика: незнайоме формулювання лишається звичайною невдачею (ескалація як вище).

Якщо ліміт розпізнано:
1. Агент ставиться **на паузу** до часу скидання ліміту — з повідомлення («try again in 2 hours», «resets 3pm», мітка часу
   після `|`), інакше на 60 хв (квота) або 5 хв (`429`). Пауза діє всюди: задачі, планер, чат, рецензент.
2. Спроба **не зараховується**, задача одразу повертається в чергу. Пауза робить агента недоступним, тож ланцюжок
   будується без нього — задачу бере наступна за «розумом» ланка тієї ж клітинки таблиці.
3. Задача з явно вибраним агентом, що на паузі, передається першій доступній ланці таблиці для її типу.
4. Якщо доступних агентів немає зовсім — задача не падає, а чекає в черзі до найближчого кінця паузи.
5. На картці агента — «ліміт до HH:MM», відповідь CLI і кнопка «Зняти паузу» (`POST /api/agents/:id/resume`).
   Пауза знімається сама, коли минає її час.

Захист від циклу: після 6 передач поспіль задача йде звичайним шляхом невдач.

## Жорсткі правила

- **Зусилля не вище `high`.** У типовій таблиці немає `xhigh` і `max`; налаштування «Стеля зусиль» (типово `high`)
  відкидає ланки з вищим рівнем. Вищий рівень можливий лише тоді, коли людина сама вписала його в конкретну задачу.
  Причина: за звітами `max` дає невеликий приріст якості, а ліміти підписки витрачає в рази швидше.
- **Ескалація — це інша модель або інший вендор, а не більше зусиль.**
- **Рецензент завжди від іншого вендора, ніж автор коду.** Вендор визначається за моделлю, а не за CLI
  (Claude Opus у Cursor — це Anthropic).
- **Fable 5.2 у типових ланцюжках немає.** Є перемикач «Дозволити Fable як останню ланку», типово вимкнений;
  він додає Fable · high четвертою ланкою лише для складних задач типів `bugfix`, `architecture`, `planning`, `backend`.
- **Gemini CLI у ланцюжках немає.**
- Агент, якого немає, який не увійшов, якого забороняє шаблон ролі або який позначений
  «не може записувати файли» (для задач із записом), пропускається.

## Типова таблиця

Скорочення: Sol = `gpt-6.1-sol`, Astra = `gpt-6-astra`, Terra = `gpt-6.1-terra`, Luna = `gpt-6-luna`,
H = `gemini-4-hydrogen`, A = `gemini-4-argon`. У Antigravity й Cursor рівень зусиль є частиною назви моделі.

| Тип | Складність | Головний | Заміна 1 | Заміна 2 |
|---|---|---|---|---|
| ui_visual | low | Claude sonnet · medium | agy H-high | Codex Terra · medium |
| ui_visual | medium | Claude opus · high | Codex Astra · high | agy H-high |
| ui_visual | high | Claude opus · high | Codex Astra · high | agy A-high |
| frontend_logic | low | Codex Sol · medium | Claude haiku · high | agy H-medium |
| frontend_logic | medium | Codex Sol · high | Claude sonnet · high | agy A-high |
| frontend_logic | high | Claude opus · high | Codex Sol · high | agy A-high |
| backend | low | Codex Sol · medium | Claude haiku · high | agy H-medium |
| backend | medium | Codex Sol · high | Claude sonnet · high | agy H-high |
| backend | high | Claude opus · high | Codex Astra · high | agy A-high |
| bugfix | low | Codex Sol · medium | Claude sonnet · medium | agy H-medium |
| bugfix | medium | Codex Sol · high | Claude opus · medium | agy H-high |
| bugfix | high | Claude opus · high | Codex Astra · high | agy A-high |
| refactor | low | Codex Sol · medium | Claude sonnet · medium | Cursor composer-2.5 |
| refactor | medium | Codex Sol · high | Claude sonnet · high | agy A-high |
| refactor | high | Codex Astra · high | Claude opus · high | agy A-high |
| architecture | low | Claude opus · medium | Codex Sol · high | agy A-medium |
| architecture | medium | Claude opus · high | Codex Astra · medium | agy A-high |
| architecture | high | Claude opus · high | Codex Astra · high | agy A-high |
| tests | low | Codex Sol · medium | Claude haiku · high | Cursor composer-2.5 |
| tests | medium | Codex Sol · high | Claude sonnet · high | agy H-high |
| tests | high | Claude opus · high | Codex Sol · high | agy A-high |
| docs | low | Claude haiku · medium | Codex Luna · high | Cursor composer-2.5 |
| docs | medium | Codex Terra · medium | Claude haiku · high | agy H-medium |
| docs | high | Claude opus · medium | Codex Terra · high | agy A-high |
| small_edit | low | Claude haiku · medium | Codex Luna · high | Cursor composer-2.5 |
| small_edit | medium | Claude haiku · high | Codex Sol · low | Cursor composer-2.5 |
| small_edit | high | Claude sonnet · medium | Codex Sol · medium | agy H-medium |
| planning | low | Claude sonnet · medium | Codex Sol · medium | agy A-medium |
| planning | medium | Claude opus · medium | Codex Sol · high | agy A-high |
| planning | high | Claude opus · high | Codex Astra · high | agy A-high |

Сесія AI-планера з виконавцем `auto` бере ланцюжок `planning / medium`.

### Рецензія

| Автор коду | Рецензент | Заміна |
|---|---|---|
| Anthropic (Claude) | Codex Sol (проста задача — medium, інакше high) | agy A-high |
| OpenAI (Codex) | Claude opus (проста задача — medium, інакше high) | agy A-high |
| інші (Gemini, Grok, Composer) | Codex Sol · high | Claude sonnet · high |

Якщо жоден рецензент із правила недоступний, береться перший доступний агент іншого вендора за політикою автовибору.

### Чому так (висновки звітів, не власні виміри)

- рутинний код — Codex Sol: якість, близька до Opus, за меншу ціну задачі;
- складне й архітектура — Opus;
- візуал — Claude; Astra — перша заміна;
- Haiku і Luna не ставляться на `low`: на цьому рівні вони слабкі;
- Sonnet не головний на складному: без `xhigh` він там поступається, а `xhigh` не використовується;
- `high` — оптимальний рівень: `max` коштує в кілька разів більше за невеликий приріст.

Розбіжність між звітами, яку мають вирішити власні виміри: Sol на `low` чи на `medium` для простих задач
(у таблиці — `medium`).

## Як передається зусилля

| CLI | Спосіб |
|---|---|
| Claude Code | `--effort <рівень>` |
| Codex | `-c model_reasoning_effort=<рівень>` |
| Antigravity, Cursor | рівень у назві моделі; прапорець не додається |
| JSON-плагін | необов'язковий `args.effort` із `{effort}` |

## Налаштування

Налаштування → «Автовибір моделі»: стеля зусиль, Fable як остання ланка, самонавчання,
позначка «агент не може записувати файли» та редагована таблиця (формат ланки: `агент модель зусилля`).

## Резервний API (платно)

Правило: **є CLI — працюємо через CLI; немає (або не виконано вхід) — через API провайдера, якщо вказано ключ.**

| Агент | API | Ключ у `.env` | Моделі |
|---|---|---|---|
| Claude Code | Anthropic (офіційний SDK `@anthropic-ai/sdk`) | `ANTHROPIC_API_KEY` | `opus` → `claude-opus-5-5`, `sonnet` → `claude-sonnet-5-5`, `haiku` → `claude-haiku-5-5` |
| Codex | OpenAI, Chat Completions | `OPENAI_API_KEY` | назва з таблиці як є (не перевірено на API) |
| Antigravity | Gemini, OpenAI-сумісна адреса | `GEMINI_API_KEY` | суфікс `-low/-medium/-high` стає зусиллям (не перевірено на API) |

- Вмикається перемикачем Налаштування → «Резервний API (платно)»; типово вимкнено. Ключ сам по собі нічого не вмикає.
- Ключі HidForge не зберігає: вони лише в `.env` (не потрапляє в git) і передаються процесу API-агента.
- API-агент (`src/adapters/api-agent.ts`) має три інструменти: `list_files`, `read_file`, `write_file`
  (останнього немає в режимі «лише читання»). Шляхи обмежено робочою копією, `.git` недоступний, команд не запускає —
  перевірку роблять команди перевірки HidForge. Максимум 60 кроків.
- Для Anthropic: зусилля — `output_config.effort`; кешування промпту ввімкнено; для Opus/Sonnet 5.5 — серверний
  резерв на випадок відмови моделі (`fallbacks: "default"`). Вартість оцінюється за цінами з довідника Claude API
  (03.11.2026) і зупиняє задачу, коли перевищено її бюджет. Для OpenAI/Gemini показуються лише токени.
- Маршрутизація не змінюється: агент лишається тим самим (`claude`, `codex`, `agy`), змінюється лише спосіб запуску;
  на сторінці агентів у назві з'являється «через API (платно)».

### API-провайдери без CLI

Окремі агенти, що працюють лише через OpenAI-сумісний API (той самий API-агент і ті самі правила: ключ у `.env`
+ перемикач «Дозволити платні API-запити»). Дані перевірено за офіційною документацією 17.11.2026; реальних запитів не було.
У таблицю автовибору вони не входять — їх вибирають вручну в задачі або вписують у таблицю пріоритетів.

| Агент | Адреса API | Ключ | Типова модель | Зусилля |
|---|---|---|---|---|
| `deepseek` | `https://api.deepseek.com` | `DEEPSEEK_API_KEY` | `deepseek-v4-pro` (дешевша `deepseek-flash`) | low → low, medium/high → high |
| `kimi` | `https://api.moonshot.ai/v1` | `MOONSHOT_API_KEY` | `kimi-k3.1-pro` (`kimi-k3`) | low → low, medium/high → high |
| `minimax` | `https://api.minimax.io/v1` | `MINIMAX_API_KEY` | `MiniMax-M3` (`MiniMax-M3.1-Flash`) | не передається (лише Flash-модель) |
| `qwen` | `https://dashscope-intl.aliyuncs.com/compatible-mode/v1` | `DASHSCOPE_API_KEY` | `qwen4-max` (`qwen3.8-flash`) | не передається (залежить від моделі) |
| `glm` | `https://api.z.ai/api/paas/v4` | `ZAI_API_KEY` | `glm-5.3` (`glm-5.3-flash`) | low → low, medium/high → high |
| `grok` | `https://api.x.ai/v1` | `XAI_API_KEY` | `grok-build-0.1` (`grok-4.7`) | не передається; Chat Completions у xAI застарілий, інструменти в ньому не підтверджено документацією |
| `mistral` | `https://api.mistral.ai/v1` | `MISTRAL_API_KEY` | `mistral-large-4` (`mistral-small-latest`) | не передається (підтримка за моделлю не підтверджена) |
| `openrouter` | `https://openrouter.ai/api/v1` | `OPENROUTER_API_KEY` | `deepseek/deepseek-v4.1-flash-20261017` | як є |

- Список моделей береться наживо з `GET /models` провайдера (безкоштовний запит), якщо ключ є; інакше — відомі назви вище.
- Моделі з «мисленням» (DeepSeek, Kimi, MiniMax) вимагають повертати `reasoning_content` після виклику інструмента — API-агент це робить.
- Офіційні CLI існують у Kimi (`kimi`), MiniMax (`mcode`), Qwen (`qwen`), xAI (`grok`), Mistral (`vibe`); на цьому ПК вони не встановлені,
  тож адаптерів для них ще немає (формат їхнього потоку подій треба перевірити на реальному CLI).
- Джерела: api-docs.deepseek.com, platform.kimi.ai/docs, platform.minimax.io/docs, alibabacloud.com/help/en/model-studio,
  docs.z.ai, docs.x.ai, docs.mistral.ai, openrouter.ai/docs.

## Власна статистика

Кожен запуск зберігає тип, складність, агента, модель і зусилля. Сторінка «Аналітика моделей» показує для кожної
зв'язки: кількість запусків, частку успішних, успіх із першої спроби, вердикти AI-рецензента, середній час, токени й долари
(долари звітує лише Claude Code). «Успішний» означає, що агент завершив роботу без помилки.

**Самонавчання** (типово вимкнено): коли кожна ланка клітинки має щонайменше 5 запусків, ланки впорядковуються
за часткою успішних запусків.

## Що перевірено

- Автотести (`test/routing.test.ts`): правила таблиці, фільтри, ескалація, запис запусків, побудова команд.
- Автотести резервного API (`test/api.test.ts`) на фейковому локальному сервері: запис файлу, відмова для шляху поза робочою копією, режим «лише читання», зусилля, оцінка вартості, «CLI спочатку». Реальні API-запити не робились.
- Реальний запуск 17.11.2026: задача `docs / low` на `auto` пішла на Claude Code з `--model haiku --effort medium` і пройшла перевірки.
- **Не перевірено на реальних CLI:** прапорець зусиль Codex у реальному запуску, ланки Antigravity й Cursor,
  самонавчання на реальних даних.
