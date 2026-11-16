// HidForge shared UI components (vanilla ES module, no build step).
// Every page is composed from these; untrusted text always goes through textContent (never innerHTML).

/** Element factory: h('div', { class, onclick, ... }, ...children). Children: Node | string | number | null | arrays. */
export function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'value') el.value = v;
    else if (k === 'checked') el.checked = !!v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat(Infinity)) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}
const cx = (...c) => c.filter(Boolean).join(' ');

// ---------------------------------------------------------------- icons (original, 24×24 stroke)
const ICONS = {
  overview: 'M4 4h6v7H4zM14 4h6v4h-6zM14 12h6v8h-6zM4 15h6v5H4z',
  tasks: 'M9 6h11M9 12h11M9 18h11M4 6l1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2',
  planner: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 16l.7 1.8 1.8.7-1.8.7L19 21l-.7-1.8-1.8-.7 1.8-.7z',
  agents: 'M7 7h10v10H7zM10 10h4v4h-4zM10 3v4M14 3v4M10 17v4M14 17v4M3 10h4M3 14h4M17 10h4M17 14h4',
  settings: 'M4 7h9M17 7h3M4 17h3M11 17h9M15 5v4M9 15v4',
  plus: 'M12 5v14M5 12h14',
  refresh: 'M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7',
  close: 'M6 6l12 12M18 6L6 18',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-4-4',
  play: 'M8 5l11 7-11 7z',
  stop: 'M7 7h10v10H7z',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  check: 'M5 12l5 5 9-10',
  alert: 'M12 4l9 16H3zM12 10v4M12 17h.01',
  folder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  branch: 'M6 4v12M6 20a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM18 8a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM18 8c0 5-6 4-12 8',
  menu: 'M4 7h16M4 12h16M4 17h16',
  merge: 'M7 4v16M7 8c0 5 10 3 10 9M17 20a2 2 0 1 0 0-4 2 2 0 0 0 0 4z',
  edit: 'M4 20h4L19 9l-4-4L4 16zM13 7l4 4',
  trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
  retry: 'M4 12a8 8 0 0 1 14-5.3M20 12a8 8 0 0 1-14 5.3M18 3v4h-4M6 21v-4h4',
  activity: 'M3 12h4l3-8 4 16 3-8h4',
  report: 'M6 3h9l4 4v14H6zM14 3v5h5M9 12h7M9 16h7',
  costs: 'M3 7h18v13H3zM3 7V5a2 2 0 0 1 2-2h13M16 12h5v5h-5a2.5 2.5 0 0 1 0-5z',
  system: 'M4 5h16v6H4zM4 14h16v6H4zM7 8h.01M7 17h.01M11 8h6M11 17h6',
  terminal: 'M4 5h16v14H4zM8 10l3 2-3 2M13 15h4',
};
export function icon(name, cls = '') {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', cx('icon', cls));
  svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(NS, 'path');
  p.setAttribute('d', ICONS[name] || ICONS.more);
  svg.append(p);
  return svg;
}
/** Product mark: original "DAG node" glyph on a mint tile. */
export function logo() {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 34 34'); svg.setAttribute('class', 'logo'); svg.setAttribute('aria-hidden', 'true');
  const add = (tag, a) => { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(a)) e.setAttribute(k, v); svg.append(e); };
  add('rect', { x: 1, y: 1, width: 32, height: 32, rx: 10, fill: 'var(--accent-soft)', stroke: 'var(--border-strong)' });
  add('path', { d: 'M11 11L23 17M11 23L23 17M11 11v12', stroke: 'var(--accent)', 'stroke-width': 2, fill: 'none', 'stroke-linecap': 'round' });
  for (const [x, y] of [[11, 11], [11, 23], [23, 17]]) add('circle', { cx: x, cy: y, r: 3.2, fill: 'var(--accent)' });
  return svg;
}

// ---------------------------------------------------------------- buttons
/** Button({ variant: 'primary'|'secondary'|'ghost'|'danger', size: 'sm', icon, onClick, ... }, label) */
export function Button(o = {}, ...label) {
  const { variant = 'primary', size, icon: ic, onClick, class: c, type = 'button', ...rest } = o;
  return h('button', { type, class: cx('btn', variant, size, c), onclick: onClick, ...rest }, ic ? icon(ic) : null, ...label);
}
export const PrimaryButton = (o, ...l) => Button({ ...o, variant: 'primary' }, ...l);
export const SecondaryButton = (o, ...l) => Button({ ...o, variant: 'secondary' }, ...l);
export const GhostButton = (o, ...l) => Button({ ...o, variant: 'ghost' }, ...l);
export const DangerButton = (o, ...l) => Button({ ...o, variant: 'danger' }, ...l);
/** IconButton({ icon, label (required, for a11y), variant='ghost', size }) */
export function IconButton(o) {
  const { icon: ic, label, variant = 'ghost', ...rest } = o;
  return Button({ ...rest, variant, class: cx('icon-only', rest.class), 'aria-label': label, title: label, icon: ic });
}

// ---------------------------------------------------------------- badges
/** tone: success | accent | warning | danger | info | neutral */
export const Badge = (text, tone = 'neutral', o = {}) => h('span', { class: cx('badge', `tone-${tone}`, o.live && 'live', o.plain && 'plain'), title: o.title }, text);
const STATUS = {
  draft: ['чернетка', 'neutral'], ready: ['чекає залежностей', 'neutral'], queued: ['у черзі', 'info'], running: ['виконується', 'info'],
  review: ['рев\'ю', 'warning'], accepted: ['прийнято', 'success'], merged: ['злито', 'success'], blocked: ['заблоковано', 'danger'],
  failed: ['помилка', 'danger'], canceled: ['скасовано', 'neutral'], needs_user_input: ['потрібна відповідь', 'warning'],
};
export const STATUS_LABEL = Object.fromEntries(Object.entries(STATUS).map(([k, [l]]) => [k, l]));
export const statusTone = (s) => STATUS[s]?.[1] ?? 'neutral';
/** StatusBadge(status) — one vocabulary for task statuses across all pages. */
export const StatusBadge = (s) => Badge(STATUS_LABEL[s] || s, statusTone(s), { live: s === 'running', title: s });
export const Chip = (text, o = {}) => h('span', { class: cx('chip', o.off && 'off'), title: o.title }, text);
export const PermissionChip = (name, value) => Chip(value === 'supported' ? name : `${name}: ${value}`, { off: value !== 'supported', title: value });

// ---------------------------------------------------------------- layout blocks
export function PageHeader({ title, subtitle, meta, actions }) {
  return h('header', { class: 'page-header' },
    h('div', { class: 'wrap' }, h('h1', {}, title), subtitle ? h('div', { class: 'sub' }, subtitle) : null, meta ? h('div', { class: 'meta row' }, meta) : null),
    actions ? h('div', { class: 'row' }, actions) : null);
}
export function SectionHeader({ title, count, actions }) {
  return h('div', { class: 'section-header' },
    h('h2', {}, title, count != null ? Badge(String(count), 'neutral', { plain: true }) : null),
    actions ? h('div', { class: 'row' }, actions) : null);
}
/** PanelCard({ title, subtitle, actions, flush, class, id }, ...children) */
export function PanelCard(o = {}, ...kids) {
  const head = o.title || o.actions ? h('div', { class: 'panel-head' },
    h('div', {}, o.title ? h('h3', {}, o.title) : null, o.subtitle ? h('div', { class: 'sub' }, o.subtitle) : null),
    o.actions ? h('div', { class: 'row' }, o.actions) : null) : null;
  return h('section', { class: cx('panel', o.flush && 'flush', o.class), id: o.id }, head, ...kids);
}
/** StatCard({ label, value, hint, tone: accent|info|warning|danger|success }) */
export const StatCard = ({ label, value, hint, tone }) => h('div', { class: cx('stat', tone && `t-${tone}`) },
  h('span', { class: 'label' }, label), h('span', { class: 'value' }, value), hint ? h('span', { class: 'hint' }, hint) : null);
/** StatLink — semantic, keyboard-accessible link wrapping a stat card. */
export const StatLink = ({ href, label, value, hint, tone }) => h('a',
  { class: 'stat-link', href, 'aria-label': `${label}: ${value}. Переглянути деталі` },
  StatCard({ label, value, hint, tone }));
/** InfoList([[label, value], ...]) — InfoRow pairs rendered as a <dl>. */
export const InfoList = (rows) => h('dl', { class: 'info' }, ...rows.filter(Boolean).flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v ?? '—')]));
/** ItemCard({ icon, title, subtitle, status, off, body, footer }) — entity card (agent, device, item). */
export function ItemCard(o) {
  return h('article', { class: 'item' },
    h('div', { class: 'item-head' }, o.icon ? h('div', { class: cx('ic', o.off && 'off') }, icon(o.icon)) : null,
      h('div', { class: 't' }, h('strong', { class: 'wrap' }, o.title), o.subtitle ? h('span', { class: 'wrap' }, o.subtitle) : null), o.status || null),
    o.body || null, o.footer ? h('div', { class: 'row' }, o.footer) : null);
}
/** EmptyState({ icon, title, text, action }) */
export const EmptyState = (o) => h('div', { class: 'empty' }, h('div', { class: 'ic' }, icon(o.icon || 'folder')),
  h('strong', {}, o.title), o.text ? h('p', {}, o.text) : null, o.action || null);
/** ActivityFeed([{ ts, content }]) */
export const ActivityFeed = (items, empty = 'Подій ще немає') => items.length
  ? h('ul', { class: 'feed' }, ...items.map((i) => h('li', {}, h('time', { datetime: i.ts }, i.ts.slice(11, 19)), h('div', { class: 'wrap' }, i.content))))
  : h('p', { class: 'muted' }, empty);

// ---------------------------------------------------------------- form controls
/** Field(label, control, hint) — label + control + hint (FormSection building block). */
export const Field = (label, control, hint, o = {}) => h('label', { class: cx('field', o.full && 'full') }, h('span', { class: 'label' }, label), control, hint ? h('span', { class: 'hint' }, hint) : null);
export const TextInput = (attrs = {}) => h('input', { ...attrs, class: cx('input', attrs.class) });
export function Textarea(value = '', attrs = {}) { const el = h('textarea', { ...attrs, class: cx('textarea', attrs.class) }); el.value = value ?? ''; return el; }
/** Select([[value, label], ...] | ['a','b'], value, attrs) */
export function Select(options, value, attrs = {}) {
  const el = h('select', { ...attrs, class: cx('select', attrs.class) }, ...options.map((o) => (Array.isArray(o) ? h('option', { value: o[0] }, o[1]) : h('option', { value: o }, o))));
  if (value != null) el.value = String(value);
  return el;
}
export function SearchInput(o = {}) {
  const input = h('input', { type: 'search', class: 'input', placeholder: o.placeholder || 'Пошук…', 'aria-label': o.placeholder || 'Пошук', value: o.value || '', oninput: o.onInput });
  return h('div', { class: 'search' }, icon('search'), input);
}
export const Toggle = ({ label, checked, onChange }) => h('label', { class: 'toggle' },
  h('input', { type: 'checkbox', role: 'switch', checked, onchange: (e) => onChange?.(e.target.checked) }), label);

// ---------------------------------------------------------------- Tabs
/** Tabs([{ id, label, count, content }], activeId, onChange?) — content panels stay mounted (live logs keep streaming). */
export function Tabs(items, active, onChange) {
  const bar = h('div', { class: 'tabs', role: 'tablist' });
  const panels = [];
  const select = (id) => {
    for (const b of bar.children) b.setAttribute('aria-selected', String(b.dataset.id === id));
    for (const p of panels) p.hidden = p.dataset.id !== id;
    onChange?.(id);
  };
  for (const it of items) {
    bar.append(h('button', { type: 'button', role: 'tab', 'data-id': it.id, onclick: () => select(it.id),
      onkeydown: (e) => { if (!['ArrowLeft', 'ArrowRight'].includes(e.key)) return; const i = items.indexOf(it) + (e.key === 'ArrowRight' ? 1 : -1); const n = items[(i + items.length) % items.length]; select(n.id); bar.querySelector(`[data-id="${n.id}"]`).focus(); } },
    it.label, it.count != null ? h('span', { class: 'count' }, it.count) : null));
    panels.push(h('div', { role: 'tabpanel', 'data-id': it.id, class: 'stack' }, it.content));
  }
  const root = h('div', { class: 'stack' }, bar, ...panels);
  select(active ?? items[0]?.id);
  return root;
}

/** Segmented([{ id, label, count }], activeId, onChange) — filter switch with the Tabs look. */
export function Segmented(items, active, onChange) {
  return h('div', { class: 'tabs', role: 'group' }, ...items.map((it) => h('button', {
    type: 'button', 'aria-pressed': String(it.id === active), 'aria-selected': String(it.id === active), onclick: () => onChange(it.id),
  }, it.label, it.count != null ? h('span', { class: 'count' }, it.count) : null)));
}

// ---------------------------------------------------------------- Table
/** Table({ columns: [{ label, render(row), class }], rows, onRowClick, selected(row), empty }) — collapses to cards ≤720px. */
export function Table({ columns, rows, onRowClick, selected, empty }) {
  if (!rows.length) return empty || EmptyState({ icon: 'tasks', title: 'Порожньо' });
  return h('div', { class: 'table-wrap' }, h('table', { class: 'table responsive' },
    h('thead', {}, h('tr', {}, ...columns.map((c) => h('th', { class: c.class }, c.label)))),
    h('tbody', {}, ...rows.map((r) => h('tr', {
      class: onRowClick ? 'clickable' : '', 'aria-selected': selected?.(r) ? 'true' : null,
      tabindex: onRowClick ? 0 : null, onclick: onRowClick ? () => onRowClick(r) : null,
      onkeydown: onRowClick ? (e) => { if (e.key === 'Enter') onRowClick(r); } : null,
    }, ...columns.map((c) => h('td', { 'data-label': c.label, class: c.class }, c.render(r))))))));
}

// ---------------------------------------------------------------- Modal (native <dialog>: focus trap + Esc for free)
/** openModal({ title, body, actions: (close) => [buttons] }) → close() */
export function openModal({ title, body, actions }) {
  const dlg = h('dialog', { class: 'modal', 'aria-label': title });
  const close = () => { dlg.close(); dlg.remove(); };
  dlg.addEventListener('cancel', (e) => { e.preventDefault(); close(); });
  dlg.append(
    h('div', { class: 'modal-head' }, h('h2', {}, title), IconButton({ icon: 'close', label: 'Закрити', size: 'sm', onClick: close })),
    h('div', { class: 'modal-body' }, body),
    actions ? h('div', { class: 'modal-foot' }, actions(close)) : null);
  document.body.append(dlg);
  dlg.showModal();
  return close;
}
/** confirmModal(text, { title, danger, ok }) → Promise<boolean> */
export function confirmModal(text, o = {}) {
  return new Promise((resolve) => {
    const close = openModal({ title: o.title || 'Підтвердження', body: h('p', { style: 'margin:0' }, text),
      actions: (c) => [GhostButton({ onClick: () => { c(); resolve(false); } }, 'Скасувати'),
        Button({ variant: o.danger ? 'danger' : 'primary', onClick: () => { c(); resolve(true); } }, o.ok || 'Так')] });
    void close;
  });
}
/** promptModal(label, { title, ok, placeholder }) → Promise<string|null> */
export function promptModal(label, o = {}) {
  return new Promise((resolve) => {
    const ta = Textarea('', { class: 'prose', placeholder: o.placeholder || '' });
    openModal({ title: o.title || label, body: Field(label, ta),
      actions: (c) => [GhostButton({ onClick: () => { c(); resolve(null); } }, 'Скасувати'),
        PrimaryButton({ onClick: () => { c(); resolve(ta.value); } }, o.ok || 'Надіслати')] });
    ta.focus();
  });
}

// ---------------------------------------------------------------- DropdownMenu (<details>: keyboard-accessible)
/** DropdownMenu({ label, icon='more' }, [{ label, icon, onClick, danger } | null]) */
export function DropdownMenu(o, items) {
  const d = h('details', { class: 'dropdown' });
  const sum = h('summary', { class: 'btn ghost sm icon-only', 'aria-label': o.label, title: o.label }, icon(o.icon || 'more'));
  const menu = h('div', { class: 'menu', role: 'menu' }, ...items.filter(Boolean).map((it) => h('button', {
    type: 'button', role: 'menuitem', class: it.danger ? 'danger' : '', onclick: () => { d.open = false; it.onClick(); },
  }, it.icon ? icon(it.icon) : null, it.label)));
  d.append(sum, menu);
  d.addEventListener('keydown', (e) => { if (e.key === 'Escape') { d.open = false; sum.focus(); } });
  return d;
}
document.addEventListener('click', (e) => { for (const d of document.querySelectorAll('details.dropdown[open]')) if (!d.contains(e.target)) d.open = false; });

// ---------------------------------------------------------------- Toast
/** toast(message, tone: 'info'|'success'|'danger') */
export function toast(msg, tone = 'info') {
  let box = document.querySelector('.toasts');
  if (!box) { box = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' }); document.body.append(box); }
  const t = h('div', { class: cx('toast', `t-${tone}`) }, icon(tone === 'danger' ? 'alert' : tone === 'success' ? 'check' : 'activity'), h('div', {}, msg));
  box.append(t);
  setTimeout(() => t.remove(), tone === 'danger' ? 8000 : 4500);
}

// ---------------------------------------------------------------- Kanban
/** Kanban({ columns: [{ id, title, items }], card: (item) => Node, empty }) — status board; columns scroll horizontally on small screens. */
export function Kanban({ columns, card, empty = 'Порожньо' }) {
  return h('div', { class: 'kanban', role: 'list' }, ...columns.map((c) => h('section', { class: 'kcol', role: 'listitem', 'aria-label': c.title },
    h('div', { class: 'kcol-head' }, h('span', {}, c.title), Badge(String(c.items.length), 'neutral', { plain: true })),
    c.items.length ? h('div', { class: 'kcol-body' }, ...c.items.map(card)) : h('p', { class: 'muted kcol-empty' }, empty))));
}

// ---------------------------------------------------------------- DagGraph (inline SVG, no library)
/**
 * DagGraph({ nodes: [{ id, label, sub, tone }], edges: [[from, to]], onNode, selected })
 * Layered layout: column = longest dependency chain to the node; edges are curves from dependency to dependent.
 */
export function DagGraph({ nodes, edges, onNode, selected }) {
  const NS = 'http://www.w3.org/2000/svg';
  const W = 210, H = 58, GX = 70, GY = 18, PAD = 16;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const deps = new Map(nodes.map((n) => [n.id, edges.filter(([, to]) => to === n.id).map(([f]) => f).filter((f) => byId.has(f))]));
  const level = new Map();
  const lv = (id, seen = new Set()) => {
    if (level.has(id)) return level.get(id);
    if (seen.has(id)) return 0; // defensive: cycles are rejected by the server
    seen.add(id);
    const v = Math.max(-1, ...deps.get(id).map((d) => lv(d, seen))) + 1;
    level.set(id, v); return v;
  };
  nodes.forEach((n) => lv(n.id));
  const cols = [];
  for (const n of nodes) (cols[level.get(n.id)] ??= []).push(n);
  const pos = new Map();
  cols.forEach((col, x) => col.forEach((n, y) => pos.set(n.id, { x: PAD + x * (W + GX), y: PAD + y * (H + GY) })));
  const width = PAD * 2 + cols.length * W + Math.max(0, cols.length - 1) * GX;
  const height = PAD * 2 + Math.max(1, ...cols.map((c) => c.length)) * (H + GY) - GY;
  const el = (tag, attrs = {}, ...kids) => { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) if (v != null) e.setAttribute(k, v); e.append(...kids); return e; };
  const svg = el('svg', { class: 'dag', viewBox: `0 0 ${width} ${height}`, width, height, role: 'img', 'aria-label': `Граф залежностей: ${nodes.length} задач` });
  svg.append(el('defs', {}, el('marker', { id: 'dag-arrow', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' }, el('path', { d: 'M0 0L10 5L0 10z', class: 'dag-arrowhead' }))));
  for (const [f, t] of edges) {
    const a = pos.get(f), b = pos.get(t);
    if (!a || !b) continue;
    const x1 = a.x + W, y1 = a.y + H / 2, x2 = b.x, y2 = b.y + H / 2, mx = (x1 + x2) / 2;
    svg.append(el('path', { d: `M${x1} ${y1}C${mx} ${y1} ${mx} ${y2} ${x2 - 2} ${y2}`, class: 'dag-edge', 'marker-end': 'url(#dag-arrow)' }));
  }
  for (const n of nodes) {
    const p = pos.get(n.id);
    const g = el('g', { class: cx('dag-node', `t-${n.tone || 'neutral'}`, selected === n.id && 'sel'), transform: `translate(${p.x} ${p.y})`, tabindex: 0, role: 'button', 'aria-label': `${n.label}${n.sub ? ', ' + n.sub : ''}` });
    const cut = (s, k) => (s.length > k ? s.slice(0, k - 1) + '…' : s);
    g.append(el('title', {}, n.label), el('rect', { width: W, height: H, rx: 12 }),
      el('text', { x: 12, y: 23, class: 'dag-label' }, cut(n.label, 26)), el('text', { x: 12, y: 43, class: 'dag-sub' }, cut(n.sub || '', 30)));
    if (onNode) { g.addEventListener('click', () => onNode(n)); g.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onNode(n); } }); }
    svg.append(g);
  }
  return h('div', { class: 'dag-wrap' }, svg);
}
