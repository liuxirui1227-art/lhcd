// **追加式上下文不变量**——"请求内容只允许在尾部增长"。
// 为什么要它：在前面插东西会让服务商的 KV 缓存整段作废（成本翻倍），也会让上下文与刚说过的话对不上。
// 这里锁三件事：正常追加**不许**报警；中途插一条**必须**报警；工具集变了也算前缀作废（如实说，不静默）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAgent } from '../factory.js';
import { MockProvider, mockText } from '../llm/adapters/mock.js';
import { runTurn } from './turn.js';
import type { AgentEvent } from '../session/events.js';

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'brain-appendonly-'));
}

/** 收集一次回合里 emit 出来的事件 */
async function turnAndCollect(session: { emit: (ev: AgentEvent) => void }, text: string): Promise<AgentEvent[]> {
  const seen: AgentEvent[] = [];
  const prev = session.emit;
  session.emit = (ev) => { seen.push(ev); prev(ev); };
  try {
    await runTurn(session as never, text);
  } finally {
    session.emit = prev;
  }
  return seen;
}

const brokenOf = (evs: AgentEvent[]) => evs.filter((e) => e.type === 'cache.broken') as Array<{ type: 'cache.broken'; reason: string }>;

test('追加式不变量：正常追加不报警；中途插一条必须报 cache.broken', async () => {
  const dir = tmpdir();
  const provider = new MockProvider({ script: [mockText('一'), mockText('二'), mockText('三')] });
  const agent = await createAgent({ cwd: dir, home: dir, provider });
  const session = agent.createSession();

  const t1 = await turnAndCollect(session, '第一句');
  assert.equal(brokenOf(t1).length, 0, '第一轮没有可比的前缀，不该报');

  const t2 = await turnAndCollect(session, '第二句');
  assert.equal(brokenOf(t2).length, 0, '正常追加（尾部多两条）不该报');

  // 模拟"中途插入"：把一条旧消息塞到历史**开头**（不是尾部）
  session.history.unshift({ role: 'user', content: '这是有人插进来的' });
  const t3 = await turnAndCollect(session, '第三句');
  const broken = brokenOf(t3);
  assert.equal(broken.length, 1, '中途插一条必须报一次');
  assert.match(broken[0]!.reason, /不是在尾部追加/, `理由要说清楚：${broken[0]!.reason}`);
  assert.match(broken[0]!.reason, /前缀对不上/);
});

test('工具集变了也报 cache.broken（tools 是可缓存前缀的一部分）', async () => {
  const dir = tmpdir();
  const provider = new MockProvider({ script: [mockText('一'), mockText('二')] });
  const agent = await createAgent({ cwd: dir, home: dir, provider });
  const session = agent.createSession();

  const t1 = await turnAndCollect(session, '第一句');
  assert.equal(brokenOf(t1).length, 0);

  // 切成"不用工具"（宿主按回合切 noTools/readonlyTools 是真实存在的路径）
  session.noTools = true;
  const t2 = await turnAndCollect(session, '第二句');
  const broken = brokenOf(t2);
  assert.equal(broken.length, 1, '工具集变了要报');
  assert.match(broken[0]!.reason, /工具集变了/);
});
