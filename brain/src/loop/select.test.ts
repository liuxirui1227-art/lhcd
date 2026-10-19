// 压缩的"选择性丢弃"单测。
// **配对修复**很关键：
//   丢了工具结果却留着 assistant 上的 tool_calls = 请求体里出现孤儿，
//   OpenAI 系（DeepSeek/百炼/vLLM）一律 400；mock 适配器不校验，只有真 key + 长会话才炸。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ChatMessage } from '../llm/provider.js';
import { selectRegion } from './select.js';

const big = (n: number) => 'x'.repeat(n);
const assistantCall = (id: string, name = 'read'): ChatMessage => ({
  role: 'assistant', content: '我看看这个文件', toolCalls: [{ id, name, args: {} }],
});
const toolResult = (id: string, text = 'ok'): ChatMessage => ({ role: 'tool', content: text, toolCallId: id });

test('丢掉超大工具输出时：assistant 上的那条 tool_calls 必须一起摘掉（否则请求体非法）', () => {
  const region: ChatMessage[] = [
    { role: 'user', content: '帮我看看' },
    assistantCall('c1'),
    toolResult('c1', big(4000)),                    // 大块头 → 丢
    { role: 'assistant', content: '看完了，是这么回事' },
  ];
  const { kept, dropped, reasons } = selectRegion(region, { toolMaxTokens: 400 });
  assert.equal(dropped.length, 1);
  assert.equal(dropped[0]!.toolCallId, 'c1');
  // 关键断言：留下的 assistant 消息上**不能**再有 c1 这条调用
  const orphan = kept.filter((m) => m.toolCalls?.some((c) => c.id === 'c1'));
  assert.deepEqual(orphan, [], '留下了没有工具结果的 tool_calls —— 真实请求会 400');
  assert.ok(reasons.some((r) => r.includes('失去工具结果')), reasons.join('；'));
});

test('一个 assistant 有两条调用、只丢了一条：留着的那条不动，丢的那条摘掉', () => {
  const region: ChatMessage[] = [
    { role: 'user', content: '两个文件都看看' },
    { role: 'assistant', content: '好', toolCalls: [{ id: 'a', name: 'read', args: {} }, { id: 'b', name: 'read', args: {} }] },
    toolResult('a', '小的'),
    toolResult('b', big(4000)),
    { role: 'assistant', content: '都看完了' },
  ];
  const { kept, dropped } = selectRegion(region, { toolMaxTokens: 400 });
  assert.deepEqual(dropped.map((m) => m.toolCallId), ['b']);
  const withCalls = kept.find((m) => m.toolCalls);
  assert.deepEqual(withCalls?.toolCalls?.map((c) => c.id), ['a'], '只该留下 a');
});

test('工具结果全被丢掉时：assistant 消息留着，但 toolCalls 整个清掉（正文照旧）', () => {
  const region: ChatMessage[] = [
    { role: 'user', content: '看看' },
    { role: 'assistant', content: '我看看', toolCalls: [{ id: 'z', name: 'read', args: {} }] },
    toolResult('z', big(9000)),
    { role: 'assistant', content: '结论是……' },
  ];
  const { kept } = selectRegion(region, { toolMaxTokens: 400 });
  const a = kept.find((m) => m.content === '我看看');
  assert.ok(a, 'assistant 正文必须留着');
  assert.equal(a!.toolCalls, undefined);
});

test('没丢东西时：一切原样（配对、顺序、条数都不动）', () => {
  const region: ChatMessage[] = [
    { role: 'user', content: '你好' },
    assistantCall('c1'),
    toolResult('c1', '小结果'),
    { role: 'assistant', content: '在的' },
  ];
  const { kept, dropped } = selectRegion(region, { toolMaxTokens: 400 });
  assert.equal(dropped.length, 0);
  assert.deepEqual(kept, region);
});

test('用户消息一条不丢 · 最后一条助手消息不丢（规矩 1/2）', () => {
  const region: ChatMessage[] = [
    { role: 'user', content: '第一句' },
    { role: 'assistant', content: big(5000) },      // 大块头但它是 assistant → 不丢（只丢 tool）
    { role: 'user', content: '第二句' },
    { role: 'assistant', content: '最后一句' },
  ];
  const { kept, dropped } = selectRegion(region);
  assert.equal(dropped.length, 0);
  assert.ok(kept.some((m) => m.content === '第一句') && kept.some((m) => m.content === '第二句'));
  assert.equal(kept[kept.length - 1]!.content, '最后一句');
});

test('连续重复的工具输出：留先出现的那条、丢后一条（挨着的才判重复）', () => {
  const region: ChatMessage[] = [
    { role: 'user', content: '查两次' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'r1', name: 'read', args: {} }] },
    toolResult('r1', '一样的内容'),
    { role: 'assistant', content: '', toolCalls: [{ id: 'r2', name: 'read', args: {} }] },
    toolResult('r2', '一样的内容'),                 // 与 r1 逐字相同 → 丢**当前**这条（r2）
    { role: 'assistant', content: '查完了' },
  ];
  const { kept, dropped } = selectRegion(region);
  assert.deepEqual(dropped.map((m) => m.toolCallId), ['r2']);
  assert.ok(kept.some((m) => m.toolCallId === 'r1'));
  // 被丢的 r2 对应的那条调用也不能留（否则又成孤儿）
  assert.equal(kept.some((m) => m.toolCalls?.some((c) => c.id === 'r2')), false);
});

test('隔着很远的两条相同工具输出：不算重复（窗口 4 条以内才判）', () => {
  const region: ChatMessage[] = [
    { role: 'user', content: '查' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'q1', name: 'read', args: {} }] },
    toolResult('q1', '一样的内容'),
    { role: 'assistant', content: '中间聊两句' },
    { role: 'user', content: '嗯' },
    { role: 'assistant', content: '再看一次' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'q2', name: 'read', args: {} }] },
    toolResult('q2', '一样的内容'),
  ];
  const { dropped } = selectRegion(region);
  assert.deepEqual(dropped, [], '超过窗口就不该判重复');
});
