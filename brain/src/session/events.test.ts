// 事件信封（稳定 id + 时间戳）。
// 要守住的三条：
//   ① 一行一个唯一 id（**不**复用 tool.call/tool.result 那个共用 id —— 它们是一对，不是一行一个）；
//   ② 老字段一个不动（信封单独放 `env`，老消费方按 `type` 读照旧）；
//   ③ 幂等（已经有 env 的事件不重复盖）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stampEmitter, makeEventIdFactory, coalesceDeltas, eventLine, type AgentEvent } from './events.js';

test('信封：每个事件都盖上唯一 id 与 ISO 时间戳；老字段一个不动', () => {
  const seen: AgentEvent[] = [];
  const emit = stampEmitter((ev) => seen.push(ev), makeEventIdFactory('ev'), () => '2026-09-26T16:00:00.000Z');
  emit({ type: 'turn.start', seq: 1 });
  emit({ type: 'tool.call', seq: 1, id: 'call-1', name: 'read', args: {} });
  emit({ type: 'tool.result', seq: 1, id: 'call-1', ok: true, output: 'x', truncated: false });

  const envs = seen.map((e) => (e as { env?: { id: string; at: string } }).env);
  assert.ok(envs.every((x) => x && x.id.startsWith('ev-') && x.at === '2026-09-26T16:00:00.000Z'), '每行都要有信封');
  assert.equal(new Set(envs.map((x) => x!.id)).size, 3, '一行一个唯一 id');
  // 工具那对共用 id 的关联没被破坏（还是 call-1）
  assert.equal((seen[1] as { id: string }).id, 'call-1');
  assert.equal((seen[2] as { id: string }).id, 'call-1');
  // 老字段在
  assert.equal((seen[0] as { seq: number }).seq, 1);
  assert.equal(eventLine(seen[0]!).includes('"type":"turn.start"'), true);
});

test('信封幂等：已经盖全的不重复盖；只缺序号时补序号、不动 id/at', () => {
  const seen: AgentEvent[] = [];
  let n = 0;
  const emit = stampEmitter((ev) => seen.push(ev), () => `ev-new-${++n}`, () => '2026-09-26T17:00:00.000Z');
  // ① 盖全了（id + at + n）→ 一个字段都不动
  emit({ type: 'turn.start', seq: 1, env: { id: 'ev-old', at: '2026-09-26T10:00:00.000Z', n: 7 } } as unknown as AgentEvent);
  assert.deepEqual((seen[0] as unknown as { env: unknown }).env, { id: 'ev-old', at: '2026-09-26T10:00:00.000Z', n: 7 });
  // ② 老日志式的信封（没有 n）→ 补上序号，但仍保留原来的 id/at
  emit({ type: 'turn.end', seq: 1, final: true, usage: {} as never, env: { id: 'ev-old2', at: '2026-09-26T10:00:01.000Z' } } as unknown as AgentEvent);
  const env2 = (seen[1] as unknown as { env: { id: string; at: string; n: number } }).env;
  assert.equal(env2.id, 'ev-old2');
  assert.equal(env2.at, '2026-09-26T10:00:01.000Z');
  assert.equal(typeof env2.n, 'number', '缺序号要补上（序号是给"按顺序读事件"用的）');
});

test('id 生成器：单调不重复、带 epoch 前缀（同一毫秒靠计数器区分）', () => {
  const next = makeEventIdFactory('ev');
  const ids = Array.from({ length: 50 }, () => next());
  assert.equal(new Set(ids).size, 50, '50 个 id 必须互不相同');
  assert.ok(ids.every((i) => /^ev-[0-9a-z]+-[0-9a-z]+$/.test(i)), '格式：前缀-epoch-序号');
  /* ⚠ **别**断言"50 个 id 的 epoch 段全相同"——那是在**测机器快不快**：
     机器一忙，第 50 个 id 跨到下一毫秒，epoch 段就变了，测试无缘无故红。
     正确的不变量：**同一 epoch 段内序号不重复且递增**；跨毫秒时段变，那是正常的。 */
  const byEpoch = new Map<string, number[]>();
  for (const id of ids) {
    const [, epoch, seq] = id.split('-') as [string, string, string];
    if (!byEpoch.has(epoch)) byEpoch.set(epoch, []);
    byEpoch.get(epoch)!.push(parseInt(seq, 36));
  }
  for (const [epoch, seqs] of byEpoch) {
    assert.equal(new Set(seqs).size, seqs.length, `同一毫秒（${epoch}）内序号不能重复`);
    assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b), '同一毫秒内序号必须递增');
  }
  assert.ok(byEpoch.size >= 1);
});

/* ── 落盘合并：一串 delta 收成一行 ─────────────────────────────────────────── */

test('落盘合并：一串 delta 收成一行（带块数与首尾时刻），别的事件照原样过', async () => {
  const out: Array<Record<string, unknown>> = [];
  const emit = coalesceDeltas((ev) => out.push(ev as unknown as Record<string, unknown>), { clock: () => '2026-09-26T10:00:00.000Z' });
  emit({ type: 'turn.start', seq: 1 });
  emit({ type: 'assistant.text.delta', seq: 1, text: '你' });
  emit({ type: 'assistant.text.delta', seq: 1, text: '好' });
  emit({ type: 'assistant.text.delta', seq: 1, text: '呀' });
  emit({ type: 'turn.end', seq: 1, final: true, usage: {} as never });

  assert.equal(out.length, 3, `应该是 turn.start + 合并后的一条 + turn.end（实际 ${out.length}）`);
  assert.equal(out[0]!.type, 'turn.start');
  assert.equal(out[1]!.type, 'assistant.text.delta');
  assert.equal(out[1]!.text, '你好呀', '文本一个字不少');
  assert.equal(out[1]!.coalesced, true);
  assert.equal(out[1]!.chunks, 3, '要记得它由几块拼成');
  assert.equal(out[1]!.firstAt, '2026-09-26T10:00:00.000Z');
  assert.equal(out[2]!.type, 'turn.end', '顺序不变：合并的那条在原位上');
});

test('落盘合并：text 与 reasoning 交替时各自成行；攒太多也会中途冲出去', async () => {
  const out: Array<Record<string, unknown>> = [];
  const emit = coalesceDeltas((ev) => out.push(ev as unknown as Record<string, unknown>), { maxChars: 10 });
  emit({ type: 'assistant.text.delta', seq: 1, text: '正文一' });
  emit({ type: 'assistant.reasoning.delta', seq: 1, text: '思路' });
  emit({ type: 'assistant.text.delta', seq: 1, text: '正文二' });
  emit({ type: 'assistant.text.delta', seq: 1, text: '长长长长长长长长长长长长' }); // 超 10 字 → 当场冲
  /* 三类各成一行：正文一 / 思路 / （正文二 + 超长那块，因为攒过阈值时是"先把当前这块并进去再冲"）。
     这条锁的是"换了种类必须断开"与"攒太多不能一直攒"。 */
  assert.deepEqual(out.map((e) => e.type), [
    'assistant.text.delta', 'assistant.reasoning.delta', 'assistant.text.delta',
  ]);
  assert.equal(out[0]!.text, '正文一');
  assert.equal(out[1]!.text, '思路');
  assert.equal(out[2]!.text, '正文二长长长长长长长长长长长长', '超阈值时把当前这块并进去再冲');
  assert.equal(out[2]!.coalesced, true);
  assert.equal(out[2]!.chunks, 2);
});
