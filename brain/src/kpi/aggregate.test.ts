// KPI 日聚合单测：五个数字每个都要能用账本/事件流**手工复算对上**——
// 所以这里的用例都是**手算好写死的**（不是跑一遍代码再把结果抄进来）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeKpiDay, taskFinalizedOn, formatKpiDay } from './aggregate.js';

const DAY = '2026-09-26';

test('任务成功率：cancelled **不算失败也不算成功**（用户自己叫停的，不冤枉她）', () => {
  const k = computeKpiDay({
    day: DAY, spentUsd: 1.2,
    tasks: [
      { state: 'completed', completedAt: `${DAY}T10:00:00+08:00` },
      { state: 'completed', completedAt: `${DAY}T11:00:00+08:00` },
      { state: 'failed', completedAt: `${DAY}T12:00:00+08:00` },
      { state: 'cancelled', completedAt: `${DAY}T13:00:00+08:00` },
      { state: 'running', updatedAt: `${DAY}T14:00:00+08:00` },      // 还没收，不算
      { state: 'failed', completedAt: '2026-09-25T23:00:00+08:00' }, // 昨天的，不算
    ],
    events: [],
  });
  assert.equal(k.tasks.completed, 2);
  assert.equal(k.tasks.failed, 1);
  assert.equal(k.tasks.cancelled, 1);
  assert.equal(k.tasks.total, 3, '分母 = 完成 2 + 失败 1（不含 cancelled、不含没跑的、不含昨天的）');
  assert.ok(Math.abs(k.tasks.rate! - 2 / 3) < 1e-9);
});

test('验证成功率：只数 verify.report 事件；没有就是 null（不是 0%）', () => {
  const none = computeKpiDay({ day: DAY, spentUsd: 0, tasks: [], events: [{ type: 'tool.result', ok: true }] });
  assert.equal(none.verify.rate, null, '没验过 → null，而不是 0%');
  assert.equal(none.verify.total, null);

  const some = computeKpiDay({
    day: DAY, spentUsd: 0, tasks: [],
    events: [
      { type: 'verify.report', passed: true },
      { type: 'verify.report', passed: false },
      { type: 'verify.report', passed: true },
      { type: 'turn.end' },   // 别的类型不掺进来
    ],
  });
  assert.equal(some.verify.hit, 2);
  assert.equal(some.verify.total, 3);
  assert.ok(Math.abs(some.verify.rate! - 2 / 3) < 1e-9);
});

test('恢复成功率：分母是"重来过几次"，分子是"重来之后成了几次"', () => {
  const k = computeKpiDay({
    day: DAY, spentUsd: 0, tasks: [],
    events: [
      { type: 'recovery.plan', recovered: true },
      { type: 'recovery.plan', recovered: true },
      { type: 'recovery.plan', recovered: false },
      { type: 'recovery.plan' },            // 还没回填结果的那次：算进分母（它确实重来过）
      { type: 'recovery.plan', recovered: true },
    ],
  });
  assert.equal(k.recovery.hit, 3);
  assert.equal(k.recovery.total, 5);
  assert.ok(Math.abs(k.recovery.rate! - 0.6) < 1e-9);
});

test('工具效率：失败率与效率互为补数，一次没调就是 null', () => {
  const k = computeKpiDay({
    day: DAY, spentUsd: 0, tasks: [],
    events: [
      { type: 'tool.result', ok: true }, { type: 'tool.result', ok: true },
      { type: 'tool.result', ok: false }, { type: 'tool.result', ok: true },
    ],
  });
  assert.equal(k.tools.calls, 4);
  assert.equal(k.tools.failed, 1);
  assert.equal(k.tools.failRate, 0.25);
  assert.equal(k.tools.efficiency, 0.75);
  const empty = computeKpiDay({ day: DAY, spentUsd: 0, tasks: [], events: [] });
  assert.equal(empty.tools.failRate, null);
  assert.equal(empty.tools.efficiency, null);
});

test('每次成功成本：完成 4 件、花 2 美元 → 0.5 美元一件；一件没成就不给数', () => {
  const tasks = Array.from({ length: 4 }, () => ({ state: 'completed', completedAt: `${DAY}T09:00:00+08:00` }));
  const k = computeKpiDay({ day: DAY, spentUsd: 2, tasks, events: [] });
  assert.equal(k.cost.perSuccessUsd, 0.5);

  const none = computeKpiDay({ day: DAY, spentUsd: 2, tasks: [{ state: 'failed', completedAt: `${DAY}T09:00:00+08:00` }], events: [] });
  assert.equal(none.cost.perSuccessUsd, null, '没有完成任务 → 不给"每次成功成本"（给 0 会被读成"没花钱"）');
  assert.equal(none.cost.spentUsd, 2, '花了多少照实说');
});

test('taskFinalizedOn：终态时间优先，没有就用 updatedAt 兜底；非终态一律不算', () => {
  assert.equal(taskFinalizedOn({ state: 'completed', completedAt: `${DAY}T10:00:00+08:00` }, DAY), true);
  assert.equal(taskFinalizedOn({ state: 'failed', updatedAt: `${DAY}T10:00:00+08:00` }, DAY), true);
  assert.equal(taskFinalizedOn({ state: 'running', updatedAt: `${DAY}T10:00:00+08:00` }, DAY), false);
  assert.equal(taskFinalizedOn({ state: 'completed', completedAt: '2026-09-25T10:00:00+08:00' }, DAY), false);
});

test('formatKpiDay：缺数的地方显示 — 而不是 0（免得"没验过"被读成"验了没过"）', () => {
  const line = formatKpiDay(computeKpiDay({ day: DAY, spentUsd: 0, tasks: [], events: [] }));
  assert.match(line, /任务成功率 —（0\/0）/);
  assert.match(line, /每次成功成本 —/);
});
