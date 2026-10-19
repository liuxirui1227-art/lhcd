// provider 回退链：首字节前才切换（开口了就不许换人重说）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ChatEvent, ChatRequest, LLMProvider } from './provider.js';
import { createFallbackProvider, shouldFallback } from './fallback.js';
import { clampMaxTokens } from './adapters/message-api.js';

const req: ChatRequest = { system: 's', messages: [{ role: 'user', content: 'hi' }], tools: [], model: { role: 'main', thinking: false } };
const done = { type: 'done' as const, usage: { inTokens: 0, hitTokens: 0, missTokens: 0, outTokens: 0, reasoningTokens: 0, costUsd: 0 } };

function provider(name: string, behavior: 'ok' | 'fail-early' | 'fail-after-text'): LLMProvider {
  return {
    name,
    caps: { cache: { kind: 'none' }, reasoning: 'none', parallelToolCalls: false, compaction: 'client', maxContextTokens: 1000 },
    sanitizeForRequest: (m) => m,
    injectCacheMarkers: () => undefined,
    async *chat(): AsyncIterable<ChatEvent> {
      if (behavior === 'fail-early') throw new Error(`HTTP 503 ${name} 服务不可用`);   // 服务商侧故障 → 该换
      yield { type: 'text.delta', text: `${name}:` } as ChatEvent;
      if (behavior === 'fail-after-text') throw new Error(`HTTP 503 ${name} 说到一半挂了`);
      yield done;
    },
  };
}

async function collect(p: LLMProvider) {
  const evs: ChatEvent[] = [];
  for await (const ev of p.chat(req)) evs.push(ev);
  return evs;
}

test('首字节前失败 → 换备胎，事件来自下一个（用户感知不到中断）', async () => {
  const fell: string[] = [];
  const p = createFallbackProvider([provider('主源', 'fail-early'), provider('备胎', 'ok')], {
    onFallback: (_e, from, to) => fell.push(`${from}→${to}`),
  });
  const evs = await collect(p);
  assert.equal((evs[0] as { text: string }).text, '备胎:');
  assert.deepEqual(fell, ['主源→备胎']);
});

test('已经开口之后失败 → **抛错，不切换**（半截回复不能换个人重说）', async () => {
  const p = createFallbackProvider([provider('主源', 'fail-after-text'), provider('备胎', 'ok')]);
  await assert.rejects(async () => { for await (const _ of p.chat(req)) void _; }, /说到一半挂了/);
});

test('链上全失败 → 抛最后一个错（不是第一个——最后一个才是"最后试过的那个"）', async () => {
  const p = createFallbackProvider([provider('A', 'fail-early'), provider('B', 'fail-early')]);
  await assert.rejects(async () => { for await (const _ of p.chat(req)) void _; }, /B 服务不可用/);
});

test('三节链：前两个都没开口就挂 → 直接落到第三个', async () => {
  const p = createFallbackProvider([provider('A', 'fail-early'), provider('B', 'fail-early'), provider('C', 'ok')]);
  const evs = await collect(p);
  assert.equal((evs[0] as { text: string }).text, 'C:');
});

test('caps / 净化 透传主源；空链直接报错（不许悄悄跑一个没有 provider 的回合）', () => {
  const p = createFallbackProvider([provider('主源', 'ok'), provider('备胎', 'ok')]);
  assert.equal(p.caps.maxContextTokens, 1000);
  assert.equal(p.name, '主源+1');
  assert.throws(() => createFallbackProvider([]), /回退链为空/);
});

test('**传输层失败不换**：没网/连不上 = "用户离线"，该走存续态人设（换一家也连不上，换人说话还毁人设）', async () => {
  const offline: LLMProvider = {
    ...provider('主源', 'ok'),
    async *chat() { throw new Error('网络错误（重试 3 次后放弃）: fetch failed'); },
  };
  const p = createFallbackProvider([offline, provider('备胎', 'ok')]);
  await assert.rejects(async () => { for await (const _ of p.chat(req)) void _; }, /fetch failed/);
});

test('**4xx 也不换**：参数/凭证错了，换个供应商只会拿同样的错请求再撞一次', async () => {
  const badReq: LLMProvider = {
    ...provider('主源', 'ok'),
    async *chat() { throw new Error('HTTP 400: Range of max_tokens should be [1, 32768]'); },
  };
  const p = createFallbackProvider([badReq, provider('备胎', 'ok')]);
  await assert.rejects(async () => { for await (const _ of p.chat(req)) void _; }, /HTTP 400/);
});

test('shouldFallback 判据：5xx/429 换，4xx 与传输层不换', () => {
  assert.equal(shouldFallback(new Error('HTTP 500: 服务器错误')), true);
  assert.equal(shouldFallback(new Error('HTTP 503 服务不可用')), true);
  assert.equal(shouldFallback(new Error('HTTP 429 rate limit')), true);
  assert.equal(shouldFallback(new Error('HTTP 400 参数不合法')), false);
  assert.equal(shouldFallback(new Error('HTTP 401 invalid key')), false);
  assert.equal(shouldFallback(new Error('网络错误（重试 3 次后放弃）: fetch failed')), false);
  assert.equal(shouldFallback(new Error('ECONNREFUSED')), false);
});

test('单次输出上限按供应商夹取（全局 64k 对 qwen 是非法的 400）', () => {
  assert.equal(clampMaxTokens(65536, 32768), 32768);
  assert.equal(clampMaxTokens(65536, undefined), 65536);
  assert.equal(clampMaxTokens(1000, 32768), 1000);
  assert.equal(clampMaxTokens(undefined, undefined), 4096);   // 都没给 → 保底
  assert.equal(clampMaxTokens(undefined, 384000), 4096);
});
