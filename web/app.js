// HidForge UI — vanilla JS, no build step. All untrusted text goes through textContent.
const TOKEN = document.querySelector('meta[name="hidforge-token"]').content;
const $ = (s) => document.querySelector(s);
const ls = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* blocked */ } } };
const state = { projects: [], agents: [], projectId: null, project: null, tasks: [], taskId: null, es: null, editing: null };

const STATUS_UA = {
  draft: 'чернетка', ready: 'чекає залежностей', queued: 'у черзі', running: 'виконується', review: 'рев\'ю',
  accepted: 'прийнято', merged: 'злито', blocked: 'заблоковано', failed: 'помилка', canceled: 'скасовано', needs_user_input: 'потрібна відповідь',
};
const ROLES = ['Project Manager/Planner', 'Architect', 'Frontend', 'Backend', 'QA', 'Security Reviewer', 'Integrator'];

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'value') el.value = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

async function api(method, path, body) {
  const res = await fetch(path, {
    method, headers: { 'content-type': 'application/json', 'x-hidforge-token': TOKEN },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}
const act = (fn) => async (...a) => { try { await fn(...a); } catch (e) { toast(e.message); } };
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.remove('hidden'); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.add('hidden'), 5000); }
const badge = (s) => h('span', { class: `badge s-${s}`, title: s }, STATUS_UA[s] || s);

// ---------------------------------------------------------------- theme & settings
const themeSel = $('#theme');
themeSel.value = ls.get('hf-theme') || 'system';
themeSel.onchange = () => {
  const v = themeSel.value;
  if (v === 'system') document.documentElement.removeAttribute('data-theme'); else document.documentElement.setAttribute('data-theme', v);
  ls.set('hf-theme', v);
};
for (let i = 1; i <= 8; i++) $('#maxConc').append(h('option', { value: i }, i));
async function loadSettings() {
  const s = await api('GET', '/api/settings');
  $('#maxConc').value = s.maxConcurrentAgents; $('#routing').value = s.routingPolicy;
}
$('#maxConc').onchange = act(() => api('PUT', '/api/settings', { maxConcurrentAgents: Number($('#maxConc').value) }));
$('#routing').onchange = act(() => api('PUT', '/api/settings', { routingPolicy: $('#routing').value }));

// ---------------------------------------------------------------- agents
async function loadAgents(refresh = false) {
  $('#agents').replaceChildren(h('li', { class: 'muted' }, 'перевірка…'));
  state.agents = await api('GET', '/api/agents' + (refresh ? '?refresh=1' : ''));
  $('#agents').replaceChildren(...state.agents.map((a) => {
    const st = !a.installed ? ['не встановлено', 'b-bad'] : a.auth === 'missing' ? ['немає авторизації', 'b-bad'] : a.auth === 'unknown' ? ['авторизація невідома', 'b-warn'] : ['готовий', 'b-ok'];
    const unsupported = Object.entries(a.capabilities).filter(([, v]) => v !== 'supported').map(([k, v]) => `${k}: ${v}`);
    return h('li', { title: [...a.notes, unsupported.length ? 'Обмеження: ' + unsupported.join(', ') : ''].join('\n') },
      h('div', { class: 'row' }, h('strong', {}, a.name), h('span', { class: `badge ${st[1]}` }, st[0])),
      a.version ? h('div', { class: 'reason' }, a.version) : null,
      a.reason ? h('div', { class: 'reason' }, a.reason) : null);
  }));
}
$('#refreshAgents').onclick = act(() => loadAgents(true));

// ---------------------------------------------------------------- projects
async function loadProjects() {
  state.projects = await api('GET', '/api/projects');
  $('#projects').replaceChildren(...state.projects.map((p) => h('li', {
    class: p.id === state.projectId ? 'active' : '', title: p.repoPath, onclick: () => selectProject(p.id),
  }, h('div', {}, p.name), h('div', { class: 'muted', style: 'font-size:12px' }, p.repoPath))));
  if (!state.projects.length) $('#projects').replaceChildren(h('li', { class: 'muted' }, 'Немає проєктів'));
}
$('#openRepo').onsubmit = act(async (e) => {
  e.preventDefault();
  const p = await api('POST', '/api/projects', { repoPath: $('#repoPath').value.trim() });
  $('#repoPath').value = '';
  await loadProjects(); await selectProject(p.id);
});
$('#demoBtn').onclick = act(async () => { const p = await api('POST', '/api/demo'); await loadProjects(); await selectProject(p.id); });

async function selectProject(id) {
  state.projectId = id; state.taskId = null; state.editing = null;
  ls.set('hf-project', String(id));
  await loadProjects();
  await reloadProject();
  connectStream();
}

async function reloadProject() {
  if (!state.projectId) return;
  const { project, tasks } = await api('GET', `/api/projects/${state.projectId}`);
  state.project = project; state.tasks = tasks;
  renderMain();
  if (state.taskId) renderDetail();
}

function renderMain() {
  const p = state.project;
  const goal = h('textarea', { id: 'goal', placeholder: 'Загальна ціль проєкту…', style: 'min-height:48px;font-family:inherit;font-size:14px' });
  goal.value = p.goal;
  const cmds = h('textarea', { placeholder: 'Одна команда на рядок, напр. npm test' });
  cmds.value = p.allowedCommands.join('\n');
  const counts = {};
  for (const t of state.tasks) counts[t.status] = (counts[t.status] || 0) + 1;
  $('#main').replaceChildren(
    h('div', { class: 'card' },
      h('h2', {}, p.name),
      h('div', { class: 'muted' }, `${p.repoPath} · базова гілка `, h('code', {}, p.baseBranch)),
      h('div', { class: 'stack' }, h('label', {}, 'Ціль', goal),
        h('div', { class: 'row' }, h('button', { class: 'ghost small', onclick: act(async () => { await api('PATCH', `/api/projects/${p.id}`, { goal: goal.value }); toast('Ціль збережено'); }) }, 'Зберегти ціль'))),
      h('details', {}, h('summary', { class: 'muted' }, `Дозволені команди перевірки (${p.allowedCommands.length})`),
        h('p', { class: 'muted' }, 'Команди запускаються без shell у worktree задачі. Команди не з цього списку потребують підтвердження; git push, rm, curl, powershell тощо заборонені завжди.'),
        cmds, h('button', { class: 'ghost small', onclick: act(async () => {
          await api('PATCH', `/api/projects/${p.id}`, { allowedCommands: cmds.value.split('\n').map((s) => s.trim()).filter(Boolean) });
          toast('Збережено'); await reloadProject();
        }) }, 'Зберегти'))),
    h('div', { class: 'row', style: 'justify-content:space-between;margin-bottom:8px' },
      h('div', { class: 'row' }, h('h3', { style: 'margin:0' }, 'План задач (DAG)'),
        ...Object.entries(counts).map(([s, n]) => h('span', { class: `badge s-${s}` }, `${STATUS_UA[s]}: ${n}`))),
      h('div', { class: 'row' },
        h('button', { class: 'ghost', onclick: () => { state.editing = 'new'; state.taskId = null; renderDetail(); } }, '+ Задача'),
        h('button', { disabled: !counts.draft, onclick: act(async () => { await api('POST', `/api/projects/${p.id}/submit-all`); await reloadProject(); }) }, `Запустити план (${counts.draft || 0})`))),
    h('div', { class: 'card', style: 'padding:0;overflow:auto' }, taskTable()),
  );
}

function taskTable() {
  if (!state.tasks.length) return h('p', { class: 'muted pad' }, 'Ще немає задач. Додайте першу або створіть демо-проєкт.');
  return h('table', {},
    h('thead', {}, h('tr', {}, ...['#', 'Задача', 'Роль', 'Виконавець', 'Залежить від', 'Статус', 'Спроби', ''].map((c) => h('th', {}, c)))),
    h('tbody', {}, ...state.tasks.map((t) => h('tr', { class: t.id === state.taskId ? 'sel' : '', onclick: () => openTask(t.id) },
      h('td', {}, t.id), h('td', {}, t.title), h('td', {}, t.assignedRole),
      h('td', {}, t.provider === 'mock' ? h('span', { class: 'mockflag' }, 'MOCK') : t.provider, t.model ? h('span', { class: 'muted' }, ` ${t.model}`) : null),
      h('td', {}, t.dependsOn.length ? t.dependsOn.map((d) => `#${d}`).join(', ') : '—'),
      h('td', {}, badge(t.status)), h('td', {}, `${t.attempts}/${t.maxAttempts}`),
      h('td', {}, quickActions(t)),
    ))));
}

function quickActions(t) {
  const stop = (fn) => (e) => { e.stopPropagation(); act(fn)(); };
  const b = [];
  if (t.status === 'draft') b.push(h('button', { class: 'small', onclick: stop(() => taskAction(t.id, 'submit')) }, 'Запустити'));
  if (['running', 'queued', 'ready'].includes(t.status)) b.push(h('button', { class: 'small danger', onclick: stop(() => taskAction(t.id, 'cancel')) }, 'Стоп'));
  if (['failed', 'blocked'].includes(t.status)) b.push(h('button', { class: 'small ghost', onclick: stop(() => taskAction(t.id, 'retry')) }, 'Повторити'));
  return h('div', { class: 'row' }, ...b);
}

async function taskAction(id, action, body) { await api('POST', `/api/tasks/${id}/${action}`, body); await reloadProject(); }

// ---------------------------------------------------------------- task detail
async function openTask(id) { state.taskId = id; state.editing = null; renderMain(); await renderDetail(); }

function taskForm(t) {
  const isNew = !t;
  t = t || { title: '', description: '', acceptanceCriteria: '', dependsOn: [], assignedRole: 'Backend', provider: 'mock', model: '', policy: 'workspace-write', allowedPaths: [], verifyCommands: [], maxAttempts: 2, timeoutSec: 1800 };
  const f = {};
  const inp = (k, v, attrs = {}) => (f[k] = h('input', { value: v ?? '', ...attrs }));
  const ta = (k, v, attrs = {}) => { const el = h('textarea', attrs); el.value = v ?? ''; return (f[k] = el); };
  const sel = (k, v, opts) => { const el = h('select', {}, ...opts.map(([val, label]) => h('option', { value: val }, label))); el.value = v; return (f[k] = el); };
  const providers = [['auto', 'auto (за політикою)'], ...state.agents.map((a) => [a.id, `${a.id}${a.available ? '' : ' (недоступний)'}`])];
  const form = h('form', { class: 'stack', onsubmit: act(async (e) => {
    e.preventDefault();
    const lines = (el) => el.value.split('\n').map((s) => s.trim()).filter(Boolean);
    const body = {
      title: f.title.value.trim(), description: f.description.value, acceptanceCriteria: f.acceptanceCriteria.value,
      dependsOn: f.dependsOn.value.split(/[\s,#]+/).filter(Boolean).map(Number), assignedRole: f.assignedRole.value,
      provider: f.provider.value, model: f.model.value.trim() || null, policy: f.policy.value,
      allowedPaths: lines(f.allowedPaths), verifyCommands: lines(f.verifyCommands),
      maxAttempts: Number(f.maxAttempts.value), timeoutSec: Number(f.timeoutSec.value),
    };
    const saved = isNew ? await api('POST', `/api/projects/${state.projectId}/tasks`, body) : await api('PATCH', `/api/tasks/${t.id}`, body);
    state.editing = null; state.taskId = saved.id;
    await reloadProject(); await renderDetail();
  }) },
  h('label', {}, 'Назва', inp('title', t.title, { required: true })),
  h('label', {}, 'Опис / інструкції агенту', ta('description', t.description, { style: 'min-height:90px' })),
  h('label', {}, 'Критерії готовності', ta('acceptanceCriteria', t.acceptanceCriteria)),
  h('div', { class: 'grid2' },
    h('label', {}, 'Роль', sel('assignedRole', t.assignedRole, ROLES.map((r) => [r, r]))),
    h('label', {}, 'Виконавець (CLI)', sel('provider', t.provider, providers)),
    h('label', {}, 'Модель (необов\'язково)', inp('model', t.model)),
    h('label', {}, 'Права', sel('policy', t.policy, [['workspace-write', 'запис у worktree'], ['read-only', 'лише читання']])),
    h('label', {}, 'Залежить від (#id через кому)', inp('dependsOn', t.dependsOn.join(', '))),
    h('label', {}, 'Макс. спроб', inp('maxAttempts', t.maxAttempts, { type: 'number', min: 1, max: 10 })),
    h('label', {}, 'Таймаут, с', inp('timeoutSec', t.timeoutSec, { type: 'number', min: 5 }))),
  h('label', {}, 'Дозволені шляхи (glob, по рядку; порожньо = будь-які)', ta('allowedPaths', t.allowedPaths.join('\n'))),
  h('label', {}, 'Команди перевірки (по рядку)', ta('verifyCommands', t.verifyCommands.join('\n'))),
  h('div', { class: 'row' }, h('button', {}, isNew ? 'Створити чернетку' : 'Зберегти'),
    h('button', { type: 'button', class: 'ghost', onclick: () => { state.editing = null; renderDetail(); } }, 'Скасувати')));
  return form;
}

async function renderDetail() {
  const d = $('#detail');
  if (state.editing === 'new') { d.classList.remove('hidden'); d.replaceChildren(h('h2', {}, 'Нова задача'), taskForm(null)); return; }
  if (!state.taskId) { d.classList.add('hidden'); return; }
  const { task: t, runs } = await api('GET', `/api/tasks/${state.taskId}`);
  if (state.editing === t.id) { d.replaceChildren(h('h2', {}, `Редагування #${t.id}`), taskForm(t)); return; }
  d.classList.remove('hidden');
  const gate = t.artifacts.gate;
  const btns = [];
  if (t.status === 'draft') btns.push(h('button', { onclick: act(() => taskAction(t.id, 'submit')) }, 'Запустити'));
  if (['draft', 'ready', 'failed', 'blocked'].includes(t.status)) btns.push(h('button', { class: 'ghost', onclick: () => { state.editing = t.id; renderDetail(); } }, 'Редагувати'));
  if (['running', 'queued', 'ready', 'draft'].includes(t.status)) btns.push(h('button', { class: 'danger', onclick: act(() => taskAction(t.id, 'cancel')) }, 'Зупинити'));
  if (['failed', 'blocked'].includes(t.status)) btns.push(h('button', { class: 'ghost', onclick: act(() => taskAction(t.id, 'retry')) }, 'Повторити'));
  if (gate?.passed && ['review', 'blocked'].includes(t.status)) btns.push(h('button', { class: 'ok', onclick: act(() => taskAction(t.id, 'approve')) }, 'Approve & Merge'));
  if (['review', 'needs_user_input'].includes(t.status)) btns.push(h('button', { class: 'ghost', onclick: act(async () => {
    const fb = prompt('Що виправити? (піде агенту як зворотний зв\'язок)'); if (fb === null) return;
    await taskAction(t.id, 'reject', { feedback: fb, retry: true });
  }) }, 'Reject'));
  if (['draft', 'canceled'].includes(t.status)) btns.push(h('button', { class: 'ghost', onclick: act(async () => { if (!confirm('Видалити задачу?')) return; await api('DELETE', `/api/tasks/${t.id}`); state.taskId = null; await reloadProject(); renderDetail(); }) }, 'Видалити'));

  const log = h('div', { class: 'log', id: 'log' });
  const diffBox = h('div', { class: 'diff', id: 'diff' }, h('span', { class: 'muted' }, 'Натисніть «Показати diff»'));
  d.replaceChildren(
    h('div', { class: 'row', style: 'justify-content:space-between' }, h('h2', {}, `#${t.id} ${t.title}`), h('button', { class: 'ghost small', onclick: () => { state.taskId = null; renderMain(); renderDetail(); } }, '✕')),
    h('div', { class: 'row' }, badge(t.status), h('span', { class: 'muted' }, `${t.assignedRole} · ${t.provider}${t.provider === 'mock' ? ' (MOCK — не справжній AI)' : ''} · спроба ${t.attempts}/${t.maxAttempts} · ${t.policy}`)),
    t.question ? h('div', { class: 'question' }, h('div', {}, t.question), h('div', { class: 'row', style: 'margin-top:8px' },
      h('button', { class: 'ok', onclick: act(() => taskAction(t.id, 'answer', { allow: true })) }, 'Дозволити'),
      h('button', { class: 'danger', onclick: act(() => taskAction(t.id, 'answer', { allow: false })) }, 'Заборонити'))) : null,
    t.feedback && !['merged'].includes(t.status) ? h('p', { class: 'muted' }, 'Остання причина: ', t.feedback) : null,
    h('div', { class: 'row', style: 'margin:8px 0' }, ...btns),
    gate ? h('p', {}, 'Gate: ', h('span', { class: `badge ${gate.passed ? 'b-ok' : 'b-bad'}` }, gate.passed ? 'пройдено' : 'не пройдено'), gate.reason ? ` ${gate.reason}` : '') : null,
    h('h3', {}, 'Живий журнал'), log,
    h('h3', {}, 'Докази (evidence)'),
    h('ul', { class: 'list evidence' }, ...t.evidence.slice().reverse().map((e) => h('li', { class: e.ok ? 'ok' : 'bad', title: e.detail || '' },
      h('span', { class: 'muted' }, `${e.ts.slice(11, 19)} ${e.kind}: `), e.summary))),
    h('h3', {}, 'Зміни ', h('button', { class: 'ghost small', onclick: act(async () => renderDiff((await api('GET', `/api/tasks/${t.id}/diff`)).diff)) }, 'Показати diff')),
    diffBox,
    h('h3', {}, 'Запуски'),
    h('ul', { class: 'list' }, ...runs.map((r) => h('li', { style: 'cursor:default' },
      `#${r.attempt} ${r.provider}${r.isMock ? ' [MOCK]' : ''} · ${r.status}${r.exitCode != null ? ` · exit ${r.exitCode}` : ''} · ${r.startedAt.slice(11, 19)}${r.endedAt ? '–' + r.endedAt.slice(11, 19) : ''}`,
      r.error ? h('div', { class: 'muted' }, r.error) : null,
      r.usage ? h('div', { class: 'muted' }, 'usage: ' + JSON.stringify(r.usage)) : null))),
    h('details', {}, h('summary', { class: 'muted' }, 'Деталі задачі'),
      h('pre', { class: 'diff' }, JSON.stringify({ description: t.description, acceptanceCriteria: t.acceptanceCriteria, allowedPaths: t.allowedPaths, verifyCommands: t.verifyCommands, workspace: t.workspace, branch: t.branch }, null, 2))),
  );
  const evs = await api('GET', `/api/events?taskId=${t.id}`);
  for (const e of evs) appendLog(e);
}

function appendLog(e) {
  const log = $('#log');
  if (!log) return;
  const ts = e.ts.slice(11, 19);
  let line;
  if (e.type === 'run.output') line = h('div', { class: `k-${e.data.kind} ${e.data.stream}` }, `${ts} ${e.data.text}`);
  else if (e.type === 'task.status') line = h('div', { class: 'sys' }, `${ts} ── ${e.data.from} → ${e.data.to}${e.data.note ? ` (${e.data.note})` : ''}`);
  else if (e.type === 'run.started') line = h('div', { class: 'sys' }, `${ts} ── запуск #${e.data.attempt}: ${e.data.mock ? '[MOCK] ' : ''}${e.data.command.split(/[\\/]/).pop()} ${e.data.args.join(' ')}`);
  else line = h('div', { class: 'sys' }, `${ts} ${e.type} ${JSON.stringify(e.data)}`);
  const atBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 20;
  log.append(line);
  if (atBottom) log.scrollTop = log.scrollHeight;
}

function renderDiff(text) {
  const box = $('#diff');
  if (!text) { box.replaceChildren(h('span', { class: 'muted' }, 'Змін немає')); return; }
  box.replaceChildren(...text.split('\n').map((l) => h('div', {
    class: l.startsWith('+') && !l.startsWith('+++') ? 'add' : l.startsWith('-') && !l.startsWith('---') ? 'del' : l.startsWith('@@') ? 'hunk' : '',
  }, l || ' ')));
}

// ---------------------------------------------------------------- live stream
let refreshTimer = null;
function connectStream() {
  state.es?.close();
  state.es = new EventSource(`/api/stream?projectId=${state.projectId}`);
  state.es.onmessage = (m) => {
    const e = JSON.parse(m.data);
    if (e.taskId === state.taskId && !state.editing) appendLog(e);
    if (e.type !== 'run.output') {
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => { if (!state.editing) reloadProject().catch(() => {}); }, 150);
    }
  };
}

// ---------------------------------------------------------------- boot
await Promise.all([loadSettings(), loadProjects()]).catch((e) => toast(e.message));
loadAgents().catch((e) => toast(e.message));
const last = Number(ls.get('hf-project'));
if (state.projects.some((p) => p.id === last)) selectProject(last);
else if (state.projects.length) selectProject(state.projects[0].id);
