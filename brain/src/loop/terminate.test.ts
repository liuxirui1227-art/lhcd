// 终止条件：四个出口各自真的能停下来——一轮累计烧了多少 token、这一轮干了多久、
// 用户一直不回审批、模型对着策略墙反复撞。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createNodeRuntime } from '../runtime/node.js';
import { MockProvider, mockText, mockToolCalls } from '../llm/adapters/mock.js';
import { Session } from './session.js';
import { runTurn } from './turn.js';
import { ToolRegistry } from '../tools/registry.js';
import { readTool } from '../tools/read.js';
import { loadConfig } from '../config/load.js';

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'brain-term-'));
}

interface Opts {
  script: ReturnType<typeof mockText>[];
  budget?: Record<string, unknown>;
  policy?: unknown;
  askApproval?: (req: unknown) => Promise<'allow' | 'deny'>;
  usage?: Record<string, number>;
}

function setup(o: Opts) {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, 'a.txt'), 'x\n');
  const rt = createNodeRuntime({
    cwd: dir,
    storage: { sessionsDir: `${dir}/s`, logsDir: `${dir}/l`, memoryDir: `${dir}/m`, configDir: `${dir}/c` },
  });
  const registry = new ToolRegistry();
  registry.register(readTool());
  const config = loadConfig({ cwd: dir, home: dir, cli: o.budget ? { budget: o.budget } : undefined });
  const provider = new MockProvider({ script: o.script, ...(o.usage ? { usage: o.usage } : {}) });
  const session = new Session({
    cwd: dir, config, provider, runtime: rt, registry, system: 't',
    ...(o.policy ? { policy: o.policy as never } : {}),
    ...(o.askApproval ? { askApproval: o.askApproval as never } : {}),
  });
  return { session };
}

const call = (i: number) => mockToolCalls([{ id: `c${i}`, name: 'read', args: { path: 'a.txt' } }]);

test('出口⑤累计 token：一轮烧过上限就停（此前有数没闸）', async () => {
  const { session } = setup({
    script: [call(1), mockText('完事')],
    usage: { inTokens: 500, outTokens: 500 },
    budget: { maxTurnTokens: 800 },
  });
  const r = await runTurn(session, '干活');
  assert.equal(r.kind, 'limit');
  assert.equal((r as { reason: string }).reason, 'maxTokens');
});

test('出口⑥墙钟：干太久停下（此前 runTurn 全程不读时钟）', async () => {
  // 预算检查在每轮**末尾**（= 下一轮的门），所以脚本要让模型一直调工具——
  // 否则它会先正常收尾（'final'），根本走不到闸门。
  const { session } = setup({
    script: [call(1), call(2), call(3), mockText('完事')],
    budget: { maxTurnMs: 0 }, // 0ms：第一轮末尾必然已超（确定性，不靠"跑得慢"）
  });
  const r = await runTurn(session, '干活');
  assert.equal(r.kind, 'limit');
  assert.equal((r as { reason: string }).reason, 'maxRuntime');
});

test('出口⑦等审批：用户不在时到点自收场（不再无限挂着）', async () => {
  const { session } = setup({
    script: [call(1), mockText('完事')],
    budget: { approvalWaitMs: 50 },
    policy: { check: () => ({ action: 'ask', ruleId: 'r1' }) },
    askApproval: () => new Promise(() => { /* 永远不回 */ }) as Promise<'allow' | 'deny'>,
  });
  const t0 = Date.now();
  const r = await runTurn(session, '干活');
  assert.ok(Date.now() - t0 < 5000, '不该真的等到天荒地老');
  assert.equal(r.kind, 'limit');
  assert.equal((r as { reason: string }).reason, 'waitingUser');
});

test('出口④策略连续硬拒：同一件事被拒 3 次就停（别撞墙烧钱）', async () => {
  const { session } = setup({
    script: [call(1), call(2), call(3), mockText('完事')],
    policy: { check: () => ({ action: 'deny', ruleId: 'r-deny', warning: '不行' }) },
  });
  const r = await runTurn(session, '干活');
  assert.equal(r.kind, 'limit');
  assert.equal((r as { reason: string }).reason, 'policy');
});
