# Дизайн-система HidForge UI

Єдине джерело правди для вигляду всіх сторінок. Стиль — оригінальний, у дусі «операторської консолі»: темний інтерфейс із ледь зеленим відтінком, м'ятний акцент, заокруглені панелі, ліва навігація, щільні, але читабельні дашборди. Чужих ассетів, іконок чи текстів не використано: логотип та іконки намальовано тут.

Стек: **vanilla JS (ES-модулі) + CSS-змінні**, без збірки — так само, як решта проєкту. React/Tailwind свідомо не додано: проєкт уже має стек, і дизайн-система адаптована до нього.

## Файли
| Файл | Що всередині |
|---|---|
| `web/styles/tokens.css` | Токени: кольори, радіуси, відступи, типографіка, тіні. Темна тема — за замовчуванням, світла — варіант `[data-theme="light"]` |
| `web/styles/ui.css` | База, AppShell, усі компоненти, адаптивність |
| `web/ui.js` | Компоненти як функції, що повертають DOM-вузли |
| `web/index.html` | Каркас AppShell |
| `web/app.js` | Роутер (`#/projects`, `#/overview`, `#/tasks[/id]`, `#/planner`, `#/agents`, `#/activity`, `#/costs`, `#/reports`, `#/system`, `#/settings`) і сторінки, зібрані з компонентів |
| `web/theme.js` | Тема до першого рендеру (без «спалаху») |

## Токени (темна тема)
| Токен | Значення | Призначення |
|---|---|---|
| `--bg-app` | `#0B0F0D` | фон застосунку |
| `--bg-sidebar` | `#0D120F` | бічна панель |
| `--bg-panel` / `--bg-panel-alt` | `#111713` / `#151C17` | картки / вкладені поверхні |
| `--border` / `--border-strong` | `rgba(120,160,130,.18)` / `rgba(120,200,150,.28)` | тонкі межі / активні межі |
| `--text` / `--text-2` / `--text-muted` | `#F2F5F2` / `#A8B3AB` / `#7D867F` | текст за ієрархією |
| `--accent` / `--accent-hover` / `--accent-soft` | `#47E0A1` / `#3BD392` / `rgba(71,224,161,.14)` | головний акцент |
| `--success` `--warning` `--danger` `--info` | `#33D17A` `#F5C86A` `#FF6B6B` `#7DD3FC` | статуси (+ `*-soft` фони) |
| `--r-sm/md/lg/xl` | 10 / 14 / 18 / 24 px | радіуси |
| `--s-1…--s-6` | 4 / 8 / 12 / 16 / 24 / 32 px | шкала відступів |
| `--font` / `--mono` | Inter → Manrope → Segoe UI / Cascadia Code → Consolas | шрифти (системні, без завантаження ззовні) |
| `--tracking-id` | `0.08em` | широкий трекінг для ID і чисел |

Правило: у компонентах і сторінках — лише змінні з `tokens.css`, жодних «сирих» кольорів.

## Компоненти (`web/ui.js`)
| Компонент | Використання |
|---|---|
| AppShell, Sidebar, TopBar | розмітка в `index.html`; бічна панель — логотип, перемикач проєкту, навігація, стан (агенти, паралельність) |
| `PageHeader({title, subtitle, meta, actions})` | заголовок сторінки: назва → підзаголовок → мета → дії |
| `SectionHeader({title, count, actions})` | заголовок секції |
| `PanelCard({title, subtitle, actions, flush}, ...children)` | основна панель; `flush` — для таблиць |
| `StatCard({label, value, hint, tone})` | великі числа на дашборді |
| `StatLink({href, ...StatCard})` | StatCard як посилання на сторінку з деталями (напр. «Витрати» на огляді) |
| `InfoList([[label, value]])` | пари InfoRow як `<dl>` |
| `Badge(text, tone)`, `StatusBadge(status)`, `Chip`, `PermissionChip` | статуси; єдиний словник статусів задач — `STATUS_LABEL` |
| `Button({variant})`, `PrimaryButton`, `SecondaryButton`, `GhostButton`, `DangerButton`, `IconButton({icon, label})` | мова кнопок: одна primary-дія на блок, secondary — обведена, danger — м'яка червона |
| `TextInput`, `Textarea`, `Select`, `SearchInput`, `Toggle`, `Field(label, control, hint)` | форми; `.form-grid` — двоколонкова сітка форми |
| `Tabs(items, active, onChange)` | вкладки; панелі лишаються змонтованими (живий журнал не губиться), ←/→ з клавіатури |
| `Segmented(items, active, onChange)` | фільтр-перемикач у стилі вкладок |
| `Table({columns, rows, onRowClick, selected, empty})` | таблиця; ≤720px перетворюється на список карток (`data-label`) |
| `EmptyState({icon, title, text, action})` | порожні стани з дією |
| `ItemCard({icon, title, subtitle, status, body, footer, class})` | картка сутності (агент, проєкт, елемент) |
| `EventCard({id, ts, time, label, rawType, tone, task, summary, data})` | рядок журналу подій; повний JSON у `<details>` створюється лише при відкритті |
| `Kanban({columns, card, empty})` | дошка за статусами; колонки прокручуються горизонтально на вузьких екранах |
| `DagGraph({nodes, edges, onNode, selected})` | inline-SVG граф залежностей: колонка = довжина ланцюжка залежностей, рамка вузла — тон статусу, Enter/пробіл відкриває вузол |
| `ActivityFeed(items)` | стрічка подій |
| `openModal`, `confirmModal`, `promptModal` | модальні вікна на нативному `<dialog>` (фокус, Esc); `promptModal(label, {value})` — з початковим текстом |
| `DropdownMenu({label}, items)` | меню на `<details>` |
| `toast(msg, tone)` | сповіщення (`aria-live`) |
| `icon(name)`, `logo()` | власні stroke-іконки 24×24 і знак продукту |

## Адаптивність
- **≥1800px (широкий десктоп):** ширша бічна панель.
- **≤1280px (ноутбук):** деталі задачі переходять під таблицю.
- **≤1024px (планшет):** бічна панель стає висувною (кнопка «Меню», затемнення фону).
- **≤720px (мобільний):** сітки в одну колонку, таблиці — картками, кнопки ≥42px.
- Жодної горизонтальної прокрутки сторінки: треки grid мають `minmax(0, 1fr)`.

## Доступність
- Видимий фокус (`--focus`).
- Семантичні `nav`, `main`, `dialog`, `role=tablist/tab/tabpanel`, `aria-current`, `aria-selected`.
- Рядки таблиці доступні з клавіатури (Tab + Enter).
- `prefers-reduced-motion` вимикає анімації.
- Увесь недовірений текст виводиться через `textContent`.

## Як додати нову сторінку
1. Додайте запис у `PAGES` (`web/app.js`) з `id`, підписом та іконкою.
2. Напишіть функцію `xxxPage()`: `mount(PageHeader(...), PanelCard(...), ...)`, лише з компонентів `ui.js`.
3. Новий візуальний елемент спершу робіть компонентом у `ui.js` / `ui.css` на токенах, а не одноразовим стилем сторінки.
