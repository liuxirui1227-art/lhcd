// 自动巩固：压缩摘要 facts 落语义层 + 情景归档；脱敏过滤；无摘要仅归档。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createNodeRuntime } from '../runtime/node.js';
import { MemoryService } from './service.js';
import { consolidateSession } from './consolidate.js';
import { Session } from '../loop/session.js';
import { MockProvider } from '../llm/adapters/mock.js';
import { ToolRegistry } from '../tools/registry.js';
import { loadConfig } from '../config/load.js';
import type { CompactSummary } from '../prompt/compact.js';

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'brain-consolidate-'));
}

function setup() {
  const dir = tmpdir();
  const rt = createNodeRuntime({
    cwd: dir,
    storage: { sessionsDir: `${dir}/s`, logsDir: `${dir}/l`, memoryDir: `${dir}/memory`, configDir: dir },
  });
  const memory = new MemoryService(rt, `${dir}/memory/semantic`, `${dir}/memory/episodes`);
  const session = new Session({
    id: 'sess-1',
    cwd: dir,
    config: loadConfig({ cwd: dir, home: dir }),
    provider: new MockProvider({ script: [] }),
    runtime: rt,
    registry: new ToolRegistry(),
    system: 'sys',
  });
  session.history = [
    { role: 'user', content: '帮我整理项目偏好' },
    { role: 'assistant', content: '已整理完成。' },
  ];
  return { dir, memory, session };
}

test('有压缩摘要：facts 落语义层（低置信、可召回）+ 情景归档', async () => {
  const { memory, session } = setup();
  const summary: CompactSummary = {
    goal: '整理偏好',
    done: [], in_progress: [], blocked: [], decisions: [], constraints: [], failures: [], file_states: [], todo_verify: [],
    facts: ['用户偏好中文回复', '项目用 MySQL'],
    plan: [],
    files: ['a.md'],
    last_tool_results: 'r',
    warnings: ['部署前复核'],
  };
  const r = await consolidateSession(session, memory, summary);
  assert.equal(r.added, 2);
  assert.equal(r.episodeWritten, true);

  const hits = await memory.search('中文');
  assert.equal(hits[0]!.entry.content, '用户偏好中文回复');
  assert.equal(hits[0]!.entry.confidence, 'low');
  assert.equal(hits[0]!.entry.source, 'sess-1');

  const ep = await memory.readEpisode('sess-1');
  assert.equal(ep?.goal, '整理偏好');
  assert.deepEqual(ep?.lessons, ['部署前复核']);
});

test('摘要含敏感事实 → redacted 跳过，不落盘', async () => {
  const { memory, session } = setup();
  const summary: CompactSummary = {
    goal: 'g',
    done: [], in_progress: [], blocked: [], decisions: [], constraints: [], failures: [], file_states: [], todo_verify: [],
    facts: ['正常事实', 'token = abc123456789'], plan: [], files: [], last_tool_results: '', warnings: [],
  };
  const r = await consolidateSession(session, memory, summary);
  assert.equal(r.added, 1);
  assert.equal(r.redacted, 1);
  const hits = await memory.search('token');
  assert.equal(hits.length, 0);
});

test('无摘要：只写情景归档，不写语义层', async () => {
  const { memory, session } = setup();
  const r = await consolidateSession(session, memory, undefined);
  assert.equal(r.added, 0);
  assert.equal(r.episodeWritten, true);
  const ep = await memory.readEpisode('sess-1');
  assert.equal(ep?.goal, '帮我整理项目偏好'); // 首条 user 输入兜底
});

test('空会话（一句话没说就退出）不抛、也不写空 episode（2026-09-25 修）', async () => {
  const { memory, session } = setup();
  session.history = [];                       // 打开应用没说一句话：这正是"退出前巩固"会撞上的形状
  const r = await consolidateSession(session, memory, undefined);
  assert.equal(r.episodeWritten, false, '没有"干了什么"就不写空 episode');
  assert.equal(r.added + r.updated, 0);
  // 再验一次：只有系统消息也一样不抛
  session.history = [{ role: 'system', content: '（宿主注入的情境提示）' }] as never;
  const r2 = await consolidateSession(session, memory, undefined);
  assert.equal(r2.episodeWritten, false);
});
