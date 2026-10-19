// 工厂组装——config→provider→runtime→registry→session；mock 下 print 流程跑通。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAgent } from './factory.js';
import { MockProvider, mockText } from './llm/adapters/mock.js';
import { runTurn } from './loop/turn.js';

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'brain-factory-'));
}

test('createAgent：默认装配 DeepSeek 配置 + 常驻工具 + 冻结前缀含项目记忆', async () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# 项目记忆内容');
  const provider = new MockProvider({ script: [mockText('好')] });
  const agent = await createAgent({
    cwd: dir,
    home: dir,
    provider,
    cli: {
      sessions: { dir: `${dir}/sessions` },
      log: { dir: `${dir}/logs` },
      memory: { autoDir: `${dir}/memory`, semanticDir: `${dir}/memory/semantic`, episodesDir: `${dir}/memory/episodes` },
    },
  });
  assert.equal(agent.provider, provider);
  assert.deepEqual(
    agent.registry.all().map((t) => t.name),
    // 含 schedule（定时任务表：<sessions 上级>/cron/jobs.json）
    // 含 task（任务账本：<sessions 上级>/tasks/）
    // 含 office（Office 六动作）与 delete（删文件进回收站）
    // 含 todo（待办：她把闲聊里聊出来的事记进家里右栏那张卡）
    // 含 undo（撤销本回合改动：回合级快照；没挂快照库时如实拒绝）
    ['app', 'bash', 'delete', 'edit', 'forget', 'glob', 'grep', 'load_skill', 'media', 'office', 'read', 'recall', 'remember', 'schedule', 'session_search', 'task', 'todo', 'undo', 'web_fetch', 'web_search', 'write'],
  );
  const session = agent.createSession();
  assert.ok(session.frozen.system.includes('通用智能体'));
  assert.ok(session.frozen.system.includes('项目记忆内容')); // AGENTS.md 注入
  const result = await runTurn(session, '你好');
  assert.equal(result.kind, 'final');
  assert.equal((result as { text: string }).text, '好');
});

test('同工厂多会话共享同一冻结前缀（字节一致 → 缓存命中）', async () => {
  const dir = tmpdir();
  const provider = new MockProvider({ script: [mockText('x'), mockText('y')] });
  const agent = await createAgent({ cwd: dir, home: dir, provider });
  const s1 = agent.createSession();
  const s2 = agent.createSession();
  assert.equal(s1.frozen.system, s2.frozen.system);
  assert.deepEqual(s1.frozen.tools, s2.frozen.tools);
});

test('回归（用户实测 bug 2026-09-19）：面板选的模型必须**真的**进配置（哪怕 cli.providers 只有 baseUrl）', async () => {
  const dir = tmpdir();
  const provider = new MockProvider({ script: [mockText('x')] });
  const agent = await createAgent({
    cwd: dir, home: dir, provider,
    // 宿主就是这么传的：只有 baseUrl，没有 models 字段
    cli: { providers: { deepseek: { baseUrl: 'https://api.deepseek.com/v1' } }, sessions: { dir: `${dir}/sessions` } },
    modelOverride: { deepseek: 'deepseek-v4-pro' },
  });
  assert.equal(
    agent.config.providers.deepseek!.models.main.id,
    'deepseek-v4-pro',
    '选了模型却没进配置 = 面板白选（此前 applyModelOverride 在合并前跑，被"没有 models 字段"跳过）',
  );
  // 只覆盖 main；fast/compact/subagent 保持供应商分档（"拆压平"）
  assert.notEqual(agent.config.providers.deepseek!.models.fast.id, 'deepseek-v4-pro');
  // 选中供应商自己的深度模型时，main 要带上 thinking
  assert.equal(agent.config.providers.deepseek!.models.main.thinking, true);
});

// 规则体检要**接在装配上**——只写单测不接线就 = 死功能
test('createAgent 会跑规则体检：写歪的规则挂在 agent.policyIssues 上（宿主据此写日志）', async () => {
  const dir = tmpdir();
  const agent = await createAgent({
    cwd: dir,
    home: dir,
    provider: new MockProvider({ script: [mockText('好')] }),
    cli: {
      sessions: { dir: `${dir}/sessions` },
      log: { dir: `${dir}/logs` },
      memory: { autoDir: `${dir}/memory`, semanticDir: `${dir}/memory/semantic`, episodesDir: `${dir}/memory/episodes` },
      permissions: {
        rules: [
          { id: 'typo', tool: 'bas', match: '^ls', action: 'allow' },   // 工具名打错 → 永不匹配
          { id: 'boom', tool: 'bash', match: '(a+)+$', action: 'deny' }, // 灾难性回溯 → 引擎直接跳过
        ],
      },
    },
  });
  const kinds = agent.policyIssues.map((i) => `${i.ruleId}:${i.kind}`);
  assert.ok(kinds.includes('typo:unknown-tool'), `应报出打错工具名的规则（实际 ${kinds.join(', ')}）`);
  assert.ok(kinds.includes('boom:redos'), `应报出灾难性回溯的规则（实际 ${kinds.join(', ')}）`);
  assert.ok(agent.policyIssues.every((i) => i.fix && i.message), '每条都要有"为什么 + 怎么改"');

  // 干净的默认配置 → 一条都不报（别把体检做成噪音）
  const clean = await createAgent({
    cwd: dir,
    home: dir,
    provider: new MockProvider({ script: [mockText('好')] }),
    cli: {
      sessions: { dir: `${dir}/s2` },
      log: { dir: `${dir}/l2` },
      memory: { autoDir: `${dir}/m2`, semanticDir: `${dir}/m2/semantic`, episodesDir: `${dir}/m2/episodes` },
    },
  });
  assert.deepEqual(clean.policyIssues, [], '默认规则表必须是干净的');
});

test('迭代 17 节点 1：宿主工具（hostTools）注册后，**目录与 schema 同源**（不再"有 schema 没自述"）', async () => {
  const dir = tmpdir();
  const provider = new MockProvider({ script: [mockText('x')] });
  // 造一个"需要 agent 实例"的假宿主工具：工厂必须在渲染冻结前缀**之前**注册它。
  // 名字故意用**在白名单里**的 `install_skill`（宿主侧就是 plan_task/install_skill/save_skill/install_mcp 这四个）
  // —— 白名单外的工具本来就不该进目录，用白名单内的名字才测得出"同源"这件事。
  const hostTool = (agent: unknown) => [{
    name: 'install_skill',
    blurb: '宿主注册的探针工具',
    whenNotToUse: '别用它',
    schema: { type: 'function', function: { name: 'install_skill', description: '宿主探针', parameters: { type: 'object', properties: {} } } },
    run: async () => ({ ok: true, output: String(!!agent) }),
  }];
  const agent = await createAgent({ cwd: dir, home: dir, provider, hostTools: hostTool as never });

  // ① schema 里有
  const names = agent.registry.all().map((t) => t.name);
  assert.ok(names.includes('install_skill'), '工具要注册进注册表');
  // ② 目录里也有（只有 schema、没有自述就 = 不同源）
  const session = agent.createSession();
  assert.ok(session.frozen.system.includes('install_skill'), '目录里必须有它（同源）');
  assert.ok(session.frozen.tools.some((t) => t.function.name === 'install_skill'), 'tools 里也要有（两侧同源）');

  // ③ 不传 hostTools 时，行为与从前一字不差（老调用方不受影响）
  const agent2 = await createAgent({ cwd: dir, home: dir, provider });
  assert.ok(!agent2.registry.all().map((t) => t.name).includes('install_skill'));
  assert.equal(agent2.createSession().frozen.system.includes('宿主注册的探针工具'), false);
});
