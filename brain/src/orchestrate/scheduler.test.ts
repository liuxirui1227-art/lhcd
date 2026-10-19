// 调度器（主动性 v0）——cron 解析/命中/下一时刻；宽限补跑；>20 分钟跳过；幂等防重。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createNodeRuntime } from '../runtime/node.js';
import { Scheduler, cronMatches, nextCron } from './scheduler.js';

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'brain-sched-'));
}

function makeScheduler() {
  const dir = tmpdir();
  const rt = createNodeRuntime({
    cwd: dir,
    storage: { sessionsDir: `${dir}/s`, logsDir: `${dir}/l`, memoryDir: `${dir}/m`, configDir: dir },
  });
  const sched = new Scheduler(rt, `${dir}/orchestrate/state.json`, [
    { id: 'daily-brief', cron: '30 16 * * 1-5', task: '分析持仓日报' },
  ]);
  return { dir, sched };
}

// 2026-08-24 为周一
const MON_1630 = new Date(2026, 7, 24, 16, 30, 0);

test('cronMatches：5 字段（分 时 日 月 周）', () => {
  assert.equal(cronMatches('30 16 * * 1-5', MON_1630), true);        // 周一 16:30
  assert.equal(cronMatches('30 16 * * 1-5', new Date(2026, 7, 22, 16, 30)), false); // 周六
  assert.equal(cronMatches('30 16 * * 1-5', new Date(2026, 7, 24, 16, 31)), false); // 分钟不符
  assert.equal(cronMatches('*/5 * * * *', new Date(2026, 7, 24, 9, 5)), true);
  assert.equal(cronMatches('*/5 * * * *', new Date(2026, 7, 24, 9, 7)), false);
  assert.equal(cronMatches('0 9,14 * * *', new Date(2026, 7, 24, 14, 0)), true); // 高峰错峰（列表）
  assert.equal(cronMatches('bad cron', MON_1630), false);
});

test('nextCron：下一命中时刻', () => {
  const next = nextCron('30 16 * * 1-5', new Date(2026, 7, 24, 16, 0));
  assert.equal(next?.getTime(), MON_1630.getTime());
  const nextWeek = nextCron('30 16 * * 1-5', new Date(2026, 7, 24, 16, 31));
  assert.equal(nextWeek?.getTime(), new Date(2026, 7, 25, 16, 30).getTime()); // 周二同刻
});

test('到期判定：无记录 + 命中 → due；记录后同 tick 幂等', async () => {
  const { sched } = makeScheduler();
  const due = await sched.dueTasks(MON_1630);
  assert.equal(due.length, 1);
  assert.equal(due[0]!.disposition, 'due');

  await sched.recordRun('daily-brief', MON_1630, 'hash1');
  const again = await sched.dueTasks(MON_1630);
  assert.equal(again.length, 0); // 幂等：不重复
});

test('宽限补跑：错过 ≤20 分钟仍 due；>20 分钟跳过并记录', async () => {
  const { sched } = makeScheduler();
  // 16:40（错过 10 分钟）→ 补跑
  const grace = await sched.dueTasks(new Date(2026, 7, 24, 16, 40, 0));
  assert.equal(grace.length, 1);
  assert.equal(grace[0]!.disposition, 'due');

  // 16:51（错过 21 分钟）→ 跳过
  const skip = await sched.dueTasks(new Date(2026, 7, 24, 16, 51, 0));
  assert.equal(skip.length, 1);
  assert.equal(skip[0]!.disposition, 'overdue-skip');

  // 已记录跳过 → 后续 tick 无动作
  const after = await sched.dueTasks(new Date(2026, 7, 24, 16, 52, 0));
  assert.equal(after.length, 0);
});

test('状态持久化：recordRun 落盘，新实例可读（防重复执行）', async () => {
  const { dir, sched } = makeScheduler();
  await sched.recordRun('daily-brief', MON_1630, 'abc123');
  const rt = createNodeRuntime({
    cwd: dir,
    storage: { sessionsDir: `${dir}/s`, logsDir: `${dir}/l`, memoryDir: `${dir}/m`, configDir: dir },
  });
  const sched2 = new Scheduler(rt, `${dir}/orchestrate/state.json`, [{ id: 'daily-brief', cron: '30 16 * * 1-5', task: 'x' }]);
  const state = await sched2.loadState();
  assert.equal(state.runs['daily-brief']!.lastHash, 'abc123');
  const due = await sched2.dueTasks(MON_1630);
  assert.equal(due.length, 0); // 同窗口不重复
});
