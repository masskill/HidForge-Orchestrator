# Промпт для GPT: сторінки «Проєкти» і «Журнал подій» HidForge

**Як користуватися.** Відкрийте новий чат у ChatGPT і прикріпіть файли:
- `web/app.js`
- `web/ui.js`
- `web/styles/ui.css`
- `web/styles/tokens.css`
- `docs/DESIGN_SYSTEM.md`
- `HidForge_Style_Master_Prompt.md`

Потім вставте весь текст нижче, від «---». Відповідь GPT (patch або блоки змін) поверніть мені: я застосую, перевірю тестами й у браузері.

---

Ти — senior frontend engineer. Працюємо над HidForge Orchestrator, локальним веб-UI для оркестрації AI-агентів програмування. До повідомлення прикріплено:
- `HidForge_Style_Master_Prompt.md` — обов'язковий стиль;
- `docs/DESIGN_SYSTEM.md` — токени й компоненти;
- `web/ui.js`, `web/styles/*.css`, `web/app.js` — поточний код.

## Стек і жорсткі правила
- **Стек:** тільки vanilla JS (ES-модулі) і CSS. Без збірки, React, Tailwind і нових залежностей.
- **Компоненти:** сторінки збирай з компонентів `web/ui.js`: `PageHeader`, `PanelCard`, `StatCard`, `StatLink`, `InfoList`, `Table`, `Tabs`, `Segmented`, `ItemCard`, `EmptyState`, `Badge`, `StatusBadge`, `Chip`, кнопки `Button`, `Field`, `TextInput`, `Textarea`, `Select`, `SearchInput`, `Toggle`, `openModal`, `confirmModal`, `promptModal`, `toast` тощо.
- **Новий візуальний елемент** оформлюй компонентом у `ui.js` зі стилями в `ui.css`, лише на CSS-змінних з `tokens.css`. Сирих кольорів не має бути.
- **Безпека:** ніякого `innerHTML`, `insertAdjacentHTML` чи `outerHTML`. Текст виводь тільки через `h()` / `textContent`. JSON і логи показуй як текст у `<pre>`.
- **Мова:** усі тексти UI українською. Ідентифікатори коду англійською.
- **Хелпери з `app.js`:** `api()`, `act()`, `mount()`, `clean()`, `go()`, `toast()`, `usd()`, `loadProjects()`, `selectProject()`, `reloadProject()`, `render()`, `renderShell()`, `addProjectModal()`, `STATUS_LABEL`, `state`.
- **Маршрутизація:**
  - hash-роутер `#/<page>`;
  - сторінки описані в масиві `PAGES`, а `render()` викликає `<page>Page()`;
  - сторінки, яким потрібен проєкт, перелічені в `needsProject`.
- **Живі оновлення:** SSE-потік (`connectStream()`) після кожної події через 150 мс викликає `reloadProject().then(render)`. Сторінка не повинна блимати «завантаженням» при кожному такому re-render. Тримай кеш у `state` і показуй його одразу, як уже зроблено в `reportsPage()` (`state.reportsData`).
- **Адаптивність:** на ширині 375 px сторінка не має горизонтальної прокрутки.
- **Нічого не зламати:** наявні сторінки й `state.activity` (події `task.status` для огляду) мають працювати як раніше.
- **Бекенд не змінюється.** Використовуй лише API, описане нижче. Якщо без нового ендпоінта не обійтися, не вигадуй його: опиши потребу в кінці відповіді.

## Задача
Додай дві сторінки. Порядок навігації в `PAGES`:
1. **Проєкти** (`projects`) — перший пункт;
2. далі Огляд, Задачі, AI-планер, Агенти;
3. **Журнал подій** (`activity`) — після Агентів;
4. далі Витрати, Звіти й рішення, Система, Налаштування.

Іконки підбери з `ICONS` у `ui.js` або додай нові stroke-іконки 24×24.

### 1. «Проєкти» — `#/projects` (проєкт НЕ потрібен)
- **Дані:** `GET /api/projects` повертає масив `{ id, name, repoPath, baseBranch, goal, budgetUsd, createdAt, allowedCommands, reviewPolicy }`.
- **Лічильники задач:** `GET /api/projects/:id` повертає `{ project, tasks: [{ id, status, … }] }`. Можна паралельно запитати всі проєкти (їх зазвичай до 20) і показати лічильники за статусами: активні / потребують уваги / злито / проблеми. Групи статусів дивись у `ACTIVE`, `ATTENTION`, `PROBLEM`. Результат кешуй у `state`.
- **Шапка:** `PageHeader` з кнопками «Відкрити проєкт» (наявний `addProjectModal()`) і «Створити демо-проєкт» (`POST /api/demo`, потім `loadProjects()` і `selectProject(id)`).
- **Картка проєкту** (`ItemCard` або `PanelCard`):
  - назва, шлях до репозиторію (моноширинним шрифтом, з переносом довгого рядка), базова гілка, ціль, бюджет («без ліміту», якщо `null`), дата створення;
  - бейдж «Активний» на поточному (`state.projectId`);
  - кнопка «Відкрити»: `selectProject(id)`, потім `go('#/overview')`;
  - дія «Змінити ціль»: `promptModal`, далі `PATCH /api/projects/:id { goal }`, після цього `loadProjects()`, а для активного проєкту ще й `reloadProject()`.
- **Пошук:** `SearchInput` за назвою або шляхом.
- **Порожній стан:** `EmptyState` з тими самими двома діями.
- **Видалення проєкту:** ендпоінта немає. Кнопку не додавай.

### 2. «Журнал подій» — `#/activity` (потрібен проєкт)
- **Дані:**
  - `GET /api/events?projectId=<id>&before=<eventId>&limit=200` повертає найновіші 200 подій з id меншим за `before`, впорядковані від старіших до новіших;
  - без `before` API віддає найстаріші, тому для першої сторінки передай `before=9007199254740991`;
  - формат події: `{ id, projectId, taskId, runId, type, data, ts }`.
- **Типи подій:** `project.created`, `task.created`, `task.deleted`, `task.status`, `task.routed`, `task.evidence`, `run.started`, `run.output`, `run.recovered`, `review.started`, `review.status`, `review.output`, `plan.started`, `plan.status`, `plan.output`, `integration.failed`, `scheduler.error`.
- **Відображення:**
  - стрічка від новіших до старіших;
  - у кожному рядку: час (локальний), бейдж типу з тоном (помилки й `failed` — `danger`, `succeeded`/`merged` — `success`, вивід агентів — `neutral`), посилання `#/tasks/<taskId>` (якщо є) і коротке людське резюме з `data`;
  - для `task.status` резюме таке: «статус → <STATUS_LABEL>» з причиною;
  - для `run.started` — провайдер і спроба;
  - для `*.output` — перші ~160 символів `data.text`;
  - повні `data` показуй у згортанні (`<details>` + `<pre>` з `JSON.stringify(data, null, 2)`).
- **Фільтри** (у `state`, щоб переживали re-render):
  - `Select` типу події: «Усі», потім групи «Задачі», «Запуски», «Рецензії», «Планер», «Помилки»;
  - `TextInput` номера задачі;
  - `Toggle` «Показувати вивід агентів» — вимкнено за замовчуванням, бо `*.output` — найшумніші події.
  - Фільтруй на клієнті по вже завантажених подіях.
- **Підвантаження:** кнопка «Завантажити старіші» робить `before = найменший id із завантажених`. Коли прийшло менше 200 подій, кнопку сховай.
- **Живі події:**
  - у `connectStream()` додай: якщо `state.page === 'activity'`, нова подія потрапляє на початок стрічки в кеші;
  - для `*.output` перемальовуй лише стрічку (без `reloadProject`), а лічильник «нових» показуй, поки користувач прокрутив униз;
  - кеш обмеж до 2000 подій.
- **Кнопки в `PageHeader`:** «Оновити» (перезавантажити першу сторінку) і «Завантажити .json» (поточна відфільтрована стрічка, Blob + `a.download`).
- **Порожній стан:** `EmptyState`.

## Формат відповіді
Цілий `app.js` не повертай: він великий, а відповідь може обрізатися. Поверни unified diff (`git diff`) для `web/app.js`, `web/ui.js` і `web/styles/ui.css`. Якщо diff не вийде, поверни блоки змін, кожен окремим code block, із заголовком однієї з форм:
- `REPLACE function <name>`;
- `ADD after function <name>`;
- `REPLACE const PAGES`;
- `REPLACE in render(): <рядок>`;
- `ui.js: ADD …`;
- `ui.css: ADD …`.

У кінці додай:
1. стислий розбір кожної сторінки: мета, дії, блоки;
2. список використаних і нових компонентів;
3. ручний чек-лист перевірки: що клікнути, щоб переконатися, що все працює і нічого не загубилось;
4. потреби в бекенді, якщо вони є.
