// HidForge UI — pages composed from shared components in ui.js. Hash routing, no build step.
import {
  h, icon, logo, Button, PrimaryButton, SecondaryButton, GhostButton, DangerButton, IconButton, Badge, StatusBadge, STATUS_LABEL,
  PermissionChip, PageHeader, SectionHeader, PanelCard, StatCard, InfoList, ItemCard, EmptyState, ActivityFeed, Field, TextInput,
  Textarea, Select, SearchInput, Toggle, Tabs, Segmented, Table, openModal, confirmModal, promptModal, DropdownMenu, toast,
  Kanban, DagGraph, statusTone,
} from './ui.js';

const TOKEN = document.querySelector('meta[name="hidforge-token"]').content;
const $ = (s) => document.querySelector(s);
const ls = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* blocked */ } } };
const state = {
  projects: [], agents: null, settings: null, projectId: null, project: null, tasks: [], plans: [], activity: [],
  page: 'overview', taskId: null, editing: null, filter: ls.get('hf-filter') || 'all', view: ls.get('hf-view') || 'table', query: '', showCanceled: false,
  detailTab: 'log', es: null, live: false, costs: null, models: {},
};
const ROLES = ['Project Manager/Planner', 'Architect', 'Frontend', 'Backend', 'QA', 'Security Reviewer', 'Integrator'];
const PAGES = [
  { id: 'overview', label: 'Огляд', icon: 'overview' },
  { id: 'tasks', label: 'Задачі', icon: 'tasks' },
  { id: 'planner', label: 'AI-планер', icon: 'planner' },
  { id: 'agents', label: 'Агенти', icon: 'agents' },
  { id: 'settings', label: 'Налаштування', icon: 'settings' },
];
const ACTIVE = ['queued', 'running', 'ready'];
const ATTENTION = ['review', 'needs_user_input'];
const PROBLEM = ['failed', 'blocked'];

async function api(method, path, body) {
  const res = await fetch(path, {
    method, headers: { 'content-type': 'application/json', 'x-hidforge-token': TOKEN },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}
const act = (fn) => async (...a) => { try { await fn(...a); } catch (e) { toast(e.message, 'danger'); } };
const go = (hash) => { if (location.hash === hash) render(); else location.hash = hash; };
const agentState = (a) => (!a.installed ? ['не встановлено', 'danger'] : a.auth === 'missing' ? ['немає авторизації', 'danger']
  : a.auth === 'unknown' ? ['авторизація невідома', 'warning'] : ['готовий', 'success']);
const providerLabel = (t) => (t.provider === 'mock' ? h('span', { class: 'mockflag' }, 'MOCK') : t.provider);
const REVIEW_VERDICT = { approve: ['схвалено', 'success'], request_changes: ['потрібні зміни', 'warning'], reject: ['відхилено', 'danger'] };
const REVIEW_STATUS = { running: ['рецензує…', 'info'], failed: ['збій рецензії', 'danger'], canceled: ['рецензію зупинено', 'neutral'] };
const SEVERITY = { critical: ['критично', 'danger'], major: ['важливо', 'warning'], minor: ['дрібниця', 'info'], info: ['примітка', 'neutral'] };
const reviewBadge = (rv) => { const [l, tone] = (rv.status === 'succeeded' ? REVIEW_VERDICT[rv.verdict] : REVIEW_STATUS[rv.status]) ?? [rv.status, 'neutral']; return Badge(l, tone, { live: rv.status === 'running' }); };
/** Mirrors Reviewer.mergeBlocker on the server (required mode). */
function reviewBlocker(t) {
  if (state.project?.reviewPolicy?.mode !== 'required') return null;
  const rv = t.artifacts.aiReview;
  if (!rv) return 'Проєкт вимагає AI-рецензію — запустіть її';
  if (rv.attempt !== t.attempts) return 'Рецензія стосується попередньої спроби — запустіть її знову';
  if (rv.status === 'running') return 'AI-рецензія ще триває';
  if (rv.status !== 'succeeded') return 'AI-рецензія не вдалася — запустіть її знову або змініть політику проєкту';
  if (rv.verdict !== 'approve') return `AI-рецензент: ${REVIEW_VERDICT[rv.verdict]?.[0] ?? rv.verdict}`;
  return null;
}
const usd = (v) => `$${(v ?? 0).toFixed(2)}`;
/** Model text input with suggestions from the selected agent's own model list (`/api/agents/:id/models`). */
function ModelInput(providerSel, value) {
  const id = `models-${Math.random().toString(36).slice(2)}`;
  const list = h('datalist', { id });
  const input = TextInput({ value: value ?? '', placeholder: 'за замовчуванням', list: id, autocomplete: 'off' });
  const fill = async () => {
    const p = providerSel.value;
    if (!p || p === 'auto' || p === 'mock') { list.replaceChildren(); return; }
    state.models[p] ??= api('GET', `/api/agents/${p}/models`).catch(() => []);
    const models = await state.models[p];
    list.replaceChildren(...models.map((m) => h('option', { value: m.id }, m.label)));
    input.title = models.length ? `${models.length} моделей від ${p}` : `${p} не надає списку моделей — впишіть назву вручну`;
  };
  providerSel.addEventListener('change', fill);
  fill();
  return h('div', {}, input, list);
}
const modelValue = (wrap) => wrap.querySelector('input').value.trim() || null;
const clean = (...n) => n.flat().filter((x) => x != null && x !== false); // replaceChildren() would print "null"
const mount = (...n) => $('#page').replaceChildren(...clean(n));
const count = (statuses) => state.tasks.filter((t) => statuses.includes(t.status)).length;

// ---------------------------------------------------------------- shell
function renderShell() {
  const nav = $('#nav');
  nav.replaceChildren(...PAGES.map((p) => h('a', { href: `#/${p.id}`, 'aria-current': state.page === p.id ? 'page' : null, onclick: () => document.body.classList.remove('nav-open') },
    icon(p.icon), p.label,
    p.id === 'tasks' && state.tasks.length ? h('span', { class: 'count' }, state.tasks.length) : null,
    p.id === 'agents' && state.agents ? h('span', { class: 'count' }, `${state.agents.filter((a) => a.available && !a.mock).length}/${state.agents.filter((a) => !a.mock).length}`) : null)));
  const sel = $('#projectSel');
  sel.replaceChildren(...(state.projects.length ? state.projects.map((p) => h('option', { value: p.id }, p.name)) : [h('option', { value: '' }, 'Немає проєктів')]));
  sel.value = state.projectId ?? '';
  sel.title = state.project?.repoPath || '';
  const page = PAGES.find((p) => p.id === state.page);
  $('#crumbs').replaceChildren(...clean(state.project ? h('span', {}, state.project.name, ' / ') : null, h('strong', {}, page?.label ?? '')));
  $('#topActions').replaceChildren(Badge(state.live ? 'наживо' : 'офлайн', state.live ? 'success' : 'neutral', { live: state.live, title: 'Потік подій (SSE)' }));
  const ready = state.agents ? state.agents.filter((a) => a.available && !a.mock) : [];
  $('#sideFoot').replaceChildren(
    h('div', { class: 'row between' }, h('span', { class: 'muted' }, 'Агенти'), state.agents ? Badge(`${ready.length} готові`, ready.length ? 'success' : 'warning') : Badge('перевірка…', 'neutral')),
    h('div', { class: 'row between' }, h('span', { class: 'muted' }, 'Паралельно'), h('span', { class: 'id' }, state.settings?.maxConcurrentAgents ?? '—')),
    h('div', { class: 'row between' }, h('span', { class: 'muted' }, 'Автовибір'), h('span', {}, state.settings?.routingPolicy ?? '—')));
}

function addProjectModal() {
  const path = TextInput({ placeholder: 'E:\\code\\my-app', required: true, 'aria-label': 'Шлях до репозиторію' });
  const open = act(async () => {
    if (!path.value.trim()) { path.focus(); return; }
    const p = await api('POST', '/api/projects', { repoPath: path.value.trim() });
    close(); await loadProjects(); await selectProject(p.id);
  });
  path.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(); });
  const close = openModal({
    title: 'Відкрити проєкт',
    body: h('div', { class: 'stack' },
      Field('Шлях до Git-репозиторію', path, 'Робоча копія має бути на гілці. Перед merge — без незакомічених змін.'),
      h('div', { class: 'callout accent' }, h('div', {}, h('strong', {}, 'Немає репозиторію під рукою?'), h('div', { class: 'text-2' }, 'Демо-проєкт створює тимчасовий репозиторій із 4 Mock-задачами — без витрат квоти.')),
        h('div', {}, SecondaryButton({ icon: 'play', onClick: act(async () => { const p = await api('POST', '/api/demo'); close(); await loadProjects(); await selectProject(p.id); }) }, 'Створити демо-проєкт')))),
    actions: (c) => [GhostButton({ onClick: c }, 'Скасувати'), PrimaryButton({ icon: 'folder', onClick: open }, 'Відкрити')],
  });
  path.focus();
}

// ---------------------------------------------------------------- data
async function loadProjects() { state.projects = await api('GET', '/api/projects'); }
async function loadAgents(refresh = false) { state.agents = await api('GET', '/api/agents' + (refresh ? '?refresh=1' : '')); }
async function loadSettings() { state.settings = await api('GET', '/api/settings'); }
async function reloadProject() {
  if (!state.projectId) return;
  const [{ project, tasks }, plans, activity] = await Promise.all([
    api('GET', `/api/projects/${state.projectId}`), api('GET', `/api/projects/${state.projectId}/plans`),
    api('GET', `/api/events?projectId=${state.projectId}&type=task.status&limit=100000`)]);
  Object.assign(state, { project, tasks, plans, activity: activity.slice(-14).reverse() });
  state.costs = await api('GET', `/api/projects/${state.projectId}/costs`).catch(() => null);
}
async function selectProject(id) {
  state.projectId = id; state.taskId = null; state.editing = null;
  ls.set('hf-project', String(id));
  await reloadProject();
  connectStream();
  if (state.page === 'tasks' && location.hash.startsWith('#/tasks/')) go('#/tasks'); else render();
}
const taskAction = async (id, action, body) => { await api('POST', `/api/tasks/${id}/${action}`, body); await reloadProject(); render(); };

// ---------------------------------------------------------------- router
function route() {
  const [, page = 'overview', id] = location.hash.split('/');
  state.page = PAGES.some((p) => p.id === page) ? page : 'overview';
  const tid = state.page === 'tasks' && id ? Number(id) : null;
  if (tid !== state.taskId) { state.taskId = tid; state.editing = null; }
}
function render() {
  renderShell();
  const pg = $('#page');
  const needsProject = ['overview', 'tasks', 'planner'].includes(state.page);
  if (needsProject && !state.project) { pg.replaceChildren(noProject()); return; }
  ({ overview: overviewPage, tasks: tasksPage, planner: plannerPage, agents: agentsPage, settings: settingsPage })[state.page]();
}
const noProject = () => PanelCard({}, EmptyState({ icon: 'folder', title: 'Проєкт не відкрито',
  text: 'Відкрийте локальний Git-репозиторій або створіть демо-проєкт, щоб планувати й запускати задачі агентів.',
  action: PrimaryButton({ icon: 'plus', onClick: addProjectModal }, 'Відкрити проєкт') }));
const projectMeta = (p) => [h('span', { class: 'row muted wrap' }, icon('folder'), h('span', { class: 'mono' }, p.repoPath)), h('span', { class: 'row muted' }, icon('branch'), h('code', {}, p.baseBranch))];
const runPlanButton = () => {
  const drafts = count(['draft']);
  return PrimaryButton({ icon: 'play', disabled: !drafts, onClick: act(async () => { await api('POST', `/api/projects/${state.projectId}/submit-all`); await reloadProject(); render(); }) }, `Запустити план (${drafts})`);
};
const newTaskButton = () => SecondaryButton({ icon: 'plus', onClick: () => { state.editing = 'new'; go('#/tasks'); render(); } }, 'Задача');

// ---------------------------------------------------------------- page: overview
/** Project report and decision log (ADR) as markdown: view, copy, download. */
function reportButton() {
  return SecondaryButton({ icon: 'report', onClick: act(async () => {
    const pid = state.project.id;
    const [rep, adr] = await Promise.all([api('GET', `/api/projects/${pid}/report`), api('GET', `/api/projects/${pid}/adr`)]);
    const docs = { report: { label: 'Звіт', md: rep.markdown, file: `hidforge-report-${pid}.md` }, adr: { label: `Рішення (ADR · ${adr.decisions.length})`, md: adr.markdown, file: `hidforge-adr-${pid}.md` } };
    let cur = 'report';
    const pre = h('pre', { class: 'diff', style: 'white-space:pre-wrap;max-height:60vh' }, docs.report.md);
    const seg = h('div', {});
    const show = () => { pre.textContent = docs[cur].md; seg.replaceChildren(Segmented(Object.entries(docs).map(([id, d]) => ({ id, label: d.label })), cur, (id) => { cur = id; show(); })); };
    show();
    openModal({ title: 'Звіт по проєкту', body: h('div', { class: 'stack' }, seg, pre), actions: (close) => [
      SecondaryButton({ onClick: async () => { try { await navigator.clipboard.writeText(docs[cur].md); toast('Скопійовано', 'success'); } catch { toast('Не вдалося скопіювати', 'danger'); } } }, 'Копіювати'),
      PrimaryButton({ icon: 'check', onClick: () => {
        const a = h('a', { href: URL.createObjectURL(new Blob([docs[cur].md], { type: 'text/markdown;charset=utf-8' })), download: docs[cur].file });
        a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000); close();
      } }, 'Завантажити .md'),
    ] });
  }) }, 'Звіт і рішення');
}

function overviewPage() {
  const p = state.project;
  const goal = Textarea(p.goal, { class: 'prose', id: 'goal', placeholder: 'Загальна ціль проєкту…', 'aria-label': 'Ціль проєкту' });
  const prev = $('#goal');
  if (prev && prev.dataset.pid === String(p.id) && prev.value !== prev.dataset.saved) goal.value = prev.value; // keep unsaved typing
  goal.dataset.pid = String(p.id); goal.dataset.saved = p.goal;
  const attention = state.tasks.filter((t) => [...ATTENTION, ...PROBLEM].includes(t.status));
  const byId = Object.fromEntries(state.tasks.map((t) => [t.id, t]));
  mount(
    PageHeader({ title: p.name, subtitle: 'Ціль → DAG задач → паралельні агенти в git worktree → перевірки → Approve & Merge', meta: projectMeta(p), actions: [reportButton(), newTaskButton(), runPlanButton()] }),
    h('div', { class: 'grid stats' },
      StatCard({ label: 'Усього задач', value: state.tasks.length, hint: `${count(['draft'])} чернеток` }),
      StatCard({ label: 'Виконується', value: count(ACTIVE), tone: 'info', hint: `з них у роботі: ${count(['running'])}` }),
      StatCard({ label: 'Потребують уваги', value: count(ATTENTION), tone: 'warning', hint: 'рев\'ю та запитання' }),
      StatCard({ label: 'Злито', value: count(['merged']), tone: 'success' }),
      StatCard({ label: 'Проблеми', value: count(PROBLEM), tone: count(PROBLEM) ? 'danger' : undefined, hint: 'помилка / заблоковано' }),
      StatCard({ label: 'Витрати', value: usd(state.costs?.totalUsd), tone: state.costs?.budgetUsd != null && state.costs.remainingUsd === 0 ? 'danger' : undefined,
        hint: state.costs?.budgetUsd != null ? `бюджет ${usd(state.costs.budgetUsd)}, лишилось ${usd(state.costs.remainingUsd)}` : 'бюджет не задано' })),
    h('div', { class: 'grid cols-2' },
      PanelCard({ title: 'Ціль проєкту', subtitle: 'З неї AI-планер будує план задач' },
        goal, h('div', { class: 'row' },
          SecondaryButton({ size: 'sm', icon: 'check', onClick: act(async () => { await api('PATCH', `/api/projects/${p.id}`, { goal: goal.value }); goal.dataset.saved = goal.value; toast('Ціль збережено', 'success'); }) }, 'Зберегти'),
          GhostButton({ size: 'sm', icon: 'planner', onClick: () => go('#/planner') }, 'Згенерувати план'))),
      PanelCard({ title: 'Потребують уваги', subtitle: 'Рев\'ю, запитання агентів, помилки', actions: GhostButton({ size: 'sm', onClick: () => go('#/tasks') }, 'Усі задачі') },
        attention.length ? h('div', { class: 'stack' }, ...attention.slice(0, 6).map((t) => h('div', { class: 'row between' },
          h('a', { href: `#/tasks/${t.id}`, class: 'wrap' }, h('span', { class: 'id' }, `#${t.id}`), ' ', t.title), StatusBadge(t.status))))
          : EmptyState({ icon: 'check', title: 'Усе спокійно', text: 'Немає задач, що чекають на ваше рішення.' }))),
    h('div', { class: 'grid cols-2' },
      PanelCard({ title: 'Остання активність', subtitle: 'Зміни статусів задач' },
        ActivityFeed(state.activity.map((e) => ({ ts: e.ts, content: [h('a', { href: `#/tasks/${e.taskId}` }, `#${e.taskId}`), ` ${byId[e.taskId]?.title ?? ''} `, h('span', { class: 'muted' }, `${STATUS_LABEL[e.data.from] ?? e.data.from} → `), STATUS_LABEL[e.data.to] ?? e.data.to] })))),
      PanelCard({ title: 'Агенти', subtitle: 'Встановлені CLI та їхній стан', actions: GhostButton({ size: 'sm', onClick: () => go('#/agents') }, 'Детальніше') },
        state.agents ? h('div', { class: 'stack' }, ...state.agents.map((a) => { const [l, tone] = agentState(a); return h('div', { class: 'row between' }, h('span', {}, a.name, a.version ? h('span', { class: 'muted' }, ` ${a.version}`) : null), Badge(l, tone)); }))
          : h('p', { class: 'muted' }, 'Перевірка агентів…'))),
    costsPanel(),
  );
}

function costsPanel() {
  const c = state.costs;
  if (!c || !c.byProvider.length) return null;
  return PanelCard({ flush: true, title: 'Витрати за агентами', subtitle: 'Долари звітує лише Claude Code; інші CLI — тільки токени' }, Table({
    columns: [
      { label: 'Агент', render: (x) => (x.provider === 'mock' ? h('span', { class: 'mockflag' }, 'MOCK') : x.provider) },
      { label: 'Сесій', render: (x) => h('span', { class: 'mono' }, x.sessions) },
      { label: 'USD', render: (x) => h('span', { class: 'mono' }, x.sessionsWithUsd ? usd(x.usd) : '—') },
      { label: 'Токени вводу', render: (x) => h('span', { class: 'mono' }, x.inputTokens.toLocaleString('uk-UA')) },
      { label: 'Токени виводу', render: (x) => h('span', { class: 'mono' }, x.outputTokens.toLocaleString('uk-UA')) },
    ], rows: c.byProvider }));
}

// ---------------------------------------------------------------- page: tasks
const FILTERS = [
  { id: 'all', label: 'Усі', match: () => true },
  { id: 'draft', label: 'Чернетки', match: (t) => t.status === 'draft' },
  { id: 'active', label: 'Активні', match: (t) => ACTIVE.includes(t.status) },
  { id: 'attention', label: 'Рев\'ю', match: (t) => ATTENTION.includes(t.status) },
  { id: 'done', label: 'Готово', match: (t) => ['merged', 'accepted'].includes(t.status) },
  { id: 'problem', label: 'Проблеми', match: (t) => PROBLEM.includes(t.status) },
];
const BOARD = [
  { id: 'draft', title: 'Чернетки', statuses: ['draft'] },
  { id: 'queue', title: 'Черга', statuses: ['ready', 'queued'] },
  { id: 'running', title: 'Виконується', statuses: ['running'] },
  { id: 'review', title: "Рев'ю", statuses: ['review', 'needs_user_input'] },
  { id: 'problems', title: 'Проблеми', statuses: ['failed', 'blocked'] },
  { id: 'done', title: 'Готово', statuses: ['accepted', 'merged'] },
  { id: 'canceled', title: 'Скасовані', statuses: ['canceled'] },
];

function tasksPage() {
  const q = state.query.trim().toLowerCase();
  const f = FILTERS.find((x) => x.id === state.filter) || FILTERS[0];
  const visible = state.tasks.filter((t) => (state.showCanceled || t.status !== 'canceled') && f.match(t)
    && (!q || `#${t.id} ${t.title} ${t.assignedRole} ${t.provider}`.toLowerCase().includes(q)));
  const hasDetail = state.taskId || state.editing;
  const table = Table({
    columns: [
      { label: '#', render: (t) => h('span', { class: 'id' }, t.id) },
      { label: 'Задача', class: 'grow', render: (t) => h('span', { class: 'wrap' }, t.title) },
      { label: 'Роль', render: (t) => h('span', { class: 'text-2' }, t.assignedRole) },
      { label: 'Виконавець', render: (t) => [providerLabel(t), t.model ? h('span', { class: 'muted' }, ` ${t.model}`) : null] },
      { label: 'Залежить від', render: (t) => (t.dependsOn.length ? t.dependsOn.map((d) => `#${d}`).join(', ') : '—') },
      { label: 'Статус', render: (t) => StatusBadge(t.status) },
      { label: 'Спроби', render: (t) => h('span', { class: 'mono' }, `${t.attempts}/${t.maxAttempts}`) },
      { label: '', render: quickActions },
    ],
    rows: visible, selected: (t) => t.id === state.taskId, onRowClick: (t) => go(`#/tasks/${t.id}`),
    empty: EmptyState({ icon: 'tasks', title: state.tasks.length ? 'Нічого не знайдено' : 'Ще немає задач',
      text: state.tasks.length ? 'Змініть фільтр або пошуковий запит.' : 'Згенеруйте план AI-планером або додайте задачу вручну.',
      action: state.tasks.length ? null : h('div', { class: 'row' }, SecondaryButton({ icon: 'planner', onClick: () => go('#/planner') }, 'AI-планер'), newTaskButton()) }),
  });
  const open = (t) => go(`#/tasks/${t.id}`);
  const board = () => Kanban({ empty: '—', columns: BOARD.map((c) => ({ id: c.id, title: c.title, items: visible.filter((t) => c.statuses.includes(t.status)) })),
    card: (t) => h('button', { type: 'button', class: t.id === state.taskId ? 'kcard sel' : 'kcard', onclick: () => open(t) },
      h('span', { class: 'wrap' }, h('span', { class: 'id' }, `#${t.id} `), t.title),
      h('span', { class: 'kmeta' }, h('span', {}, `${t.assignedRole} · ${t.provider}`), StatusBadge(t.status))) });
  const graph = () => (visible.length ? DagGraph({ selected: state.taskId, onNode: (n) => open(n.task),
    nodes: visible.map((t) => ({ id: t.id, task: t, label: `#${t.id} ${t.title}`, sub: `${STATUS_LABEL[t.status] || t.status} · ${t.provider}`, tone: statusTone(t.status) })),
    edges: visible.flatMap((t) => t.dependsOn.map((d) => [d, t.id])) }) : table);
  const views = { table: () => PanelCard({ flush: true }, table), kanban: board, graph: () => PanelCard({}, graph()) };
  const view = (views[state.view] || views.table)();
  const search = SearchInput({ placeholder: 'Пошук за назвою, #id, роллю…', value: state.query, onInput: (e) => { state.query = e.target.value; tasksPage(); const i = $('.toolbar input[type=search]'); i.focus(); i.setSelectionRange(i.value.length, i.value.length); } });
  const detail = h('div', { class: 'detail', id: 'detail' });
  mount(
    PageHeader({ title: 'Задачі', subtitle: 'Незалежні задачі стартують паралельно, залежні — після merge своїх залежностей.', actions: [newTaskButton(), runPlanButton()] }),
    h('div', { class: 'toolbar' },
      Segmented(FILTERS.map((x) => ({ id: x.id, label: x.label, count: state.tasks.filter(x.match).length })), state.filter, (id) => { state.filter = id; ls.set('hf-filter', id); tasksPage(); }),
      search,
      Toggle({ label: 'Показувати скасовані', checked: state.showCanceled, onChange: (v) => { state.showCanceled = v; tasksPage(); } }),
      Segmented([{ id: 'table', label: 'Таблиця' }, { id: 'kanban', label: 'Kanban' }, { id: 'graph', label: 'Граф' }], state.view in views ? state.view : 'table', (id) => { state.view = id; ls.set('hf-view', id); tasksPage(); })),
    h('div', { class: `split${hasDetail ? '' : ' solo'}` }, view, hasDetail ? detail : null),
  );
  if (hasDetail) renderDetail().catch((e) => toast(e.message, 'danger'));
}

function quickActions(t) {
  const stop = (fn) => (e) => { e.stopPropagation(); act(fn)(); };
  const b = [];
  if (t.status === 'draft') b.push(IconButton({ icon: 'play', label: 'Запустити', size: 'sm', variant: 'secondary', onClick: stop(() => taskAction(t.id, 'submit')) }));
  if (['running', 'queued', 'ready'].includes(t.status)) b.push(IconButton({ icon: 'stop', label: 'Зупинити', size: 'sm', variant: 'danger', onClick: stop(() => taskAction(t.id, 'cancel')) }));
  if (PROBLEM.includes(t.status)) b.push(IconButton({ icon: 'retry', label: 'Повторити', size: 'sm', onClick: stop(() => taskAction(t.id, 'retry')) }));
  return h('div', { class: 'row', style: 'justify-content:flex-end' }, ...b);
}

function taskForm(t) {
  const isNew = !t;
  t = t || { title: '', description: '', acceptanceCriteria: '', dependsOn: [], assignedRole: 'Backend', provider: 'mock', model: '', policy: 'workspace-write', allowedPaths: [], verifyCommands: [], maxAttempts: 2, timeoutSec: 1800 };
  const f = {
    title: TextInput({ value: t.title, required: true }),
    description: Textarea(t.description, { class: 'prose', style: 'min-height:110px' }),
    acceptanceCriteria: Textarea(t.acceptanceCriteria, { class: 'prose' }),
    assignedRole: Select(ROLES, t.assignedRole),
    provider: Select([['auto', 'auto (за політикою)'], ...(state.agents || []).map((a) => [a.id, `${a.id}${a.available ? '' : ' (недоступний)'}`])], t.provider),
    model: null,
    maxBudgetUsd: TextInput({ type: 'number', min: 0.01, step: 0.01, value: t.maxBudgetUsd ?? '', placeholder: 'без ліміту' }),
    policy: Select([['workspace-write', 'запис у worktree'], ['read-only', 'лише читання']], t.policy),
    dependsOn: TextInput({ value: t.dependsOn.join(', '), placeholder: 'напр. 1, 2' }),
    maxAttempts: TextInput({ type: 'number', min: 1, max: 10, value: t.maxAttempts }),
    timeoutSec: TextInput({ type: 'number', min: 5, value: t.timeoutSec }),
    allowedPaths: Textarea(t.allowedPaths.join('\n'), { placeholder: 'src/api/**' }),
    verifyCommands: Textarea(t.verifyCommands.join('\n'), { placeholder: 'npm test' }),
  };
  f.model = ModelInput(f.provider, t.model);
  const lines = (el) => el.value.split('\n').map((s) => s.trim()).filter(Boolean);
  const cancel = () => { state.editing = null; render(); };
  return PanelCard({ title: isNew ? 'Нова задача' : `Редагування #${t.id}`, subtitle: 'Контракт задачі для агента', actions: IconButton({ icon: 'close', label: 'Закрити', size: 'sm', onClick: cancel }) },
    h('form', { class: 'stack', onsubmit: act(async (e) => {
      e.preventDefault();
      const body = {
        title: f.title.value.trim(), description: f.description.value, acceptanceCriteria: f.acceptanceCriteria.value,
        dependsOn: f.dependsOn.value.split(/[\s,#]+/).filter(Boolean).map(Number), assignedRole: f.assignedRole.value,
        provider: f.provider.value, model: modelValue(f.model), policy: f.policy.value, maxBudgetUsd: f.maxBudgetUsd.value ? Number(f.maxBudgetUsd.value) : null,
        allowedPaths: lines(f.allowedPaths), verifyCommands: lines(f.verifyCommands),
        maxAttempts: Number(f.maxAttempts.value), timeoutSec: Number(f.timeoutSec.value),
      };
      const saved = isNew ? await api('POST', `/api/projects/${state.projectId}/tasks`, body) : await api('PATCH', `/api/tasks/${t.id}`, body);
      state.editing = null; await reloadProject(); toast(isNew ? 'Чернетку створено' : 'Збережено', 'success'); go(`#/tasks/${saved.id}`);
    }) },
    h('div', { class: 'form-grid' },
      Field('Назва', f.title, null, { full: true }),
      Field('Опис / інструкції агенту', f.description, null, { full: true }),
      Field('Критерії готовності', f.acceptanceCriteria, null, { full: true }),
      Field('Роль', f.assignedRole), Field('Виконавець (CLI)', f.provider, '«auto» — за політикою автовибору'),
      Field('Модель', f.model), Field('Права', f.policy),
      Field('Залежить від', f.dependsOn, '#id через кому'), Field('Макс. спроб', f.maxAttempts),
      Field('Таймаут, с', f.timeoutSec), Field('Ліміт витрат, $', f.maxBudgetUsd, 'передається лише CLI з власним лімітом (Claude Code)'),
      Field('Дозволені шляхи', f.allowedPaths, 'glob по рядку; порожньо = будь-які', { full: true }),
      Field('Команди перевірки', f.verifyCommands, 'по рядку; запускаються без shell', { full: true })),
    h('div', { class: 'row' }, PrimaryButton({ type: 'submit', icon: 'check' }, isNew ? 'Створити чернетку' : 'Зберегти'), GhostButton({ onClick: cancel }, 'Скасувати'))));
}

async function renderDetail() {
  const box = $('#detail');
  if (!box) return;
  if (state.editing === 'new') { box.replaceChildren(taskForm(null)); return; }
  const { task: t, runs } = await api('GET', `/api/tasks/${state.taskId}`);
  if (!$('#detail')) return;
  if (state.editing === t.id) { box.replaceChildren(taskForm(t)); return; }
  const gate = t.artifacts.gate;
  const primary = [];
  if (t.status === 'draft') primary.push(PrimaryButton({ icon: 'play', onClick: act(() => taskAction(t.id, 'submit')) }, 'Запустити'));
  const rv = t.artifacts.aiReview;
  const blocker = reviewBlocker(t);
  if (gate?.passed && ['review', 'blocked'].includes(t.status)) primary.push(PrimaryButton({ icon: 'merge', disabled: Boolean(blocker), title: blocker || null, onClick: act(() => taskAction(t.id, 'approve')) }, 'Approve & Merge'));
  if (rv?.status === 'running') primary.push(SecondaryButton({ icon: 'stop', onClick: act(() => taskAction(t.id, 'review/cancel')) }, 'Зупинити рецензію'));
  else if (gate?.passed && t.status === 'review') primary.push(SecondaryButton({ icon: 'check', onClick: act(() => taskAction(t.id, 'review')) }, rv ? 'Рецензувати знову' : 'AI-рецензія'));
  if (ATTENTION.includes(t.status)) primary.push(SecondaryButton({ onClick: act(async () => {
    const fb = await promptModal('Що виправити? Агент отримає це в repair-спробі.', { title: `Reject #${t.id}`, ok: 'Відхилити й повторити' }); if (fb === null) return;
    await taskAction(t.id, 'reject', { feedback: fb, retry: true });
  }) }, 'Reject'));
  if (PROBLEM.includes(t.status)) primary.push(SecondaryButton({ icon: 'retry', onClick: act(() => taskAction(t.id, 'retry')) }, 'Повторити'));
  if ([...ACTIVE, 'draft'].includes(t.status)) primary.push(DangerButton({ icon: 'stop', onClick: act(() => taskAction(t.id, 'cancel')) }, 'Зупинити'));
  const menu = DropdownMenu({ label: 'Інші дії' }, [
    ['draft', 'ready', 'failed', 'blocked'].includes(t.status) ? { label: 'Редагувати', icon: 'edit', onClick: () => { state.editing = t.id; renderDetail(); } } : null,
    ['draft', 'canceled'].includes(t.status) ? { label: 'Видалити', icon: 'trash', danger: true, onClick: act(async () => {
      if (!await confirmModal(`Видалити задачу #${t.id} «${t.title}»? Це не можна скасувати.`, { danger: true, ok: 'Видалити' })) return;
      await api('DELETE', `/api/tasks/${t.id}`); await reloadProject(); go('#/tasks');
    }) } : null,
  ].filter(Boolean));

  const log = h('div', { class: 'console', id: 'log', role: 'log', 'aria-live': 'off' });
  const diffBox = h('pre', { class: 'diff', id: 'diff' }, h('span', { class: 'muted' }, 'Завантаження…'));
  const loadDiff = act(async () => renderDiff((await api('GET', `/api/tasks/${t.id}/diff`)).diff));
  box.replaceChildren(PanelCard({},
    h('div', { class: 'panel-head' },
      h('div', { class: 'wrap' }, h('div', { class: 'row' }, h('span', { class: 'id', style: 'font-size:var(--fs-xl)' }, `#${t.id}`), StatusBadge(t.status)),
        h('h3', { style: 'margin-top:6px' }, t.title)),
      h('div', { class: 'row' }, menu.querySelector('button') ? menu : null, IconButton({ icon: 'close', label: 'Закрити', size: 'sm', onClick: () => go('#/tasks') }))),
    h('div', { class: 'row text-2', style: 'font-size:var(--fs-sm)' }, t.assignedRole, ' · ', providerLabel(t), t.provider === 'mock' ? ' (не справжній AI)' : '', ` · спроба ${t.attempts}/${t.maxAttempts} · ${t.policy}`),
    t.question ? h('div', { class: 'callout' }, h('div', { class: 'row' }, icon('alert'), h('strong', {}, 'Агент чекає на рішення')), h('div', { class: 'wrap' }, t.question),
      h('div', { class: 'row' }, PrimaryButton({ size: 'sm', onClick: act(() => taskAction(t.id, 'answer', { allow: true })) }, 'Дозволити'),
        DangerButton({ size: 'sm', onClick: act(() => taskAction(t.id, 'answer', { allow: false })) }, 'Заборонити'))) : null,
    primary.length ? h('div', { class: 'row' }, ...primary) : null,
    gate ? h('div', { class: 'row' }, h('span', { class: 'muted' }, 'Gate'), Badge(gate.passed ? 'пройдено' : 'не пройдено', gate.passed ? 'success' : 'danger'), gate.reason ? h('span', { class: 'text-2 wrap' }, gate.reason) : null) : null,
    rv ? h('div', { class: 'row' }, h('span', { class: 'muted' }, 'AI-рецензія'), reviewBadge(rv), rv.attempt !== t.attempts ? Badge(`спроба ${rv.attempt}`, 'neutral', { plain: true }) : null) : null,
    blocker && gate?.passed && ['review', 'blocked'].includes(t.status) ? h('div', { class: 'text-2 wrap', style: 'font-size:var(--fs-sm)' }, h('span', { class: 'muted' }, 'Merge заблоковано: '), blocker) : null,
    t.feedback && t.status !== 'merged' ? h('div', { class: 'text-2 wrap', style: 'font-size:var(--fs-sm)' }, h('span', { class: 'muted' }, 'Остання причина: '), t.feedback) : null,
    Tabs([
      { id: 'log', label: 'Журнал', content: log },
      { id: 'evidence', label: 'Докази', count: t.evidence.length, content: t.evidence.length ? h('ul', { class: 'evidence' }, ...t.evidence.slice().reverse().map((e) => h('li', { class: e.ok ? 'ok' : 'bad', title: e.detail || '' },
        h('span', { class: 'muted mono' }, `${e.ts.slice(11, 19)} ${e.kind}: `), e.summary))) : h('p', { class: 'muted' }, 'Доказів ще немає') },
      { id: 'review', label: 'AI-рецензія', count: rv?.findings?.length || null, content: reviewPanel(t, rv) },
      { id: 'diff', label: 'Зміни', content: [h('div', {}, GhostButton({ size: 'sm', icon: 'refresh', onClick: loadDiff }, 'Оновити diff')), diffBox] },
      { id: 'runs', label: 'Запуски', count: runs.length, content: runs.length ? h('ul', { class: 'evidence' }, ...runs.map((r) => h('li', {},
        h('div', { class: 'row between' }, h('span', {}, h('span', { class: 'id' }, `#${r.attempt}`), ` ${r.provider}`, r.isMock ? h('span', { class: 'mockflag' }, ' MOCK') : null), h('span', { class: 'muted mono' }, `${r.startedAt.slice(11, 19)}${r.endedAt ? '–' + r.endedAt.slice(11, 19) : ''}`)),
        h('div', { class: 'text-2' }, r.status, r.exitCode != null ? ` · exit ${r.exitCode}` : ''),
        r.error ? h('div', { class: 'muted' }, r.error) : null,
        r.usage ? h('div', { class: 'muted mono' }, 'usage: ' + JSON.stringify(r.usage)) : null))) : h('p', { class: 'muted' }, 'Запусків ще не було') },
      { id: 'info', label: 'Деталі', content: InfoList([
        ['Опис', h('div', { style: 'white-space:pre-wrap' }, t.description || '—')], ['Критерії', h('div', { style: 'white-space:pre-wrap' }, t.acceptanceCriteria || '—')],
        ['Залежить від', t.dependsOn.map((d) => `#${d}`).join(', ') || '—'], ['Дозволені шляхи', t.allowedPaths.join(', ') || 'будь-які'],
        ['Перевірка', t.verifyCommands.join('; ') || '—'], ['Гілка', t.branch ? h('code', {}, t.branch) : '—'], ['Worktree', t.workspace ? h('span', { class: 'mono' }, t.workspace) : '—'],
        ['Таймаут', `${t.timeoutSec} с`]]) },
    ], state.detailTab, (id) => { state.detailTab = id; if (id === 'diff') loadDiff(); }),
  ));
  const evs = await api('GET', `/api/events?taskId=${t.id}`);
  for (const e of evs) appendLog(e);
}

function appendLog(e) {
  const log = $('#log');
  if (!log) return;
  const ts = e.ts.slice(11, 19);
  let line;
  if (e.type === 'run.output') line = h('div', { class: `k-${e.data.kind} ${e.data.stream}` }, `${ts} ${e.data.text}`);
  else if (e.type === 'review.output') line = h('div', { class: `k-${e.data.kind} ${e.data.stream}` }, `${ts} [рецензент] ${e.data.text}`);
  else if (e.type === 'review.started') line = h('div', { class: 'sys' }, `${ts} ── AI-рецензія спроби #${e.data.attempt}: ${e.data.mock ? '[MOCK] ' : ''}${e.data.provider}${e.data.model ? ' ' + e.data.model : ''}`);
  else if (e.type === 'review.status') line = h('div', { class: 'sys' }, `${ts} ── AI-рецензія: ${e.data.status}${e.data.verdict ? ` → ${e.data.verdict}` : ''}`);
  else if (e.type === 'task.status') line = h('div', { class: 'sys' }, `${ts} ── ${e.data.from} → ${e.data.to}${e.data.note ? ` (${e.data.note})` : ''}`);
  else if (e.type === 'run.started') line = h('div', { class: 'sys' }, `${ts} ── запуск #${e.data.attempt}: ${e.data.mock ? '[MOCK] ' : ''}${e.data.command.split(/[\\/]/).pop()} ${e.data.args.join(' ')}`);
  else line = h('div', { class: 'sys' }, `${ts} ${e.type} ${JSON.stringify(e.data)}`);
  const atBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 20;
  log.append(line);
  if (atBottom) log.scrollTop = log.scrollHeight;
}

function reviewPanel(t, rv) {
  const mode = state.project?.reviewPolicy?.mode ?? 'off';
  if (!rv) {
    return EmptyState({ icon: 'check', title: 'Рецензії ще не було',
      text: mode === 'off' ? 'AI-рецензент вимкнений для проєкту (Налаштування → AI-рецензент). Запустити вручну можна після успішних gate-ів.'
        : 'Рецензент (QA + Security) запуститься автоматично після успішних gate-ів.' });
  }
  const order = Object.keys(SEVERITY);
  const findings = (rv.findings || []).slice().sort((a, b) => order.indexOf(a.severity) - order.indexOf(b.severity));
  return h('div', { class: 'stack' },
    InfoList([
      ['Вердикт', reviewBadge(rv)],
      ['Рецензент', h('span', {}, rv.provider === 'mock' ? h('span', { class: 'mockflag' }, 'MOCK') : rv.provider, rv.model ? h('span', { class: 'muted' }, ` ${rv.model}`) : '')],
      ['Спроба', h('span', {}, h('span', { class: 'id' }, `#${rv.attempt}`), rv.attempt !== t.attempts ? h('span', { class: 'muted' }, ` (поточна #${t.attempts})`) : '')],
      ['Режим проєкту', { off: 'вимкнено', advisory: 'дорадчий', required: 'обов\'язковий' }[mode] ?? mode],
      rv.summary ? ['Підсумок', h('div', { style: 'white-space:pre-wrap' }, rv.summary)] : null,
      rv.error ? ['Помилка', h('div', { class: 'wrap' }, rv.error)] : null,
      rv.usage ? ['Usage', h('span', { class: 'mono muted' }, JSON.stringify(rv.usage))] : null,
    ].filter(Boolean)),
    findings.length ? h('ul', { class: 'evidence' }, ...findings.map((f) => h('li', { class: ['critical', 'major'].includes(f.severity) ? 'bad' : '' },
      h('div', { class: 'row' }, Badge(SEVERITY[f.severity]?.[0] ?? f.severity, SEVERITY[f.severity]?.[1] ?? 'neutral'),
        f.file ? h('code', {}, `${f.file}${f.line ? ':' + f.line : ''}`) : ''),
      h('div', { class: 'wrap', style: 'margin-top:var(--s-1)' }, f.message))))
      : h('p', { class: 'muted' }, rv.status === 'succeeded' ? 'Зауважень немає' : rv.status === 'running' ? 'Рецензент працює — вивід у вкладці «Журнал».' : ''));
}

function renderDiff(text) {
  const box = $('#diff');
  if (!box) return;
  if (!text) { box.replaceChildren(h('span', { class: 'muted' }, 'Змін немає')); return; }
  box.replaceChildren(...text.split('\n').map((l) => h('div', {
    class: l.startsWith('+') && !l.startsWith('+++') ? 'add' : l.startsWith('-') && !l.startsWith('---') ? 'del' : l.startsWith('@@') ? 'hunk' : '',
  }, l || ' ')));
}

// ---------------------------------------------------------------- page: AI planner
const PLAN_STATUS = { running: ['генерується', 'info'], succeeded: ['готовий до перегляду', 'warning'], failed: ['помилка', 'danger'], canceled: ['скасовано', 'neutral'], applied: ['застосовано', 'success'], discarded: ['відхилено', 'neutral'] };
const planBadge = (pl) => Badge(PLAN_STATUS[pl.status]?.[0] ?? pl.status, PLAN_STATUS[pl.status]?.[1], { live: pl.status === 'running' });

function plannerPage() {
  const p = state.project;
  const plan = state.plans[0];
  const busy = plan?.status === 'running';
  const planners = (state.agents || []).filter((a) => a.available && (a.mock || a.capabilities.readOnlyMode === 'supported'));
  const goal = Textarea(p.goal, { class: 'prose', placeholder: 'Опишіть, що має бути зроблено…', 'aria-label': 'Ціль' });
  const prov = Select([['auto', 'auto (за політикою)'], ...planners.map((a) => [a.id, a.mock ? 'mock (демо, не AI)' : a.name])], 'auto');
  const model = ModelInput(prov, null);
  const maxTasks = TextInput({ type: 'number', min: 1, max: 30, value: 12 });
  const generate = act(async () => {
    if (goal.value !== p.goal) await api('PATCH', `/api/projects/${p.id}`, { goal: goal.value });
    await api('POST', `/api/projects/${p.id}/plans`, { provider: prov.value, model: modelValue(model), maxTasks: Number(maxTasks.value) });
    await reloadProject(); render();
  });
  mount(
    PageHeader({ title: 'AI-планер', subtitle: 'Агент читає репозиторій у режимі лише читання й пропонує DAG задач. Нічого не створюється, доки ви не підтвердите.' }),
    PanelCard({ title: 'Ціль і параметри', actions: plan ? planBadge(plan) : null },
      Field('Ціль проєкту', goal),
      h('div', { class: 'form-grid', style: 'grid-template-columns:repeat(auto-fit,minmax(180px,1fr))' },
        Field('Агент-планер', prov, state.agents ? null : 'перевірка агентів…'), Field('Модель', model), Field('Макс. задач', maxTasks)),
      h('div', { class: 'row' }, PrimaryButton({ icon: 'planner', disabled: busy, onClick: generate }, 'Згенерувати план'),
        busy ? DangerButton({ icon: 'stop', onClick: act(async () => { await api('POST', `/api/plans/${plan.id}/cancel`); await reloadProject(); render(); }) }, 'Зупинити') : null)),
    plan && plan.status !== 'discarded' ? planResult(plan) : null,
    state.plans.length > 1 ? PanelCard({ flush: true, title: 'Історія планів' }, Table({
      columns: [
        { label: '#', render: (x) => h('span', { class: 'id' }, x.id) }, { label: 'Статус', render: planBadge },
        { label: 'Агент', render: (x) => `${x.provider}${x.model ? ' ' + x.model : ''}` },
        { label: 'Задач', render: (x) => x.plan?.tasks?.length ?? '—' }, { label: 'Створено', render: (x) => h('span', { class: 'mono muted' }, x.createdAt?.replace('T', ' ').slice(0, 19) ?? '') },
      ], rows: state.plans.slice(1) })) : null,
  );
}

function planResult(plan) {
  const busy = plan.status === 'running';
  const discard = act(async () => { await api('POST', `/api/plans/${plan.id}/discard`).catch(() => {}); await reloadProject(); render(); });
  if (busy || plan.status === 'failed' || plan.status === 'canceled') {
    const log = h('div', { class: 'console short', id: 'planlog', 'data-plan': plan.id, role: 'log' });
    for (const line of (plan.output || '').split('\n').slice(-200)) if (line) log.append(h('div', {}, line));
    if (busy) queueMicrotask(() => loadPlanLog(plan.id));
    return PanelCard({ title: `План #${plan.id}`, subtitle: `${plan.provider}${plan.model ? ' ' + plan.model : ''}`, actions: busy ? null : GhostButton({ size: 'sm', onClick: discard }, 'Сховати') },
      plan.error ? h('div', { class: 'callout' }, h('strong', {}, 'Причина'), h('div', { class: 'wrap' }, plan.error)) : null, log);
  }
  if (plan.status === 'applied') {
    return PanelCard({ title: `План #${plan.id} застосовано` }, h('p', { class: 'text-2', style: 'margin:0' }, `Створено чернетки: ${(plan.appliedTaskIds || []).map((i) => '#' + i).join(', ')}. Відредагуйте їх за потреби й запустіть план.`),
      h('div', { class: 'row' }, SecondaryButton({ icon: 'tasks', onClick: () => { state.filter = 'draft'; go('#/tasks'); } }, 'До чернеток'), runPlanButton()));
  }
  const d = plan.plan;
  const applyProv = Select([['auto', 'auto (за політикою)'], ...(state.agents || []).filter((a) => a.available).map((a) => [a.id, a.mock ? 'mock' : a.id])], plan.provider === 'mock' ? 'mock' : 'auto', { class: 'w-auto' });
  return PanelCard({ flush: true, title: `Запропонований план #${plan.id}`, subtitle: d.summary || `${d.tasks.length} задач` },
    d.risks.length ? h('div', { style: 'padding:var(--s-4) var(--s-5) 0' }, h('div', { class: 'callout' }, h('strong', {}, 'Ризики'), h('ul', { style: 'margin:0;padding-left:18px' }, ...d.risks.map((r) => h('li', {}, r))))) : null,
    Table({
      columns: [
        { label: 'Ключ', render: (t) => h('code', {}, t.key) },
        { label: 'Задача', class: 'grow', render: (t) => h('span', { title: `${t.description}\n\nКритерії: ${t.acceptanceCriteria}` }, t.title, t.policy === 'read-only' ? h('span', { class: 'muted' }, ' (read-only)') : null) },
        { label: 'Роль', render: (t) => t.role },
        { label: 'Залежить від', render: (t) => (t.dependsOn.length ? t.dependsOn.map((x) => (typeof x === 'number' ? `#${x}` : x)).join(', ') : '—') },
        { label: 'Шляхи', render: (t) => h('span', { class: 'mono' }, t.allowedPaths.join(', ') || 'будь-які') },
        { label: 'Перевірка', render: (t) => h('span', { class: 'mono' }, t.verifyCommands.join('; ') || '—') },
      ], rows: d.tasks }),
    h('div', { class: 'row', style: 'padding:var(--s-4) var(--s-5);border-top:1px solid var(--border)' },
      h('label', { class: 'row text-2' }, 'Виконавець задач', applyProv),
      h('div', { style: 'flex:1' }),
      GhostButton({ onClick: discard }, 'Відхилити'),
      PrimaryButton({ icon: 'check', onClick: act(async () => {
        const tasks = await api('POST', `/api/plans/${plan.id}/apply`, { provider: applyProv.value });
        toast(`Створено ${tasks.length} чернеток`, 'success'); await reloadProject(); render();
      }) }, 'Додати як чернетки')));
}

async function loadPlanLog(planId) {
  const log = $('#planlog');
  if (!log || log.dataset.loaded) return;
  log.dataset.loaded = '1';
  const evs = await api('GET', `/api/events?projectId=${state.projectId}&type=plan.output&limit=20000`);
  for (const e of evs) if (e.type === 'plan.output' && e.data.planId === planId) appendPlanLog(e);
}
function appendPlanLog(e) {
  const log = $('#planlog');
  if (!log || Number(log.dataset.plan) !== e.data.planId) return;
  const atBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 20;
  log.append(h('div', { class: `k-${e.data.kind}` }, `${e.ts.slice(11, 19)} ${e.data.text}`));
  if (atBottom) log.scrollTop = log.scrollHeight;
}

// ---------------------------------------------------------------- page: agents
function agentsPage() {
  const refresh = act(async () => { state.agents = null; render(); await loadAgents(true); render(); });
  mount(
    PageHeader({ title: 'Агенти', subtitle: 'CLI агентів програмування на цьому комп\'ютері. Недоступний агент не зупиняє проєкт — задачі йдуть на інші за політикою автовибору.',
      actions: SecondaryButton({ icon: 'refresh', onClick: refresh, disabled: !state.agents }, 'Перевірити знову') }),
    state.agents ? h('div', { class: 'grid cards' }, ...state.agents.map((a) => {
      const [label, tone] = agentState(a);
      return ItemCard({
        icon: a.mock ? 'terminal' : 'agents', off: !a.available, title: a.name, subtitle: a.version || (a.installed ? 'версія невідома' : 'не знайдено в PATH'),
        status: Badge(label, tone),
        body: h('div', { class: 'stack' },
          a.mock ? h('div', { class: 'mockflag' }, 'ДЕМО-АГЕНТ — НЕ СПРАВЖНІЙ AI') : null,
          a.reason ? h('div', { class: 'text-2 wrap', style: 'font-size:var(--fs-sm)' }, a.reason) : null,
          h('div', { class: 'row' }, ...Object.entries(a.capabilities).map(([k, v]) => PermissionChip(k, v))),
          a.notes.length ? h('ul', { class: 'muted', style: 'margin:0;padding-left:18px;font-size:var(--fs-sm)' }, ...a.notes.map((n) => h('li', {}, n))) : null),
      });
    })) : PanelCard({}, EmptyState({ icon: 'refresh', title: 'Перевірка агентів…', text: 'Шукаємо CLI у PATH і перевіряємо авторизацію.' })),
  );
}

// ---------------------------------------------------------------- page: settings
function settingsPage() {
  const s = state.settings || {};
  const maxConc = Select(Array.from({ length: 8 }, (_, i) => String(i + 1)), s.maxConcurrentAgents, { onchange: act(async (e) => { await api('PUT', '/api/settings', { maxConcurrentAgents: Number(e.target.value) }); await loadSettings(); renderShell(); toast('Збережено', 'success'); }) });
  const routing = Select(['cost-first', 'balanced', 'quality-first'], s.routingPolicy, { onchange: act(async (e) => { await api('PUT', '/api/settings', { routingPolicy: e.target.value }); await loadSettings(); renderShell(); toast('Збережено', 'success'); }) });
  const theme = Select([['dark', 'Темна (за замовчуванням)'], ['light', 'Світла'], ['system', 'Як у системі']], ls.get('hf-theme') || 'dark', { onchange: (e) => { ls.set('hf-theme', e.target.value); applyTheme(); } });
  const p = state.project;
  let cmds = null;
  if (p) { cmds = Textarea(p.allowedCommands.join('\n'), { placeholder: 'Одна команда на рядок, напр. npm test' }); }
  mount(
    PageHeader({ title: 'Налаштування', subtitle: 'Виконання, вигляд і політики проєкту' }),
    h('div', { class: 'grid cols-2' },
      PanelCard({ title: 'Виконання', subtitle: 'Глобально для всіх проєктів' },
        Field('Паралельних агентів', maxConc, 'Скільки задач можуть виконуватися одночасно'),
        Field('Політика автовибору', routing, 'cost-first — дешевші агенти; quality-first — найсильніші; balanced — між ними')),
      PanelCard({ title: 'Вигляд' }, Field('Тема', theme, 'Зберігається лише в цьому браузері'))),
    p ? budgetSettings(p) : null,
    p ? reviewSettings(p) : null,
    trustSettings(),
    rolesSettings(),
    agentsExtSettings(),
    maintenanceSettings(),
    aboutSettings(),
    p ? PanelCard({ title: 'Дозволені команди перевірки', subtitle: `Проєкт «${p.name}»` },
      h('p', { class: 'text-2', style: 'margin:0' }, 'Команди запускаються без shell у worktree задачі. Команди не з цього списку потребують підтвердження; git push, rm, curl, powershell тощо заборонені завжди.'),
      cmds, h('div', {}, PrimaryButton({ icon: 'check', onClick: act(async () => {
        await api('PATCH', `/api/projects/${p.id}`, { allowedCommands: cmds.value.split('\n').map((x) => x.trim()).filter(Boolean) });
        await reloadProject(); toast('Збережено', 'success'); render();
      }) }, 'Зберегти'))) : null,
  );
}
function budgetSettings(p) {
  const budget = TextInput({ type: 'number', min: 0.01, step: 0.01, value: p.budgetUsd ?? '', placeholder: 'без ліміту' });
  const c = state.costs;
  return PanelCard({ title: 'Бюджет проєкту', subtitle: `Витрачено ${usd(c?.totalUsd)}${p.budgetUsd != null ? ` з ${usd(p.budgetUsd)}` : ''}` },
    h('p', { class: 'text-2', style: 'margin:0' }, 'Коли сума звітованих витрат (задачі, планер, рецензії) досягає бюджету, HidForge не запускає нових задач. Долари звітує лише Claude Code; витрати інших CLI не враховуються в сумі.'),
    Field('Бюджет, $', budget, 'порожньо — без ліміту'),
    h('div', {}, PrimaryButton({ icon: 'check', onClick: act(async () => {
      await api('PATCH', `/api/projects/${p.id}`, { budgetUsd: budget.value ? Number(budget.value) : null });
      await reloadProject(); toast('Бюджет збережено', 'success'); render();
    }) }, 'Зберегти')));
}
/** JSON plugin adapters (read-only info) and the optional WSL2 backend. */
function agentsExtSettings() {
  const s = state.settings || {};
  const distro = TextInput({ value: s.wsl?.distro || '', placeholder: 'напр. Ubuntu', 'aria-label': 'Дистрибутив WSL' });
  const agents = TextInput({ value: (s.wsl?.agents || []).join(', '), placeholder: 'напр. claude, codex', 'aria-label': 'Агенти у WSL' });
  const save = act(async () => {
    const d = distro.value.trim();
    await api('PUT', '/api/settings', { wsl: d ? { distro: d, agents: agents.value.split(/[\s,]+/).filter(Boolean) } : null });
    await loadSettings(); toast('Збережено. Діє після перезапуску сервера', 'success'); render();
  });
  const plugins = (state.agents || []).filter((a) => a.notes?.some((n) => n.startsWith('JSON plugin')));
  return PanelCard({ title: 'Плагіни агентів і WSL2', subtitle: 'Додаткові CLI без зміни коду; запуск агентів у дистрибутиві WSL (експериментально)' },
    h('p', { class: 'text-2', style: 'margin:0;font-size:var(--fs-sm)' },
      `JSON-плагіни: ${plugins.map((a) => a.id).join(', ') || 'немає'}. Власні специфікації кладіть у `, h('span', { class: 'mono' }, '%LOCALAPPDATA%\\HidForge\\plugins\\*.json'),
      ' (формат — plugins\\gemini.json). Прапорці обходу дозволів і промпт в аргументах відхиляються при завантаженні. Діє після перезапуску.'),
    h('div', { class: 'grid cols-2' },
      Field('Дистрибутив WSL', distro, 'Порожньо — WSL не використовується'),
      Field('Агенти у WSL', agents, 'З’являться як окремі агенти з суфіксом -wsl')),
    h('div', {}, PrimaryButton({ icon: 'check', onClick: save }, 'Зберегти')));
}

const CHECK_TONE = { ok: 'success', info: 'neutral', warn: 'warning', error: 'danger' };
const CHECK_LABEL = { ok: 'OK', info: 'інфо', warn: 'увага', error: 'помилка' };

/** Diagnostics (doctor) and backups of the local state. */
function maintenanceSettings() {
  const diag = h('div', {});
  const backups = h('div', {});
  const kb = (b) => (b < 1048576 ? `${Math.max(1, Math.round(b / 1024))} КБ` : `${(b / 1048576).toFixed(1)} МБ`);
  const loadBackups = async () => {
    const r = await api('GET', '/api/backups');
    backups.replaceChildren(r.backups.length
      ? Table({ columns: [
        { label: 'Копія', class: 'grow', render: (b) => h('span', { class: 'mono' }, b.name) },
        { label: 'Створено (UTC)', render: (b) => b.createdAt.slice(0, 16).replace('T', ' ') },
        { label: 'Розмір', render: (b) => kb(b.sizeBytes) },
      ], rows: r.backups })
      : h('p', { class: 'muted', style: 'margin:0' }, 'Копій ще немає.'),
    h('p', { class: 'text-2', style: 'margin:0;font-size:var(--fs-sm)' }, 'Тека: ', h('span', { class: 'mono' }, r.dir),
      '. Автоматично — при запуску, не частіше разу на добу; зберігаються 10 останніх. Відновлення: зупиніть сервер і скопіюйте потрібну копію замість hidforge.db у теці даних (видаливши hidforge.db-wal і hidforge.db-shm).'));
  };
  const runDiag = act(async () => {
    diag.replaceChildren(h('p', { class: 'muted', style: 'margin:0' }, 'Перевіряю…'));
    const d = await api('GET', '/api/diagnostics');
    diag.replaceChildren(Table({ columns: [
      { label: 'Перевірка', render: (c) => h('strong', {}, c.label) },
      { label: 'Стан', render: (c) => Badge(CHECK_LABEL[c.level], CHECK_TONE[c.level]) },
      { label: 'Деталі', class: 'grow', render: (c) => h('span', { class: 'wrap' }, c.detail) },
    ], rows: d.checks }));
  });
  loadBackups().catch((e) => backups.replaceChildren(h('p', { class: 'muted' }, e.message)));
  return PanelCard({ title: 'Діагностика й резервні копії', subtitle: 'Стан середовища, бази й агентів; копії локального стану (SQLite)' },
    h('div', { class: 'row' },
      SecondaryButton({ icon: 'activity', onClick: runDiag }, 'Запустити діагностику'),
      SecondaryButton({ icon: 'check', onClick: act(async () => { await api('POST', '/api/backups'); await loadBackups(); toast('Резервну копію створено', 'success'); }) }, 'Створити копію зараз')),
    diag, backups);
}

/** Version, updates and stopping a server that was started without a terminal. */
function aboutSettings() {
  const info = h('div', {}, h('p', { class: 'muted', style: 'margin:0' }, 'Завантаження…'));
  api('GET', '/api/version').then((v) => info.replaceChildren(InfoList([
    ['Версія', h('span', { class: 'mono' }, `${v.version}${v.commit ? ` (${v.commit})` : ''}`)],
    ['Node.js', h('span', { class: 'mono' }, v.node)],
  ]))).catch((e) => info.replaceChildren(h('p', { class: 'muted', style: 'margin:0' }, e.message)));
  const stop = act(async () => {
    if (!await confirmModal('Зупинити сервер HidForge? Задачі, що виконуються, буде перервано й відновлено при наступному запуску.', { danger: true, ok: 'Зупинити' })) return;
    await api('POST', '/api/shutdown');
    mount(EmptyState({ icon: 'stop', title: 'Сервер зупинено', text: 'Запустіть HidForge знову ярликом «HidForge Orchestrator» або командою node src\\main.ts --open.' }));
  });
  return PanelCard({ title: 'Про програму', subtitle: 'Версія, оновлення, зупинка сервера' }, info,
    h('p', { class: 'text-2', style: 'margin:0;font-size:var(--fs-sm)' }, 'Оновлення: ', h('span', { class: 'mono' }, 'scripts\\update.ps1 -Check'), ' показує нові коміти, ',
      h('span', { class: 'mono' }, 'scripts\\update.ps1'), ' оновлює лише fast-forward (локальні зміни не перезаписуються). Після оновлення перезапустіть сервер.'),
    h('div', {}, DangerButton({ icon: 'stop', onClick: stop }, 'Зупинити сервер')));
}

function rolesSettings() {
  const s = state.settings;
  if (!s?.roleTemplates) return null;
  const rows = (s.roles || Object.keys(s.roleTemplates)).map((role) => {
    const t = s.roleTemplates[role] || { instructions: '', readOnly: false, providers: [] };
    return { role, instr: Textarea(t.instructions, { 'aria-label': `Інструкції ролі ${role}`, style: 'min-height:60px' }),
      ro: h('input', { type: 'checkbox', role: 'switch', checked: t.readOnly, 'aria-label': `${role}: лише читання` }),
      prov: TextInput({ value: t.providers.join(', '), placeholder: 'будь-які', 'aria-label': `${role}: дозволені агенти` }) };
  });
  const save = act(async () => {
    const roleTemplates = Object.fromEntries(rows.map((r) => [r.role, { instructions: r.instr.value, readOnly: r.ro.checked, providers: r.prov.value.split(/[\s,]+/).filter(Boolean) }]));
    await api('PUT', '/api/settings', { roleTemplates }); await loadSettings(); toast('Шаблони ролей збережено', 'success'); render();
  });
  return PanelCard({ flush: true, title: 'Ролі: шаблони й дозволи', subtitle: 'Інструкції додаються в контракт задачі; «лише читання» і дозволені агенти примусово застосовує планувальник' },
    Table({ columns: [
      { label: 'Роль', render: (r) => h('strong', {}, r.role) },
      { label: 'Інструкції для агента', class: 'grow', render: (r) => r.instr },
      { label: 'Лише читання', render: (r) => h('label', { class: 'toggle' }, r.ro) },
      { label: 'Дозволені агенти', render: (r) => r.prov },
    ], rows }),
    h('div', { class: 'row', style: 'padding:var(--s-4) var(--s-5);border-top:1px solid var(--border)' },
      h('span', { class: 'text-2', style: 'flex:1;font-size:var(--fs-sm)' }, `Агенти: ${(state.agents || []).map((a) => a.id).join(', ') || '…'}. Порожньо — будь-які.`),
      PrimaryButton({ icon: 'check', onClick: save }, 'Зберегти ролі')));
}
function trustSettings() {
  const trust = state.settings?.agentTrust || {};
  const cursor = (state.agents || []).find((a) => a.id === 'cursor');
  if (!cursor?.installed) return null;
  return PanelCard({ title: 'Довіра до робочих каталогів', subtitle: 'Cursor Agent CLI' },
    h('div', { class: 'callout' }, h('strong', {}, 'Ваше свідоме рішення'),
      h('div', { class: 'text-2' }, 'Cursor у headless-режимі працює лише в «довіреному» каталозі. Увімкнення передає Cursor прапорець --trust для worktree, які створює HidForge (копії вашого репозиторію). Прапорці --force / --yolo не передаються ніколи.')),
    Toggle({ label: 'Довіряти worktree HidForge для Cursor', checked: trust.cursor === true, onChange: act(async (v) => {
      await api('PUT', '/api/settings', { agentTrust: { ...trust, cursor: v } }); await loadSettings(); toast(v ? 'Довіру ввімкнено' : 'Довіру вимкнено', 'success'); render();
    }) }));
}
function reviewSettings(p) {
  const pol = p.reviewPolicy || { mode: 'off', provider: 'auto', model: null };
  const reviewers = (state.agents || []).filter((a) => a.mock || a.capabilities.readOnlyMode === 'supported');
  const mode = Select([['off', 'Вимкнено'], ['advisory', 'Дорадчий — лише показує вердикт'], ['required', 'Обов\'язковий — merge лише після «схвалено»']], pol.mode);
  const prov = Select([['auto', 'auto (за політикою)'], ...reviewers.map((a) => [a.id, a.mock ? 'mock (демо, не AI)' : `${a.name}${a.available ? '' : ' (недоступний)'}`])], pol.provider);
  const model = ModelInput(prov, pol.model);
  return PanelCard({ title: 'AI-рецензент', subtitle: `QA + Security · проєкт «${p.name}»` },
    h('p', { class: 'text-2', style: 'margin:0' }, 'Після успішних gate-ів окремий агент у режимі лише читання перевіряє diff задачі. В обов\'язковому режимі «потрібні зміни» автоматично повертає задачу агенту із зауваженнями, а Approve & Merge доступний лише після вердикту «схвалено». Остаточне рішення завжди за вами.'),
    h('div', { class: 'form-grid', style: 'grid-template-columns:repeat(auto-fit,minmax(200px,1fr))' },
      Field('Режим', mode), Field('Агент-рецензент', prov, state.agents ? null : 'перевірка агентів…'), Field('Модель', model)),
    h('div', {}, PrimaryButton({ icon: 'check', onClick: act(async () => {
      await api('PATCH', `/api/projects/${p.id}`, { reviewPolicy: { mode: mode.value, provider: prov.value, model: modelValue(model) } });
      await reloadProject(); toast('Політику рецензії збережено', 'success'); render();
    }) }, 'Зберегти')));
}
function applyTheme() {
  let t = ls.get('hf-theme') || 'dark';
  if (t === 'system') t = matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', t);
}

// ---------------------------------------------------------------- live stream
let refreshTimer = null;
function connectStream() {
  state.es?.close();
  state.es = new EventSource(`/api/stream?projectId=${state.projectId}`);
  state.es.onopen = () => { state.live = true; renderShell(); };
  state.es.onerror = () => { state.live = false; renderShell(); };
  state.es.onmessage = (m) => {
    const e = JSON.parse(m.data);
    if (e.taskId === state.taskId && state.editing == null) appendLog(e);
    if (e.type === 'plan.output') { appendPlanLog(e); return; }
    if (e.type === 'run.output' || e.type === 'review.output') return;
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      if (state.editing != null || document.querySelector('dialog[open]')) return; // never wipe a form or modal in progress
      reloadProject().then(render).catch(() => {});
    }, 150);
  };
}

// ---------------------------------------------------------------- boot
$('#brand').prepend(logo());
$('#addProjectSlot').replaceWith(IconButton({ icon: 'plus', label: 'Відкрити проєкт', variant: 'secondary', onClick: addProjectModal }));
$('#menuSlot').replaceWith(IconButton({ icon: 'menu', label: 'Меню', class: 'menu-btn', onClick: () => document.body.classList.toggle('nav-open') }));
$('#scrim').onclick = () => document.body.classList.remove('nav-open');
$('#projectSel').onchange = act(async (e) => { if (e.target.value) await selectProject(Number(e.target.value)); });
addEventListener('hashchange', () => { route(); render(); $('#page').focus({ preventScroll: true }); });
matchMedia('(prefers-color-scheme: light)').addEventListener('change', applyTheme);

route();
await Promise.all([loadSettings(), loadProjects()]).catch((e) => toast(e.message, 'danger'));
const last = Number(ls.get('hf-project'));
const first = state.projects.some((p) => p.id === last) ? last : state.projects[0]?.id;
if (first) { state.projectId = first; await reloadProject().catch((e) => toast(e.message, 'danger')); connectStream(); }
render();
loadAgents().then(render).catch((e) => toast(e.message, 'danger'));
