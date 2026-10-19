// 事件回放（把"她做了什么"从只写不读的日志里重建出来）。
// 重点不在"能重建"，而在"**缺口要说得出来**"——日志看着完整和真的完整是两件事。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { replayEvents, loadEvents, replaySession } from './replay.js';
import { createNodeRuntime } from '../runtime/node.js';
import type { AgentEvent } from './events.js';

const env = (n: number) => ({ id: `ev-t-${n}`, at: new Date(Date.UTC(2026, 8, 26, 8, 0, n)).toISOString() });
const stamped = (ev: unknown, n: number) => ({ ...(ev as object), env: env(n) }) as unknown as AgentEvent;

test('回放：一轮的正文/工具/用量都能重建；工具时延从两个信封算得出', () => {
  const events: AgentEvent[] = [
    stamped({ type: 'turn.start', seq: 1 }, 0),
    stamped({ type: 'assistant.text.delta', seq: 1, text: '你好' }, 1),
    stamped({ type: 'assistant.reasoning.delta', seq: 1, text: '想一下' }, 2),
    stamped({ type: 'tool.call', seq: 1, id: 'c1', name: 'read', args: { path: 'a' }, risk: 'R1' }, 3),
    stamped({ type: 'tool.result', seq: 1, id: 'c1', ok: true, output: 'x', truncated: false }, 5),
    stamped({ type: 'turn.end', seq: 1, final: true, usage: { inTokens: 10, hitTokens: 4, missTokens: 6, outTokens: 3, reasoningTokens: 2, costUsd: 0.001 } }, 6),
  ];
  const r = replayEvents(events);
  assert.equal(r.turns.length, 1);
  const t = r.turns[0]!;
  assert.equal(t.seq, 1);
  assert.equal(t.textChars, 2);
  assert.equal(t.reasoningChars, 3);
  assert.equal(t.final, true);
  assert.equal(t.tools.length, 1);
  assert.equal(t.tools[0]!.ok, true);
  assert.equal(t.tools[0]!.risk, 'R1');
  assert.equal(t.tools[0]!.ms, 2000, 'call→result 的毫秒差');
  assert.equal(t.usage?.costUsd, 0.001);
  assert.deepEqual(r.gaps, [], '完整的一轮不该报缺口');
  assert.ok(r.from && r.to, '起止时刻来自信封');
});

test('回放：缺口要如实报（缺 turn.end / 缺工具结果 / 孤儿 turn.end）', () => {
  const events: AgentEvent[] = [
    stamped({ type: 'turn.start', seq: 1 }, 0),
    stamped({ type: 'tool.call', seq: 1, id: 'c1', name: 'bash', args: {} }, 1),
    stamped({ type: 'turn.start', seq: 2 }, 2),           // 上一轮没 end
    stamped({ type: 'turn.end', seq: 2, final: false, usage: { inTokens: 0, hitTokens: 0, missTokens: 0, outTokens: 0, reasoningTokens: 0, costUsd: 0 } }, 3),
    stamped({ type: 'turn.end', seq: 3, final: true, usage: { inTokens: 0, hitTokens: 0, missTokens: 0, outTokens: 0, reasoningTokens: 0, costUsd: 0 } }, 4), // 孤儿
  ];
  const r = replayEvents(events);
  const joined = r.gaps.join(' | ');
  assert.match(joined, /第 1 轮没有 turn\.end/, '缺收尾要报');
  assert.match(joined, /工具调用没有结果（id=c1）/, '悬空工具调用要报');
  assert.match(joined, /turn\.end 没有对应的 turn\.start/, '孤儿收尾要报');
});

test('回放：压缩 / 审批 / 缓存 都成对或累计；没有 start 的 end 要报缺口', () => {
  const events: AgentEvent[] = [
    stamped({ type: 'compact.start', beforeTokens: 900 }, 0),
    stamped({ type: 'compact.end', beforeTokens: 900, afterTokens: 300 }, 1),
    stamped({ type: 'compact.failed', beforeTokens: 900, reason: '摘要 JSON 解析失败，已降级保留原文' }, 2),
    stamped({ type: 'approval.request', tool: 'bash', args: {}, ruleId: 'r1', risk: 'R3' }, 3),
    stamped({ type: 'approval.result', tool: 'bash', granted: true, by: 'user' }, 4),
    stamped({ type: 'cache', hitTokens: 100, missTokens: 20, hitRate: 100 / 120 }, 5),
    stamped({ type: 'cache', hitTokens: 50, missTokens: 50, hitRate: 0.5 }, 6),
  ];
  const r = replayEvents(events);
  assert.equal(r.compactions.length, 2, 'start 各配一次');
  assert.equal(r.compactions[0]!.ok, true);
  assert.equal(r.compactions[0]!.afterTokens, 300);
  assert.equal(r.compactions[1]!.ok, false);
  assert.match(String(r.compactions[1]!.reason), /降级/);
  assert.equal(r.approvals.length, 1);
  assert.equal(r.approvals[0]!.granted, true);
  assert.equal(r.approvals[0]!.by, 'user');
  assert.equal(r.cache.calls, 2);
  assert.equal(r.cache.hitTokens, 150);
  assert.equal(r.cache.missTokens, 70);
  assert.equal(r.cache.lastHitRate, 0.5);
  assert.ok(r.counts['cache'] === 2);
});

test('loadEvents / replaySession：坏行跳过并记进 gaps；没有事件流不算错', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-replay-'));
  const rt = createNodeRuntime({
    cwd: dir,
    storage: { sessionsDir: `${dir}/s`, logsDir: `${dir}/l`, memoryDir: `${dir}/m`, configDir: `${dir}/c` },
  });
  fs.mkdirSync(`${dir}/s/main`, { recursive: true });
  fs.writeFileSync(`${dir}/s/main/events.jsonl`, [
    JSON.stringify({ type: 'turn.start', seq: 1, env: { id: 'e1', at: '2026-09-26T08:00:00.000Z' } }),
    '{ 这不是合法 JSON',
    JSON.stringify({ type: 'turn.end', seq: 1, final: true, usage: { inTokens: 0, hitTokens: 0, missTokens: 0, outTokens: 0, reasoningTokens: 0, costUsd: 0 }, env: { id: 'e2', at: '2026-09-26T08:00:01.000Z' } }),
  ].join('\n') + '\n');

  const one = await replaySession(rt, 'main');
  assert.equal(one.turns.length, 1);
  assert.match(one.gaps.join(' | '), /1 行解析失败/);

  const none = await replaySession(rt, 'nope');
  assert.deepEqual(none.turns, []);
  assert.deepEqual(none.gaps, [], '没有事件流不是错误（她从没跑过）');

  const { events, badLines } = await loadEvents(rt, 'main');
  assert.equal(events.length, 2);
  assert.equal(badLines, 1);
});
