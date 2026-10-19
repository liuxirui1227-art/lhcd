// 失败分类与恢复——分类表 + 三条纪律（用户叫停不重来 / 动过手不重来 / 一轮只重来一次）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyTurnFailure, planRecovery, userMessageFor, type FailureFacts, type RecoveryKind } from './recovery.js';

test('分类：limit 的三个原因各归各（原先 maxCost/maxIterations 全落 unknown——账本据此什么都没做）', () => {
  assert.equal(classifyTurnFailure({ kind: 'limit', reason: 'maxCost' }), 'budget');
  assert.equal(classifyTurnFailure({ kind: 'limit', reason: 'maxContext' }), 'context');
  assert.equal(classifyTurnFailure({ kind: 'limit', reason: 'maxIterations' }), 'loop');
  // 其余四个 limit 出口（每个都要有归属，不能落 unknown）
  assert.equal(classifyTurnFailure({ kind: 'limit', reason: 'maxTokens' }), 'budget');
  assert.equal(classifyTurnFailure({ kind: 'limit', reason: 'maxRuntime' }), 'loop');
  assert.equal(classifyTurnFailure({ kind: 'limit', reason: 'waitingUser' }), 'permission');
  assert.equal(classifyTurnFailure({ kind: 'limit', reason: 'policy' }), 'permission');
});

test('分类：先判具体再判宽泛——"permission denied" 不该被网络正则吞掉', () => {
  assert.equal(classifyTurnFailure({ kind: 'error', message: 'bash 被拒：POLICY_DENY 风险过高' }), 'permission');
  assert.equal(classifyTurnFailure({ kind: 'error', message: 'EACCES: permission denied' }), 'env');
  assert.equal(classifyTurnFailure({ kind: 'error', message: 'ENOENT: no such file' }), 'env');
  assert.equal(classifyTurnFailure({ kind: 'error', message: 'BAD_SCHEMA 参数不符' }), 'bad_args');
  assert.equal(classifyTurnFailure({ kind: 'error', message: 'HTTP 401 invalid key' }), 'auth');
  assert.equal(classifyTurnFailure({ kind: 'error', message: '429 rate limit' }), 'usage');
  assert.equal(classifyTurnFailure({ kind: 'error', message: '网络错误（重试 3 次后放弃）' }), 'transient');
  assert.equal(classifyTurnFailure({ kind: 'error', message: '莫名其妙' }), 'unknown');
});

test('纪律①：用户叫停绝不自动重来（那不是故障，是人的意志）', () => {
  const p = planRecovery({ kind: 'aborted', toolsUsed: 0 });
  assert.equal(p.auto, false);
  assert.ok(p.why.includes('用户叫停'));
});

test('纪律②：本回合动过手就不自动重来（怕重复副作用）→ 停下来报清楚', () => {
  const p = planRecovery({ kind: 'error', message: '网络错误', toolsUsed: 3 });
  assert.equal(p.kind, 'transient');
  assert.equal(p.auto, false);
  assert.equal(p.action, 'escalate');
  assert.ok(p.why.includes('动过工具'));
  assert.ok(p.userMessage.includes('没成'));
});

test('纪律③：一轮只自动重来一次（重来过之后同样停下）', () => {
  const first = planRecovery({ kind: 'error', message: '网络错误', toolsUsed: 0 });
  assert.equal(first.auto, true);
  assert.equal(first.action, 'retry');
  assert.ok(first.note.includes('[自动重试]'));
  const second = planRecovery({ kind: 'error', message: '网络错误', toolsUsed: 0, retried: true });
  assert.equal(second.auto, false);
  assert.ok(second.why.includes('已经重来过'));
});

test('三种自愈各有各的招：网络→重试 / 参数错→修参数 / 打转→换法子', () => {
  assert.equal(planRecovery({ kind: 'error', message: '网络错误', toolsUsed: 0 }).action, 'retry');
  const repair = planRecovery({ kind: 'error', message: 'BAD_ARGS 参数不合法', toolsUsed: 0 });
  assert.equal(repair.action, 'repair');
  assert.ok(repair.note.includes('先 read 看清真实内容'));
  const replan = planRecovery({ kind: 'limit', reason: 'maxIterations', toolsUsed: 0 });
  assert.equal(replan.action, 'replan');
  assert.ok(replan.note.includes('换一个思路'));
});

test('不可自愈的处境：不重来，但人话说清"卡在哪 + 要你做什么"', () => {
  const cases: Array<[FailureFacts, RecoveryKind]> = [
    [{ kind: 'limit', reason: 'maxCost' }, 'budget'],
    [{ kind: 'error', message: 'HTTP 401 invalid key' }, 'auth'],
    [{ kind: 'error', message: '审批未通过' }, 'permission'],
    [{ kind: 'error', message: 'ENOENT: no such file' }, 'env'],
    [{ kind: 'error', message: '429 rate limit' }, 'usage'],
  ];
  for (const [facts, kind] of cases) {
    const p = planRecovery({ ...facts, toolsUsed: 0 });
    assert.equal(p.kind, kind);
    assert.equal(p.auto, false);
    assert.ok(p.userMessage.length > 10, `${kind} 要有人说话`);
  }
  assert.ok(userMessageFor('auth').includes('钥匙'));
  assert.ok(userMessageFor('permission').includes('批准'));
});
