// subagent——AGENT.md 解析扫描 / 白名单隔离（不可见宿主历史）/ 迭代上限 / 独立成本 / 未知名报错。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createNodeRuntime } from '../runtime/node.js';
import { MockProvider, mockText, mockToolCalls } from '../llm/adapters/mock.js';
import { ToolRegistry } from '../tools/registry.js';
import { readTool } from '../tools/read.js';
import { writeTool } from '../tools/write.js';
import { loadConfig } from '../config/load.js';
import { Session } from '../loop/session.js';
import { parseAgentMd, scanAgents, agentsIndexText } from './scan.js';
import { runSubagent, buildSubagentRunner } from './runner.js';

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'brain-agents-'));
}

const REVIEWER_MD = `---
name: code-reviewer
description: 对文件做代码审查，输出问题清单
tools: [read, grep]
model: fast
maxIterations: 20
---
你是代码审查员。只输出问题清单。`;

function makeHost(script: ReturnType<typeof mockText>[]) {
  const dir = tmpdir();
  const rt = createNodeRuntime({
    cwd: dir,
    storage: { sessionsDir: `${dir}/s`, logsDir: `${dir}/l`, memoryDir: `${dir}/m`, configDir: dir },
  });
  const registry = new ToolRegistry();
  registry.register(readTool());
  registry.register(writeTool());
  const provider = new MockProvider({ script });
  const config = loadConfig({ cwd: dir, home: dir });
  const session = new Session({ id: 'host-1', cwd: dir, config, provider, runtime: rt, registry, system: '宿主系统提示' });
  session.history = [
    { role: 'user', content: '宿主秘密任务' },
    { role: 'assistant', content: '宿主秘密结论' },
  ];
  return { dir, rt, registry, provider, config, session };
}

test('parseAgentMd / scanAgents：frontmatter 解析 + 目录扫描', async () => {
  const p = parseAgentMd(REVIEWER_MD);
  assert.equal(p?.spec.name, 'code-reviewer');
  assert.deepEqual(p?.spec.tools, ['read', 'grep']);
  assert.equal(p?.spec.model, 'fast');
  assert.equal(p?.spec.maxIterations, 20);
  assert.ok(p?.body.includes('代码审查员'));

  const dir = tmpdir();
  const rt = createNodeRuntime({
    cwd: dir,
    storage: { sessionsDir: `${dir}/s`, logsDir: `${dir}/l`, memoryDir: `${dir}/m`, configDir: dir },
  });
  fs.mkdirSync(path.join(dir, 'agents', 'code-reviewer'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'agents', 'code-reviewer', 'AGENT.md'), REVIEWER_MD);
  const specs = await scanAgents(rt, [`${dir}/agents`]);
  assert.equal(specs[0]!.name, 'code-reviewer');
  assert.ok(specs[0]!.body.includes('问题清单'));
});

test('白名单隔离：工具仅 spec.tools ∩ 注册表；宿主历史不可见', async () => {
  const host = makeHost([mockText('审查完成：3 个问题')]);
  const spec = parseAgentMd(REVIEWER_MD)!.spec;

  const result = await runSubagent(spec, '审查 a.txt', {
    session: () => host.session,
    runtime: host.rt,
    config: host.config,
    provider: host.provider,
    registry: host.registry,
    agents: [],
  });
  assert.equal(result.ok, true);
  assert.equal(result.output, '审查完成：3 个问题');

  // 子请求：system 含角色正文；tools 白名单；messages 无宿主历史
  const req = host.provider.requests[0]!;
  assert.ok(req.system.includes('子任务角色：code-reviewer'));
  assert.ok(req.system.includes('问题清单'));
  assert.deepEqual(req.tools.map((t) => t.function.name), ['read']);
  const msgText = req.messages.map((m) => m.content).join('\n');
  assert.ok(!msgText.includes('宿主秘密任务')); // 不可见宿主历史
  assert.ok(msgText.includes('审查 a.txt'));
});

test('迭代上限 min(spec.maxIterations, 20) → SUBAGENT_LIMIT', async () => {
  const script: ReturnType<typeof mockToolCalls>[] = [];
  for (let i = 0; i < 25; i++) script.push(mockToolCalls([{ id: `c${i}`, name: 'read', args: { path: 'a.txt' } }]));
  const host = makeHost(script);
  fs.writeFileSync(path.join(host.dir, 'a.txt'), 'x\n');
  const spec = parseAgentMd(REVIEWER_MD)!.spec;

  const result = await runSubagent(spec, '审查', {
    session: () => host.session,
    runtime: host.rt,
    config: host.config,
    provider: host.provider,
    registry: host.registry,
    agents: [],
  });
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, 'SUBAGENT_LIMIT');
  // 20 次迭代后终止（不是 25）
  const readCalls = host.provider.requests.filter((r) => r.model.role === 'fast').length;
  assert.ok(readCalls <= 20);
});

test('独立成本记账 + 未知 agent 报错', async () => {
  const host = makeHost([mockText('好')]);
  host.provider = new MockProvider({ script: [mockText('好')], usage: { costUsd: 0.05 } });
  const spec = parseAgentMd(REVIEWER_MD)!.spec;
  await runSubagent(spec, 't', {
    session: () => host.session,
    runtime: host.rt,
    config: host.config,
    provider: host.provider,
    registry: host.registry,
    agents: [],
  });
  assert.equal(host.session.stats.subagentCostUsd, 0.05);

  const runner = buildSubagentRunner({
    session: () => host.session,
    runtime: host.rt,
    config: host.config,
    provider: host.provider,
    registry: host.registry,
    agents: [spec],
  });
  const r = await runner('nope', 't');
  assert.equal(r.error?.code, 'UNKNOWN_AGENT');
  assert.match(r.error!.message, /code-reviewer/);
});

// ---------- 内置分身（中文名 + 名册进前缀） ----------

const CN_MD = `---
name: 查证员
description: 核实一个说法是否成立
tools: [read, grep]
model: subagent
maxIterations: 16
---
你是查证员。查不到就说查不到。`;

test('中文分身名可用（内置「查证员/资料员/整理员」靠这条）；路径式名字仍被拒', async () => {
  const dir = tmpdir();
  const rt = createNodeRuntime({ cwd: dir, storage: { sessionsDir: `${dir}/s`, logsDir: `${dir}/l`, memoryDir: `${dir}/m`, configDir: dir } });
  fs.mkdirSync(`${dir}/agents/verifier`, { recursive: true });
  fs.writeFileSync(`${dir}/agents/verifier/AGENT.md`, CN_MD);
  fs.mkdirSync(`${dir}/agents/evil`, { recursive: true });
  fs.writeFileSync(`${dir}/agents/evil/AGENT.md`, CN_MD.replace('name: 查证员', 'name: ../escape'));
  const agents = await scanAgents(rt, [`${dir}/agents`]);
  assert.deepEqual(agents.map((a) => a.name), ['查证员']);
  assert.equal(agents[0]!.model, 'subagent');
  assert.equal(agents[0]!.maxIterations, 16);
  assert.ok(agents[0]!.body.includes('查不到就说查不到'));
});

test('名册（agentsIndexText）：列名字与能力 + 何时派/何时别派；空名册给空串（前缀不变）', () => {
  assert.equal(agentsIndexText([]), '');
  const text = agentsIndexText([
    { name: '查证员', description: '核实说法真伪', tools: [], model: 'subagent', maxIterations: 16, dir: '', body: '' },
    { name: '整理员', description: '收拾文件', tools: [], model: 'subagent', maxIterations: 20, dir: '', body: '' },
  ]);
  assert.ok(text.includes('【可以派出去的分身'));
  assert.ok(text.includes('- 查证员：核实说法真伪'));
  assert.ok(text.includes('- 整理员：收拾文件'));
  assert.ok(text.includes('什么时候派'));
  assert.ok(text.includes('什么时候别派'));
});

test('内置目录排在用户目录之后：同名时用户自己写的分身赢（可覆盖内置）', async () => {
  const dir = tmpdir();
  const rt = createNodeRuntime({ cwd: dir, storage: { sessionsDir: `${dir}/s`, logsDir: `${dir}/l`, memoryDir: `${dir}/m`, configDir: dir } });
  fs.mkdirSync(`${dir}/mine/v`, { recursive: true });
  fs.writeFileSync(`${dir}/mine/v/AGENT.md`, CN_MD.replace('核实一个说法是否成立', '我自己的查证员'));
  fs.mkdirSync(`${dir}/builtin/v`, { recursive: true });
  fs.writeFileSync(`${dir}/builtin/v/AGENT.md`, CN_MD);
  const agents = await scanAgents(rt, [`${dir}/mine`, `${dir}/builtin`]);
  assert.equal(agents.length, 1);
  assert.equal(agents[0]!.description, '我自己的查证员');
});

// ---------- 派活的四道闸（深度/数量/成本/时长） ----------

function hostOf(h: ReturnType<typeof makeHost>, depth?: number) {
  return { session: () => h.session, runtime: h.rt, config: h.config, provider: h.provider, registry: h.registry, agents: [], ...(depth ? { depth } : {}) };
}

test('闸①深度：默认只许派一层——第 2 层直接拒（不再靠"子会话没注入 runner"的偶然）', async () => {
  const host = makeHost([mockText('x')]);
  const spec = parseAgentMd(REVIEWER_MD)!.spec;
  const r = await runSubagent(spec, 't', hostOf(host, 2)); // 子代理再想派 → depth=2 > maxDepth=1
  assert.equal(r.ok, false);
  assert.equal(r.error?.code, 'SUBAGENT_DEPTH');
});

test('闸②数量：一回合最多 maxChildren 个；新回合清零后又能派', async () => {
  const host = makeHost([mockText('好')]);
  host.config = { ...host.config, budget: { ...host.config.budget, subagent: { maxDepth: 1, maxChildren: 1, maxCost: 2, maxRuntimeMs: 600_000 } } };
  const spec = parseAgentMd(REVIEWER_MD)!.spec;
  assert.equal((await runSubagent(spec, 't1', hostOf(host))).ok, true);
  const second = await runSubagent(spec, 't2', hostOf(host));
  assert.equal(second.ok, false);
  assert.equal(second.error?.code, 'SUBAGENT_LIMIT');
  assert.ok(second.error?.message.includes('上限')); // 人话，不是错误码
  // 新回合：runTurn 会把计数清零（这里模拟那一步）
  host.session.subagentSpawns = 0;
  assert.equal((await runSubagent(spec, 't3', hostOf(host))).ok, true);
});

test('闸③成本：全局闸与分身自述取最小 → 花到上限就停（SUBAGENT_LIMIT 说清花到多少）', async () => {
  // 脚本：先调一次工具（逼出第二轮——成本闸在每轮开头判），再回文本
  const host = makeHost([mockToolCalls([{ id: 'c1', name: 'read', args: { path: 'a.txt' } }]), mockText('好')]);
  fs.writeFileSync(path.join(host.dir, 'a.txt'), 'x\n');
  host.provider = new MockProvider({
    script: [mockToolCalls([{ id: 'c1', name: 'read', args: { path: 'a.txt' } }]), mockText('好'), mockText('继续')],
    usage: { costUsd: 0.05 },
  });
  host.config = { ...host.config, budget: { ...host.config.budget, maxCost: null, subagent: { maxDepth: 1, maxChildren: 8, maxCost: 0.01, maxRuntimeMs: 600_000 } } };
  const spec = parseAgentMd(REVIEWER_MD)!.spec;
  const r = await runSubagent(spec, 't', hostOf(host));
  assert.equal(r.ok, false);
  assert.equal(r.error?.code, 'SUBAGENT_LIMIT');
  assert.ok(r.error?.message.includes('花到上限'), r.error?.message);
});

test('闸④时长：分身自述 maxRuntime 秒 → 卡住的分身被掐断，且明说是超时（不是"用户中止"）', async () => {
  const host = makeHost([mockText('x')]);
  // 卡住且尊重 signal 的 provider：在真 MockProvider 上只覆盖 chat（保住接口其余方法）
  const hang = new MockProvider({ script: [mockText('x')] });
  (hang as unknown as { chat: unknown }).chat = (req: { signal?: AbortSignal }) => (async function* () {
    await new Promise((_res, rej) => {
      const t = setTimeout(() => rej(new Error('should-not-happen')), 30_000);
      req.signal?.addEventListener('abort', () => { clearTimeout(t); rej(new Error('aborted')); });
    });
  })();
  host.provider = hang;
  const spec = { ...parseAgentMd(REVIEWER_MD)!.spec, maxRuntimeSec: 1 }; // 1 秒
  const t0 = Date.now();
  const r = await runSubagent(spec, 't', hostOf(host));
  assert.ok(Date.now() - t0 < 10_000, '应该 1 秒左右就中止，不该等满');
  assert.equal(r.error?.code, 'SUBAGENT_TIMEOUT');
  assert.ok(r.error?.message.includes('超时'), r.error?.message);
});

test('AGENT.md 可声明 maxCost / maxRuntime（秒）+ 键名兼容 snake_case', () => {
  const p = parseAgentMd(`---
name: x
description: d
tools: [read]
max_iterations: 7
max_cost: 0.5
max_runtime: 90
---
正文`);
  assert.equal(p?.spec.maxIterations, 7);
  assert.equal(p?.spec.maxCost, 0.5);
  assert.equal(p?.spec.maxRuntimeSec, 90);
});

test('闸④夹取：分身自述的 maxRuntime 只能更小——下载来的 AGENT.md 拆不掉全局保险丝', async () => {
  const host = makeHost([mockText('x')]);
  let seenSignal: AbortSignal | undefined;
  const spy = new MockProvider({ script: [mockText('x')] });
  (spy as unknown as { chat: unknown }).chat = (req: { signal?: AbortSignal }) => {
    seenSignal = req.signal;
    return (async function* () { yield { type: 'text.delta', text: 'ok' }; yield { type: 'done', usage: { inTokens: 0, hitTokens: 0, missTokens: 0, outTokens: 0, reasoningTokens: 0, costUsd: 0 } }; })();
  };
  host.provider = spy;
  // 全局闸 1 秒，分身自称 86400 秒（一天）——夹取后必须仍是全局闸
  host.config = { ...host.config, budget: { ...host.config.budget, subagent: { maxDepth: 1, maxChildren: 8, maxCost: 2, maxRuntimeMs: 1000 } } };
  const spec = { ...parseAgentMd(REVIEWER_MD)!.spec, maxRuntimeSec: 86_400 };
  const r = await runSubagent(spec, 't', hostOf(host));
  assert.equal(r.ok, true);
  assert.ok(seenSignal, '信号要真的传下去');
  assert.equal(seenSignal!.aborted, false);
  // 1 秒后应当被夹取后的闸掐断（而不是 86400 秒后才断）
  await new Promise((res) => setTimeout(res, 1300));
  assert.equal(seenSignal!.aborted, true);
});

test('子代理事件带 by 身份：宿主据此**不把分身的话当成她说的**（否则解锁 run_agent 后第一次派活就串台）', async () => {
  const host = makeHost([mockText('查完了：3 处不对')]);
  const seen: Array<{ type: string; by?: string }> = [];
  host.session.emit = (ev) => { seen.push(ev as never); };
  const spec = parseAgentMd(REVIEWER_MD)!.spec;
  const r = await runSubagent(spec, 't', hostOf(host));
  assert.equal(r.ok, true);
  const textEv = seen.find((e) => e.type === 'assistant.text.delta');
  assert.ok(textEv, '子代理的文本事件要照常转发（过程可见）');
  assert.equal(textEv!.by, 'code-reviewer', '但必须带 by——宿主靠它把这些字挡在她的气泡之外');
  const toolEv = seen.find((e) => e.type === 'tool.call');
  if (toolEv) assert.equal(toolEv.by, 'code-reviewer');
});
