// 压缩——触发即 compact 角色独立请求；成功替换 [摘要块+最后4条]；失败降级；frozen 不动。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChatMessage } from '../llm/provider.js';
import { MockProvider, mockText } from '../llm/adapters/mock.js';
import { createNodeRuntime } from '../runtime/node.js';
import { ToolRegistry } from '../tools/registry.js';
import { readTool } from '../tools/read.js';
import { loadConfig } from '../config/load.js';
import { Session } from './session.js';
import { SessionArchive } from '../session/archive.js';
import { runTurn } from './turn.js';
import { parseCompactJson } from '../prompt/compact.js';
import { sampleForSummary } from './compact.js';
import type { AgentEvent } from '../session/events.js';

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'brain-compact-'));
}

function makeSession(script: ReturnType<typeof mockText>[], opts: { history?: ChatMessage[] } = {}) {
  const dir = tmpdir();
  const rt = createNodeRuntime({
    cwd: dir,
    storage: { sessionsDir: `${dir}/s`, logsDir: `${dir}/l`, memoryDir: `${dir}/m`, configDir: `${dir}/c` },
  });
  const registry = new ToolRegistry();
  registry.register(readTool());
  const config = loadConfig({
    cwd: dir,
    home: dir,
    cli: { budget: { compactAtTokens: 1 } }, // 强制触发压缩
  });
  const provider = new MockProvider({ script });
  const events: AgentEvent[] = [];
  const session = new Session({
    cwd: dir,
    config,
    provider,
    runtime: rt,
    registry,
    system: '冻结前缀 sys',
    emit: (ev) => events.push(ev),
  });
  if (opts.history) session.history = opts.history;
  return { dir, session, provider, events };
}

function longHistory(opts: { huge?: boolean } = {}): ChatMessage[] {
  const msgs: ChatMessage[] = [];
  for (let i = 0; i < 20; i++) {
    msgs.push({ role: 'user', content: `问题 ${i}` });
    msgs.push({ role: 'assistant', content: `回答 ${i}` });
    // 第 0 条给一个"超大块头"（>400 token）——这是选择性丢弃要丢的那种东西
    const output = opts.huge && i === 0 ? `HUGE_${'x'.repeat(2000)}` : `结果 ${i}`;
    msgs.push({ role: 'tool', content: JSON.stringify({ ok: true, output }), toolCallId: `t${i}` });
  }
  return msgs;
}

test('压缩成功：compact 角色独立请求（无工具/温度0.3）+ 摘要块替换 + frozen 不动', async () => {
  const summaryJson = JSON.stringify({
    goal: '原始任务', facts: ['f1'], plan: ['p1'], files: ['a.txt'], last_tool_results: 'r', warnings: ['w'],
  });
  const { session, provider, events } = makeSession(
    [mockText(summaryJson), mockText('最终回答')],
    { history: longHistory({ huge: true }) },
  );
  const frozenBefore = session.frozen.system;
  const result = await runTurn(session, '继续');
  assert.equal(result.kind, 'final');

  // compact 请求特征
  const req = provider.requests[0]!;
  assert.equal(req.model.role, 'compact');
  assert.equal(req.tools.length, 0);
  assert.equal(req.temperature, 0.3);

  /* 历史被替换为 [摘要块, ...留下没被摘要的原文, ...最后4条]。
     ⚠ 选择性丢弃的契约：**用户消息与她最后说过的话不再被摘要转述掉**
     ——所以条数不再固定是 6，改断言"该在的都在、该走的真走了"：
       · 摘要块在第一；
       · 最后 4 条原文还在（例：结果 19）；
       · 大块头工具输出**已经离开上下文**（例：结果 0 / 结果 10）；
       · 用户消息一条不少（关系资产）。 */
  assert.ok(String(session.history[0]!.content).includes('会话压缩摘要'));
  assert.ok(session.history.some((m) => String(m.content).includes('结果 19')), '最后 4 条要在');
  assert.ok(!session.history.some((m) => String(m.content).includes('HUGE_')), '超大块头工具输出要离开上下文（原文进存档）');
  assert.ok(session.history.filter((m) => m.role === 'user').length >= 10, '用户消息不该被摘要掉');
  assert.ok(String(session.history[0]!.content).includes('原始任务'));
  // 最后 4 条原文保留（按下标取容易错位——按内容找）
  assert.ok(session.history.some((m) => String(m.content).includes('结果 19')), JSON.stringify(session.history.map((m) => m.role)));

  // frozen 原样
  assert.equal(session.frozen.system, frozenBefore);
  // 事件
  assert.ok(events.some((e) => e.type === 'compact.start'));
  assert.ok(events.some((e) => e.type === 'compact.end'));
  assert.equal(session.stats.compactions, 1);
});

test('压缩失败降级：保留首条 user + 最后 8 条；compact.failed 事件', async () => {
  const { session, events } = makeSession(
    [mockText('这不是 JSON'), mockText('最终回答')],
    { history: longHistory() },
  );
  const result = await runTurn(session, '继续');
  assert.equal(result.kind, 'final');

  assert.ok(events.some((e) => e.type === 'compact.failed'));
  // 首条 user（问题 0）+ 最后 8 条
  assert.equal(session.history.length, 10); // 含本回合的最终回复
  assert.ok(String(session.history[0]!.content).includes('问题 0'));
  assert.ok(session.history.some((m) => String(m.content).includes('结果 19')));
});

test('条 37：压缩块附锚点索引与找回提示；原文进存档、能搜回', async () => {
  const summaryJson = JSON.stringify({
    goal: '原始任务', facts: [], plan: [], files: [], last_tool_results: '', warnings: [],
  });
  const { session, events } = makeSession([mockText(summaryJson), mockText('最终回答')], {
    history: [
      { role: 'user', content: '灵核项目下周要出验收包，关键文件是 brain/src/loop/compact.ts，约定 2026-09-20 前给答复' },
      ...longHistory().slice(0, 18),
    ],
  });
  const result = await runTurn(session, '继续');
  assert.equal(result.kind, 'final');

  // 摘要块 = 结构化摘要 + 锚点 + 找回路径（三件都在同一个消息里，历史长度不变）
  const block = String(session.history[0]!.content);
  assert.ok(block.includes('会话压缩摘要'));
  assert.ok(block.includes('精确锚点'));
  assert.ok(block.includes('brain/src/loop/compact.ts')); // 路径被机械抠出
  assert.ok(block.includes('2026-09-20'));                 // 日期被机械抠出
  assert.ok(block.includes('找回路径'));
  assert.ok(block.includes('session_search'));             // 点名真实工具
  // 这一份夹具里没有"大块头工具输出"可丢 → 走的是兜底老路（整段换摘要），
  // 所以那句话不在上下文里；但**必须能从存档搜回来**（下面就是在验这个）。
  // "用户消息不被摘要掉"那条规矩由上面第一个用例（有得丢的场景）守着。

  // 原文没有被丢掉：进了存档，且中文长句能搜回
  const archive = new SessionArchive(session.runtime, session.id);
  const all = await archive.list();
  assert.ok(all.length > 0);
  assert.ok(all.some((m) => m.content.includes('灵核项目下周要出验收包')));
  const hits = await archive.search('上次我们说的那个验收包什么时候要');
  assert.equal(hits.length, 1);
  assert.ok(hits[0]!.msg.content.includes('验收包'));
  assert.ok(events.some((e) => e.type === 'compact.start' && e.beforeTokens > 0));
});

test('上下文超 maxContextTokens 且已压缩过 → limit 终止', async () => {
  const { session } = makeSession(
    [mockText('{"goal":"g","facts":[],"plan":[],"files":[],"last_tool_results":"","warnings":[]}'), mockText('x')],
    { history: longHistory() },
  );
  session.config.budget.maxContextTokens = 10; // 压缩后仍超 → 终止
  const result = await runTurn(session, '继续');
  assert.equal(result.kind, 'limit');
});


test('条 37③（审计后补）：摘要输入超预算 → 均匀采样，不掐头去尾（中段不整段失踪）', () => {
  const lines = Array.from({ length: 200 }, (_, i) => `[user] 第 ${i} 条消息内容`.padEnd(60, 'x'));
  const r = sampleForSummary(lines, 3000); // 约 50 条预算
  assert.ok(r.elided > 0, '应该抽掉一部分');
  assert.ok(r.text.length <= 3000 + 200, '采样后应在预算内：' + r.text.length);
  assert.ok(r.text.includes('第 0 条'), '开头要在');
  assert.ok(r.text.includes('第 199 条'), '结尾要在');
  // 中段必须有代表（均匀采样）——不是只剩头尾
  const mid = r.text.includes('第 100 条') || r.text.includes('第 99 条') || r.text.includes('第 101 条') || /第 1[0-9][0-9] 条/.test(r.text);
  assert.ok(mid, '中段应该有抽样（掐头去尾会把整段中段藏起来）');
  assert.match(r.text, /session_search/, '省略处要指明找回路径');
  // 不超预算时原样返回
  const small = sampleForSummary(['a', 'b', 'c'], 9999);
  assert.equal(small.elided, 0);
  assert.equal(small.text, 'a\nb\nc');
});

test('选择性丢弃的兜底：没有可丢的大块头时，退回"整段换摘要 + 留最后 4 条"', async () => {
  const summaryJson = JSON.stringify({
    goal: '原始任务', facts: [], plan: [], files: [], last_tool_results: '', warnings: [],
  });
  const { session } = makeSession([mockText(summaryJson), mockText('最终回答')], { history: longHistory() });
  const result = await runTurn(session, '继续');
  assert.equal(result.kind, 'final');
  // 兜底路径：摘要块 + 最后 4 条 + 本回合最终回复 = 6
  assert.equal(session.history.length, 6, JSON.stringify(session.history.map((m) => m.role)));
  assert.ok(String(session.history[0]!.content).includes('会话压缩摘要'));
  assert.ok(session.history.some((m) => String(m.content).includes('结果 19')), '最后 4 条仍要在');
});

/* ── 状态重建八字段 / 增量摘要 / 截断拒落盘 ─────────────────────────────────── */

test('状态重建：八字段进摘要块最前面（人话"任务现状"），老格式摘要缺字段也不炸', async () => {
  const summaryJson = JSON.stringify({
    goal: '把月报收尾',
    done: ['三张表已对齐'],
    in_progress: ['补一页结论'],
    blocked: ['等财务给口径'],
    decisions: ['按 9 月口径出'],
    constraints: ['别动原始数据'],
    failures: ['试过按 8 月口径，对不上'],
    file_states: ['月报.xlsx 已改，总表.xlsx 未动'],
    todo_verify: ['数字还没核算'],
    facts: [], plan: [], files: [], last_tool_results: '', warnings: [],
  });
  const { session } = makeSession([mockText(summaryJson), mockText('最终回答')], { history: longHistory({ huge: true }) });
  await runTurn(session, '继续');
  const block = String(session.history[0]!.content);
  assert.ok(block.includes('任务现状'), '要有人话的"任务现状"段');
  assert.ok(block.includes('卡住（卡在哪）'));
  assert.ok(block.includes('等财务给口径'));
  assert.ok(block.includes('做完但没验证'));
  assert.ok(block.includes('数字还没核算'));
  // 原始 JSON 仍在（结构化那份没丢）
  assert.ok(block.includes('"goal": "把月报收尾"'));
});

test('老格式摘要（只有原六字段）读出来不炸：八项自动成空数组', () => {
  const old = parseCompactJson(JSON.stringify({ goal: 'g', facts: ['f'], plan: [], files: [], last_tool_results: '', warnings: [] }));
  assert.ok(old);
  assert.deepEqual(old!.done, []);
  assert.deepEqual(old!.todo_verify, []);
});

test('截断拒落盘：输出连右花括号都没有 → compact.failed（理由写明"截断"）+ 走降级 + 不写 summary.json', async () => {
  const { session, events } = makeSession(
    [mockText('{"goal":"还没写完就被切断了'), mockText('最终回答')],
    { history: longHistory({ huge: true }) },
  );
  await runTurn(session, '继续');
  const failed = events.find((e) => e.type === 'compact.failed') as { reason?: string } | undefined;
  assert.ok(failed, '要有 compact.failed');
  assert.match(String(failed!.reason), /截断/, `理由要说清是截断：${failed!.reason}`);
  // summary.json 不该存在（半截摘要绝不落盘）
  const f = `${session.runtime.storage.sessionsDir()}/${session.id}/summary.json`;
  assert.equal(fs.existsSync(f), false, '半截摘要不许落盘');
});

test('增量摘要：第二次压缩把"上一次的摘要"一起喂进去，且落一份 summary.json 供跨重启', async () => {
  const first = JSON.stringify({ goal: '第一轮目标', done: ['A'], in_progress: ['B'], blocked: [], decisions: ['D'], constraints: [], failures: [], file_states: [], todo_verify: [], facts: [], plan: [], files: [], last_tool_results: '', warnings: [] });
  const second = JSON.stringify({ goal: '第一轮目标', done: ['A', 'B'], in_progress: [], blocked: [], decisions: ['D'], constraints: [], failures: [], file_states: [], todo_verify: [], facts: [], plan: [], files: [], last_tool_results: '', warnings: [] });
  const { session, provider } = makeSession([mockText(first), mockText('答复一'), mockText(second), mockText('答复二')], { history: longHistory({ huge: true }) });
  await runTurn(session, '第一次');
  // 第一次压缩后落盘
  const f = `${session.runtime.storage.sessionsDir()}/${session.id}/summary.json`;
  assert.ok(fs.existsSync(f), 'summary.json 要落盘（跨重启的增量基线）');
  // 塞更长的历史再压一次
  session.history.push(...longHistory({ huge: true }));
  await runTurn(session, '第二次');
  const compactReqs = provider.requests.filter((r) => r.model.role === 'compact');
  assert.ok(compactReqs.length >= 2, `至少要压两次（实际 ${compactReqs.length}）`);
  const secondReq = JSON.stringify(compactReqs[1]!.messages);
  assert.ok(secondReq.includes('上一次的摘要'), '第二次压缩要带上一份摘要（增量更新）');
  assert.ok(secondReq.includes('第一轮目标'), '上一份内容真的在里面');
});
