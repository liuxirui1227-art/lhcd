// mock 适配器：确定性回放、零网络、零成本。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MockProvider, mockText, mockToolCalls } from './mock.js';

test('确定性：同一脚本两次构造 → 输出逐字节一致', async () => {
  const script = [
    mockText('第一回合'),
    mockToolCalls([{ id: 'c1', name: 'read', args: { path: 'a.txt' } }]),
  ];
  const collect = async () => {
    const p = new MockProvider({ script });
    const rounds: string[] = [];
    for (let i = 0; i < 2; i++) {
      const evs: unknown[] = [];
      for await (const ev of p.chat({ system: 's', messages: [], tools: [], model: { role: 'main', thinking: false } })) evs.push(ev);
      rounds.push(JSON.stringify(evs));
    }
    return rounds;
  };
  const a = await collect();
  const b = await collect();
  assert.deepEqual(a, b);
  assert.deepEqual(a, b); // 两次读取同样结果
});

test('脚本顺序消耗：第一回合文本、第二回合工具调用', async () => {
  const p = new MockProvider({
    script: [
      mockText('你好'),
      mockToolCalls([{ id: 'c2', name: 'web_search', args: { query: 'x' } }]),
    ],
  });
  const req = { system: 's', messages: [], tools: [], model: { role: 'main', thinking: false } as const };
  const r1 = [];
  for await (const ev of p.chat(req)) r1.push(ev);
  assert.ok(r1.some((e) => e.type === 'text.delta' && (e as { text: string }).text === '你好'));

  const r2 = [];
  for await (const ev of p.chat(req)) r2.push(ev);
  const tc = r2.find((e) => e.type === 'tool_calls');
  assert.ok(tc && tc.type === 'tool_calls');
  assert.deepEqual((tc as { calls: unknown[] }).calls, [{ id: 'c2', name: 'web_search', args: { query: 'x' } }]);
});

test('usage 可注入且默认零成本', async () => {
  const p0 = new MockProvider({ script: [mockText('x')] });
  const p1 = new MockProvider({
    script: [mockText('x')],
    usage: { hitTokens: 10, missTokens: 5, outTokens: 3, costUsd: 0.001 },
  });
  const done = async (p: MockProvider) => {
    const evs = [];
    for await (const ev of p.chat({ system: '', messages: [], tools: [], model: { role: 'main', thinking: false } })) evs.push(ev);
    return evs.find((e) => e.type === 'done') as { usage: { hitTokens: number; costUsd: number } };
  };
  assert.equal((await done(p0)).usage.costUsd, 0);
  const d1 = await done(p1);
  assert.equal(d1.usage.hitTokens, 10);
  assert.equal(d1.usage.costUsd, 0.001);
});

test('空脚本抛错（防止静默通过）', async () => {
  const p = new MockProvider();
  await assert.rejects(async () => {
    for await (const _ev of p.chat({ system: '', messages: [], tools: [], model: { role: 'main', thinking: false } })) void _ev;
  }, /mock 脚本为空/);
});
