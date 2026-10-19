// 后台复盘单测：**独立 context + 工具白名单 + 只提候选**。
//
// 为什么这些断言必须在**内核**这一层：
//   · 白名单是安全属性（"绝不给 bash/write/edit"）——它必须有一条不看界面的、
//     直接盯住"复盘这次实际拿到的工具表"的断言，否则哪天有人把 READONLY_TOOL_SET 放宽就没人发现；
//   · "不外传"是产品属性（后台复盘的字不许出现在她的对话里）——只该有两个候选事件走出去。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAgent } from '../factory.js';
import { MockProvider, mockToolCalls } from '../llm/adapters/mock.js';
import type { ChatEvent } from '../llm/provider.js';
import type { AgentEvent } from '../session/events.js';
import type { ToolEntry } from '../tools/registry.js';
import { runReview, renderTranscript, REVIEW_TOOLS, REVIEWER_SYSTEM } from './review.js';

/**
 * 提候选工具的**桩**（真身在宿主 `runtime/lib.mjs`：它要碰技能目录与宿主状态）。
 * 这里只验复盘机制本身；真工具"确实只提候选、真的落盘"由宿主侧守。
 */
function stubProposeTools(): ToolEntry[] {
  const mk = (name: 'propose_memory' | 'propose_skill'): ToolEntry => ({
    name,
    permissionClass: 'internal',
    schema: { type: 'function', function: { name, description: `${name}（桩）`, parameters: { type: 'object', properties: {} } } },
    executor: async (_args, ctx) => {
      if (name === 'propose_memory') ctx.emit({ type: 'memory.candidate', key: 'work.report', content: '下周三交济易贷月报', why: '用户明说了交期', by: 'review' } as AgentEvent);
      return { ok: true, output: '已提候选' };
    },
  });
  return [mk('propose_memory'), mk('propose_skill')];
}

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'brain-review-'));
}

const textTurn = (text: string): ChatEvent[] => [
  { type: 'text.delta', text },
  { type: 'done', usage: { inTokens: 10, hitTokens: 0, missTokens: 10, outTokens: 5, reasoningTokens: 0, costUsd: 0 } },
];

/** 一个"提一条候选记忆 + 说一句"的复盘回合 */
function proposeTurn(): ChatEvent[][] {
  return [
    mockToolCalls([{ id: 'p1', name: 'propose_memory', args: { key: 'work.report', content: '下周三交济易贷月报', why: '用户明说了交期' } }]),
    textTurn('提了一条：下周三交月报（等你点头才生效）'),
  ];
}

async function setup(script: ChatEvent[][]) {
  const dir = tmpdir();
  const agent = await createAgent({
    cwd: dir,
    home: dir,
    cli: { sessions: { dir: `${dir}/sessions` } },
    provider: new MockProvider({ script }),
  });
  const events: AgentEvent[] = [];
  const hostSession = agent.createSession({ emit: (ev) => events.push(ev) });
  return { dir, agent, hostSession, events };
}

test('复盘者拿到的是**白名单那三件**：recall + 两个提候选工具，没有 bash/write/edit/delete', async () => {
  const { agent, hostSession } = await setup([...proposeTurn()]);
  const extra = stubProposeTools();
  let seenTools: string[] = [];
  // 偷看一次请求：mock provider 会把每次请求记下来
  const provider = hostSession.provider as unknown as { requests?: Array<{ tools?: Array<{ function: { name: string } }> }> };
  await runReview({ agent, hostSession, transcript: '用户：下周三要交济易贷的月报', extraTools: extra });
  seenTools = (provider.requests ?? []).flatMap((r) => (r.tools ?? []).map((t) => t.function.name));
  const names = [...new Set(seenTools)].sort();
  assert.deepEqual(names, [...REVIEW_TOOLS].sort(), `复盘者这一轮看到的工具应当**只有**白名单那几件，实际：${names.join(', ')}`);
  assert.equal(names.includes('bash'), false);
  assert.equal(names.includes('write'), false);
  assert.equal(names.includes('edit'), false);
  assert.equal(names.includes('delete'), false);
  assert.equal(names.includes('read'), false, '连 read 都不给：要判断的东西已经在摘录里');
});

test('复盘者的上下文是**独立的**：system 是复盘者那份，历史从零开始', async () => {
  const { agent, hostSession } = await setup([...proposeTurn()]);
  const extra = stubProposeTools();
  const provider = hostSession.provider as unknown as { requests?: Array<{ system?: string; messages?: Array<{ content: unknown }> }> };
  // 主会话先聊两句脏历史——复盘者一个字节都不该看见
  hostSession.history = [
    { role: 'user', content: '主会话的第一句话' },
    { role: 'assistant', content: '主会话的回答' },
  ];
  await runReview({ agent, hostSession, transcript: '用户：下周三要交济易贷的月报', extraTools: extra });
  const reqs = provider.requests ?? [];
  const last = reqs[reqs.length - 1]!;
  assert.ok(String(last.system ?? '').includes('你是复盘者'), 'system 必须是复盘者那份');
  assert.equal(String(last.system ?? '').includes(REVIEWER_SYSTEM.slice(0, 10)), true);
  const all = JSON.stringify(last.messages ?? []);
  assert.equal(all.includes('主会话的第一句话'), false, '主会话历史不许进复盘者的请求');
  assert.ok(all.includes('济易贷'), '摘录要在（复盘靠的就是它）');
});

test('只有候选事件往外走：复盘者的正文与工具步骤都不外传', async () => {
  const { agent, hostSession, events } = await setup([...proposeTurn()]);
  const extra = stubProposeTools();
  const r = await runReview({ agent, hostSession, transcript: '用户：下周三要交济易贷的月报', extraTools: extra });
  assert.equal(r.ok, true, r.error ?? '');
  assert.equal(r.candidates, 1, '提了 1 条候选');
  const types = events.map((e) => e.type);
  assert.deepEqual([...new Set(types)], ['memory.candidate'], `只有候选事件该外传，实际：${types.join(', ')}`);
  const ev = events[0] as Extract<AgentEvent, { type: 'memory.candidate' }>;
  assert.equal(ev.key, 'work.report');
  assert.equal(ev.by, 'review');
  assert.ok(ev.why.length > 0, 'why 必须有（凭什么提这条）');
});

test('renderTranscript：只留"谁说了什么"，超长截断并如实标注', () => {
  const t = renderTranscript([
    { role: 'user', text: '  你好\n\n我在忙  ' },
    { role: 'assistant', text: '好' },
    { role: 'user', text: '' },
  ]);
  assert.equal(t, '用户：你好 我在忙\n她：好');
  const long = renderTranscript([{ role: 'user', text: '啊'.repeat(100) }], 20);
  assert.ok(long.length < 60 && long.endsWith('（前文省略）'));
});
