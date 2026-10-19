// 成本核算公式 + DeepSeek 峰谷价规则（北京时间 9:00–12:00 / 14:00–18:00）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPeakTime, hourInTimezone, hitPrice, missPrice, makeUsage } from './usage.js';
import type { PricingCfg } from '../config/schema.js';

const pricing: PricingCfg = { hit: 0.05, hitPeak: 0.10, miss: 1.5, missPeak: 3.0, out: 4.5 };

// 北京时间 = UTC+8（测试用 UTC 构造，保证任何机器时区下结果一致）
const bj = (h: number, m = 0) => new Date(Date.UTC(2026, 7, 21, h - 8, m));

test('hourInTimezone：机器时区无关地取北京时间墙钟小时', () => {
  assert.equal(hourInTimezone(new Date(Date.UTC(2026, 7, 21, 1, 0))), 9);  // 01:00 UTC = 09:00 北京
  assert.equal(hourInTimezone(new Date(Date.UTC(2026, 7, 21, 16, 30))), 0); // 16:30 UTC = 00:30 北京（次日）
});

test('isPeakTime：高峰 = 北京 9:00–12:00 与 14:00–18:00（含起点不含终点）', () => {
  assert.equal(isPeakTime(bj(9, 0)), true);
  assert.equal(isPeakTime(bj(10, 30)), true);
  assert.equal(isPeakTime(bj(11, 59)), true);
  assert.equal(isPeakTime(bj(12, 0)), false);   // 12:00 起空闲
  assert.equal(isPeakTime(bj(13, 59)), false);
  assert.equal(isPeakTime(bj(14, 0)), true);
  assert.equal(isPeakTime(bj(17, 59)), true);
  assert.equal(isPeakTime(bj(18, 0)), false);   // 18:00 起空闲
  assert.equal(isPeakTime(bj(8, 59)), false);
  assert.equal(isPeakTime(bj(0, 30)), false);
});

test('missPrice：高峰用 missPeak，缺省 ×2', () => {
  assert.equal(missPrice(pricing, bj(9, 0)), 3.0);
  assert.equal(missPrice(pricing, bj(12, 0)), 1.5);
  assert.equal(missPrice({ hit: 0.05, miss: 1.5, out: 4.5 }, bj(16, 0)), 3.0);
});

test('hitPrice：高峰缓存命中价也 ×2（官方 flash/pro 均为 2 倍关系）', () => {
  assert.equal(hitPrice(pricing, bj(9, 0)), 0.10);
  assert.equal(hitPrice(pricing, bj(12, 30)), 0.05);
  assert.equal(hitPrice({ hit: 0.05, miss: 1.5, out: 4.5 }, bj(16, 0)), 0.10); // 缺省 hitPeak → hit×2
});

test('成本公式：hit/miss/out/reasoning（reasoning 缺省按 out 计）', () => {
  const u = makeUsage(
    { hitTokens: 1000, missTokens: 200, outTokens: 300, reasoningTokens: 50 },
    pricing,
    bj(12, 30), // 空闲时段
  );
  assert.equal(u.inTokens, 1200);
  assert.equal(u.hitTokens, 1000);
  const expected = (1000 * 0.05 + 200 * 1.5 + 300 * 4.5 + 50 * 4.5) / 1e6;
  assert.equal(u.costUsd, expected);
});

test('成本公式：高峰时段 hit/miss 都按峰值计', () => {
  const u = makeUsage(
    { hitTokens: 1000, missTokens: 200, outTokens: 300, reasoningTokens: 0 },
    pricing,
    bj(10, 0), // 高峰时段
  );
  const expected = (1000 * 0.10 + 200 * 3.0 + 300 * 4.5) / 1e6;
  assert.equal(u.costUsd, expected);
});

test('Pro 档记账：pricingReasoner（out=13.5）整档单价更高', () => {
  const pro: PricingCfg = { hit: 0.15, hitPeak: 0.30, miss: 4.5, missPeak: 9.0, out: 13.5 };
  const u = makeUsage(
    { hitTokens: 1000, missTokens: 200, outTokens: 300, reasoningTokens: 500 },
    pro,
    bj(12, 30), // 空闲时段
  );
  const expected = (1000 * 0.15 + 200 * 4.5 + 300 * 13.5 + 500 * 13.5) / 1e6;
  assert.equal(u.costUsd, expected);
});
