// 会话存储——save/load 往返、resume 重放、fork、configHash 变更、事件追加。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createNodeRuntime } from '../runtime/node.js';
import { SessionStore } from './store.js';

/** `load()` 会在**内存里**给老条目补 id/parentId（文件不动）。
    比较"内容"时把这两个宿主字段剥掉——它们不是会话内容。 */
const stripHost = (h: unknown[]) => h.map((m) => {
  const { id: _id, parentId: _pid, ...rest } = m as Record<string, unknown>;
  return rest;
});
import { MockProvider, mockText } from '../llm/adapters/mock.js';
import { ToolRegistry } from '../tools/registry.js';
import { readTool } from '../tools/read.js';
import { loadConfig } from '../config/load.js';
import { Session } from '../loop/session.js';
import { runTurn } from '../loop/turn.js';
import type { AgentEvent } from './events.js';

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'brain-store-'));
}

function setup() {
  const dir = tmpdir();
  const rt = createNodeRuntime({
    cwd: dir,
    storage: { sessionsDir: `${dir}/sessions`, logsDir: `${dir}/logs`, memoryDir: `${dir}/memory`, configDir: dir },
  });
  const registry = new ToolRegistry();
  registry.register(readTool());
  const config = loadConfig({ cwd: dir, home: dir });
  const provider = new MockProvider({ script: [mockText('回复')] });
  const session = new Session({ cwd: dir, config, provider, runtime: rt, registry, system: 'sys' });
  const store = new SessionStore(rt);
  return { dir, rt, session, store, config };
}

test('save/load 往返：历史重放 + configHash 一致', async () => {
  const { session, store, config } = setup();
  session.history = [
    { role: 'user', content: '你好' },
    { role: 'assistant', content: '你好呀' },
  ];
  session.stats.iterations = 3;
  const startedAt = session.runtime.clock();
  await store.save(session, startedAt);

  const loaded = await store.load(session.id, config);
  assert.ok(loaded);
  assert.equal(loaded.meta.id, session.id);
  assert.equal(loaded.meta.startedAt, startedAt);
  assert.equal(loaded.configChanged, false);
  assert.deepEqual(stripHost(loaded.history), stripHost(session.history));
  assert.equal(loaded.meta.stats.iterations, 3);
});

test('configHash 变更 → 警告标记', async () => {
  const { session, store, config } = setup();
  await store.save(session, session.runtime.clock());
  const changed = { ...config, budget: { ...config.budget, maxIterations: 99 } };
  const loaded = await store.load(session.id, changed);
  assert.equal(loaded?.configChanged, true);
});

test('load 不存在的会话 → null', async () => {
  const { store, config } = setup();
  assert.equal(await store.load('nope', config), null);
});

test('事件追加：events.jsonl 每行可解析为 AgentEvent', async () => {
  const { session, store } = setup();
  const emit = store.makeEmitter(session.id);
  emit({ type: 'turn.start', seq: 1 });
  emit({ type: 'tool.call', seq: 1, id: 'c1', name: 'read', args: { path: 'a' } });
  const raw = (await session.runtime.fs.read(`${session.runtime.storage.sessionsDir()}/${session.id}/events.jsonl`)).content;
  const events = raw.split('\n').filter(Boolean).map((l) => JSON.parse(l) as AgentEvent);
  assert.equal(events.length, 2);
  assert.equal(events[0]!.type, 'turn.start');
  assert.equal(events[1]!.type, 'tool.call');
});

test('fork：新 id 复制全部存档', async () => {
  const { session, store, config } = setup();
  session.history = [{ role: 'user', content: '原文' }];
  await store.save(session, session.runtime.clock());
  store.makeEmitter(session.id)({ type: 'turn.start', seq: 1 });
  await store.fork(session.id, 'child-1');

  const child = await store.load('child-1', config);
  assert.ok(child);
  assert.equal(child.meta.id, 'child-1'); // meta 中 id 保持原值（快照复制），history 完整
  // `load()` 会在内存里补 id/parentId（文件不动）→ 比内容时剥掉这两个宿主字段
  assert.deepEqual(stripHost(child.history), stripHost(session.history));
  const events = (await session.runtime.fs.read(`${session.runtime.storage.sessionsDir()}/child-1/events.jsonl`)).content;
  assert.ok(events.includes('turn.start'));
});

test('resume 续跑：重放历史后继续对话', async () => {
  const { session, store, config } = setup();
  session.history = [{ role: 'user', content: '之前聊过' }];
  await store.save(session, session.runtime.clock());

  const loaded = await store.load(session.id, config);
  const resumed = new Session({
    id: session.id,
    cwd: session.cwd,
    config,
    provider: session.provider,
    runtime: session.runtime,
    registry: session.registry,
    system: 'sys',
  });
  resumed.history = loaded!.history;
  const result = await runTurn(resumed, '继续');
  assert.equal(result.kind, 'final');
  // 新输入追加在重放历史之后（不丢旧记忆）
  assert.equal(resumed.history[0]!.content, '之前聊过');
  assert.ok(resumed.estimateTokens() > 0);
});

/* ── 对话树：分支落盘（老分支一个字节不动） ───────────────────────────────── */

test('分支：从某条用户消息重说 → 新会话 id 是 `<父>~b1`，内容是那条之前的历史；老会话文件不变', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-branch-'));
  const rt = createNodeRuntime({
    cwd: dir,
    storage: { sessionsDir: `${dir}/s`, logsDir: `${dir}/l`, memoryDir: `${dir}/m`, configDir: `${dir}/c` },
  });
  const store = new SessionStore(rt);
  const session = {
    id: 'main', cwd: dir, provider: { name: 'mock' }, config: { a: 1 }, stats: {},
    history: [
      { role: 'user', content: '第一句' },
      { role: 'assistant', content: '回一' },
      { role: 'user', content: '第二句（说重了）' },
      { role: 'assistant', content: '回二' },
    ],
  } as never;
  await store.save(session as never, '2026-09-26T00:00:00.000Z');
  const before = fs.readFileSync(path.join(dir, 's', 'main', 'messages.jsonl'), 'utf8');

  // 先读回（老会话没有 id → 内存里补齐），拿到那句话的 id
  const loaded = await store.load('main', { a: 1 });
  const target = (loaded!.history as unknown as { id: string; content: string }[]).find((m) => String(m.content).includes('第二句'))!;
  assert.ok(target?.id, '读回来要补上 id');

  const b = await store.branch('main', target.id, 1);
  assert.ok(b, '分支要成功');
  assert.equal(b!.id, 'main~b1');
  assert.equal(b!.text, '第二句（说重了）', '原话回填输入框');
  assert.equal(b!.keptCount, 2, '只保留那条之前的两句');

  // 新会话内容 = 前两句；meta 里记着从哪来
  const nb = await store.load('main~b1', { a: 1 });
  assert.deepEqual((nb!.history as { content: string }[]).map((m) => m.content), ['第一句', '回一']);
  assert.equal(nb!.meta.branchedFrom?.sessionId, 'main');
  assert.equal(nb!.meta.branchedFrom?.atMessageId, target.id);

  // 老分支：一个字节都没动
  assert.equal(fs.readFileSync(path.join(dir, 's', 'main', 'messages.jsonl'), 'utf8'), before);

  // 找不到那条消息 → 如实 null（不装作成功）
  assert.equal(await store.branch('main', 'm不存在', 2), null);
});
