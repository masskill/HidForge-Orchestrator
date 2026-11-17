// Progress per roadmap section, computed from the markers in docs/ROADMAP.md (✅ = 1, 🟡 = 0.5, ⬜ = 0).
// Usage: node scripts/progress.ts
import { readFileSync } from 'node:fs';

const WEIGHT: Record<string, number> = { '✅': 1, '🟡': 0.5, '⬜': 0 };
const sections: { name: string; done: number; total: number }[] = [];
for (const line of readFileSync(new URL('../docs/ROADMAP.md', import.meta.url), 'utf8').split(/\r?\n/)) {
  if (line.startsWith('## ')) sections.push({ name: line.slice(3).trim(), done: 0, total: 0 });
  const m = /^- (✅|🟡|⬜)/u.exec(line);
  if (m && sections.length) { const s = sections.at(-1)!; s.total++; s.done += WEIGHT[m[1]!]!; }
}
const pct = (d: number, t: number) => (t ? Math.round((d / t) * 100) : 0);
const bar = (p: number) => '█'.repeat(Math.round(p / 10)).padEnd(10, '░');
for (const s of sections) {
  const p = pct(s.done, s.total);
  console.log(`${bar(p)} ${String(p).padStart(3)}% готово | ${String(100 - p).padStart(3)}% лишилось | ${s.name} (${s.done}/${s.total})`);
}
const stages = sections.filter((s) => s.name.startsWith('Етап'));
const overall = Math.round(stages.reduce((a, s) => a + pct(s.done, s.total), 0) / stages.length);
console.log(`\nЗагалом по етапах 0–6: ${overall}% готово, ${100 - overall}% лишилось`);
