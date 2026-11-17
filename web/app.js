// HidForge UI — pages composed from shared components in ui.js. Hash routing, no build step.
import {
  h, icon, logo, Button, PrimaryButton, SecondaryButton, GhostButton, DangerButton, IconButton, Badge, StatusBadge, STATUS_LABEL,
  PermissionChip, Disclosure, PageHeader, SectionHeader, PanelCard, StatCard, StatLink, InfoList, ItemCard, EmptyState, ActivityFeed, Field, TextInput,
  Textarea, Select, SearchInput, Toggle, Tabs, Segmented, Table, openModal, confirmModal, promptModal, DropdownMenu, toast,
  Kanban, DagGraph, EventCard, statusTone, Progress,
} from './ui.js';

const TOKEN = document.querySelector('meta[name="hidforge-token"]').content;
const $ = (s) => document.querySelector(s);
const ls = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* blocked */ } } };
const state = {
  projects: [], agents: null, settings: null, projectId: null, project: null, tasks: [], plans: [], activity: [],
  page: 'overview', taskId: null, editing: null, filter: ls.get('hf-filter') || 'all', view: ls.get('hf-view') || 'table', query: '', showCanceled: false,
  detailTab: 'log', reportsTab: 'report', reportsData: null, diag: null, es: null, live: false, costs: null, models: {},
  projectsQuery: '', projectSummaries: {}, projectSummariesPending: {},
  activityLog: null, activityFilter: 'all', activityTaskQuery: '', activityShowOutput: false,
};
const ROLES = ['Project Manager/Planner', 'Architect', 'Frontend', 'Backend', 'QA', 'Security Reviewer', 'Integrator'];
const PAGES = [
  { id: 'projects', label: 'Проєкти', icon: 'projects' },
  { id: 'overview', label: 'Огляд', icon: 'overview' },
  { id: 'plan', label: 'План проєкту', icon: 'stages' },
  { id: 'tasks', label: 'Задачі', icon: 'tasks' },
  { id: 'planner', label: 'AI-планер', icon: 'planner' },
  { id: 'agents', label: 'Агенти', icon: 'agents' },
  { id: 'activity', label: 'Журнал подій', icon: 'activity' },
  { id: 'costs', label: 'Витрати', icon: 'costs' },
  { id: 'models', label: 'Аналітика моделей', icon: 'chart' },
  { id: 'reports', label: 'Звіти й рішення', icon: 'report' },
  { id: 'system', label: 'Система', icon: 'system' },
  { id: 'settings', label: 'Налаштування', icon: 'settings' },
];
const CATEGORY_LABEL = { ui_visual: 'Візуал / UI', frontend_logic: 'Логіка фронтенду', backend: 'Бекенд', bugfix: 'Виправлення помилки', refactor: 'Рефакторинг',
  architecture: 'Архітектура', tests: 'Тести', docs: 'Документація', small_edit: 'Дрібна правка', planning: 'Планування' };
const COMPLEXITY_LABEL = { low: 'проста', medium: 'середня', high: 'складна' };
const EFFORT_LABEL = { low: 'низькі', medium: 'середні', high: 'високі', xhigh: 'надвисокі — швидко витрачають ліміти', max: 'максимальні — швидко витрачають ліміти' };
const kindLabel = (t) => (t.category ? `${CATEGORY_LABEL[t.category] || t.category} · ${COMPLEXITY_LABEL[t.complexity || 'medium']}` : null);
const linkText = (l) => [l.agent, l.model, l.effort].filter(Boolean).join(' ');
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
const agentState = (a) => (a.apiOnly && a.auth === 'missing' ? ['потрібен ключ API', 'neutral'] : !a.installed ? ['не встановлено', 'danger'] : a.auth === 'missing' ? ['немає авторизації', 'danger']
  : a.auth === 'unknown' ? ['авторизація невідома', 'warning'] : ['готовий', 'success']);
/** The Mock agent is a demo tool: shown only in a project that already uses it (the demo project). */
const usesMock = () => state.tasks.some((t) => t.provider === 'mock');
const agentList = () => (state.agents || []).filter((a) => !a.mock || usesMock());
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
    p.id === 'agents' && state.agents ? h('span', { class: 'count' }, `${state.agents.filter((a) => a.available && !a.mock).length}/${state.agents.filter((a) => !a.mock && !(a.apiOnly && !a.available)).length}`) : null)));
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
async function loadProjects() {
  state.projects = await api('GET', '/api/projects');
  const ids = new Set(state.projects.map((p) => String(p.id)));
  for (const id of Object.keys(state.projectSummaries)) if (!ids.has(id)) delete state.projectSummaries[id];
}
async function loadAgents(refresh = false) { state.agents = await api('GET', '/api/agents' + (refresh ? '?refresh=1' : '')); }
async function loadSettings() { state.settings = await api('GET', '/api/settings'); }
async function reloadProject() {
  if (!state.projectId) return;
  const [{ project, tasks }, plans, activity] = await Promise.all([
    api('GET', `/api/projects/${state.projectId}`), api('GET', `/api/projects/${state.projectId}/plans`),
    api('GET', `/api/events?projectId=${state.projectId}&type=task.status&before=9007199254740991&limit=14`)]);
  Object.assign(state, { project, tasks, plans, activity: activity.slice(-14).reverse() });
  state.projectSummaries[project.id] = projectTaskCounts(tasks);
  [state.costs, state.planView] = await Promise.all([api('GET', `/api/projects/${state.projectId}/costs`).catch(() => null),
    api('GET', `/api/projects/${state.projectId}/plan-progress`).catch(() => null)]);
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
  const needsProject = ['overview', 'plan', 'tasks', 'planner', 'activity', 'costs', 'reports'].includes(state.page);
  if (needsProject && !state.project) { pg.replaceChildren(noProject()); return; }
  ({ projects: projectsPage, overview: overviewPage, plan: planPage, tasks: tasksPage, planner: plannerPage, agents: agentsPage,
    activity: activityPage, costs: costsPage, models: modelsPage, reports: reportsPage, system: systemPage, settings: settingsPage })[state.page]();
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

// ---------------------------------------------------------------- page: projects
/** Project cards are cached so SSE refreshes never refetch every repository. */
function projectTaskCounts(tasks = []) {
  const countStatus = (statuses) => tasks.filter((t) => statuses.includes(t.status)).length;
  return { active: countStatus(ACTIVE), attention: countStatus(ATTENTION), merged: countStatus(['merged']),
    problems: countStatus(PROBLEM) };
}

async function loadProjectSummaries() {
  const missing = state.projects.filter((p) => state.projectSummaries[p.id] == null && !state.projectSummariesPending[p.id]);
  await Promise.all(missing.map(async (p) => {
    state.projectSummariesPending[p.id] = true;
    try {
      const result = await api('GET', `/api/projects/${p.id}`);
      state.projectSummaries[p.id] = projectTaskCounts(result.tasks || []);
    } catch (e) {
      state.projectSummaries[p.id] = { error: e.message };
    } finally {
      delete state.projectSummariesPending[p.id];
      if (state.page === 'projects') renderProjectCards();
    }
  }));
}

const createDemoProject = act(async () => {
  const p = await api('POST', '/api/demo');
  await loadProjects();
  await selectProject(p.id);
  go('#/overview');
  toast('Демо-проєкт створено', 'success');
});

function projectButtons() {
  return [
    SecondaryButton({ icon: 'folder', onClick: addProjectModal }, 'Відкрити проєкт'),
    PrimaryButton({ icon: 'plus', onClick: createDemoProject }, 'Створити демо-проєкт'),
  ];
}

const projectDate = (value) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? (value || '—') : date.toLocaleString('uk-UA', { dateStyle: 'medium', timeStyle: 'short' });
};

async function editProjectGoal(p) {
  const goal = await promptModal('Ціль проєкту', {
    title: `Змінити ціль · ${p.name}`, ok: 'Зберегти', value: p.goal || '',
  });
  if (goal === null || goal === (p.goal || '')) return;
  await api('PATCH', `/api/projects/${p.id}`, { goal });
  await loadProjects();
  if (state.projectId === p.id) await reloadProject();
  if (state.page === 'projects') { renderProjectCards(); renderShell(); }
  else render();
  toast('Ціль проєкту збережено', 'success');
}

function renderProjectCards() {
  const cards = $('#projectCards');
  if (!cards || state.page !== 'projects') return;
  const query = state.projectsQuery.trim().toLowerCase();
  const projects = state.projects.filter((p) => `${p.name} ${p.repoPath}`.toLowerCase().includes(query));
  cards.replaceChildren(...(projects.length ? projects.map((p) => {
    const summary = state.projectSummaries[p.id];
    const counters = summary?.error ? Badge('Статистика недоступна', 'danger', { title: summary.error })
      : summary ? h('div', { class: 'project-counts row' },
        Badge(`Активні: ${summary.active}`, 'info'),
        Badge(`Увага: ${summary.attention}`, 'warning'),
        Badge(`Злито: ${summary.merged}`, 'success'),
        Badge(`Проблеми: ${summary.problems}`, summary.problems ? 'danger' : 'neutral'))
      : h('span', { class: 'muted' }, 'Завантаження статистики задач…');
    return ItemCard({
      class: 'project-card', icon: 'projects', title: p.name,
      status: state.projectId === p.id ? Badge('Відкритий', 'accent') : null,
      body: h('div', { class: 'stack' },
        InfoList([
          ['Репозиторій', h('code', { class: 'wrap' }, p.repoPath || '—')],
          ['Базова гілка', h('code', { class: 'wrap' }, p.baseBranch || '—')],
          ['Ціль', h('div', { class: 'pre-wrap' }, p.goal || 'Не задано')],
          ['Бюджет', p.budgetUsd == null ? 'без ліміту' : usd(p.budgetUsd)],
          ['Створено', h('time', { datetime: p.createdAt || '' }, projectDate(p.createdAt))],
        ]),
        counters),
      footer: [
        PrimaryButton({ icon: 'folder', size: 'sm', onClick: act(async () => {
          await selectProject(p.id);
          go('#/overview');
        }) }, 'Відкрити'),
        SecondaryButton({ icon: 'edit', size: 'sm', onClick: act(() => editProjectGoal(p)) }, 'Змінити ціль'),
        DangerButton({ icon: 'trash', size: 'sm', onClick: act(() => deleteProject(p)) }, 'Видалити'),
      ],
    });
  }) : [PanelCard({}, EmptyState({ icon: 'search', title: 'Проєктів не знайдено',
    text: 'Спробуйте іншу назву або шлях до репозиторію.' }))]));
}

async function deleteProject(p) {
  const ok = await confirmModal(`Видалити проєкт «${p.name}» з HidForge? Буде видалено його задачі, історію запусків, плани й робочі копії задач (worktree). Ваш репозиторій і гілки задач у ньому не зміняться. Скасувати видалення неможливо.`,
    { title: 'Видалити проєкт', danger: true, ok: 'Видалити проєкт' });
  if (!ok) return;
  const r = await api('DELETE', `/api/projects/${p.id}`);
  toast(r.keptBranches.length ? `Проєкт видалено. Незлиті гілки задач лишились у репозиторії: ${r.keptBranches.join(', ')}` : 'Проєкт видалено', 'success');
  delete state.projectSummaries[p.id];
  await loadProjects();
  if (state.projectId === p.id) {
    const next = state.projects[0];
    if (next) { await selectProject(next.id); return; }
    state.es?.close();
    Object.assign(state, { projectId: null, project: null, tasks: [], plans: [], activity: [], costs: null, planView: null, live: false });
    ls.set('hf-project', '');
  }
  render();
}

function projectsPage() {
  const n = state.projects.length;
  const noun = n % 100 >= 11 && n % 100 <= 14 ? 'проєктів'
    : n % 10 === 1 ? 'проєкт' : n % 10 >= 2 && n % 10 <= 4 ? 'проєкти' : 'проєктів';
  mount(
    PageHeader({ title: 'Проєкти', subtitle: 'Робочі репозиторії, цілі та стан задач',
      meta: Badge(`${n} ${noun}`, 'neutral', { plain: true }), actions: projectButtons() }),
    state.projects.length ? h('div', { class: 'project-search' },
      SearchInput({ placeholder: 'Пошук за назвою або шляхом…', value: state.projectsQuery,
        onInput: (e) => { state.projectsQuery = e.target.value; renderProjectCards(); } })) : null,
    state.projects.length ? h('div', { id: 'projectCards', class: 'grid project-grid' })
      : PanelCard({}, EmptyState({ icon: 'projects', title: 'Проєктів ще немає',
        text: 'Відкрийте Git-репозиторій або створіть демо-проєкт для знайомства з HidForge.',
        action: h('div', { class: 'row' }, projectButtons()) })),
  );
  renderProjectCards();
  if (state.projects.length) void loadProjectSummaries();
}

// ---------------------------------------------------------------- page: overview
/** Open the full report and ADR workspace from the overview. */
function reportButton() {
  return SecondaryButton({ icon: 'report', onClick: () => go('#/reports') }, 'Звіт і рішення');
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
      StatLink({ href: '#/plan', label: 'Виконано (приблизно)', value: state.planView ? `${state.planView.pct}%` : '—', tone: 'accent',
        hint: state.planView?.currentStage ? `етап ${state.planView.currentStage} з ${state.planView.stages.length}` : 'план порожній' }),
      StatCard({ label: 'Усього задач', value: state.tasks.length, hint: `${count(['draft'])} чернеток` }),
      StatCard({ label: 'Виконується', value: count(ACTIVE), tone: 'info', hint: `з них у роботі: ${count(['running'])}` }),
      StatCard({ label: 'Потребують уваги', value: count(ATTENTION), tone: 'warning', hint: 'рев\'ю та запитання' }),
      StatCard({ label: 'Злито', value: count(['merged']), tone: 'success' }),
      StatCard({ label: 'Проблеми', value: count(PROBLEM), tone: count(PROBLEM) ? 'danger' : undefined, hint: 'помилка / заблоковано' }),
      StatLink({ href: '#/costs', label: 'Витрати', value: usd(state.costs?.totalUsd), tone: state.costs?.budgetUsd != null && state.costs.remainingUsd <= 0 ? 'danger' : undefined,
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
        state.agents ? h('div', { class: 'stack' }, ...agentList().map((a) => { const [l, tone] = agentState(a); return h('div', { class: 'row between' }, h('span', {}, a.name, a.version ? h('span', { class: 'muted' }, ` ${a.version}`) : null), Badge(l, tone)); }))
          : h('p', { class: 'muted' }, 'Перевірка агентів…'))),
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

// ---------------------------------------------------------------- page: activity
const ACTIVITY_PAGE_SIZE = 200;
const ACTIVITY_CACHE_LIMIT = 2000;
const ACTIVITY_FIRST_BEFORE = Number.MAX_SAFE_INTEGER;
const ACTIVITY_FILTERS = [
  ['all', 'Усі'], ['task', 'Задачі'], ['run', 'Запуски'], ['review', 'Рецензії'],
  ['plan', 'Планер'], ['error', 'Помилки'],
];
const EVENT_LABELS = {
  'project.created': 'Проєкт створено', 'task.created': 'Задачу створено', 'task.deleted': 'Задачу видалено',
  'task.status': 'Статус задачі', 'task.routed': 'Маршрутизація', 'task.evidence': 'Докази',
  'run.started': 'Запуск агента', 'run.output': 'Вивід агента', 'run.recovered': 'Відновлення запуску',
  'review.started': 'AI-рецензія', 'review.status': 'Статус рецензії', 'review.output': 'Вивід рецензента',
  'plan.started': 'Планування', 'plan.status': 'Статус плану', 'plan.output': 'Вивід планера',
  'integration.failed': 'Помилка інтеграції', 'scheduler.error': 'Помилка планувальника задач',
};
const isOutputEvent = (e) => e.type.endsWith('.output');
const isErrorEvent = (e) => e.type.endsWith('.failed') || e.type.endsWith('.error') || e.data?.ok === false
  || ['failed', 'error', 'blocked'].includes(e.data?.status) || ['failed', 'blocked'].includes(e.data?.to);
const eventTone = (e) => isOutputEvent(e) ? 'neutral' : isErrorEvent(e) ? 'danger'
  : ['succeeded', 'merged'].includes(e.data?.status) || ['succeeded', 'merged'].includes(e.data?.to) ? 'success'
    : e.type === 'task.status' || e.type === 'review.status' || e.type === 'plan.status' ? 'info' : 'neutral';

function activityStore(pid) {
  if (!state.activityLog || state.activityLog.pid !== pid) {
    state.activityLog = { pid, events: [], loaded: false, loading: false, hasMore: false, error: null, unread: 0 };
  }
  return state.activityLog;
}

function activitySummary(e) {
  const d = e.data || {};
  const note = d.note || d.reason || d.error || d.message;
  const withNote = (s) => `${s}${note ? ` · ${String(note)}` : ''}`;
  switch (e.type) {
    case 'project.created': return `Створено проєкт${d.name ? ` «${d.name}»` : ''}`;
    case 'task.created': return `Створено задачу${d.title ? ` «${d.title}»` : ''}`;
    case 'task.deleted': return withNote('Задачу видалено');
    case 'task.status': return withNote(`статус → ${STATUS_LABEL[d.to] || d.to || 'невідомий'}`);
    case 'task.routed': return withNote(`Призначено: ${[d.provider || d.to || 'автовибір', d.model, d.effort].filter(Boolean).join(' · ')}${d.link ? ` (ланка ${d.link} з ${d.of})` : ''}`);
    case 'task.evidence': return withNote(d.summary || 'Додано результати перевірки');
    case 'run.started': return `Агент: ${[d.provider || d.command?.split(/[\\/]/).pop() || 'невідомий', d.model, d.effort].filter(Boolean).join(' · ')} · спроба #${d.attempt ?? '—'}`;
    case 'run.recovered': return withNote('Відновлено перерваний запуск');
    case 'review.started': return `Рецензент: ${[d.provider || 'невідомий', d.model, d.effort].filter(Boolean).join(' · ')} · спроба #${d.attempt ?? '—'}`;
    case 'review.status': return withNote(`Рецензія: ${d.status || 'оновлено'}${d.verdict ? ` · ${d.verdict}` : ''}`);
    case 'plan.started': return `Планер: ${d.provider || 'автовибір'}`;
    case 'plan.status': return withNote(`План: ${d.status || 'оновлено'}`);
    case 'integration.failed': return withNote('Не вдалося інтегрувати зміни');
    case 'scheduler.error': return withNote('Помилка планувальника задач');
    default:
      if (isOutputEvent(e)) {
        const text = String(d.text || '').replace(/\s+/g, ' ').trim();
        return text.length > 160 ? `${text.slice(0, 160)}…` : text || 'Порожній вивід';
      }
      return String(d.summary || note || 'Подія записана в журнал').slice(0, 240);
  }
}

function activityMatches(e) {
  if (!state.activityShowOutput && isOutputEvent(e)) return false;
  const filter = state.activityFilter;
  if (filter === 'error' && !isErrorEvent(e)) return false;
  if (filter !== 'all' && filter !== 'error' && !e.type.startsWith(`${filter}.`)) return false;
  const taskQuery = state.activityTaskQuery.trim();
  return !taskQuery || String(e.taskId ?? '') === taskQuery;
}

const filteredActivity = () => (state.activityLog?.events || []).filter(activityMatches);
function activityClock(ts) {
  const date = new Date(ts);
  return Number.isNaN(date.getTime()) ? ts : date.toLocaleString('uk-UA', { dateStyle: 'short', timeStyle: 'medium' });
}

/** Merge live and paged events by event ID, newest first, bounded to 2000. */
function mergeActivityEvents(current, incoming) {
  const byId = new Map();
  for (const e of [...current, ...incoming]) if (Number.isSafeInteger(e.id)) byId.set(e.id, e);
  return [...byId.values()].sort((a, b) => b.id - a.id).slice(0, ACTIVITY_CACHE_LIMIT);
}

function updateActivityControls() {
  if (state.page !== 'activity') return;
  const log = activityStore(state.projectId);
  const counts = $('#activityCounts');
  if (counts) counts.replaceChildren(...clean(
    h('span', { class: 'muted' }, `Показано ${filteredActivity().length} із ${log.events.length} завантажених`),
    log.unread ? SecondaryButton({ icon: 'refresh', size: 'sm', onClick: () => {
      const feed = $('#activityStream'); if (feed) feed.scrollTop = 0;
      log.unread = 0; updateActivityControls();
    } }, `${log.unread} нових · До початку`) : null,
  ));
  const footer = $('#activityFooter');
  if (footer) footer.replaceChildren(...clean(
    log.error ? h('p', { class: 'text-2 wrap' }, `Помилка завантаження: ${log.error}`) : null,
    log.hasMore && log.events.length < ACTIVITY_CACHE_LIMIT
      ? SecondaryButton({ icon: 'refresh', disabled: log.loading, onClick: act(() => loadActivityEvents(false)) },
        log.loading ? 'Завантаження…' : 'Завантажити старіші') : null,
    log.events.length === ACTIVITY_CACHE_LIMIT ? h('span', { class: 'muted' }, 'У кеші максимум 2000 подій.') : null,
  ));
}

function renderActivityFeed({ resetScroll = false, keepPosition = false } = {}) {
  const feed = $('#activityStream');
  if (!feed || state.page !== 'activity' || state.activityLog?.pid !== state.projectId) return;
  const log = state.activityLog;
  const beforeHeight = feed.scrollHeight;
  const beforeTop = feed.scrollTop;
  const atTop = beforeTop <= 40 || resetScroll;
  const opened = new Set([...feed.querySelectorAll('details[open][data-event-id]')].map((el) => el.dataset.eventId));
  const visible = filteredActivity();
  feed.replaceChildren(...(visible.length ? visible.map((e) => {
    const task = e.taskId == null ? null : h('a', { class: 'activity-task', href: `#/tasks/${e.taskId}` }, `Задача #${e.taskId}`);
    const row = EventCard({ id: e.id, ts: e.ts, time: activityClock(e.ts),
      label: EVENT_LABELS[e.type] || e.type, rawType: e.type, tone: eventTone(e), task,
      summary: activitySummary(e), data: e.data });
    const details = row.querySelector('details');
    if (opened.has(String(e.id))) details.open = true;
    return row;
  }) : [EmptyState({ icon: 'activity', title: log.error ? 'Не вдалося завантажити події'
    : !log.loaded ? 'Завантаження подій…' : 'Подій не знайдено',
    text: log.error || (log.loaded ? 'Спробуйте змінити фільтри або завантажити старіші події.'
      : 'Завантажуємо журнал подій цього проєкту.') })]));
  if (atTop) { feed.scrollTop = 0; if (log.unread) log.unread = 0; }
  else feed.scrollTop = keepPosition ? beforeTop : Math.max(0, beforeTop + feed.scrollHeight - beforeHeight);
  updateActivityControls();
}

let activityPaintQueued = false;
function scheduleActivityPaint() {
  if (activityPaintQueued) return;
  activityPaintQueued = true;
  requestAnimationFrame(() => { activityPaintQueued = false; renderActivityFeed(); });
}

function addLiveActivityEvent(e) {
  const log = state.activityLog;
  if (!log || log.pid !== state.projectId || !Number.isSafeInteger(e.id)) return;
  if (log.events.some((x) => x.id === e.id)) return;
  const feed = $('#activityStream');
  const wasBelow = Boolean(feed && feed.scrollTop > 40);
  log.events = mergeActivityEvents(log.events, [e]);
  if (state.page === 'activity') {
    if (wasBelow && activityMatches(e)) log.unread++;
    scheduleActivityPaint();
  }
}

async function loadActivityEvents(reset = false) {
  const pid = state.projectId;
  const log = activityStore(pid);
  if (log.loading || (!reset && (!log.hasMore || !log.events.length))) return;
  const before = reset ? ACTIVITY_FIRST_BEFORE : Math.min(...log.events.map((e) => e.id));
  const newestAtStart = log.events[0]?.id ?? 0;
  log.loading = true;
  log.error = null;
  updateActivityControls();
  try {
    const events = await api('GET', `/api/events?projectId=${pid}&before=${before}&limit=${ACTIVITY_PAGE_SIZE}`);
    if (!Array.isArray(events)) throw new Error('Сервер повернув некоректний список подій');
    if (state.activityLog !== log || state.projectId !== pid) return;
    const baseline = reset ? log.events.filter((e) => e.id > newestAtStart) : log.events;
    log.events = mergeActivityEvents(baseline, events);
    log.loaded = true;
    log.hasMore = events.length === ACTIVITY_PAGE_SIZE;
    log.unread = reset ? 0 : log.unread;
    renderActivityFeed({ resetScroll: reset, keepPosition: !reset });
  } catch (e) {
    log.error = e.message;
    if (state.activityLog === log && state.page === 'activity') renderActivityFeed();
    toast(`Не вдалося завантажити події: ${e.message}`, 'danger');
  } finally {
    log.loading = false;
    if (state.activityLog === log && state.page === 'activity') updateActivityControls();
  }
}

function downloadActivityJson() {
  const events = filteredActivity();
  const filename = `hidforge-events-${state.projectId}-${new Date().toISOString().slice(0, 10)}.json`;
  const href = URL.createObjectURL(new Blob([JSON.stringify(events, null, 2)], { type: 'application/json;charset=utf-8' }));
  const a = h('a', { href, download: filename });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 1000);
}

function activityPage() {
  const log = activityStore(state.projectId);
  const filter = Select(ACTIVITY_FILTERS, state.activityFilter, { onchange: (e) => {
    state.activityFilter = e.target.value;
    log.unread = 0; renderActivityFeed({ resetScroll: true });
  } });
  const task = TextInput({ type: 'number', min: 1, step: 1, placeholder: 'Усі задачі',
    value: state.activityTaskQuery, oninput: (e) => {
      state.activityTaskQuery = e.target.value;
      log.unread = 0; renderActivityFeed({ resetScroll: true });
    } });
  const feed = h('div', { id: 'activityStream', class: 'activity-stream', role: 'feed',
    'aria-label': 'Журнал подій', tabindex: 0 });
  feed.addEventListener('scroll', () => {
    if (feed.scrollTop <= 40 && log.unread) { log.unread = 0; updateActivityControls(); }
  });
  mount(
    PageHeader({ title: 'Журнал подій', subtitle: 'Історія дій агентів, запусків, рецензій і помилок',
      meta: projectMeta(state.project), actions: [
        SecondaryButton({ icon: 'refresh', onClick: act(() => loadActivityEvents(true)) }, 'Оновити'),
        SecondaryButton({ icon: 'report', onClick: downloadActivityJson }, 'Завантажити .json'),
      ] }),
    PanelCard({ title: 'Фільтри' }, h('div', { class: 'activity-filters' },
      Field('Тип подій', filter), Field('Номер задачі', task),
      Toggle({ label: 'Показувати вивід агентів', checked: state.activityShowOutput, onChange: (value) => {
        state.activityShowOutput = value;
        log.unread = 0; renderActivityFeed({ resetScroll: true });
      } }))),
    PanelCard({ title: 'Події', subtitle: 'Від новіших до старіших',
      actions: h('div', { id: 'activityCounts', class: 'row' }) },
    feed, h('div', { id: 'activityFooter', class: 'activity-footer row' })),
  );
  renderActivityFeed();
  if (!log.loaded && !log.loading) void loadActivityEvents(true);
}

// ---------------------------------------------------------------- page: costs
function costsPage() {
  const p = state.project;
  const c = state.costs;
  const providers = c?.byProvider || [];
  const sessions = providers.reduce((sum, x) => sum + (x.sessions || 0), 0);
  const budget = c?.budgetUsd ?? p.budgetUsd ?? null;
  const remaining = c?.remainingUsd ?? null;
  mount(
    PageHeader({ title: 'Витрати', subtitle: 'Витрати, токени, сесії агентів і бюджет проєкту', meta: projectMeta(p),
      actions: SecondaryButton({ icon: 'refresh', onClick: act(async () => { await reloadProject(); render(); }) }, 'Оновити') }),
    h('div', { class: 'grid stats' },
      StatCard({ label: 'Витрачено', value: c ? usd(c.totalUsd) : '—' }),
      StatCard({ label: 'Бюджет', value: budget == null ? 'не задано' : usd(budget) }),
      StatCard({ label: 'Лишилось', value: budget == null ? '—' : remaining == null ? '—' : usd(remaining),
        tone: budget != null && remaining != null && remaining <= 0 ? 'danger' : undefined }),
      StatCard({ label: 'Сесій усього', value: c ? sessions : '—' })),
    PanelCard({ title: 'Розподіл за видом', subtitle: 'Звітовані витрати у USD' },
      c ? InfoList([
        ['Задачі', usd(c.byKind?.task)],
        ['AI-планер', usd(c.byKind?.planner)],
        ['AI-рецензії', usd(c.byKind?.review)],
      ]) : h('p', { class: 'muted' }, 'Не вдалося завантажити розподіл витрат.')),
    h('p', { class: 'text-2', style: 'margin:0' },
      'Важливо: USD-витрати звітує лише Claude Code. Інші CLI повідомляють тільки про токени, тому фактичні витрати можуть бути вищими.'),
    !c ? PanelCard({}, EmptyState({ icon: 'alert', title: 'Дані витрат недоступні',
      text: 'Перевірте сервер і натисніть «Оновити».' }))
      : sessions ? costsPanel() : PanelCard({}, EmptyState({ icon: 'costs', title: 'Сесій ще немає',
        text: 'Після запуску задач, планера або рецензій тут з’явиться статистика агентів.' })),
    budgetSettings(p),
  );
}

// ---------------------------------------------------------------- page: project plan
const AGENT_SOURCE = { running: ['працює зараз', 'accent'], next: ['наступна спроба', 'neutral'], last: ['остання спроба', 'neutral'] };
const agentCell = (a) => (a ? h('div', { class: 'stack tight' }, h('span', { class: 'mono' }, [a.provider, a.model, a.effort].filter(Boolean).join(' · ')),
  Badge(AGENT_SOURCE[a.source][0], AGENT_SOURCE[a.source][1], { plain: a.source !== 'running', live: a.source === 'running' })) : h('span', { class: 'muted' }, '—'));
function planPage() {
  const v = state.planView;
  const header = PageHeader({ title: 'План проєкту', subtitle: 'Етапи за залежностями задач: що вже зроблено, хто, якою моделлю й з якими зусиллями працює зараз',
    meta: projectMeta(state.project), actions: [SecondaryButton({ icon: 'refresh', onClick: act(async () => { await reloadProject(); render(); }) }, 'Оновити'), runPlanButton()] });
  if (!v) { mount(header, PanelCard({}, EmptyState({ icon: 'alert', title: 'План недоступний', text: 'Не вдалося завантажити план. Перевірте сервер і натисніть «Оновити».' }))); return; }
  if (!v.total) {
    mount(header, PanelCard({}, EmptyState({ icon: 'stages', title: 'Плану ще немає', text: 'Задайте ціль проєкту і згенеруйте план AI-планером або додайте задачі вручну.',
      action: PrimaryButton({ icon: 'planner', onClick: () => go('#/planner') }, 'Згенерувати план') })));
    return;
  }
  const running = v.stages.flatMap((s) => s.tasks.filter((t) => t.status === 'running').map((t) => ({ ...t, stage: s.n })));
  const stageBadge = (s) => (s.done === s.total ? Badge('завершено', 'success') : s.current ? Badge('поточний етап', 'accent') : Badge('очікує', 'neutral'));
  mount(header,
    h('div', { class: 'grid stats' },
      h('div', { class: 'stat t-accent' }, h('span', { class: 'label' }, 'Виконано (приблизно)'), h('span', { class: 'value' }, `${v.pct}%`), Progress({ value: v.pct, label: 'Загальне виконання проєкту' })),
      StatCard({ label: 'Поточний етап', value: v.currentStage ? `${v.currentStage} з ${v.stages.length}` : 'усі завершено', tone: v.currentStage ? undefined : 'success' }),
      StatCard({ label: 'Агентів працює', value: v.running, tone: v.running ? 'accent' : undefined }),
      StatCard({ label: 'Злито задач', value: `${v.done} з ${v.total}`, tone: v.done === v.total ? 'success' : undefined })),
    PanelCard({ title: 'Зараз працюють', subtitle: 'Агент · модель · зусилля для кожної задачі, що виконується' },
      running.length ? h('div', { class: 'stack' }, ...running.map((t) => h('div', { class: 'row between wrap-row' },
        h('a', { href: `#/tasks/${t.id}`, class: 'wrap' }, h('span', { class: 'id' }, `#${t.id}`), ' ', t.title, h('span', { class: 'muted' }, ` · етап ${t.stage}`)),
        h('span', { class: 'row' }, h('span', { class: 'mono' }, [t.agent?.provider, t.agent?.model, t.agent?.effort].filter(Boolean).join(' · ')), h('span', { class: 'muted' }, `спроба ${t.attempts}/${t.maxAttempts}`)))))
        : EmptyState({ icon: 'agents', title: 'Зараз ніхто не працює', text: 'Задачі запускаються, коли їхні залежності злито і є вільний слот для агента.' })),
    ...v.stages.map((s) => PanelCard({ flush: true, title: `Етап ${s.n}`, subtitle: `${s.done} з ${s.total} задач злито · приблизно ${s.pct}%`, actions: stageBadge(s) },
      h('div', { class: 'progress-row' }, Progress({ value: s.pct, label: `Виконання етапу ${s.n}` })),
      Table({ columns: [
        { label: 'Задача', class: 'grow', render: (t) => h('a', { href: `#/tasks/${t.id}`, class: 'wrap' }, h('span', { class: 'id' }, `#${t.id}`), ' ', t.title) },
        { label: 'Тип · складність', render: (t) => kindLabel(t) || '—' },
        { label: 'Статус', render: (t) => StatusBadge(t.status) },
        { label: 'Агент · модель · зусилля', render: (t) => agentCell(t.agent) },
        { label: 'Виконано', class: 'num', render: (t) => `≈${t.pct}%` },
      ], rows: s.tasks }))),
    h('p', { class: 'text-2', style: 'margin:0' },
      'Відсоток приблизний, не вимір: злито — 100%, прийнято — 90%, на перевірці або чекає відповіді — 75%, заблоковано — 50%, виконується — 40%, решта — 0%. Складна задача важить утричі більше за просту, середня — удвічі. Етап — задачі, які можуть іти паралельно: наступний етап чекає злиття залежностей. «Наступна спроба» — кого вибере автовибір, якщо задачу запустити зараз.'),
  );
}

// ---------------------------------------------------------------- page: model analytics
async function modelsPage() {
  const header = PageHeader({ title: 'Аналітика моделей', subtitle: 'Власні виміри HidForge: як кожна зв’язка «агент · модель · зусилля» впоралася із задачами кожного типу',
    actions: SecondaryButton({ icon: 'refresh', onClick: () => render() }, 'Оновити') });
  mount(header, PanelCard({}, EmptyState({ icon: 'refresh', title: 'Завантаження…', text: 'Рахуємо статистику запусків.' })));
  let rows;
  try { rows = await api('GET', '/api/model-stats'); } catch (e) { toast(e.message, 'danger'); return; }
  if (state.page !== 'models') return;
  const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '—');
  const order = Object.keys(CATEGORY_LABEL);
  rows.sort((a, b) => order.indexOf(a.category) - order.indexOf(b.category) || a.complexity.localeCompare(b.complexity) || b.runs - a.runs);
  const total = rows.reduce((n, r) => n + r.runs, 0);
  mount(header,
    h('div', { class: 'grid stats' },
      StatCard({ label: 'Запусків враховано', value: total }),
      StatCard({ label: 'Зв’язок «модель · зусилля»', value: rows.length }),
      StatCard({ label: 'Самонавчання', value: state.settings?.selfLearning ? 'увімкнено' : 'вимкнено' })),
    rows.length ? PanelCard({ flush: true, title: 'Результати за типом задачі', subtitle: 'Усі проєкти; демо-агент, скасовані й перервані запуски не враховуються' },
      Table({ columns: [
        { label: 'Тип', render: (r) => h('strong', {}, CATEGORY_LABEL[r.category] || r.category) },
        { label: 'Складність', render: (r) => COMPLEXITY_LABEL[r.complexity] || r.complexity },
        { label: 'Агент · модель · зусилля', class: 'grow', render: (r) => h('span', { class: 'mono' }, [r.agent, r.model, r.effort].filter(Boolean).join(' · ')) },
        { label: 'Запусків', render: (r) => r.runs },
        { label: 'Успішних', render: (r) => Badge(pct(r.succeeded, r.runs), r.succeeded / r.runs >= 0.8 ? 'success' : r.succeeded / r.runs >= 0.5 ? 'warning' : 'danger') },
        { label: 'З першої спроби', render: (r) => pct(r.firstTry, r.firstTryRuns) },
        { label: 'Рецензій «схвалено»', render: (r) => (r.reviewed ? `${r.approved} з ${r.reviewed}` : '—') },
        { label: 'Сер. час', render: (r) => `${Math.round(r.avgSec)} с` },
        { label: 'Токени', render: (r) => (r.inputTokens + r.outputTokens).toLocaleString('uk-UA') },
        { label: 'USD', render: (r) => (r.runsWithUsd ? usd(r.usd) : '—') },
      ], rows }))
      : PanelCard({}, EmptyState({ icon: 'overview', title: 'Вимірів ще немає', text: 'Статистика з’явиться після запусків задач із заданим типом. Доти діє таблиця пріоритетів із досліджень (Налаштування → Автовибір моделі).' })),
    h('p', { class: 'text-2', style: 'margin:0' },
      '«Успішний» запуск — агент завершив роботу без помилки; чи пройшла робота перевірки, показує колонка рецензій. USD звітує лише Claude Code. Кілька запусків — це ще не висновок: порівнюйте зв’язки, коли в кожної є хоча б 5 запусків.'),
  );
}

// ---------------------------------------------------------------- page: reports
/** Save Markdown as a file without interpreting it as HTML. */
function downloadMarkdown(markdown, filename) {
  const href = URL.createObjectURL(new Blob([markdown], { type: 'text/markdown;charset=utf-8' }));
  const a = h('a', { href, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 1000);
}

function reportsPage() {
  const pid = state.project.id;
  const content = h('div', { class: 'stack' });
  let requestId = 0;
  // Live events re-render the page: show the last loaded data at once (no "loading" flicker), then refresh it.
  const show = (report, adr) => {
      const decisions = adr.decisions || [];
      const copy = act(async (text) => { await navigator.clipboard.writeText(text); toast('Скопійовано', 'success'); });
      const reportTab = h('div', { class: 'stack' },
        h('div', { class: 'row' },
          SecondaryButton({ icon: 'check', onClick: () => copy(report.markdown) }, 'Копіювати'),
          PrimaryButton({ icon: 'report', onClick: () => downloadMarkdown(report.markdown, `hidforge-report-${pid}.md`) }, 'Завантажити .md')),
        h('pre', { class: 'diff', style: 'white-space:pre-wrap' }, report.markdown || 'Звіт порожній.'));
      const adrTab = h('div', { class: 'stack' },
        h('div', { class: 'row' },
          PrimaryButton({ icon: 'report', onClick: () => downloadMarkdown(adr.markdown, `hidforge-adr-${pid}.md`) }, 'Завантажити ADR .md')),
        decisions.length ? h('div', { class: 'stack' }, ...decisions.map((d) => PanelCard({
          title: d.title || 'Рішення без назви',
          subtitle: d.ts ? `Дата: ${d.ts.replace('T', ' ').slice(0, 19)}` : 'Дата не вказана',
          actions: d.taskId != null ? h('a', { href: `#/tasks/${d.taskId}`, class: 'report-task-link' }, `Задача #${d.taskId}`) : null,
        }, InfoList([
          ['Контекст', h('div', { class: 'pre-wrap' }, d.context || '—')],
          ['Рішення', h('div', { class: 'pre-wrap' }, d.decision || '—')],
          ['Наслідки', h('div', { class: 'pre-wrap' }, d.consequences || '—')],
        ])))) : PanelCard({}, EmptyState({ icon: 'report', title: 'Рішень поки немає',
          text: 'Коли в проєкті з’являться ADR, вони відображатимуться тут.' })));
      content.replaceChildren(PanelCard({ title: 'Документація проєкту', subtitle: 'Звіт і журнал архітектурних рішень' },
        Tabs([
          { id: 'report', label: 'Звіт', content: reportTab },
          { id: 'adr', label: `Рішення (ADR · ${decisions.length})`, content: adrTab },
        ], state.reportsTab, (id) => { state.reportsTab = id; })));
  };
  const load = act(async () => {
    const current = ++requestId;
    if (state.reportsData?.pid !== pid) content.replaceChildren(PanelCard({}, h('p', { class: 'muted', style: 'margin:0' }, 'Завантаження звіту й рішень…')));
    try {
      const [report, adr] = await Promise.all([
        api('GET', `/api/projects/${pid}/report`),
        api('GET', `/api/projects/${pid}/adr`),
      ]);
      state.reportsData = { pid, report, adr };
      if (!content.isConnected || state.page !== 'reports' || state.projectId !== pid || current !== requestId) return;
      show(report, adr);
    } catch (e) {
      if (content.isConnected && current === requestId) {
        content.replaceChildren(PanelCard({}, EmptyState({ icon: 'alert', title: 'Не вдалося завантажити звіт', text: e.message })));
      }
      throw e;
    }
  });
  mount(
    PageHeader({ title: 'Звіти й рішення', subtitle: 'Зведений звіт і журнал архітектурних рішень (ADR)',
      meta: projectMeta(state.project),
      actions: SecondaryButton({ icon: 'refresh', onClick: load }, 'Оновити') }),
    content,
  );
  if (state.reportsData?.pid === pid) show(state.reportsData.report, state.reportsData.adr);
  load();
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
  t = t || { title: '', description: '', acceptanceCriteria: '', dependsOn: [], assignedRole: 'Backend', provider: usesMock() ? 'mock' : 'auto', model: '', policy: 'workspace-write', allowedPaths: [], verifyCommands: [], maxAttempts: usesMock() ? 2 : 3, timeoutSec: 1800,
    category: usesMock() ? null : 'backend', complexity: 'medium', effort: null };
  const f = {
    title: TextInput({ value: t.title, required: true }),
    description: Textarea(t.description, { class: 'prose', style: 'min-height:110px' }),
    acceptanceCriteria: Textarea(t.acceptanceCriteria, { class: 'prose' }),
    assignedRole: Select(ROLES, t.assignedRole),
    provider: Select([['auto', 'auto (за політикою)'], ...agentList().map((a) => [a.id, `${a.id}${a.available ? '' : ' (недоступний)'}`])], t.provider),
    model: null,
    category: Select([['', 'не задано'], ...Object.entries(CATEGORY_LABEL)], t.category || ''),
    complexity: Select(Object.entries(COMPLEXITY_LABEL), t.complexity || 'medium'),
    effort: Select([['', 'авто (з таблиці пріоритетів)'], ...Object.entries(EFFORT_LABEL)], t.effort || ''),
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
        provider: f.provider.value, model: modelValue(f.model), policy: f.policy.value,
        category: f.category.value || null, complexity: f.complexity.value, effort: f.effort.value || null, maxBudgetUsd: f.maxBudgetUsd.value ? Number(f.maxBudgetUsd.value) : null,
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
      Field('Роль', f.assignedRole), Field('Виконавець (CLI)', f.provider, '«auto» — агент, модель і зусилля беруться з таблиці пріоритетів за типом і складністю'),
      Field('Тип задачі', f.category, 'для «auto»; без типу — простий автовибір агента'), Field('Складність', f.complexity),
      Field('Модель', f.model, 'для «auto» з типом модель вибирає таблиця'), Field('Зусилля', f.effort, 'вище «високих» — лише свідомо: ліміти витрачаються в рази швидше'),
      Field('Права', f.policy),
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
    h('div', { class: 'row text-2', style: 'font-size:var(--fs-sm)' }, t.assignedRole, ' · ', providerLabel(t), t.provider === 'mock' ? ' (не справжній AI)' : '', ` · спроба ${t.attempts}/${t.maxAttempts} · ${t.policy}`, kindLabel(t) ? ` · ${kindLabel(t)}` : '', t.effort ? ` · зусилля: ${t.effort}` : ''),
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
        h('div', { class: 'row between' }, h('span', {}, h('span', { class: 'id' }, `#${r.attempt}`), ` ${[r.provider, r.model, r.effort].filter(Boolean).join(' · ')}`, r.isMock ? h('span', { class: 'mockflag' }, ' MOCK') : null), h('span', { class: 'muted mono' }, `${r.startedAt.slice(11, 19)}${r.endedAt ? '–' + r.endedAt.slice(11, 19) : ''}`)),
        h('div', { class: 'text-2' }, r.status, r.exitCode != null ? ` · exit ${r.exitCode}` : ''),
        r.error ? h('div', { class: 'muted' }, r.error) : null,
        r.usage ? h('div', { class: 'muted mono' }, 'usage: ' + JSON.stringify(r.usage)) : null))) : h('p', { class: 'muted' }, 'Запусків ще не було') },
      { id: 'info', label: 'Деталі', content: InfoList([
        ['Опис', h('div', { style: 'white-space:pre-wrap' }, t.description || '—')], ['Критерії', h('div', { style: 'white-space:pre-wrap' }, t.acceptanceCriteria || '—')],
        ['Залежить від', t.dependsOn.map((d) => `#${d}`).join(', ') || '—'], ['Дозволені шляхи', t.allowedPaths.join(', ') || 'будь-які'],
        ['Перевірка', t.verifyCommands.join('; ') || '—'], ['Гілка', t.branch ? h('code', {}, t.branch) : '—'], ['Worktree', t.workspace ? h('span', { class: 'mono' }, t.workspace) : '—'],
        ['Тип і складність', kindLabel(t) || 'не задано'], ['Таймаут', `${t.timeoutSec} с`]]) },
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
  const planners = agentList().filter((a) => a.available && (a.mock || a.capabilities.readOnlyMode === 'supported'));
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
  const applyProv = Select([['auto', 'auto (за політикою)'], ...agentList().filter((a) => a.available).map((a) => [a.id, a.mock ? 'mock' : a.id])], plan.provider === 'mock' ? 'mock' : 'auto', { class: 'w-auto' });
  return PanelCard({ flush: true, title: `Запропонований план #${plan.id}`, subtitle: d.summary || `${d.tasks.length} задач` },
    d.risks.length ? h('div', { style: 'padding:var(--s-4) var(--s-5) 0' }, h('div', { class: 'callout' }, h('strong', {}, 'Ризики'), h('ul', { style: 'margin:0;padding-left:18px' }, ...d.risks.map((r) => h('li', {}, r))))) : null,
    Table({
      columns: [
        { label: 'Ключ', render: (t) => h('code', {}, t.key) },
        { label: 'Задача', class: 'grow', render: (t) => h('span', { title: `${t.description}\n\nКритерії: ${t.acceptanceCriteria}` }, t.title, t.policy === 'read-only' ? h('span', { class: 'muted' }, ' (read-only)') : null) },
        { label: 'Роль', render: (t) => t.role },
        { label: 'Тип · складність', render: (t) => kindLabel(t) || '—' },
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
    state.agents ? h('div', { class: 'grid cards' }, ...agentList().map((a) => {
      const [label, tone] = agentState(a);
      return ItemCard({
        icon: a.mock ? 'terminal' : 'agents', off: !a.available, title: a.name, subtitle: a.version || (a.installed ? 'версія невідома' : 'не знайдено в PATH'),
        status: Badge(label, tone),
        body: h('div', { class: 'stack' },
          a.mock ? h('div', { class: 'mockflag' }, 'ДЕМО-АГЕНТ — НЕ СПРАВЖНІЙ AI') : null,
          a.reason ? h('div', { class: 'text-2 wrap', style: 'font-size:var(--fs-sm)' }, a.reason) : null,
          Disclosure('Можливості й примітки',
            h('div', { class: 'row' }, ...Object.entries(a.capabilities).map(([k, v]) => PermissionChip(k, v))),
            a.notes.length ? h('ul', { class: 'muted', style: 'margin:0;padding-left:18px;font-size:var(--fs-sm)' }, ...a.notes.map((n) => h('li', {}, n))) : null)),
      });
    })) : PanelCard({}, EmptyState({ icon: 'refresh', title: 'Перевірка агентів…', text: 'Шукаємо CLI у PATH і перевіряємо авторизацію.' })),
    agentsExtSettings(),
    trustSettings(),
  );
}

// ---------------------------------------------------------------- page: system
/** Last diagnostic result is kept in memory for this browser session. */
function diagnosticBadges(d) {
  if (!d?.checks) return [];
  const total = (level) => d.checks.filter((c) => c.level === level).length;
  const ukPlural = (n, one, few, many) => (n % 100 >= 11 && n % 100 <= 14) ? many
    : n % 10 === 1 ? one : n % 10 >= 2 && n % 10 <= 4 ? few : many;
  const warnings = total('warn');
  const errors = total('error');
  return [Badge(`${total('ok')} OK`, 'success'),
    Badge(`${warnings} ${ukPlural(warnings, 'попередження', 'попередження', 'попереджень')}`, 'warning'),
    Badge(`${errors} ${ukPlural(errors, 'помилка', 'помилки', 'помилок')}`, 'danger')];
}

function diagnosticTable(d) {
  return Table({ columns: [
    { label: 'Перевірка', render: (c) => h('strong', {}, c.label) },
    { label: 'Стан', render: (c) => Badge(CHECK_LABEL[c.level] || c.level, CHECK_TONE[c.level] || 'neutral') },
    { label: 'Деталі', class: 'grow', render: (c) => h('span', { class: 'wrap' }, c.detail) },
  ], rows: d.checks });
}

function systemPage() {
  mount(
    PageHeader({ title: 'Система', subtitle: 'Стан середовища, резервні копії, версія й обслуговування сервера',
      meta: h('div', { id: 'systemDiagSummary', class: 'row' }, ...diagnosticBadges(state.diag)) }),
    maintenanceSettings(),
    aboutSettings(),
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
    PanelCard({}, h('div', { class: 'row' },
      h('span', { class: 'text-2' }, 'Витрати й бюджет → '), h('a', { href: '#/costs' }, 'Витрати'),
      h('span', { class: 'text-2' }, '· Діагностика, копії, версія → '), h('a', { href: '#/system' }, 'Система'))),
    h('div', { class: 'grid cols-2' },
      PanelCard({ title: 'Виконання', subtitle: 'Глобально для всіх проєктів' },
        Field('Паралельних агентів', maxConc, 'Скільки задач можуть виконуватися одночасно'),
        Field('Політика автовибору', routing, 'cost-first — дешевші агенти; quality-first — найсильніші; balanced — між ними')),
      PanelCard({ title: 'Вигляд' }, Field('Тема', theme, 'Зберігається лише в цьому браузері'))),
    ...(routingSettings() || []),
    apiSettings(),
    p ? reviewSettings(p) : null,
    rolesSettings(),
    p ? PanelCard({ title: 'Дозволені команди перевірки', subtitle: `Проєкт «${p.name}»` },
      h('p', { class: 'text-2', style: 'margin:0' }, 'Команди запускаються без shell у worktree задачі. Команди не з цього списку потребують підтвердження; git push, rm, curl, powershell тощо заборонені завжди.'),
      cmds, h('div', {}, PrimaryButton({ icon: 'check', onClick: act(async () => {
        await api('PATCH', `/api/projects/${p.id}`, { allowedCommands: cmds.value.split('\n').map((x) => x.trim()).filter(Boolean) });
        await reloadProject(); toast('Збережено', 'success'); render();
      }) }, 'Зберегти'))) : null,
  );
}
/** Paid API fallback: used only for an agent whose CLI is missing or not logged in, and only with the provider's key in .env. */
function apiSettings() {
  const s = state.settings;
  if (!s?.apiKeys) return null;
  const toggle = act(async (v) => { await api('PUT', '/api/settings', { apiFallback: v }); await Promise.all([loadSettings(), loadAgents()]); toast(v ? 'Платний API увімкнено як резерв' : 'Платний API вимкнено', 'success'); render(); });
  return PanelCard({ title: 'Резервний API (платно)', subtitle: 'API-провайдери без CLI (DeepSeek, Kimi, MiniMax…) і запасний шлях для Claude, Codex, Antigravity, коли їхнього CLI немає' },
    h('p', { class: 'text-2', style: 'margin:0' }, 'Поки CLI встановлено й увійдено, використовується тільки CLI. API — запасний шлях: кожен запит оплачується з вашого ключа провайдера. Ключі HidForge не зберігає: впишіть їх у файл .env поруч із HidForge (він не потрапляє в git) і перезапустіть HidForge. API-агент читає й записує файли робочої копії, але не запускає команд — перевірку роблять команди перевірки HidForge.'),
    h('div', { class: 'stack' }, ...s.apiKeys.map((k) => h('div', { class: 'row between wrap-row' }, h('span', {}, k.label, ' ', h('span', { class: 'mono muted' }, k.key)),
      k.present ? Badge('ключ є', 'success') : Badge('ключа немає', 'neutral')))),
    Toggle({ label: 'Дозволити платні API-запити', checked: s.apiFallback === true, onChange: (v) => toggle(v) }));
}
/** Auto-routing: effort ceiling, opt-in Fable link, self-learning, agents that cannot write, and the editable priority table. */
function routingSettings() {
  const s = state.settings;
  if (!s?.routing) return null;
  const put = (body, msg = 'Збережено') => act(async () => { await api('PUT', '/api/settings', body()); await loadSettings(); toast(msg, 'success'); render(); });
  const ceiling = Select(s.routing.efforts.map((e) => [e, EFFORT_LABEL[e]]), s.effortCeiling, { onchange: (e) => put(() => ({ effortCeiling: e.target.value }))() });
  const real = (state.agents || []).filter((a) => !a.mock);
  const parse = (v) => { const [agent, model, effort] = v.trim().split(/\s+/); return agent && model ? { agent, model, effort: effort || null } : null; };
  const rows = s.routing.categories.flatMap((cat) => s.routing.complexities.map((cx) => {
    const key = `${cat}/${cx}`;
    const links = s.routingMatrix[key] || [];
    return { key, cat, cx, inputs: [0, 1, 2].map((i) => TextInput({ value: links[i] ? linkText(links[i]) : '', class: 'mono', 'aria-label': `${CATEGORY_LABEL[cat]}, ${COMPLEXITY_LABEL[cx]}: ${['головний', 'заміна 1', 'заміна 2'][i]}` })) };
  }));
  const save = put(() => ({ routingMatrix: Object.fromEntries(rows.map((r) => [r.key, r.inputs.map((i) => parse(i.value)).filter(Boolean)])) }), 'Таблицю пріоритетів збережено');
  const reset = act(async () => {
    if (!await confirmModal('Повернути типову таблицю пріоритетів? Ваші правки таблиці буде втрачено.', { ok: 'Повернути типову' })) return;
    await api('PUT', '/api/settings', { routingMatrix: null }); await loadSettings(); toast('Типову таблицю відновлено', 'success'); render();
  });
  return [
    PanelCard({ title: 'Автовибір моделі', subtitle: 'Для задач із виконавцем «auto» і заданим типом: агент, модель і зусилля беруться з таблиці пріоритетів' },
      Field('Стеля зусиль', ceiling, 'Ланки таблиці з вищим рівнем пропускаються. Рівні вище «високих» витрачають ліміти в рази швидше — їх можна вписати лише вручну в окрему задачу.'),
      Toggle({ label: 'Дозволити Fable 5.2 як останню ланку (лише складні: помилки, архітектура, планування, бекенд)', checked: s.allowFable === true, onChange: (v) => put(() => ({ allowFable: v }))() }),
      Toggle({ label: 'Самонавчання: коли кожна ланка клітинки має щонайменше 5 власних запусків, порядок ланок ставлять виміри', checked: s.selfLearning === true, onChange: (v) => put(() => ({ selfLearning: v }))() }),
      real.length ? h('div', { class: 'stack' }, h('div', { class: 'text-2', style: 'font-size:var(--fs-sm)' }, 'Агент зараз не може записувати файли — автовибір не дає йому задач із записом (рецензії й планування лишаються):'),
        h('div', { class: 'row wrap' }, ...real.map((a) => Toggle({ label: a.id, checked: s.agentReadOnly?.[a.id] === true,
          onChange: (v) => put(() => ({ agentReadOnly: { ...s.agentReadOnly, [a.id]: v } }))() })))) : null),
    PanelCard({ flush: true, title: 'Таблиця пріоритетів', subtitle: 'Початкові пріоритети з досліджень (17.11.2026), не виміряно HidForge. Спроба 1 — головний, далі заміни; ескалація — це інша модель, а не більше зусиль' },
      Table({ columns: [
        { label: 'Тип', render: (r) => h('strong', {}, CATEGORY_LABEL[r.cat]) },
        { label: 'Складність', render: (r) => COMPLEXITY_LABEL[r.cx] },
        { label: 'Головний', render: (r) => r.inputs[0] }, { label: 'Заміна 1', render: (r) => r.inputs[1] }, { label: 'Заміна 2', render: (r) => r.inputs[2] },
      ], rows }),
      h('div', { class: 'row', style: 'padding:var(--s-4) var(--s-5);border-top:1px solid var(--border)' },
        h('span', { class: 'text-2', style: 'flex:1;font-size:var(--fs-sm)' }, 'Формат ланки: «агент модель зусилля», напр. «claude opus high». Порожнє поле — ланки немає. Рецензента вибирає окреме правило: завжди інший вендор, ніж автор коду.'),
        GhostButton({ onClick: reset }, 'Повернути типову'), PrimaryButton({ icon: 'check', onClick: save }, 'Зберегти таблицю'))),
  ];
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
/** JSON plugin adapters (read-only info) and the optional WSL2 / VPS (ssh) backends. */
function agentsExtSettings() {
  const s = state.settings || {};
  const distro = TextInput({ value: s.wsl?.distro || '', placeholder: 'напр. Ubuntu', 'aria-label': 'Дистрибутив WSL' });
  const agents = TextInput({ value: (s.wsl?.agents || []).join(', '), placeholder: 'напр. claude, codex', 'aria-label': 'Агенти у WSL' });
  const sshHost = TextInput({ value: s.ssh?.host || '', placeholder: 'напр. dev@my-vps або аліас з ~/.ssh/config', 'aria-label': 'SSH-хост' });
  const sshPort = TextInput({ value: s.ssh?.port || '', type: 'number', min: 1, max: 65535, placeholder: '22', 'aria-label': 'SSH-порт' });
  const sshDir = TextInput({ value: s.ssh?.remoteDir || '', placeholder: '.hidforge/work', 'aria-label': 'Тека на хості' });
  const sshAgents = TextInput({ value: (s.ssh?.agents || []).join(', '), placeholder: 'напр. claude, codex', 'aria-label': 'Агенти через SSH' });
  const list = (v) => v.split(/[\s,]+/).filter(Boolean);
  const save = act(async () => {
    const d = distro.value.trim();
    const host = sshHost.value.trim();
    await api('PUT', '/api/settings', {
      wsl: d ? { distro: d, agents: list(agents.value) } : null,
      ssh: host ? { host, port: sshPort.value ? Number(sshPort.value) : null, remoteDir: sshDir.value.trim(), agents: list(sshAgents.value) } : null,
    });
    await loadSettings(); toast('Збережено. Діє після перезапуску сервера', 'success'); render();
  });
  const plugins = (state.agents || []).filter((a) => a.notes?.some((n) => n.startsWith('JSON plugin')));
  return PanelCard({ title: 'Плагіни агентів, WSL2 і VPS', subtitle: 'Додаткові CLI без зміни коду; запуск агентів у WSL або на VPS через SSH (експериментально)' },
    h('p', { class: 'text-2', style: 'margin:0;font-size:var(--fs-sm)' },
      `JSON-плагіни: ${plugins.map((a) => a.id).join(', ') || 'немає'}. Власні специфікації кладіть у `, h('span', { class: 'mono' }, '%LOCALAPPDATA%\\HidForge\\plugins\\*.json'),
      ' (формат — plugins\\gemini.json). Прапорці обходу дозволів і промпт в аргументах відхиляються при завантаженні. Діє після перезапуску.'),
    h('div', { class: 'grid cols-2' },
      Field('Дистрибутив WSL', distro, 'Порожньо — WSL не використовується'),
      Field('Агенти у WSL', agents, 'З’являться як окремі агенти з суфіксом -wsl')),
    h('p', { class: 'text-2', style: 'margin:0;font-size:var(--fs-sm)' },
      'VPS через SSH (експериментально): файли worktree копіюються на хост, агент працює там, зміни повертаються як git diff і проходять звичайні перевірки. Вхід — лише вашим SSH-ключем (без пароля), хост має бути в known_hosts; на хості потрібні git, tar і сам CLI з власною авторизацією.'),
    h('div', { class: 'grid cols-2' },
      Field('SSH-хост', sshHost, 'Порожньо — SSH не використовується'),
      Field('Порт', sshPort, 'Порожньо — з ~/.ssh/config або 22'),
      Field('Тека на хості', sshDir, 'Відносно домашньої теки; за замовчуванням .hidforge/work'),
      Field('Агенти через SSH', sshAgents, 'З’являться як окремі агенти з суфіксом -ssh')),
    h('div', {}, PrimaryButton({ icon: 'check', onClick: save }, 'Зберегти')));
}

const CHECK_TONE = { ok: 'success', info: 'neutral', warn: 'warning', error: 'danger' };
const CHECK_LABEL = { ok: 'OK', info: 'інфо', warn: 'увага', error: 'помилка' };

/** Diagnostics (doctor) and backups of the local state. */
function maintenanceSettings() {
  const diag = h('div', {}, state.diag ? diagnosticTable(state.diag) : null);
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
    try {
      const d = await api('GET', '/api/diagnostics');
      state.diag = d;
      diag.replaceChildren(diagnosticTable(d));
      $('#systemDiagSummary')?.replaceChildren(...diagnosticBadges(d));
    } catch (e) {
      diag.replaceChildren(h('p', { class: 'muted', style: 'margin:0' }, `Помилка діагностики: ${e.message}`));
      throw e;
    }
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
  const reviewers = (state.agents || []).filter((a) => !a.mock || usesMock() || pol.provider === 'mock').filter((a) => a.mock || a.capabilities.readOnlyMode === 'supported');
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
    addLiveActivityEvent(e);
    if (e.taskId === state.taskId && state.editing == null) appendLog(e);
    if (e.type === 'plan.output') { appendPlanLog(e); return; }
    if (isOutputEvent(e)) return;
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      if (state.editing != null || document.querySelector('dialog[open]')) return; // never wipe a form or modal in progress
      reloadProject().then(() => {
        if (state.page === 'activity') { renderShell(); scheduleActivityPaint(); }
        else if (state.page === 'projects') { renderShell(); renderProjectCards(); }
        else render();
      }).catch(() => {});
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
