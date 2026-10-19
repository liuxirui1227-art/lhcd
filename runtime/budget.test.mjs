// 打扰预算单测：安静时段/跨午夜窗/每日上限/按日重置/配置校验。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lhcd-budget-'));
process.env.LHCD_DATA_DIR = dataDir;
const lib = await import('./lib.mjs');

test('budgetGate：安静时段（跨午夜 23–8）与同日内窗口', () => {
  const b = { quietStart: 23, quietEnd: 8, maxProactivePerDay: 3 };
  const at = (h) => new Date(2026, 7, 22, h, 0, 0);
  assert.equal(lib.budgetGate(b, at(22)).ok, true);      // 22 点可主动
  assert.equal(lib.budgetGate(b, at(23)).reason, 'quiet'); // 23 点安静
  assert.equal(lib.budgetGate(b, at(3)).reason, 'quiet');  // 凌晨安静
  assert.equal(lib.budgetGate(b, at(8)).ok, true);       // 8 点恢复
  // 同日内窗口 13–14
  assert.equal(lib.budgetGate({ quietStart: 13, quietEnd: 14 }, at(13)).reason, 'quiet');
  assert.equal(lib.budgetGate({ quietStart: 13, quietEnd: 14 }, at(14)).ok, true);
  // 相同起止 = 不设安静
  assert.equal(lib.budgetGate({ quietStart: 8, quietEnd: 8 }, at(8)).ok, true);
});

test('budgetGate：每日上限 + 跨日重置', () => {
  const day1 = new Date(2026, 7, 22, 10, 0, 0);
  const day2 = new Date(2026, 7, 23, 10, 0, 0);
  const b = { quietStart: 23, quietEnd: 8, maxProactivePerDay: 2, lastResetDay: '2026-8-22', dailyCount: 2 };
  assert.equal(lib.budgetGate(b, day1).reason, 'daily_cap');
  // 次日自动归零
  assert.equal(lib.budgetGate(b, day2).ok, true);
  assert.equal(lib.budgetGate(b, day2).daily, 0);
  // 上限 0 = 当日禁声
  assert.equal(lib.budgetGate({ ...b, maxProactivePerDay: 0 }, day2).reason, 'daily_cap');
});

test('budgetSpend：计数 + 跨日归零；setInterruptionBudget 校验', () => {
  fs.writeFileSync(path.join(dataDir, 'state.json'), JSON.stringify({ bound: true, interruptionBudget: { quietStart: 23, quietEnd: 8, maxProactivePerDay: 3, lastResetDay: '2026-8-22', dailyCount: 0 } }));
  lib.budgetSpend('proactive');
  lib.budgetSpend('info-sync');
  const after = JSON.parse(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8')).interruptionBudget;
  assert.equal(after.dailyCount, 2);
  assert.equal(after.lastKind, 'info-sync');
  const r1 = lib.setInterruptionBudget({ quietStart: 22, quietEnd: 7, maxProactivePerDay: 5 });
  assert.ok(r1.ok);
  assert.equal(r1.budget.quietStart, 22);
  assert.equal(lib.setInterruptionBudget({ quietStart: 25, quietEnd: 7, maxProactivePerDay: 5 }).ok, false);
  assert.equal(lib.setInterruptionBudget({ quietStart: 22, quietEnd: 7, maxProactivePerDay: 99 }).ok, false);
});
