// 权限接入核心循环——deny 不执行工具；ask 走审批通道；approval 事件序列。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createNodeRuntime } from '../runtime/node.js';
import { MockProvider, mockToolCalls, mockText } from '../llm/adapters/mock.js';
import { ToolRegistry, type ToolEntry } from '../tools/registry.js';
import { loadConfig } from '../config/load.js';
import { Session } from './session.js';
import { runTurn } from './turn.js';
import { PolicyEngine } from '../policy/engine.js';
import type { PermissionsCfg } from '../config/schema.js';
import type { AgentEvent } from '../session/events.js';

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'brain-policy-'));
}

function setup(opts: { script: ReturnType<typeof mockToolCalls>[]; permissions?: Partial<PermissionsCfg>; askApproval?: Session['askApproval']; toolName?: string }) {
  const dir = tmpdir();
  const rt = createNodeRuntime({
    cwd: dir,
    storage: { sessionsDir: `${dir}/s`, logsDir: `${dir}/l`, memoryDir: `${dir}/m`, configDir: dir },
  });
  const registry = new ToolRegistry();
  let ran = 0;
  const toolName = opts.toolName ?? 'spy';
  const spy: ToolEntry = {
    name: toolName,
    permissionClass: 'bash',
    schema: { type: 'function', function: { name: toolName, description: 's', parameters: { type: 'object', properties: { command: { type: 'string' } } } } },
    executor: async () => {
      ran++;
      return { ok: true, output: 'ran' };
    },
  };
  registry.register(spy);
  const config = loadConfig({ cwd: dir, home: dir, cli: opts.permissions ? { permissions: opts.permissions } : undefined });
  const provider = new MockProvider({ script: opts.script });
  const events: AgentEvent[] = [];
  const session = new Session({
    cwd: dir,
    config,
    provider,
    runtime: rt,
    registry,
    system: 'sys',
    policy: new PolicyEngine(config.permissions),
    askApproval: opts.askApproval,
    emit: (ev) => events.push(ev),
  });
  return { session, ran: () => ran, events };
}

/** 测试助手（历史里也有用户消息与最终回复，按下标取容易错位——按角色找） */
function firstToolMsg(session: { history: Array<{ role: string; content: unknown }> }): string {
  return String(session.history.find((m) => m.role === 'tool')?.content ?? '');
}

test('deny 判定：工具不执行，返回 POLICY_DENY', async () => {
  const { session, ran } = setup({
    script: [
      mockToolCalls([{ id: 'd1', name: 'spy', args: { command: 'rm -rf /' } }]),
      mockText('好'),
    ],
  });
  const result = await runTurn(session, '跑');
  assert.equal(result.kind, 'final');
  assert.equal(ran(), 0); // 从未执行
  const msg = JSON.parse(firstToolMsg(session)) as { ok: boolean; error?: { code: string; message: string } };
  assert.equal(msg.ok, false);
  assert.equal(msg.error?.code, 'POLICY_DENY');
  assert.match(msg.error!.message, /禁止递归删除根目录/);
});

test('ask 判定 + 审批拒绝：不执行，APPROVAL_DENIED；approval.request/result 事件成对', async () => {
  const { session, ran, events } = setup({
    script: [
      mockToolCalls([{ id: 'a1', name: 'spy', args: { command: 'npm install x' } }]),
      mockText('好'),
    ],
    askApproval: async () => 'deny',
  });
  const result = await runTurn(session, '跑');
  assert.equal(result.kind, 'final');
  assert.equal(ran(), 0);
  assert.ok(events.some((e) => e.type === 'approval.request'));
  assert.ok(events.some((e) => e.type === 'approval.result' && (e as { granted: boolean }).granted === false));
  const msg = JSON.parse(firstToolMsg(session)) as { error?: { code: string } };
  assert.equal(msg.error?.code, 'APPROVAL_DENIED');
});

test('ask 判定 + 审批通过：执行成功', async () => {
  const { session, ran } = setup({
    script: [
      mockToolCalls([{ id: 'a2', name: 'spy', args: { command: 'npm install x' } }]),
      mockText('好'),
    ],
    askApproval: async () => 'allow',
  });
  const result = await runTurn(session, '跑');
  assert.equal(result.kind, 'final');
  assert.equal(ran(), 1);
  const msg = JSON.parse(firstToolMsg(session)) as { ok: boolean };
  assert.equal(msg.ok, true);
});

test('无审批通道：ask 视为拒绝（默认安全）', async () => {
  const { session, ran } = setup({
    script: [
      mockToolCalls([{ id: 'a3', name: 'spy', args: { command: 'npm install x' } }]),
      mockText('好'),
    ],
  });
  const result = await runTurn(session, '跑');
  assert.equal(result.kind, 'final');
  assert.equal(ran(), 0);
});

// ---------- hooks 生产守卫：被拦下时"为什么"要回到模型 ----------

test('PreToolUse 守卫（exit 2）：工具不执行，且守卫说的人话进 HOOK_BLOCKED', async () => {
  const dir = tmpdir();
  const guard = path.join(dir, 'guard.sh');
  fs.writeFileSync(guard, '#!/bin/sh\ncat > /dev/null\necho "保留区：这条命令我不碰"\nexit 2\n');
  const { session, ran, events } = setup({
    script: [
      mockToolCalls([{ id: 'h1', name: 'bash', args: { command: 'cp evil.sh .git/hooks/pre-commit' } }]),
      mockText('好'),
    ],
    toolName: 'bash', // 生产那条 matcher 就是 `tool:bash:*`，这里要用真名字才测得到它
  });
  session.config.hooks.PreToolUse = [{ matcher: 'tool:bash:*', command: `sh ${guard}` }];

  const result = await runTurn(session, '跑');
  assert.equal(result.kind, 'final');
  assert.equal(ran(), 0, '被守卫拦下的命令不许执行');
  assert.ok(events.some((e) => e.type === 'hook' && (e as { exit: number }).exit === 2), 'hook 事件要留在事件流里');
  const msg = JSON.parse(firstToolMsg(session)) as { ok: boolean; error?: { code: string; message: string } };
  assert.equal(msg.ok, false);
  assert.equal(msg.error?.code, 'HOOK_BLOCKED');
  // 只说"被 hook 阻止"等于让模型猜，要把守卫那句人话带回来
  assert.match(msg.error!.message, /保留区：这条命令我不碰/);
});

// ---------- 作用域「到这次对话结束都允许」 ----------
// 三条纪律：① 只在内存（会话级）② 覆盖范围 = 同工具 + 同判据 + **风险不更高** ③ **R5 永远不覆盖**

test('作用域：答"到对话结束"之后，同类不再问；但更危险的一档照样问', async () => {
  const { session, ran, events } = setup({
    script: [
      mockToolCalls([{ id: 's1', name: 'spy', args: { command: 'npm install a' } }]),
      mockText('好'),
      mockToolCalls([{ id: 's2', name: 'spy', args: { command: 'npm install b' } }]),
      mockText('好'),
    ],
    // 第一次给"到对话结束"，之后就算宿主还想问，也不该再走到审批通道
    askApproval: async () => 'allow-session',
  });
  await runTurn(session, '装个东西');
  const askedFirst = events.filter((e) => e.type === 'approval.request').length;
  assert.equal(askedFirst, 1, '第一次该问');
  assert.equal(session.sessionGrants.length, 1, '应当记下一条会话授权');
  assert.equal(session.sessionGrants[0]!.tool, 'spy');

  await runTurn(session, '再装一个');
  assert.equal(events.filter((e) => e.type === 'approval.request').length, 1, '第二次**不该再问**（被会话授权覆盖）');
  const grants = events.filter((e) => e.type === 'approval.result' && (e as { by?: string }).by === 'session-grant');
  assert.equal(grants.length, 1, '覆盖放行要如实留痕（by=session-grant），不能与"用户点的头"混成一回事');
  assert.equal(ran(), 2, '两次都该真的执行');
});

test('作用域：R5（不可逆）永远不给会话授权——记了也不生效', async () => {
  const { session } = setup({
    script: [mockToolCalls([{ id: 'r1', name: 'app', args: { action: 'run', script: 'return 1' } }]), mockText('好')],
    permissions: { app: { mode: 'trusted', whitelist: [] } },
    askApproval: async () => 'allow-session',
  });
  await runTurn(session, '跑个脚本');
  // app.run 是 R5：即便宿主回了 allow-session，也不许落成会话授权
  assert.equal(session.sessionGrants.length, 0, 'R5 不许进会话授权表');
  assert.equal(session.grantCovers('app', 'app-high-risk', 'R5'), false, 'R5 永远不被覆盖');
});

test('作用域：只覆盖"同一个工具 + 同一条判据"，换个工具不算数', async () => {
  const { session } = setup({
    script: [mockToolCalls([{ id: 'x1', name: 'spy', args: { command: 'npm i a' } }]), mockText('好')],
    askApproval: async () => 'allow-session',
  });
  await runTurn(session, '装');
  assert.equal(session.grantCovers('spy', 'default:bash', 'R2'), true, '同工具同判据同风险：覆盖');
  assert.equal(session.grantCovers('bash', 'default:bash', 'R2'), false, '换个工具：不覆盖');
  assert.equal(session.grantCovers('spy', 'r3', 'R2'), false, '换个判据：不覆盖');
  assert.equal(session.grantCovers('spy', 'default:bash', 'R4'), false, '风险更高：不覆盖（更危险的照样问）');
});

/* ---------- 带 key 的会话授权（按文件给，不按"这一类"给） ---------- */
test('会话授权带 key：同一份文件覆盖，换一份文件照样问', () => {
  // 直接建一个够用的 Session（这条只测授权表，不跑回合）
  const { session } = setup({ script: [mockToolCalls([{ id: 'c1', name: 'spy', args: {} }])] });
  session.addSessionGrant({ tool: 'read', ruleId: 'outside-source-read', risk: 'R2', key: 'read:/Users/demo/Downloads/a.docx' });
  assert.equal(session.grantCovers('read', 'outside-source-read', 'R2', 'read:/Users/demo/Downloads/a.docx'), true, '同一份文件：覆盖');
  assert.equal(session.grantCovers('read', 'outside-source-read', 'R2', 'read:/Users/demo/Downloads/b.docx'), false, '换一份：不覆盖（那是另一份别人的字）');
  // 没带 key 的老授权行为不变（覆盖同一工具+判据的所有调用）
  session.addSessionGrant({ tool: 'spy', ruleId: 'default:bash', risk: 'R3' });
  assert.equal(session.grantCovers('spy', 'default:bash', 'R2'), true);
  assert.equal(session.grantCovers('spy', 'default:bash', 'R2', 'read:/x'), false, '带 key 去查没带 key 的授权：不覆盖');
});
