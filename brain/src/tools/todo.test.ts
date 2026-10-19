// 待办工具单测（hermetic）：动作映射 / 参数校验 / 端口缺失如实拒绝 / 错误回传。
// 工具**不在 brain 里存任何状态**——全部经 TodoPort 交给宿主，这里用一个假的端口验它有没有老实调、老实报。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { todoTool } from './todo.js';
import type { ExecCtx } from './registry.js';
import type { AgentPorts } from '../ports.js';

type Call = { method: 'add' | 'list'; args: unknown[] };

function ctxWith(ports: AgentPorts | undefined, opts: { addOk?: boolean; listItems?: unknown[] } = {}): { ctx: ExecCtx; calls: Call[] } {
  const calls: Call[] = [];
  const todos = {
    add: async (text: string, o?: { priority?: 'high' | 'mid' | 'low' | null }) => {
      calls.push({ method: 'add', args: [text, o] });
      return opts.addOk === false ? { ok: false, error: '磁盘满了' } : { ok: true };
    },
    list: async () => {
      calls.push({ method: 'list', args: [] });
      return (opts.listItems ?? []) as Array<{ id: string; text: string; priority: string | null; done: boolean }>;
    },
  };
  const base = { sessionId: 's1', cwd: '/tmp', runtime: {} as ExecCtx['runtime'], config: {} as ExecCtx['config'], emit: () => undefined };
  const ctx = { ...base, ports: ports ? { ...ports, todos } : undefined } as unknown as ExecCtx;
  return { ctx, calls };
}

const run = (ctx: ExecCtx, args: unknown) => todoTool().executor(args as never, ctx);

test('todo.add：记一条 → 调端口一次，来源由宿主定（这里只验参数原样传下去）', async () => {
  const { ctx, calls } = ctxWith({});
  const r = await run(ctx, { action: 'add', text: '把桌面那批截图归档' });
  assert.equal(r.ok, true);
  assert.match(r.output, /记下了/);
  assert.deepEqual(calls, [{ method: 'add', args: ['把桌面那批截图归档', { priority: null }] }]);
});

test('todo.add：priority 带上 → 原样传给端口，回话里带优先级', async () => {
  const { ctx, calls } = ctxWith({});
  const r = await run(ctx, { action: 'add', text: '回名单口径', priority: 'high' });
  assert.equal(r.ok, true);
  assert.match(r.output, /高优先级/);
  assert.deepEqual(calls[0], { method: 'add', args: ['回名单口径', { priority: 'high' }] });
});

test('todo.add：没写 text → 拒绝（不拿空串去写盘）', async () => {
  const { ctx, calls } = ctxWith({});
  const r = await run(ctx, { action: 'add', text: '   ' });
  assert.equal(r.ok, false);
  assert.equal(r.error?.code, 'BAD_ARG');
  assert.equal(calls.length, 0);
});

test('todo.add：priority 写了别的值 → 拒绝（别静默降级成"默认"）', async () => {
  const { ctx, calls } = ctxWith({});
  const r = await run(ctx, { action: 'add', text: 'x', priority: 'urgent' });
  assert.equal(r.ok, false);
  assert.equal(r.error?.code, 'BAD_ARG');
  assert.equal(calls.length, 0);
});

test('todo.list：空 → 说人话，不是"[]"', async () => {
  const { ctx } = ctxWith({});
  const r = await run(ctx, { action: 'list' });
  assert.equal(r.ok, true);
  assert.match(r.output, /没有待办/);
});

test('todo.list：有条目 → 逐条列出，优先级以（高/中/低）标注', async () => {
  const { ctx } = ctxWith({}, { listItems: [
    { id: 't1', text: '把名单发出去', priority: 'high', done: false },
    { id: 't2', text: '看看季报里那个数', priority: null, done: false },
  ] });
  const r = await run(ctx, { action: 'list' });
  assert.equal(r.ok, true);
  assert.match(r.output, /2 条待办/);
  assert.match(r.output, /把名单发出去（高）/);
  assert.match(r.output, /看看季报里那个数$/m);   // 没标优先级 → 不加括号，不显示「默认」
});

test('端口没注入 → 如实拒绝，且**不许假装记下了**', async () => {
  const { ctx, calls } = ctxWith(undefined);
  const r = await run(ctx, { action: 'add', text: 'x' });
  assert.equal(r.ok, false);
  assert.equal(r.error?.code, 'NO_TODO');
  assert.match(String(r.error?.message), /没有挂载/);
  assert.equal(calls.length, 0);
});

test('宿主写失败 → 原样带回人话原因，不吞', async () => {
  const { ctx } = ctxWith({}, { addOk: false });
  const r = await run(ctx, { action: 'add', text: 'x' });
  assert.equal(r.ok, false);
  assert.equal(r.error?.code, 'TODO_FAIL');
  assert.match(String(r.error?.message), /磁盘满了/);
});

test('不认识的 action → 拒绝并列出可用项', async () => {
  const { ctx } = ctxWith({});
  const r = await run(ctx, { action: 'delete', text: 'x' });
  assert.equal(r.ok, false);
  assert.equal(r.error?.code, 'BAD_ARG');
  assert.match(String(r.error?.message), /add \/ list/);
});

test('工具说明里写清了与 schedule 的分工（防"两个都记"）', () => {
  const d = todoTool().schema.function.description ?? '';
  assert.match(d, /schedule/);
  assert.match(d, /别两个都记/);
  assert.equal(todoTool().name, 'todo');
});
