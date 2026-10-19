// 真流式回归
//
// 这一条钉的是"**边收边用**"，不是"能拿到完整回复"——后者一直是好的。
// 两条防线：
//   ① 适配器：SSE 行**增量**解析。用一道"闸门"证明它：流只吐第一块就停住，
//      适配器必须**当场**把第一段正文交出来；整包实现会卡在 `await res.text()` 上（测试里带超时，卡住即红）。
//   ② runtime：`streamText()` 把响应体按块解码。用一个**真的 localhost SSE 服务**证明
//      分块确实是分着到的（不是收完再切）。零成本、不联网。
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import type { ChatEvent, ProviderCaps } from '../provider.js';
import type { NetResponse } from '../../runtime/types.js';
import { createMessageApiProvider } from './message-api.js';
import { createNodeRuntime } from '../../runtime/node.js';

const caps: ProviderCaps = {
  cache: { kind: 'automatic', minPrefixTokens: 64 },
  reasoning: 'content-field',
  parallelToolCalls: true,
  compaction: 'client',
  maxContextTokens: 128000,
};
const pricing = { hit: 0.05, miss: 1.5, missPeak: 3.0, out: 4.5 };

const sse = (text: string) => `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`;
const DONE = 'data: [DONE]\n\n';

test('① 适配器：SSE 来了就吐——流没结束也能先拿到正文（整包实现会卡死在这里）', async () => {
  let release = () => { /* 等下被替换 */ };
  const gate = new Promise<void>((r) => { release = r; });
  const chunks: string[] = [];
  const res: NetResponse = {
    status: 200,
    ok: true,
    text: async () => { throw new Error('不该走整包这条路：明明有 streamText'); },
    json: async () => ({}),
    // 只吐第一块就挂住；第二块要等测试放闸
    streamText: async function* () {
      chunks.push('first');
      yield sse('第一段');
      await gate;
      yield sse('第二段') + DONE;
    },
  };
  const provider = createMessageApiProvider('deepseek', {
    baseUrl: 'https://x', apiKeyEnv: 'TEST_KEY', reasoningField: null, caps, pricing,
    models: { main: { id: 'm', thinking: false }, fast: { id: 'm', thinking: false }, compact: { id: 'm', thinking: false }, subagent: { id: 'm', thinking: false } },
  }, { apiKey: () => 'sk-test', http: async () => res });

  const it = provider.chat({ system: 's', messages: [{ role: 'user', content: '你好' }], tools: [], model: { role: 'main', thinking: false }, maxOutputTokens: 100 })[Symbol.asyncIterator]();

  // 闸门没放开之前，第一段必须已经到了
  const first = await Promise.race([
    it.next(),
    new Promise<'TIMEOUT'>((r) => setTimeout(() => r('TIMEOUT'), 2000)),
  ]);
  assert.notEqual(first, 'TIMEOUT', '2 秒还没吐第一段 ⇒ 又退回整包了（闸门没放，整包实现在这里必然卡住）');
  const ev = (first as IteratorResult<ChatEvent>).value as ChatEvent;
  assert.equal(ev.type, 'text.delta');
  assert.equal((ev as { text: string }).text, '第一段');

  release();
  for (;;) {
    const n = await it.next();
    if (n.done) break;
  }
  assert.deepEqual(chunks, ['first'], '流只被拉了一次就吐完了 ⇒ 不是边收边解');
});

test('② runtime：streamText 按块解码（真 localhost SSE 服务，分块确实是分着到的）', async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(sse('一'));
    setTimeout(() => res.write(sse('二')), 60);
    setTimeout(() => { res.write(DONE); res.end(); }, 120);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;

  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-stream-'));
    const rt = createNodeRuntime({
      cwd: dir,
      storage: { sessionsDir: `${dir}/s`, logsDir: `${dir}/l`, memoryDir: `${dir}/m`, configDir: `${dir}/c` },
    });
    const res = await rt.net.fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: 'POST' });
    assert.equal(typeof res.streamText, 'function', 'NetResponse 缺 streamText（runtime 没实现真流式）');
    const stamps: number[] = [];
    const pieces: string[] = [];
    for await (const c of res.streamText!()) { stamps.push(Date.now()); pieces.push(c); }
    const all = pieces.join('');
    assert.ok(all.includes('一') && all.includes('二'), `内容没到齐：${all.slice(0, 120)}`);
    assert.ok(stamps.length >= 2, `只收到 ${stamps.length} 块 ⇒ 是收完再切，不是真流式`);
    // 第二块要**明显晚于**第一块（服务端隔了 60ms）——这条就是"分着到"的证据
    assert.ok(stamps[stamps.length - 1]! - stamps[0]! >= 40, `块之间没有间隔（${stamps[stamps.length - 1]! - stamps[0]!}ms）⇒ 不是流式`);
  } finally {
    server.close();
  }
});
