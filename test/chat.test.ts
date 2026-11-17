// Project chat: read-only assistant replies, history in the prompt, one reply at a time, cancel, clear, project deletion guard.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { setup, waitFor, mock } from './helpers.ts';
import { BadRequest, Conflict, type ChatMessage, type Run, type Task } from '../src/store.ts';
import { buildChatPrompt } from '../src/chat.ts';

const replies = <T extends ChatMessage>(msgs: T[]) => msgs.filter((m) => m.role === 'assistant');

test('chat: the assistant answers read-only in a snapshot, keeps history, one reply at a time', async () => {
  const { orch, project, dataDir } = await setup();
  try {
    await assert.rejects(orch.chat.send(project.id, { text: '   ', provider: 'mock' }), BadRequest);
    const u1 = await orch.chat.send(project.id, { text: 'What does README say?', provider: 'mock' });
    assert.equal(u1.role, 'user');
    assert.ok(orch.chat.state(project.id).pending, 'pending while the agent runs');
    await assert.rejects(orch.chat.send(project.id, { text: 'again', provider: 'mock' }), Conflict, 'one reply at a time');
    await waitFor(() => replies(orch.chat.state(project.id).messages).length === 1, 15_000, 'first reply');
    await orch.idle();
    const [r1] = replies(orch.chat.state(project.id).messages);
    assert.equal(r1!.text, 'MOCK reply (not an AI): What does README say?');
    assert.equal(r1!.provider, 'mock'); assert.equal(r1!.error, null);
    assert.equal(orch.chat.state(project.id).pending, null);
    assert.ok(orch.store.events({ projectId: project.id }).some((e) => e.type === 'chat.output'), 'tool steps streamed');
    assert.equal(readdirSync(path.join(dataDir, 'chat')).length, 0, 'snapshot removed');

    await orch.chat.send(project.id, { text: 'And the second question', provider: 'mock' });
    await waitFor(() => replies(orch.chat.state(project.id).messages).length === 2, 15_000, 'second reply');
    await orch.idle();
    assert.deepEqual(orch.chat.state(project.id).messages.map((m) => m.role), ['user', 'assistant', 'user', 'assistant']);

    assert.equal(orch.chat.clear(project.id).ok, true);
    assert.equal(orch.chat.state(project.id).messages.length, 0);
  } finally { await orch.stop(); }
});

test('chat: stop kills the agent; deleting the project waits for the assistant', async () => {
  const { orch, project, repo } = await setup();
  try {
    await orch.chat.send(project.id, { text: `think forever ${mock({ mode: 'hang' })}`, provider: 'mock' });
    await waitFor(() => orch.store.events({ projectId: project.id }).some((e) => e.type === 'chat.output'), 15_000, 'agent started');
    await assert.rejects(orch.deleteProject(project.id), Conflict);
    assert.throws(() => orch.chat.clear(project.id), Conflict);
    await orch.chat.cancel(project.id);
    await waitFor(() => replies(orch.chat.state(project.id).messages).length === 1, 15_000, 'canceled reply');
    await orch.idle();
    const [r] = replies(orch.chat.state(project.id).messages);
    assert.equal(r!.error, 'зупинено користувачем');
    await assert.rejects(orch.chat.cancel(project.id), Conflict);
    await orch.deleteProject(project.id);
    assert.ok(existsSync(repo), 'repository untouched');
  } finally { await orch.stop(); }
});

test('chat: asked for a plan, the assistant proposes one; it is validated, stored and applied like a planner plan', async () => {
  const { orch, project } = await setup();
  try {
    await orch.chat.send(project.id, { text: 'Склади план робіт', provider: 'mock' });
    await waitFor(() => replies(orch.chat.state(project.id).messages).length === 1, 15_000, 'plan reply');
    await orch.idle();
    let [r] = replies(orch.chat.state(project.id).messages);
    assert.equal(r!.error, null);
    assert.ok(r!.plan, 'reply carries a plan proposal');
    assert.equal(r!.plan.status, 'succeeded');
    assert.equal(r!.plan.tasks, 4);
    assert.doesNotMatch(r!.text, /```json/, 'the JSON is not shown as text');
    assert.match(r!.text, /MOCK reply \(not an AI\): Склади план робіт/);
    assert.equal(orch.store.listTasks(project.id).length, 0, 'nothing is created until the user applies it');
    assert.equal(orch.store.listPlans(project.id)[0]!.id, r!.plan.id, 'shown on the planner page as the latest plan');

    const created = orch.planner.apply(r!.plan.id);
    assert.equal(created.length, 4);
    assert.ok(created.every((t) => t.status === 'draft'));
    [r] = replies(orch.chat.state(project.id).messages);
    assert.equal(r!.plan!.status, 'applied');

    // A broken plan is not stored; the user sees why.
    await orch.chat.send(project.id, { text: `ще один план ${mock({ planRaw: '```json\n{"tasks": []}\n```' })}`, provider: 'mock' });
    await waitFor(() => replies(orch.chat.state(project.id).messages).length === 2, 15_000, 'bad plan reply');
    await orch.idle();
    const bad = replies(orch.chat.state(project.id).messages)[1]!;
    assert.equal(bad.plan, null);
    assert.match(bad.text, /не пройшов перевірку — plan has no tasks/);
    assert.equal(orch.store.listPlans(project.id).length, 1);
  } finally { await orch.stop(); }
});

test('chat prompt: stages, task state and failures, plan format, newest history within the budget, failed replies skipped', () => {
  const p = { id: 1, name: 'Demo', goal: 'Ship it', baseBranch: 'main' } as never;
  const m = (id: number, role: 'user' | 'assistant', text: string, error: string | null = null) =>
    ({ id, projectId: 1, role, text, provider: null, model: null, effort: null, usage: null, error, createdAt: '', planId: null }) as ChatMessage;
  const task = (id: number, status: string, title: string, extra = {}) => ({ id, status, title, description: '', dependsOn: [], category: null, complexity: null,
    assignedRole: 'Backend', provider: 'auto', model: null, attempts: 0, maxAttempts: 3, question: null, feedback: null, allowedPaths: [], ...extra });
  const tasks = [task(7, 'merged', 'Add login', { category: 'backend', complexity: 'medium' }),
    task(8, 'failed', 'Add logout', { dependsOn: [7], attempts: 3, description: 'Remove the session cookie' })] as never as Task[];
  const view = { pct: 50, done: 1, total: 2, currentStage: 2, running: 0, stages: [
    { n: 1, pct: 100, done: 1, total: 1, current: false, tasks: [{ id: 7 }] }, { n: 2, pct: 0, done: 0, total: 1, current: true, tasks: [{ id: 8 }] }] } as never;
  const lastRuns = new Map([[8, { status: 'failed', error: 'npm test failed: 2 tests' } as Run]]);
  const prompt = buildChatPrompt(p, { tasks, view, lastRuns, files: ['README.md'] }, [
    m(1, 'user', 'old '.repeat(10_000)), m(2, 'assistant', 'boom', 'agent exited with code 1'), m(3, 'user', 'Latest question'),
  ]);
  assert.ok(prompt.startsWith('# Chat with the HidForge assistant'));
  assert.match(prompt, /cannot change files/);
  assert.match(prompt, /Overall about 50% done/);
  assert.match(prompt, /Stage 2 \(current\): 0%, 0\/1 merged — #8/);
  assert.match(prompt, /#7 \[merged\] Add login · \(backend, medium, Backend\)/);
  assert.match(prompt, /#8 \[failed\] Add logout · \(Backend\) · depends on #7 · attempts 3\/3/);
  assert.match(prompt, /what: Remove the session cookie/);
  assert.match(prompt, /last run failed: npm test failed: 2 tests/);
  assert.match(prompt, /"allowedPaths"/, 'plan format included');
  assert.match(prompt, /User: Latest question/);
  assert.doesNotMatch(prompt, /boom/, 'failed replies are not fed back');
  assert.doesNotMatch(prompt, /old old/, 'history over the budget is dropped, newest kept');
});
