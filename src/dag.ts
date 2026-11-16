// Dependency graph checks for the task plan.
import type { Task } from './store.ts';

/** Returns an error message if `deps` for `taskId` reference missing tasks or would create a cycle. */
export function validateDeps(tasks: Pick<Task, 'id' | 'dependsOn'>[], taskId: number, deps: number[]): string | null {
  const byId = new Map(tasks.map((t) => [t.id, t.dependsOn]));
  for (const d of deps) {
    if (d === taskId) return `task ${taskId} cannot depend on itself`;
    if (!byId.has(d)) return `dependency ${d} does not exist in this project`;
  }
  byId.set(taskId, deps);
  // DFS from taskId: reaching taskId again means a cycle.
  const seen = new Set<number>();
  const stack = [...deps];
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur === taskId) return `dependency cycle through task ${taskId}`;
    if (seen.has(cur)) continue;
    seen.add(cur);
    stack.push(...(byId.get(cur) ?? []));
  }
  return null;
}

/** Topological order (Kahn). Throws on cycle. */
export function topoOrder(tasks: Pick<Task, 'id' | 'dependsOn'>[]): number[] {
  const indeg = new Map(tasks.map((t) => [t.id, 0]));
  for (const t of tasks) for (const d of t.dependsOn) if (indeg.has(d)) indeg.set(t.id, indeg.get(t.id)! + 1);
  const q = tasks.filter((t) => indeg.get(t.id) === 0).map((t) => t.id);
  const out: number[] = [];
  while (q.length) {
    const id = q.shift()!;
    out.push(id);
    for (const t of tasks) if (t.dependsOn.includes(id)) {
      indeg.set(t.id, indeg.get(t.id)! - 1);
      if (indeg.get(t.id) === 0) q.push(t.id);
    }
  }
  if (out.length !== tasks.length) throw new Error('dependency cycle');
  return out;
}

/** A task may start only when every dependency is merged into the base branch. */
export function depsSatisfied(task: Pick<Task, 'dependsOn'>, all: Map<number, Pick<Task, 'status'>>): boolean {
  return task.dependsOn.every((d) => all.get(d)?.status === 'merged');
}
