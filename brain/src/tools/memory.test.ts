// 记忆三工具（remember/recall/forget）经 ExecCtx 跑通 + 跨会话召回 + 覆盖/删除。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createNodeRuntime } from '../runtime/node.js';
import { MemoryService } from '../memory/service.js';
import { rememberTool, recallTool, forgetTool } from './memory.js';
import type { ExecCtx } from './registry.js';
import type { AgentEvent } from '../session/events.js';

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'brain-memtools-'));
}

function setup() {
  const dir = tmpdir();
  const rt = createNodeRuntime({
    cwd: dir,
    storage: { sessionsDir: `${dir}/s`, logsDir: `${dir}/l`, memoryDir: `${dir}/memory`, configDir: dir },
  });
  const memory = new MemoryService(rt, `${dir}/memory/semantic`, `${dir}/memory/episodes`);
  const events: AgentEvent[] = [];
  const ctx: ExecCtx = {
    sessionId: 'sess-A',
    cwd: dir,
    runtime: rt,
    config: undefined as never,
    memory,
    emit: (ev) => events.push(ev),
  };
  return { dir, memory, ctx, events };
}

test('remember → 新会话 recall 召回（跨会话记忆）', async () => {
  const { memory, ctx } = setup();
  const r = await rememberTool().executor({ scope: 'global', key: 'user.preferred_language', content: '用户要求一律使用中文' }, ctx);
  assert.equal(r.ok, true);

  // 新会话 B（同一记忆库）召回
  const ctxB: ExecCtx = { ...ctx, sessionId: 'sess-B' };
  const recall = await recallTool().executor({ query: '语言 中文' }, ctxB);
  assert.equal(recall.ok, true);
  assert.match(recall.output, /user.preferred_language/);
  void memory;
});

test('remember 覆盖旧值；recall 只回新值', async () => {
  const { ctx } = setup();
  await rememberTool().executor({ scope: 'global', key: 'user.city', content: '住在北京' }, ctx);
  const r2 = await rememberTool().executor({ scope: 'global', key: 'user.city', content: '住在杭州' }, ctx);
  assert.equal(r2.ok, true);
  const recall = await recallTool().executor({ query: '住' }, ctx);
  assert.match(recall.output, /杭州/);
  assert.ok(!recall.output.includes('北京'));
});

test('forget 删除后检索不到；再删报 NOT_FOUND', async () => {
  const { ctx } = setup();
  await rememberTool().executor({ scope: 'global', key: 'user.tmp', content: '临时事实' }, ctx);
  const f1 = await forgetTool().executor({ scope: 'global', key: 'user.tmp' }, ctx);
  assert.equal(f1.ok, true);
  const recall = await recallTool().executor({ query: '临时' }, ctx);
  assert.match(recall.output, /没有检索到/);
  const f2 = await forgetTool().executor({ scope: 'global', key: 'user.tmp' }, ctx);
  assert.equal(f2.ok, false);
  assert.equal(f2.error?.code, 'NOT_FOUND');
});

test('remember 脱敏拒写 → MEMORY_REDACTED + memory.write(redacted) 事件', async () => {
  const { ctx, events } = setup();
  const r = await rememberTool().executor({ scope: 'global', key: 'user.secret', content: '密码 = mypass123' }, ctx);
  assert.equal(r.ok, false);
  assert.equal(r.error?.code, 'MEMORY_REDACTED');
  assert.ok(events.some((e) => e.type === 'memory.write' && (e as { action: string }).action === 'redacted'));
});

test('未挂载记忆层 → NO_MEMORY', async () => {
  const dir = tmpdir();
  const rt = createNodeRuntime({
    cwd: dir,
    storage: { sessionsDir: `${dir}/s`, logsDir: `${dir}/l`, memoryDir: `${dir}/memory`, configDir: dir },
  });
  const ctxNoMem: ExecCtx = { sessionId: 'x', cwd: dir, runtime: rt, config: undefined as never, emit: () => undefined };
  const r = await rememberTool().executor({ scope: 'global', key: 'k', content: 'v' }, ctxNoMem);
  assert.equal(r.error?.code, 'NO_MEMORY');
});

// ── Identity 层走工具这条路 ─────────────────────────────────────────────────

test('remember(scope=identity)：进 Identity 层（不是语义记忆），一条一行可读；重申不重复', async () => {
  const { dir, memory, ctx } = setup();
  const r1 = await rememberTool().executor({ scope: 'identity', key: 'k', content: '以后回复都用中文，别夹英文' }, ctx);
  assert.equal(r1.ok, true);
  assert.match(String(r1.output), /记住了/);
  assert.equal((await memory.semantic.list()).length, 0, 'identity 不该写进语义记忆');
  const raw = fs.readFileSync(`${dir}/memory/identity.md`, 'utf8');
  assert.match(raw, /^- 以后回复都用中文，别夹英文/m);
  // 重申（措辞略有不同）→ 不新增条目
  const r2 = await rememberTool().executor({ scope: 'identity', key: 'k', content: '以后回复请都用中文，不要夹英文' }, ctx);
  assert.equal(r2.ok, true);
  assert.match(String(r2.output), /说过/);
  assert.equal((await memory.identity.list()).length, 1);
});

test('forget(scope=identity)：按原文删掉一条规矩', async () => {
  const { memory, ctx } = setup();
  await rememberTool().executor({ scope: 'identity', key: 'k', content: '别在我写代码时说话' }, ctx);
  const r = await forgetTool().executor({ scope: 'identity', key: '别在我写代码时说话' }, ctx);
  assert.equal(r.ok, true);
  assert.equal((await memory.identity.list()).length, 0);
  const r2 = await forgetTool().executor({ scope: 'identity', key: '没这条' }, ctx);
  assert.equal(r2.error?.code, 'NOT_FOUND');
});
