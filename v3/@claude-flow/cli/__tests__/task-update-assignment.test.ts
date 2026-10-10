import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const state = vi.hoisted(() => ({ cwd: '', failSave: false }));
vi.mock('node:fs', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return { ...fs, writeFileSync: (...args: Parameters<typeof fs.writeFileSync>) => {
    if (state.failSave && String(args[0]).endsWith('/tasks/store.json')) throw new Error('save failed');
    return fs.writeFileSync(...args);
  } };
});
vi.mock('../src/mcp-tools/types.js', () => ({ getProjectCwd: () => state.cwd }));
import { taskTools } from '../src/mcp-tools/task-tools.js';
const call = (name: string, input: Record<string, unknown>) => taskTools.find(t => t.name === name)!.handler(input) as Promise<any>;
const stores = ['agents/store.json', 'agents.json'];
const agents = (file: string) => JSON.parse(readFileSync(join(state.cwd, '.claude-flow', file), 'utf8')).agents;
beforeEach(() => {
  state.failSave = false;
  state.cwd = mkdtempSync(join(tmpdir(), 'ruflo-task-reassign-'));
  mkdirSync(join(state.cwd, '.claude-flow/agents'), { recursive: true });
  for (const file of stores) writeFileSync(join(state.cwd, '.claude-flow', file), JSON.stringify({ agents: {
    old: { status: 'idle', currentTask: null, taskCount: 0 },
    next: { status: 'idle', currentTask: null, taskCount: 0 },
  } }));
});
afterEach(() => rmSync(state.cwd, { recursive: true, force: true }));
it('reassigns through task_update with the same worker state as task_assign in both stores', async () => {
  const { taskId } = await call('task_create', { type: 'test', description: 'work' });
  await call('task_assign', { taskId, agentIds: ['old'] });
  await call('task_update', { taskId, assignTo: ['next'] });
  for (const file of stores) {
    expect(agents(file).old).toMatchObject({ status: 'idle', currentTask: null });
    expect(agents(file).next).toMatchObject({ status: 'busy', currentTask: taskId });
  }
  await call('task_complete', { taskId });
  for (const file of stores) expect(agents(file).next).toMatchObject({ status: 'idle', currentTask: null, taskCount: 1 });
});
it('an empty assignment releases the former worker', async () => {
  const { taskId } = await call('task_create', { type: 'test', description: 'work' });
  await call('task_assign', { taskId, agentIds: ['old'] });
  await call('task_update', { taskId, assignTo: [] });
  for (const file of stores) expect(agents(file).old).toMatchObject({ status: 'idle', currentTask: null });
});
it.each(['completed', 'failed', 'cancelled'])('a simultaneous %s and reassignment frees the workers that actually held the task', async status => {
  const { taskId } = await call('task_create', { type: 'test', description: 'work' });
  await call('task_assign', { taskId, agentIds: ['old'] });
  await call('task_update', { taskId, status, assignTo: ['next'] });
  for (const file of stores) {
    expect(agents(file).old).toMatchObject({ status: 'idle', currentTask: null, taskCount: status === 'completed' ? 1 : 0 });
    expect(agents(file).next).toMatchObject({ status: 'idle', currentTask: null, taskCount: 0 });
  }
});

it('preserves both worker stores when saving the reassignment fails', async () => {
  const { taskId } = await call('task_create', { type: 'test', description: 'work' });
  await call('task_assign', { taskId, agentIds: ['old'] });
  const before = stores.map(file => readFileSync(join(state.cwd, '.claude-flow', file), 'utf8'));
  state.failSave = true;
  await expect(call('task_update', { taskId, assignTo: ['next'] })).rejects.toThrow('save failed');
  expect(stores.map(file => readFileSync(join(state.cwd, '.claude-flow', file), 'utf8'))).toEqual(before);
});
it('does not free a former assignee who now holds another task', async () => {
  const first = await call('task_create', { type: 'test', description: 'first' });
  const second = await call('task_create', { type: 'test', description: 'second' });
  await call('task_assign', { taskId: first.taskId, agentIds: ['old'] });
  await call('task_assign', { taskId: second.taskId, agentIds: ['old'] });
  await call('task_update', { taskId: first.taskId, assignTo: ['next'] });
  for (const file of stores) expect(agents(file).old).toMatchObject({ status: 'busy', currentTask: second.taskId });
});
