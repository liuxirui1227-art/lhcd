// 脑侧单测：两档插话（steer 档）/ 打断后接着讲。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createNodeRuntime } from '../runtime/node.js';
import { MockProvider, mockText, mockToolCalls } from '../llm/adapters/mock.js';
import type { ChatEvent, ChatMessage, ChatRequest, LLMProvider, ProviderCaps } from '../llm/provider.js';
import { ToolRegistry } from '../tools/registry.js';
import { readTool } from '../tools/read.js';
import { loadConfig } from '../config/load.js';
import { Session } from './session.js';
import { runTurn } from './turn.js';
import type { AgentEvent } from '../session/events.js';

function setup(script: ChatEvent[][]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-interject-'));
  const rt = createNodeRuntime({
    cwd: dir,
    storage: { sessionsDir: `${dir}/s`, logsDir: `${dir}/l`, memoryDir: `${dir}/m`, configDir: `${dir}/c` },
  });
  const registry = new ToolRegistry();
  registry.register(readTool());
  const config = loadConfig({ cwd: dir, home: dir });
  const provider = new MockProvider({ script });
  const events: AgentEvent[] = [];
  const session = new Session({
    cwd: dir,
    config,
    provider,
    runtime: rt,
    registry,
    system: '测试 system',
    emit: (ev) => events.push(ev),
  });
  return { dir, session, provider, events };
}

/** 先吐两段正文、再触发 abort、然后继续吐——模拟"用户看到半截时按了停止" */
class AbortMidStreamProvider implements LLMProvider {
  readonly name = 'abort-mid';
  readonly caps: ProviderCaps = {
    cache: { kind: 'none' }, reasoning: 'none', parallelToolCalls: true, compaction: 'client', maxContextTokens: 128000,
  };
  readonly requests: ChatRequest[] = [];
  constructor(private readonly ctrl: AbortController) {}
  sanitizeForRequest(msgs: ChatMessage[]): ChatMessage[] { return msgs.map((m) => ({ ...m })); }
  injectCacheMarkers(): void {}
  async *chat(req: ChatRequest): AsyncIterable<ChatEvent> {
    this.requests.push(req);
    yield { type: 'text.delta' as const, text: '半截' };
    yield { type: 'text.delta' as const, text: '正文' };
    this.ctrl.abort();
    yield { type: 'text.delta' as const, text: '（这段不该被收到）' };
  }
}

test('条 11（steer）：工具轮次之间取插话 → 追加到下一轮请求尾部（append-only）', async () => {
  const { dir, session, provider, events } = setup([
    mockToolCalls([{ id: 'c1', name: 'read', args: { path: 'a.txt' } }]),
    mockText('好，按新的来'),
  ]);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'hello\n');

  const steers = ['改主意：别读那个文件了，直接说结论'];
  let taken = false;
  const result = await runTurn(session, '读 a.txt', undefined, {
    drainSteers: () => { if (taken) return []; taken = true; return steers; },
  });

  assert.equal(result.kind, 'final');
  assert.equal((result as { text: string }).text, '好，按新的来');
  // 第二轮请求的最后一条 user 消息 = 插话原文（尾部追加）
  const req2 = provider.requests[1]!;
  const last = req2.messages[req2.messages.length - 1]!;
  assert.equal(last.role, 'user');
  assert.equal(String(last.content), steers[0]);
  // 事件流记录插话（可审计）
  assert.ok(events.some((e) => e.type === 'user.steer.submit' && (e as { text: string }).text === steers[0]));
  // 插话作为**一条独立的用户消息**进历史（尾部追加——append-only，前缀缓存不变量仍成立；
  // 只塞进请求尾部、不进历史的话，等于"模型见过但记录里没有"）
  assert.ok(session.history.some((m) => m.role === 'user' && String(m.content).includes('改主意')));
  assert.ok(session.history[session.history.length - 1]!.role === 'assistant', '最终回复仍在最后');
  // 队列只在轮次之间取：第二轮之后没有多余消费
  assert.equal(provider.requests.length, 2);
});

test('条 12（打断接着讲）：中止时半截正文留在上下文 + 补 turn.end；「继续」能看到它', async () => {
  const ctrl = new AbortController();
  const { session, events } = setup([]);
  const aborting = new AbortMidStreamProvider(ctrl);
  (session as unknown as { provider: LLMProvider }).provider = aborting;

  const result = await runTurn(session, '讲个长故事', ctrl.signal);
  assert.equal(result.kind, 'aborted');
  assert.equal((result as { text: string }).text, '半截正文'); // 半截保留（不含中止后到达的）
  // 半截进了上下文
  assert.deepEqual(session.history[session.history.length - 1], { role: 'assistant', content: '半截正文' });
  // 中止也不能让事件流缺收尾（每个 turn.start 都要有对应的 turn.end）
  const ends = events.filter((e) => e.type === 'turn.end');
  assert.equal(ends.length, 1);
  assert.equal((ends[0] as { final: boolean }).final, false);

  // 「继续」：新回合请求里能看到那段半截（模型可接着写，而不是重来）
  const cont = new MockProvider({ script: [mockText('（接着写）')] });
  (session as unknown as { provider: LLMProvider }).provider = cont;
  const r2 = await runTurn(session, '继续');
  assert.equal(r2.kind, 'final');
  const msgs = cont.requests[0]!.messages;
  assert.ok(msgs.some((m) => m.role === 'assistant' && m.content === '半截正文'), '继续的请求里应包含半截正文');
  assert.equal(msgs[msgs.length - 1]!.role, 'user');
  assert.equal(String(msgs[msgs.length - 1]!.content), '继续');
});

test('条 12 边界：无正文就中止 → 仍是 error（不留空 assistant 消息）', async () => {
  const ctrl = new AbortController();
  const { session } = setup([]);
  class SilentAbort implements LLMProvider {
    readonly name = 'silent';
    readonly caps: ProviderCaps = {
      cache: { kind: 'none' }, reasoning: 'none', parallelToolCalls: true, compaction: 'client', maxContextTokens: 128000,
    };
    sanitizeForRequest(msgs: ChatMessage[]): ChatMessage[] { return msgs; }
    injectCacheMarkers(): void {}
    async *chat(): AsyncIterable<ChatEvent> { ctrl.abort(); yield { type: 'text.delta' as const, text: '' }; }
  }
  (session as unknown as { provider: LLMProvider }).provider = new SilentAbort();
  const before = session.history.length;
  const result = await runTurn(session, '空跑', ctrl.signal);
  assert.equal(result.kind, 'error');
  // 用户那句"空跑"会在回合开始时进历史（+1）；没有半截正文，所以不会多出 assistant 消息
  assert.equal(session.history.length, before + 1);
  assert.equal(session.history[session.history.length - 1]!.role, 'user');
});
