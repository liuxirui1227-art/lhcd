// 核心循环——mock 最小任务（读→改→跑）/ retry 修复 / 并行≤4 / 写互斥 / 重复检测 / 预算。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createNodeRuntime } from '../runtime/node.js';
import { MockProvider, mockToolCalls, mockText } from '../llm/adapters/mock.js';
import type { ChatEvent, ChatMessage, ChatRequest, LLMProvider, ProviderCaps } from '../llm/provider.js';
import { ToolRegistry, type ToolEntry } from '../tools/registry.js';
import { bashTool } from '../tools/bash.js';
import { readTool } from '../tools/read.js';
import { writeTool } from '../tools/write.js';
import { appTool } from '../tools/app.js';
import { PolicyEngine } from '../policy/engine.js';
import { loadConfig } from '../config/load.js';
import { Session } from './session.js';
import { runTurn } from './turn.js';
import type { AgentEvent } from '../session/events.js';

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'brain-loop-'));
}

function setup(opts: { script: ChatEvent[][]; registry?: ToolRegistry; maxIterations?: number; provider?: LLMProvider }) {
  const dir = tmpdir();
  const rt = createNodeRuntime({
    cwd: dir,
    storage: { sessionsDir: `${dir}/s`, logsDir: `${dir}/l`, memoryDir: `${dir}/m`, configDir: `${dir}/c` },
  });
  const registry = opts.registry ?? new ToolRegistry();
  const config = loadConfig({
    cwd: dir,
    home: dir,
    cli: opts.maxIterations !== undefined ? { budget: { maxIterations: opts.maxIterations } } : undefined,
  });
  // 默认 MockProvider 带 requests 记录（断言用）；注入自定义 provider 的测试不使用 requests
  const provider = (opts.provider ?? new MockProvider({ script: opts.script })) as LLMProvider & { requests: ChatRequest[] };
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
  return { dir, rt, registry, config, provider, session, events };
}

/** 脚本化 provider：先发 delta，再（可选）abort 外部信号，最后抛错——模拟真实适配器流中断/中止 */
class ThrowingProvider implements LLMProvider {
  readonly name = 'throwing';
  readonly caps: ProviderCaps = {
    cache: { kind: 'none' }, reasoning: 'none', parallelToolCalls: true, compaction: 'client', maxContextTokens: 128000,
  };
  constructor(
    private readonly opts: { deltas?: string[]; error: string; abortController?: AbortController },
  ) {}
  sanitizeForRequest(msgs: ChatMessage[]): ChatMessage[] {
    return msgs.map((m) => ({ ...m }));
  }
  injectCacheMarkers(): void {}
  async *chat(_req: ChatRequest): AsyncIterable<ChatEvent> {
    for (const d of this.opts.deltas ?? []) {
      yield { type: 'text.delta' as const, text: d };
    }
    if (this.opts.abortController) this.opts.abortController.abort();
    throw new Error(this.opts.error);
  }
}

/** 测试助手：历史里还有用户消息与最终回复，按下标取容易错位——按角色找 */
function firstToolMsg(session: { history: Array<{ role: string; content: unknown }> }): string {
  return String(session.history.find((m) => m.role === 'tool')?.content ?? '');
}

// 输入条能连粘几张截图 → 内核得按 N 个 image_url 块发出去。
// 零成本抓包：MockProvider 会记下真实请求（`requests`），断言就落在它上面——
// 不靠"看图看得对"（那要真 key），只钉住**线格式**。
test('多图输入：image 收数组 → user 消息按 N 个 image_url 块发出去', async () => {
  const { session, provider } = setup({ script: [mockText('看过这两张了')] });
  const A = 'data:image/png;base64,AAAA';
  const B = 'data:image/png;base64,BBBB';
  await runTurn(session, { text: '这两张图对一下', image: [A, B] });
  const req = (provider as unknown as { requests: ChatRequest[] }).requests[0]!;
  const user = req.messages.find((m) => m.role === 'user' && Array.isArray(m.content)) as
    | { content: Array<{ type: string; text?: string; image_url?: { url: string } }> }
    | undefined;
  assert.ok(user, '缺多模态 user 消息');
  assert.equal(user.content[0]!.type, 'text', '文字块要在最前');
  const imgs = user.content.filter((c) => c.type === 'image_url');
  assert.equal(imgs.length, 2, '两张图要发两个 image_url 块');
  assert.equal(imgs[0]!.image_url?.url, A);
  assert.equal(imgs[1]!.image_url?.url, B);
  // 单图（老路子）与纯文本一个字都不能变
  const { session: s2, provider: p2 } = setup({ script: [mockText('好'), mockText('好')] });
  await runTurn(s2, { text: '一张', image: A });
  await runTurn(s2, '纯文本');
  const r2 = (p2 as unknown as { requests: ChatRequest[] }).requests;
  const u1 = r2[0]!.messages.find((m) => m.role === 'user' && Array.isArray(m.content)) as { content: unknown[] } | undefined;
  assert.equal(u1?.content.length, 2, '单图 = 文字 + 一个图块');
  const u2 = r2[1]!.messages.filter((m) => m.role === 'user' && typeof m.content === 'string');
  assert.ok(u2.length >= 1, '纯文本仍是字符串内容（没被多模态逻辑改写）');
});

test('mock 最小任务：读→写→跑→最终文本（全链路）', async () => {
  const { dir, session, provider, events } = setup({
    script: [
      mockToolCalls([{ id: 'c1', name: 'read', args: { path: 'a.txt' } }]),
      mockToolCalls([{ id: 'c2', name: 'write', args: { path: 'b.txt', content: 'world' } }]),
      mockToolCalls([{ id: 'c3', name: 'bash', args: { command: 'cat b.txt' } }]),
      mockText('完成：b.txt 已写入 world'),
    ],
  });
  // 注册工具
  for (const t of [bashTool(), readTool(), writeTool()]) session.registry.register(t);

  // fixture：a.txt
  fs.writeFileSync(path.join(dir, 'a.txt'), 'hello\n');

  const result = await runTurn(session, '读 a.txt，写入 b.txt，跑 cat 确认');
  assert.equal(result.kind, 'final');
  assert.equal((result as { text: string }).text, '完成：b.txt 已写入 world');
  assert.equal(fs.readFileSync(path.join(dir, 'b.txt'), 'utf8'), 'world');

  // 历史：3 组 assistant+tool
  assert.equal(session.history.length, 8); // +用户消息 +最终回复
  const firstTool = JSON.parse(firstToolMsg(session)) as { ok: boolean; output: string };
  assert.equal(firstTool.ok, true);
  assert.match(firstTool.output, /1\thello/);

  // 事件顺序：user.prompt.submit → turn.start → tool.call×3 → tool.result×3 → turn.end(final)
  const types = events.map((e) => e.type);
  assert.equal(types[0], 'user.prompt.submit');
  assert.equal(types[1], 'turn.start');
  assert.ok(types.includes('tool.call') && types.includes('tool.result') && types.includes('cache'));
  assert.equal(types[types.length - 1], 'turn.end');

  // 模型收到的第二轮消息包含第一轮 tool_result（渐进）
  assert.equal(provider.requests.length, 4);
});

test('retry：args 损坏回注错误，模型修复后成功', async () => {
  const { dir, session, provider } = setup({
    script: [
      mockToolCalls([{ id: 'b1', name: 'read', args: 'oops-非对象' }]),
      mockToolCalls([{ id: 'b2', name: 'read', args: { path: 'a.txt' } }]),
      mockText('好'),
    ],
  });
  for (const t of [readTool()]) session.registry.register(t);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'x\n');

  const result = await runTurn(session, '读');
  assert.equal(result.kind, 'final');
  // 第一轮回注了参数损坏错误
  const msg1 = JSON.parse(firstToolMsg(session)) as { ok: boolean; error?: { code: string } };
  assert.equal(msg1.ok, false);
  assert.equal(msg1.error?.code, 'BAD_ARGS');
  assert.equal(provider.requests.length, 3);
});

test('retry：未知工具回注可用工具列表（顺序固定）', async () => {
  const { session, provider } = setup({
    script: [
      mockToolCalls([{ id: 'u1', name: 'nope', args: {} }]),
      mockText('收到'),
    ],
  });
  for (const t of [readTool(), bashTool()]) session.registry.register(t);
  const result = await runTurn(session, '做点什么');
  assert.equal(result.kind, 'final');
  const msg = JSON.parse(firstToolMsg(session)) as { error?: { code: string; message: string } };
  assert.equal(msg.error?.code, 'UNKNOWN_TOOL');
  assert.match(msg.error!.message, /可用工具/);
  assert.match(msg.error!.message, /bash、read/); // 固定顺序（name 排序）
  void provider;
});

test('retry：schema 不符 1 次修复机会，二次失败丢弃', async () => {
  const { session } = setup({
    script: [
      mockToolCalls([{ id: 's1', name: 'read', args: { path: 123 } }]),
      mockToolCalls([{ id: 's2', name: 'read', args: { path: 456 } }]),
      mockText('放弃'),
    ],
  });
  for (const t of [readTool()]) session.registry.register(t);
  const result = await runTurn(session, '读');
  assert.equal(result.kind, 'final');
  const m1 = JSON.parse(firstToolMsg(session)) as { error?: { code: string; message: string } };
  assert.equal(m1.error?.code, 'BAD_SCHEMA');
  assert.match(m1.error!.message, /修复后重试/);
  const m2 = JSON.parse(String(session.history.filter((m) => m.role === 'tool')[1]?.content ?? '')) as { error?: { code: string; message: string } };
  assert.equal(m2.error?.code, 'BAD_SCHEMA');
  assert.match(m2.error!.message, /已丢弃/);
});

test('并行执行：非写类 ≤4 并发；写类互斥串行', async () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  let active = 0;
  let maxActive = 0;
  let writeActive = 0;
  let maxWriteActive = 0;
  const probe = (name: string, exclusive: boolean): ToolEntry => ({
    name,
    permissionClass: 'read',
    exclusive,
    schema: { type: 'function', function: { name, description: name, parameters: { type: 'object', properties: {} } } },
    executor: async () => {
      if (exclusive) {
        writeActive++;
        maxWriteActive = Math.max(maxWriteActive, writeActive);
        await sleep(30);
        writeActive--;
      } else {
        active++;
        maxActive = Math.max(maxActive, active);
        await sleep(30);
        active--;
      }
      return { ok: true, output: 'ok' };
    },
  });

  const registry = new ToolRegistry();
  for (let i = 0; i < 8; i++) registry.register(probe(`probe${i}`, false));
  for (let i = 0; i < 3; i++) registry.register(probe(`wprobe${i}`, true));

  const { session } = setup({
    registry,
    script: [
      mockToolCalls([
        { id: 'p0', name: 'probe0', args: {} },
        { id: 'p1', name: 'probe1', args: {} },
        { id: 'p2', name: 'probe2', args: {} },
        { id: 'p3', name: 'probe3', args: {} },
        { id: 'p4', name: 'probe4', args: {} },
        { id: 'p5', name: 'probe5', args: {} },
        { id: 'p6', name: 'probe6', args: {} },
        { id: 'p7', name: 'probe7', args: {} },
        { id: 'w0', name: 'wprobe0', args: {} },
        { id: 'w1', name: 'wprobe1', args: {} },
        { id: 'w2', name: 'wprobe2', args: {} },
      ]),
      mockText('done'),
    ],
  });

  const result = await runTurn(session, '跑');
  assert.equal(result.kind, 'final');
  assert.equal(maxActive, 4);   // 并行 ≤4
  assert.equal(maxWriteActive, 1); // 写类互斥串行
});

test('重复检测：同一工具+参数连续 3 回合 → 回注换方案提示', async () => {
  const { session, provider } = setup({
    script: [
      mockToolCalls([{ id: 'r1', name: 'read', args: { path: 'a.txt' } }]),
      mockToolCalls([{ id: 'r2', name: 'read', args: { path: 'a.txt' } }]),
      mockToolCalls([{ id: 'r3', name: 'read', args: { path: 'a.txt' } }]),
      mockText('换方案成功'),
    ],
  });
  for (const t of [readTool()]) session.registry.register(t);
  const result = await runTurn(session, '读');
  assert.equal(result.kind, 'final');
  // 第 4 次请求的 user 消息应含系统提示
  const msgs = provider.requests[3]!.messages;
  const lastUser = [...msgs].reverse().find((m) => m.role === 'user');
  assert.match(String(lastUser?.content ?? ''), /重复/);
});

test('预算：达到 maxIterations → limit 终止', async () => {
  const { session } = setup({
    maxIterations: 2,
    script: [
      mockToolCalls([{ id: 'x1', name: 'read', args: { path: 'a.txt' } }]),
      mockToolCalls([{ id: 'x2', name: 'read', args: { path: 'a.txt' } }]),
      mockToolCalls([{ id: 'x3', name: 'read', args: { path: 'a.txt' } }]),
    ],
  });
  for (const t of [readTool()]) session.registry.register(t);
  const result = await runTurn(session, '读');
  assert.equal(result.kind, 'limit');
  assert.equal((result as { reason: string }).reason, 'maxIterations');
  assert.equal(session.stats.iterations, 2);
});

test('工具抛错 → 结构化错误回传，不中断循环', async () => {
  const boom: ToolEntry = {
    name: 'boom',
    permissionClass: 'read',
    schema: { type: 'function', function: { name: 'boom', description: 'b', parameters: { type: 'object', properties: {} } } },
    executor: async () => {
      throw new Error('内部炸了');
    },
  };
  const { session } = setup({
    script: [
      mockToolCalls([{ id: 't1', name: 'boom', args: {} }]),
      mockText('收到错误'),
    ],
  });
  session.registry.register(boom);
  const result = await runTurn(session, '跑');
  assert.equal(result.kind, 'final');
  const msg = JSON.parse(firstToolMsg(session)) as { ok: boolean; error?: { code: string; message: string } };
  assert.equal(msg.ok, false);
  assert.equal(msg.error?.code, 'TOOL_THREW');
  assert.match(msg.error!.message, /内部炸了/);
  assert.equal(session.stats.failedToolCalls, 1);
});

test('Tier3 深度模式（noTools）：本回合请求不带工具', async () => {
  const { session, provider } = setup({
    script: [mockText('深度思考的答案')],
  });
  for (const t of [readTool(), bashTool()]) session.registry.register(t);
  session.noTools = true; // Tier3：reasoner 纯文本
  const result = await runTurn(session, '帮我深度分析一下');
  assert.equal(result.kind, 'final');
  assert.equal(provider.requests[0]!.tools.length, 0);
  assert.equal((result as { text: string }).text, '深度思考的答案');
});

test('只读工具模式（011-A4）：只带只读工具集（禁写禁执行），且能真的读文件', async () => {
  const { dir, session, provider } = setup({
    script: [
      mockToolCalls([{ id: 'ro1', name: 'read', args: { path: 'a.txt' } }]),
      mockText('读到了'),
    ],
  });
  for (const t of [readTool(), writeTool(), bashTool()]) session.registry.register(t);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'hello\n');
  session.readonlyTools = true;
  const result = await runTurn(session, '读一下 a.txt');
  assert.equal(result.kind, 'final');
  const toolNames = provider.requests[0]!.tools.map((t) => t.function.name);
  assert.deepEqual(toolNames, ['read']); // write/bash 被过滤
  const msg = JSON.parse(firstToolMsg(session)) as { ok: boolean; output: string };
  assert.equal(msg.ok, true);
  assert.match(msg.output, /hello/);
});

test('只读工具模式 + noTools 同时为 true → noTools 优先（不带任何工具）', async () => {
  const { session, provider } = setup({
    script: [mockText('纯文本')],
  });
  for (const t of [readTool()]) session.registry.register(t);
  session.readonlyTools = true;
  session.noTools = true;
  await runTurn(session, '分析');
  assert.equal(provider.requests[0]!.tools.length, 0);
});

test('流中断恢复（011-A2）：已收到部分正文 → 保留为最终回复，不整回合丢弃', async () => {
  const { session, events } = setup({
    script: [[]],
    provider: new ThrowingProvider({ deltas: ['前半句', '后半句'], error: '总时长超限（300000ms）' }),
  });
  const result = await runTurn(session, '问个问题');
  assert.equal(result.kind, 'final');
  assert.match((result as { text: string }).text, /前半句后半句/);
  assert.match((result as { text: string }).text, /中断/);
  assert.ok(events.some((e) => e.type === 'error' && (e as { code: string }).code === 'STREAM_INTERRUPTED'));
  assert.equal(events[events.length - 1]!.type, 'turn.end');
});

test('流中断：无内容即抛错（错误上抛由调用方翻译友好提示）', async () => {
  const { session } = setup({
    script: [[]],
    provider: new ThrowingProvider({ error: '首 token 超时（15000ms）' }),
  });
  await assert.rejects(() => runTurn(session, '问个问题'), /首 token 超时/);
});

test('用户中止（011-A7 + 迭代 03 条 12）：有半截正文 → aborted 保留；无正文 → error「用户中止」', async () => {
  const ctrl = new AbortController();
  const { session } = setup({
    script: [[]],
    provider: new ThrowingProvider({ deltas: ['半句'], error: 'This operation was aborted', abortController: ctrl }),
  });
  const result = await runTurn(session, '问个问题', ctrl.signal);
  // 中止时半截正文不丢弃（kind 是 aborted 而非 error，正文已进本会话上下文）
  assert.equal(result.kind, 'aborted');
  assert.equal((result as { text: string }).text, '半句');

  // 另一个出口：无正文就中止 → 仍为 error（不留空 assistant 消息）
  const ctrl2 = new AbortController();
  const { session: s2 } = setup({
    script: [[]],
    provider: new ThrowingProvider({ error: 'This operation was aborted', abortController: ctrl2 }),
  });
  const r2 = await runTurn(s2, '问个问题', ctrl2.signal);
  assert.equal(r2.kind, 'error');
  assert.equal((r2 as { message: string }).message, '用户中止');
});

test('device.action 审计（蓝图 9.5）：未授权 app 调用 → confirmed=false 审计事件，且不执行', async () => {
  const { session, events, config } = setup({
    script: [
      mockToolCalls([{ id: 'd1', name: 'app', args: { action: 'open', target: 'Terminal' } }]),
      mockText('已处理'),
    ],
  });
  session.registry.register(appTool());
  // 默认权限：app 白名单模式（空名单）→ open 落 ask；无审批通道 → 拒绝
  session.policy = new PolicyEngine(config.permissions);
  let opened = false;
  session.runtime.app = {
    open: async () => { opened = true; return { ok: true, output: 'ok' }; },
    activate: async () => { opened = true; return { ok: true, output: 'ok' }; },
    clipboard: async () => ({ ok: true, content: '' }),
    notify: async () => ({ ok: true, output: '' }),
    run: async () => ({ ok: true, output: '' }),
  };
  const result = await runTurn(session, '打开 Terminal');
  assert.equal(result.kind, 'final');
  const audits = events.filter((e) => e.type === 'device.action') as Array<{ action: string; level: string; confirmed: boolean; gateAsked: boolean; ok: boolean; undo: string }>;
  assert.equal(audits.length, 1);
  assert.equal(audits[0]!.action, 'open');
  assert.equal(audits[0]!.level, 'execute');
  assert.equal(audits[0]!.confirmed, false);
  // 走的是 ask 分支（发了 approval.request）→ asked=true。没通道没人答，所以 confirmed=false。
  assert.equal(audits[0]!.gateAsked, true, 'ask 分支必须记 gateAsked=true——它确实问了');
  assert.equal(audits[0]!.ok, false);
  assert.ok(audits[0]!.undo.length > 0);
  assert.equal(opened, false); // 被拒后绝不执行
});

test('device.action 审计：问过且用户同意 → asked=true + confirmed=true（和"自动放行"分开）', async () => {
  const { session, events, config } = setup({
    script: [
      mockToolCalls([{ id: 'd3', name: 'app', args: { action: 'open', target: 'Terminal' } }]),
      mockText('已打开'),
    ],
  });
  session.registry.register(appTool());
  session.policy = new PolicyEngine(config.permissions); // 空名单 → open 落 ask
  session.askApproval = async () => 'allow';             // 用户在宿主那边点了"允许"
  session.runtime.app = {
    open: async () => ({ ok: true, output: 'ok' }),
    activate: async () => ({ ok: true, output: 'ok' }),
    clipboard: async () => ({ ok: true, content: '' }),
    notify: async () => ({ ok: true, output: '' }),
    run: async () => ({ ok: true, output: '' }),
  };
  const result = await runTurn(session, '打开 Terminal');
  assert.equal(result.kind, 'final');
  const audits = events.filter((e) => e.type === 'device.action') as Array<{ confirmed: boolean; gateAsked: boolean; ok: boolean }>;
  assert.equal(audits.length, 1);
  assert.equal(audits[0]!.confirmed, true);
  assert.equal(audits[0]!.gateAsked, true, '闸门问了且放行：confirmed 与 gateAsked 都是 true');
  assert.equal(audits[0]!.ok, true);
});

test('device.action 审计：信任模式观察级（clipboard）→ confirmed=true + 撤销提示', async () => {
  const { session, events, config } = setup({
    script: [
      mockToolCalls([{ id: 'd2', name: 'app', args: { action: 'clipboard' } }]),
      mockText('读到了'),
    ],
  });
  session.registry.register(appTool());
  session.policy = new PolicyEngine({ ...config.permissions, app: { mode: 'trusted', whitelist: [] } });
  session.runtime.app = {
    open: async () => ({ ok: true, output: '' }),
    activate: async () => ({ ok: true, output: '' }),
    clipboard: async () => ({ ok: true, content: '剪贴板内容' }),
    notify: async () => ({ ok: true, output: '' }),
    run: async () => ({ ok: true, output: '' }),
  };
  const result = await runTurn(session, '读剪贴板');
  assert.equal(result.kind, 'final');
  const audits = events.filter((e) => e.type === 'device.action') as Array<{ action: string; level: string; confirmed: boolean; gateAsked: boolean; ok: boolean; output: string }>;
  assert.equal(audits.length, 1);
  assert.equal(audits[0]!.level, 'observe');
  assert.equal(audits[0]!.confirmed, true);
  // 信任模式是**自动放行**，没人问过用户 → asked=false。
  // 这正是要分开记 asked 的原因：只看 confirmed=true 会把"自动放行"读成"用户确认过"。
  assert.equal(audits[0]!.gateAsked, false, '自动放行时闸门根本没发起审批请求');
  assert.equal(audits[0]!.ok, true);
  assert.ok(audits[0]!.output.includes('剪贴板内容'));
});

/* 复盘会话的承诺："她复盘时只能看和提候选"。
   ⚠ 白名单若**只作用于"发给模型的清单"**，执行层（prepareCalls）只查 registry ——
   复盘会话的 registry 是全套工具的副本，模型吐出一个清单外的名字
   （幻觉 / 被摘录里的内容带偏）就**真执行**，
   而复盘跑在 chat 档（静默放行）→ 后台悄悄改/删用户文件，还不进她的对话。 */
test('工具白名单：**执行层也拦**——清单外的调用不执行、文件真的没被写出来', async () => {
  const { dir, session } = setup({
    script: [
      mockToolCalls([{ id: 'w1', name: 'write', args: { path: 'x.txt', content: '不该被写出来' } }]),
      mockText('好'),
    ],
  });
  session.registry.register(writeTool());
  session.toolWhitelist = ['read'];           // 复盘会话就是这个形状：只留只读 + 两个提候选
  const result = await runTurn(session, '写个文件');
  assert.equal(result.kind, 'final');
  const msg = JSON.parse(firstToolMsg(session)) as { ok: boolean; error?: { code: string; message: string } };
  assert.equal(msg.ok, false);
  assert.equal(msg.error?.code, 'TOOL_NOT_ALLOWED');
  // 最有说服力的一条：文件**根本不存在**（不是"执行了但失败"）
  assert.equal(fs.existsSync(path.join(dir, 'x.txt')), false, '白名单外的写入竟然落盘了');
});

test('工具白名单：清单里的调用照常执行（别把墙砌到自家人身上）', async () => {
  const { dir, session } = setup({
    script: [
      mockToolCalls([{ id: 'r1', name: 'read', args: { path: 'a.txt' } }]),
      mockText('读到了'),
    ],
  });
  fs.writeFileSync(path.join(dir, 'a.txt'), '内容');
  session.registry.register(readTool());
  session.toolWhitelist = ['read'];
  const result = await runTurn(session, '读一下');
  assert.equal(result.kind, 'final');
  const msg = JSON.parse(firstToolMsg(session)) as { ok: boolean; output: string };
  assert.equal(msg.ok, true);
  assert.ok(msg.output.includes('内容'));
});
