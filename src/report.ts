// Project report and decision log (ADR), derived from what SQLite already records:
// applied plans, human approvals/rejections, AI reviews, merges and integration checks. Nothing new is stored.
import type { Store, Task, Evidence } from './store.ts';
import { projectCosts } from './costs.ts';

export interface Decision { ts: string; title: string; context: string; decision: string; consequences: string; taskId?: number }

const STATUS_UA: Record<string, string> = {
  draft: 'чернетка', ready: 'чекає залежностей', queued: 'у черзі', running: 'виконується', review: "рев'ю", accepted: 'прийнято',
  merged: 'злито', blocked: 'заблоковано', failed: 'помилка', canceled: 'скасовано', needs_user_input: 'потрібна відповідь',
};
const cell = (s: unknown) => String(s ?? '').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
const usd = (v: number) => `$${v.toFixed(2)}`;
const lastEv = (t: Task, kind?: string): Evidence | undefined => [...t.evidence].reverse().find((e) => !kind || e.kind === kind);
type Review = { verdict?: string; summary?: string; provider?: string; findings?: unknown[] } | undefined;

/** Decisions in time order. */
export function decisions(store: Store, projectId: number): Decision[] {
  const out: Decision[] = [];
  for (const p of store.listPlans(projectId, 100_000)) {
    if (p.status !== 'applied' || !p.plan) continue;
    const ids = p.appliedTaskIds ?? [];
    out.push({ ts: p.finishedAt ?? p.createdAt, title: `План #${p.id} прийнято як ${ids.length} задач`,
      context: `Ціль: ${p.goal}`, decision: `План від ${p.provider}${p.model ? ` (${p.model})` : ''} додано як чернетки: ${ids.map((i) => `#${i}`).join(', ') || '—'}.`,
      consequences: 'Задачі виконуються за залежностями після запуску користувачем.' });
  }
  for (const t of store.listTasks(projectId)) {
    const rv = t.artifacts.aiReview as Review;
    const review = rv?.verdict ? ` AI-рецензія (${rv.provider}): ${rv.verdict}${rv.summary ? ` — ${rv.summary}` : ''}.` : '';
    for (const e of t.evidence) {
      if (e.kind === 'human-review' && !e.ok) {
        out.push({ ts: e.ts, taskId: t.id, title: `Відхилено задачу #${t.id} ${t.title}`, context: t.description.slice(0, 600),
          decision: e.summary, consequences: 'Задача повернута на доопрацювання з відгуком або заблокована.' });
      }
      if (e.kind === 'merge' && e.ok) {
        const gates = t.evidence.filter((x) => x.kind === 'verify' || x.kind === 'gate').map((x) => `${x.ok ? '✓' : '✗'} ${x.summary}`);
        out.push({ ts: e.ts, taskId: t.id, title: `Злито задачу #${t.id} ${t.title}`,
          context: [t.description.slice(0, 600), t.acceptanceCriteria ? `Критерії: ${t.acceptanceCriteria.slice(0, 400)}` : ''].filter(Boolean).join('\n\n'),
          decision: `Користувач затвердив зміни (${t.assignedRole}, ${t.provider}). ${e.summary}.${review}`,
          consequences: gates.length ? `Перевірки:\n${gates.map((g) => `- ${g}`).join('\n')}` : 'Перевірок не було.' });
      }
      if (e.kind === 'integrator') {
        out.push({ ts: e.ts, taskId: t.id, title: `Інтеграційна перевірка після #${t.id} не пройшла`, context: e.summary,
          decision: `Створено чернетку Інтегратора #${String(t.artifacts.integratorTaskId ?? '?')}.`, consequences: 'Базова гілка потребує виправлення; запуск — за рішенням користувача.' });
      }
    }
  }
  return out.sort((a, b) => a.ts.localeCompare(b.ts));
}

export function adrMarkdown(store: Store, projectId: number): string {
  const p = store.getProject(projectId);
  const list = decisions(store, projectId);
  const head = `# Журнал рішень (ADR): ${p.name}\n\nЗгенеровано автоматично з історії HidForge ${new Date().toISOString()}.\n`;
  if (!list.length) return `${head}\nРішень ще немає.\n`;
  return head + list.map((d, i) => `
## ADR-${String(i + 1).padStart(3, '0')}: ${d.title}
- Дата: ${d.ts}
- Статус: прийнято

### Контекст
${d.context || '—'}

### Рішення
${d.decision}

### Наслідки
${d.consequences}
`).join('');
}

export function projectReport(store: Store, projectId: number): string {
  const p = store.getProject(projectId);
  const tasks = store.listTasks(projectId);
  const live = tasks.filter((t) => t.status !== 'canceled');
  const done = live.filter((t) => t.status === 'merged').length;
  const pct = live.length ? Math.round((done / live.length) * 100) : 0;
  const counts = Object.entries(tasks.reduce<Record<string, number>>((a, t) => ((a[t.status] = (a[t.status] ?? 0) + 1), a), {}))
    .map(([s, n]) => `${STATUS_UA[s] ?? s}: ${n}`).join(' · ');
  const problems = tasks.filter((t) => ['failed', 'blocked', 'needs_user_input'].includes(t.status));
  const c = projectCosts(store, projectId);
  const dec = decisions(store, projectId);
  const L: string[] = [
    `# Звіт по проєкту: ${p.name}`, '',
    `- Репозиторій: \`${p.repoPath}\` (гілка \`${p.baseBranch}\`)`,
    `- Ціль: ${p.goal || '—'}`,
    `- Сформовано: ${new Date().toISOString()}`, '',
    '## Підсумок', '',
    `- Злито ${done} з ${live.length} задач (${pct}%)${tasks.length !== live.length ? `, скасовано ${tasks.length - live.length}` : ''}`,
    `- За статусами: ${counts || 'задач немає'}`,
    `- Витрати: ${usd(c.totalUsd)}${c.budgetUsd != null ? ` з бюджету ${usd(c.budgetUsd)}` : ''} (USD повідомляє лише Claude Code; інші агенти — токени)`, '',
    '## Задачі', '',
    '| # | Задача | Роль | Агент | Статус | Спроби | AI-рецензія | Останній доказ |',
    '|---|---|---|---|---|---|---|---|',
    ...tasks.map((t) => {
      const rv = t.artifacts.aiReview as Review;
      const ev = lastEv(t);
      return `| ${t.id} | ${cell(t.title)} | ${cell(t.assignedRole)} | ${cell(t.provider)}${t.model ? ` ${cell(t.model)}` : ''} | ${STATUS_UA[t.status] ?? t.status} | ${t.attempts}/${t.maxAttempts} | ${cell(rv?.verdict ?? '—')} | ${ev ? `${ev.ok ? '✓' : '✗'} ${cell(ev.summary).slice(0, 120)}` : '—'} |`;
    }),
  ];
  if (problems.length) {
    L.push('', '## Потребує уваги', '');
    for (const t of problems) L.push(`- #${t.id} ${t.title} — ${STATUS_UA[t.status]}: ${cell(lastEv(t)?.summary ?? t.feedback ?? '').slice(0, 300) || 'без деталей'}`);
  }
  if (c.byProvider.length) {
    L.push('', '## Витрати за агентами', '', '| Агент | Сесій | USD | Вхідні токени | Вихідні токени |', '|---|---|---|---|---|');
    for (const r of c.byProvider) L.push(`| ${r.provider} | ${r.sessions} | ${r.sessionsWithUsd ? usd(r.usd) : '—'} | ${r.inputTokens} | ${r.outputTokens} |`);
  }
  L.push('', '## Рішення', '');
  L.push(...(dec.length ? dec.map((d) => `- ${d.ts.slice(0, 16).replace('T', ' ')} — ${d.title}`) : ['Рішень ще немає.']));
  return L.join('\n') + '\n';
}
