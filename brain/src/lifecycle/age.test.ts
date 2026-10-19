// 年龄系统单测：纯派生/叙事阶段/曲线插值/里程碑队列。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  birthAgeTierToYears, ageYears, narrativeStage, growthParams, milestoneQueue, milestoneQueueForTier,
} from './age.js';

const DAY = 24 * 3600 * 1000;
const YEAR = 365.25 * DAY;

test('出生年龄档 → 起始年龄（14/20/26，默认 20）', () => {
  assert.equal(birthAgeTierToYears(1), 14);
  assert.equal(birthAgeTierToYears(2), 20);
  assert.equal(birthAgeTierToYears(3), 26);
  assert.equal(birthAgeTierToYears('x'), 20);
});

test('ageYears：纯派生、负差钳 0、含小数', () => {
  const anchor = 1_700_000_000_000;
  assert.equal(ageYears(anchor, anchor + YEAR), 1);
  assert.equal(ageYears(anchor, anchor - 999), 0);
  assert.ok(ageYears(anchor, anchor + YEAR / 2) > 0.49);
});

test('叙事阶段：初生/婴幼/童年/少年/青春期/成年/成熟', () => {
  assert.equal(narrativeStage(0.05).key, 'newborn');
  assert.equal(narrativeStage(0.5).key, 'infant');
  assert.equal(narrativeStage(3).key, 'child');
  assert.equal(narrativeStage(10).key, 'youth');
  assert.equal(narrativeStage(16).key, 'teen');
  assert.equal(narrativeStage(25).key, 'adult');
  assert.equal(narrativeStage(50).key, 'mature');
});

test('成长曲线：单调递增、18 岁收敛到 1、音高随成熟度下降', () => {
  const g0 = growthParams(0);
  const g1 = growthParams(1);
  const g18 = growthParams(18);
  const g60 = growthParams(60);
  assert.ok(g1.maturity > g0.maturity);
  assert.ok(g18.maturity > g1.maturity);
  assert.equal(g18.maturity, 0.95);
  assert.equal(g60.skinGlow, 1);
  assert.ok(g0.voicePitch > g18.voicePitch); // 幼年清亮 → 成年沉稳
});

test('里程碑队列：满月/百日/半岁/周岁/每年生日（未来一年内）', () => {
  const now = 1_700_000_000_000;
  const q = milestoneQueue(now - 10 * DAY, now); // 已出生 10 天
  const ids = q.map((m) => m.id);
  assert.ok(ids.includes('full-moon'));
  assert.ok(ids.includes('hundred-days'));
  assert.ok(ids.includes('half-year'));
  assert.ok(ids.includes('first-birthday'));
  assert.ok(q.every((m) => m.dueAt > now - 30 * DAY)); // 宽限窗口内
  // 10 天龄：满月距今 20 天
  const fullMoon = q.find((m) => m.id === 'full-moon')!;
  assert.ok(Math.abs(fullMoon.dueAt - (now + 20 * DAY)) < 1000);
});

test('成年礼：出生档 1（14 岁）→ 18 周岁触发；成年档不触发', () => {
  const now = 1_700_000_000_000;
  const q1 = milestoneQueueForTier(now, 1, now); // 刚出生，14 岁档
  assert.ok(q1.some((m) => m.id === 'coming-of-age'));
  const q3 = milestoneQueueForTier(now, 3, now); // 26 岁档
  assert.ok(!q3.some((m) => m.id === 'coming-of-age'));
});
