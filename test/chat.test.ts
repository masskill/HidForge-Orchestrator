// Project chat: read-only assistant replies, history in the prompt, one reply at a time, cancel, clear, project deletion guard.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { setup, waitFor, mock } from './helpers.ts';
import { BadRequest, Conflict, type ChatMessage } from '../src/store.ts';
import { buildChatPrompt } from '../src/chat.ts';

const replies = (msgs: ChatMessage[]) => msgs.filter((m) => m.role === 'assistant');

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

test('chat prompt: read-only instructions, tasks, newest history within the budget, failed replies skipped', () => {
  const p = { id: 1, name: 'Demo', goal: 'Ship it', baseBranch: 'main' } as never;
  const m = (id: number, role: 'user' | 'assistant', text: string, error: string | null = null) =>
    ({ id, projectId: 1, role, text, provider: null, model: null, effort: null, usage: null, error, createdAt: '' }) as ChatMessage;
  const prompt = buildChatPrompt(p, [{ id: 7, status: 'draft', title: 'Add login' }] as never, [
    m(1, 'user', 'old '.repeat(10_000)), m(2, 'assistant', 'boom', 'agent exited with code 1'), m(3, 'user', 'Latest question'),
  ], ['README.md']);
  assert.ok(prompt.startsWith('# Chat with the HidForge assistant'));
  assert.match(prompt, /cannot change files/);
  assert.match(prompt, /#7 \[draft\] Add login/);
  assert.match(prompt, /User: Latest question/);
  assert.doesNotMatch(prompt, /boom/, 'failed replies are not fed back');
  assert.doesNotMatch(prompt, /old old/, 'history over the budget is dropped, newest kept');
});
