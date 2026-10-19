// message-api 适配器：SSE 流式解析 / usage 峰谷成本 / 净化 / 重试。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ChatEvent, ChatMessage, ChatRequest, ProviderCaps, Usage } from '../provider.js';
import type { NetFetch, NetResponse } from '../../runtime/types.js';
import { createMessageApiProvider } from './message-api.js';

const caps: ProviderCaps = {
  cache: { kind: 'automatic', minPrefixTokens: 64 },
  reasoning: 'content-field',
  parallelToolCalls: true,
  compaction: 'client',
  maxContextTokens: 128000,
};

const pricing = { hit: 0.05, miss: 1.5, missPeak: 3.0, out: 4.5 };

function makeProvider(extra?: { http?: NetFetch; now?: () => Date; thinkingEffort?: boolean }) {
  return createMessageApiProvider(
    'deepseek',
    {
      baseUrl: 'https://api.deepseek.com/v1',
      apiKeyEnv: 'TEST_KEY',
      reasoningField: 'reasoning_content',
      caps: { ...caps, ...(extra?.thinkingEffort ? { thinkingEffort: true } : {}) },
      pricing,
      models: {
        main: { id: 'deepseek-chat', thinking: false },
        fast: { id: 'deepseek-chat', thinking: false },
        compact: { id: 'deepseek-chat', thinking: false },
        subagent: { id: 'deepseek-chat', thinking: false },
        reasoner: { id: 'deepseek-reasoner', thinking: true },
      },
    },
    { apiKey: () => 'sk-test', ...extra },
  );
}

function sseRes(lines: string[]): NetResponse {
  const text = lines.join('\n');
  return { status: 200, ok: true, text: async () => text, json: async () => ({}) };
}
function errRes(status: number, body: string): NetResponse {
  return { status, ok: false, text: async () => body, json: async () => ({}) };
}

/** 可记录调用次数与请求体的 stub fetch */
function stubHttp(...responses: NetResponse[]) {
  const calls: Array<Record<string, unknown>> = [];
  const f = (async (_url: string, init?: Record<string, unknown>) => {
    calls.push(init ?? {});
    const idx = Math.min(calls.length - 1, responses.length - 1);
    return responses[idx]!;
  }) as NetFetch & { calls: typeof calls };
  f.calls = calls;
  return f;
}

const baseReq = {
  system: 'sys',
  messages: [{ role: 'user', content: 'hi' }] as ChatMessage[],
  tools: [] as [],
  model: { role: 'main', thinking: false } as const,
};

test('SSE 流式解析：text.delta / reasoning.delta / tool_calls / done(usage)', async () => {
  const http = stubHttp(sseRes([
    'data: {"choices":[{"delta":{"content":"你好"}}]}',
    'data: {"choices":[{"delta":{"reasoning_content":"让我想想"}}]}',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"web_search","arguments":"{\\"query\\":\\"天气\\"}"}}]}}]}',
    'data: {"choices":[],"usage":{"prompt_tokens":1200,"prompt_cache_hit_tokens":1000,"prompt_cache_miss_tokens":200,"completion_tokens":300,"completion_tokens_details":{"reasoning_tokens":50}}}',
    'data: [DONE]',
  ]));
  const provider = makeProvider({ http, now: () => new Date(Date.UTC(2026, 7, 21, 4, 30)) });

  const evs: ChatEvent[] = [];
  for await (const ev of provider.chat(baseReq)) evs.push(ev);

  const texts = evs.filter((e) => e.type === 'text.delta').map((e) => (e as { text: string }).text);
  assert.equal(texts.join(''), '你好');
  const reasonings = evs.filter((e) => e.type === 'reasoning.delta').map((e) => (e as { text: string }).text);
  assert.equal(reasonings.join(''), '让我想想');

  const tc = evs.find((e) => e.type === 'tool_calls');
  assert.ok(tc && tc.type === 'tool_calls');
  const calls = (tc as { calls: Array<{ id: string; name: string; args: unknown }> }).calls;
  assert.equal(calls[0]!.id, 'call_1');
  assert.equal(calls[0]!.name, 'web_search');
  assert.deepEqual(calls[0]!.args, { query: '天气' });

  const done = evs.find((e) => e.type === 'done') as { usage: Usage } | undefined;
  assert.ok(done);
  assert.equal(done.usage.hitTokens, 1000);
  assert.equal(done.usage.missTokens, 200);
  assert.equal(done.usage.outTokens, 300);
  assert.equal(done.usage.reasoningTokens, 50);
  // 北京 12:30 空闲：0.05×1000/1e6 + 1.5×200/1e6 + 4.5×300/1e6 + 4.5×50/1e6
  const expected = (1000 * 0.05 + 200 * 1.5 + 300 * 4.5 + 50 * 4.5) / 1e6;
  assert.equal(done.usage.costUsd, Math.round(expected * 1e6) / 1e6);

  // 请求体：system 置首 + 流式 + usage 回传开关
  const body = JSON.parse(String(http.calls[0]!.body)) as Record<string, unknown>;
  assert.equal(body.model, 'deepseek-chat');
  assert.equal(body.stream, true);
  assert.deepEqual(body.stream_options, { include_usage: true });
  assert.deepEqual((body.messages as Array<{ role: string }>)[0], { role: 'system', content: 'sys' });
});

test('峰谷计价：北京时间 9:00 高峰时段输入未命中 ×2', async () => {
  const http = stubHttp(sseRes([
    'data: {"choices":[],"usage":{"prompt_cache_hit_tokens":0,"prompt_cache_miss_tokens":200,"completion_tokens":300}}',
  ]));
  const provider = makeProvider({ http, now: () => new Date(Date.UTC(2026, 7, 21, 1, 0)) });
  const evs: ChatEvent[] = [];
  for await (const ev of provider.chat(baseReq)) evs.push(ev);
  const done = evs.find((e) => e.type === 'done') as { usage: Usage };
  // 高峰 miss=3.0（北京 9:00）：200×3.0/1e6 + 300×4.5/1e6
  assert.equal(done.usage.costUsd, (200 * 3.0 + 300 * 4.5) / 1e6);
});

test('thinking=true 使用 reasoner 模型条目', async () => {
  const http = stubHttp(sseRes(['data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5}}']));
  const provider = makeProvider({ http, now: () => new Date(Date.UTC(2026, 7, 21, 4, 30)) });
  const evs: ChatEvent[] = [];
  for await (const ev of provider.chat({ ...baseReq, model: { role: 'main', thinking: true } })) evs.push(ev);
  void evs;
  const body = JSON.parse(String(http.calls[0]!.body)) as Record<string, unknown>;
  assert.equal(body.model, 'deepseek-reasoner');
});

test('净化 sanitize（wire 格式）：相邻同角色合并；无 tool_calls 剥离 reasoning；tool_call_id 蛇形；tool_calls 转 function 结构', () => {
  const provider = makeProvider();
  const msgs: ChatMessage[] = [
    { role: 'user', content: 'a' },
    { role: 'user', content: 'b' },
    { role: 'assistant', content: 'x', reasoning: '思考1', toolCalls: [{ id: 't1', name: 'read', args: { path: 'f' } }] },
    { role: 'tool', content: 'r', toolCallId: 't1' },
    { role: 'tool', content: 'r2', toolCallId: 't1' },
    { role: 'assistant', content: 'final', reasoning: '思考2' },
  ];
  const out = provider.sanitizeForRequest(msgs) as unknown as Array<Record<string, unknown>>;
  assert.equal(out[0]!.content, 'a\nb');
  // assistant 带 tool_calls → OpenAI wire 格式（arguments 为 JSON 字符串）
  const tcs = out[1]!.tool_calls as Array<{ id: string; type: string; function: { name: string; arguments: string } }>;
  assert.equal(tcs.length, 1);
  assert.equal(tcs[0]!.id, 't1');
  assert.equal(tcs[0]!.type, 'function');
  assert.equal(tcs[0]!.function.name, 'read');
  assert.deepEqual(JSON.parse(tcs[0]!.function.arguments), { path: 'f' });
  // reasoning 用服务商思考字段名
  assert.equal(out[1]!.reasoning_content, '思考1');
  // tool 消息用 tool_call_id（蛇形）；tool 消息不合并
  assert.equal(out[2]!.tool_call_id, 't1');
  assert.equal(out[3]!.tool_call_id, 't1');
  assert.equal(out[4]!.reasoning_content, undefined); // 无 tool_calls → 剥离
});

test('净化：空 id 的伪 tool_call 不发（并发补位防御）', () => {
  const provider = makeProvider();
  const out = provider.sanitizeForRequest([
    { role: 'assistant', content: 'x', toolCalls: [{ id: '', name: 'recall', args: {} }, { id: 'c2', name: 'recall', args: {} }] },
  ]) as unknown as Array<Record<string, unknown>>;
  const tcs = out[0]!.tool_calls as Array<{ id: string }>;
  assert.equal(tcs.length, 1);
  assert.equal(tcs[0]!.id, 'c2');
});

test('reasoningField=null 时不回放思考', () => {
  const p = createMessageApiProvider(
    'x',
    {
      apiKeyEnv: 'TEST_KEY', reasoningField: null, caps, pricing,
      models: { main: { id: 'm', thinking: false } },
    },
    { apiKey: () => 'sk' },
  );
  const out = p.sanitizeForRequest([{ role: 'assistant', content: 'a', reasoning: 'r', toolCalls: [{ id: 't', name: 'read', args: {} }] }]) as unknown as Array<Record<string, unknown>>;
  assert.equal(out[0]!.reasoning_content, undefined);
  assert.equal(out[0]!.reasoning, undefined);
});

test('重试：5xx 退避重试成功；4xx 不重试立即抛错', async () => {
  const ok = sseRes(['data: {"choices":[{"delta":{"content":"ok"}}]}', 'data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":2}}']);
  const http5 = stubHttp(errRes(500, 'boom'), ok);
  const p5 = makeProvider({ http: http5, now: () => new Date(Date.UTC(2026, 7, 21, 4, 30)) });
  const evs: ChatEvent[] = [];
  for await (const ev of p5.chat(baseReq)) evs.push(ev);
  assert.ok(evs.some((e) => e.type === 'text.delta'));
  assert.equal(http5.calls.length, 2);

  const http4 = stubHttp(errRes(400, 'bad request'));
  const p4 = makeProvider({ http: http4, now: () => new Date(Date.UTC(2026, 7, 21, 4, 30)) });
  await assert.rejects(async () => {
    for await (const _ev of p4.chat(baseReq)) void _ev;
  }, /HTTP 400/);
  assert.equal(http4.calls.length, 1);
});

test('重试：429 限流退避重试（011-A2）；耗尽后抛错', async () => {
  const ok = sseRes(['data: {"choices":[{"delta":{"content":"限流后成功"}}]}', 'data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":2}}']);
  const http = stubHttp(errRes(429, 'rate limited'), ok);
  const p = makeProvider({ http, now: () => new Date(Date.UTC(2026, 7, 21, 4, 30)) });
  const evs: ChatEvent[] = [];
  for await (const ev of p.chat(baseReq)) evs.push(ev);
  assert.ok(evs.some((e) => e.type === 'text.delta'));
  assert.equal(http.calls.length, 2);

  // 连续 429 → 重试耗尽后抛错（含状态码，便于宿主翻译友好提示）
  const httpAll = stubHttp(errRes(429, 'rate limited'));
  const pAll = makeProvider({ http: httpAll, now: () => new Date(Date.UTC(2026, 7, 21, 4, 30)) });
  await assert.rejects(async () => {
    for await (const _ev of pAll.chat(baseReq)) void _ev;
  }, /HTTP 429/);
  assert.equal(httpAll.calls.length, 3);
});

// DeepSeek V4.1 思考档位（服务端枚举 none/minimal/low/medium/high/xhigh/max，
// 官方折叠成 low/high/max）。规则：**供应商要申报 caps.thinkingEffort 才发**；
// 发了的话优先级 = 条目写死的 effort（开发侧开关）> 内核自动选档 effortFor（闲聊 low / 深任务 max）。
test('思考档位：申报后按内核自动选档发；条目写死的 effort 优先', async () => {
  const sse = () => sseRes(['data: {"choices":[{"delta":{"content":"hi"}}]}', 'data: [DONE]']);
  const now = () => new Date(Date.UTC(2026, 7, 21, 4, 30));
  const bodyOf = async (p: ReturnType<typeof makeProvider>, http: ReturnType<typeof stubHttp>, req: ChatRequest) => {
    for await (const ev of p.chat(req)) void ev;
    return JSON.parse(String(http.calls[0]!.body)) as Record<string, unknown>;
  };

  // ① 没申报 thinkingEffort（BYOK 默认）→ 一个字段都不发，旧行为逐字一致
  const http0 = stubHttp(sse());
  const p0 = makeProvider({ http: http0, now });
  const b0 = await bodyOf(p0, http0, baseReq);
  assert.equal('reasoning_effort' in b0, false);

  // ② 申报了 → 闲聊主档自动 low、深任务（thinking）自动 max
  const http1 = stubHttp(sse());
  const p1 = makeProvider({ http: http1, now, thinkingEffort: true });
  const b1 = await bodyOf(p1, http1, baseReq);
  assert.equal(b1.reasoning_effort, 'low');
  const http2 = stubHttp(sse());
  const p2 = makeProvider({ http: http2, now, thinkingEffort: true });
  const b2 = await bodyOf(p2, http2, { ...baseReq, model: { role: 'main', thinking: true } });
  assert.equal(b2.reasoning_effort, 'max');

  // ③ 条目写死 effort（开发侧"flash max 版"）压过自动选档
  const http3 = stubHttp(sse());
  const p3 = makeProvider({ http: http3, now, thinkingEffort: true });
  p3.setModels({ main: { id: 'deepseek-flash', thinking: false, effort: 'max' } });
  const b3 = await bodyOf(p3, http3, baseReq);
  assert.equal(b3.model, 'deepseek-flash');
  assert.equal(b3.reasoning_effort, 'max');
});
