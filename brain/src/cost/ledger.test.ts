// 成本账本 + 缓存未命中归因单测。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createNodeRuntime } from '../runtime/node.js';
import {
  CostLedger, priceUsage, rowFromUsage, detectCacheMiss, explainCacheMiss,
  CACHE_TTL_MS, NOISE_FLOOR_TOKENS, type UsageRow,
} from './ledger.js';
import type { PricingCfg } from '../config/schema.js';

const PRICING: PricingCfg = { hit: 0.05, miss: 1.5, out: 4.5 };

function row(over: Partial<UsageRow> = {}): UsageRow {
  return {
    at: 1_000_000, sessionId: 's', provider: 'deepseek', model: 'deepseek-chat', role: 'main',
    inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cacheWrite1hTokens: 0,
    outTokens: 0, reasoningTokens: 0, cost: 0,
    breakdown: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    ...over,
  };
}

test('计价①：阶梯档按 input+cacheRead+cacheWrite 总量选「门槛最高且低于总量」的那档（pi models.ts:891-909）', () => {
  const tiered: PricingCfg = {
    hit: 0.05, miss: 1.5, out: 4.5,
    tiers: [
      { inputTokensAbove: 32_000, hit: 0.1, miss: 3.0, out: 9.0 },
      { inputTokensAbove: 128_000, hit: 0.2, miss: 6.0, out: 18.0 },
    ],
  };
  // 总量 40k：命中 32k 档（不是只看 input 的 8k）
  const b1 = priceUsage(tiered, { inputTokens: 8_000, cacheReadTokens: 32_000, cacheWriteTokens: 0, cacheWrite1hTokens: 0, outTokens: 0, reasoningTokens: 0 });
  assert.equal(Number(b1.input.toFixed(6)), Number(((8_000 / 1e6) * 3.0).toFixed(6)));
  assert.equal(Number(b1.cacheRead.toFixed(6)), Number(((32_000 / 1e6) * 0.1).toFixed(6)));
  // 总量 130k → 命中最高档；总量 20k → 保持基础档
  const b2 = priceUsage(tiered, { inputTokens: 130_000, cacheReadTokens: 0, cacheWriteTokens: 0, cacheWrite1hTokens: 0, outTokens: 0, reasoningTokens: 0 });
  assert.equal(Number(b2.input.toFixed(6)), Number(((130_000 / 1e6) * 6.0).toFixed(6)));
  const b3 = priceUsage(tiered, { inputTokens: 20_000, cacheReadTokens: 0, cacheWriteTokens: 0, cacheWrite1hTokens: 0, outTokens: 0, reasoningTokens: 0 });
  assert.equal(Number(b3.input.toFixed(6)), Number(((20_000 / 1e6) * 1.5).toFixed(6)));
});

test('计价②：1 小时缓存写按 2×input 价计（最常算错的一条）', () => {
  const b = priceUsage(PRICING, { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 10_000, cacheWrite1hTokens: 10_000, outTokens: 0, reasoningTokens: 0 });
  assert.equal(Number(b.cacheWrite.toFixed(6)), Number(((10_000 / 1e6) * 1.5 * 2).toFixed(6)));
  // 短写按 cacheWrite 价（缺省 = miss 价）
  const b2 = priceUsage(PRICING, { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 10_000, cacheWrite1hTokens: 0, outTokens: 0, reasoningTokens: 0 });
  assert.equal(Number(b2.cacheWrite.toFixed(6)), Number(((10_000 / 1e6) * 1.5).toFixed(6)));
});

test('账本行：四项分项成本算清（思考 token 按 reasoning 价，缺省按 out）', () => {
  const r = rowFromUsage({
    usage: { inTokens: 10_000, hitTokens: 8_000, missTokens: 2_000, outTokens: 1_000, reasoningTokens: 500, costUsd: 0 },
    provider: 'deepseek', model: 'deepseek-reasoner', role: 'reasoner', sessionId: 's', at: 1, pricing: PRICING,
  });
  assert.equal(r.inputTokens, 2_000);
  assert.equal(r.cacheReadTokens, 8_000);
  assert.equal(Number(r.breakdown.input.toFixed(6)), Number(((2_000 / 1e6) * 1.5).toFixed(6)));
  assert.equal(Number(r.breakdown.cacheRead.toFixed(6)), Number(((8_000 / 1e6) * 0.05).toFixed(6)));
  assert.equal(Number(r.breakdown.output.toFixed(6)), Number((((1_000 + 500) / 1e6) * 4.5).toFixed(6)));
  assert.ok(r.cost > 0);
});

test('归因：空闲超 5 分钟 → 说「缓存过期」，并算出多花的钱', () => {
  const prev = row({ at: 0, inputTokens: 500, cacheReadTokens: 9_500, breakdown: { input: (500 / 1e6) * 1.5, output: 0, cacheRead: (9_500 / 1e6) * 0.05, cacheWrite: 0 } });
  const cur = row({
    at: CACHE_TTL_MS + 60_000, inputTokens: 9_000, cacheReadTokens: 1_000,
    breakdown: { input: (9_000 / 1e6) * 1.5, output: 0, cacheRead: (1_000 / 1e6) * 0.05, cacheWrite: 0 },
  });
  const miss = detectCacheMiss(prev, cur);
  assert.ok(miss, '应该检测到未命中');
  assert.equal(miss!.idleMs, CACHE_TTL_MS + 60_000);
  assert.equal(miss!.modelChanged, false);
  assert.ok(miss!.missedTokens > NOISE_FLOOR_TOKENS);
  assert.ok(miss!.missedCost > 0);
  assert.match(explainCacheMiss(miss!, (n) => `${n.toFixed(4)} 元`), /缓存.*过期|超过了缓存有效期/);
});

test('归因：噪声地板 —— 未命中不到 1024 token 不算（免得天天报"浪费"）', () => {
  const prev = row({ at: 0, inputTokens: 500, cacheReadTokens: 9_500 });
  const cur = row({ at: 60_000, inputTokens: 500, cacheReadTokens: 9_500 }); // 只差 500
  assert.equal(detectCacheMiss(prev, cur), undefined);
});

test('归因：中途换模型 → 不算"浪费"，说清是必要开销', () => {
  const prev = row({ at: 0, provider: 'deepseek', model: 'deepseek-chat', inputTokens: 0, cacheReadTokens: 10_000 });
  const cur = row({
    at: 60_000, provider: 'qwen', model: 'qwen3-vl-plus', inputTokens: 9_000, cacheReadTokens: 0,
    breakdown: { input: (9_000 / 1e6) * 1.4, output: 0, cacheRead: 0, cacheWrite: 0 },
  });
  const miss = detectCacheMiss(prev, cur);
  assert.ok(miss?.modelChanged);
  assert.match(explainCacheMiss(miss!, (n) => String(n)), /换了模型/);
});

test('归因：首轮/没有可比上一轮 → 不报（别把正常开销说成浪费）', () => {
  assert.equal(detectCacheMiss(undefined, row({ inputTokens: 5_000 })), undefined);
  // 供应商压根不报缓存活动（cacheRead/cacheWrite 全 0 且上一行也没报过）
  const a = row({ at: 0, inputTokens: 5_000 });
  const b = row({ at: 60_000, inputTokens: 5_000 });
  assert.equal(detectCacheMiss(a, b), undefined);
});

test('账本：append-only 落盘 + 重新加载 + 分桶（角色/模型）+ 缓存省下的钱', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-cost-'));
  const rt = createNodeRuntime({ cwd: dir, storage: { sessionsDir: `${dir}/s`, logsDir: `${dir}/l`, memoryDir: `${dir}/m`, configDir: `${dir}/c` } });
  const file = `${dir}/cost/ledger.jsonl`;
  const led = new CostLedger(rt, file);
  await led.load();
  await led.append(rowFromUsage({ usage: { inTokens: 10_000, hitTokens: 9_000, missTokens: 1_000, outTokens: 500, reasoningTokens: 0, costUsd: 0 }, provider: 'deepseek', model: 'deepseek-chat', role: 'main', sessionId: 's', at: 1, pricing: PRICING }));
  await led.append(rowFromUsage({ usage: { inTokens: 3_000, hitTokens: 0, missTokens: 3_000, outTokens: 300, reasoningTokens: 0, costUsd: 0 }, provider: 'deepseek', model: 'deepseek-chat', role: 'compact', sessionId: 's', at: 2, pricing: PRICING }));

  // 重新加载（模拟重启）
  const led2 = new CostLedger(rt, file);
  await led2.load();
  assert.equal(led2.size(), 2);
  const t = led2.totals();
  assert.equal(t.calls, 2);
  assert.ok(t.cost > 0);
  assert.equal(t.byRole.main!.calls, 1);
  assert.equal(t.byRole.compact!.calls, 1, '压缩摘要单独一桶');
  assert.ok(t.cacheSaved > 0, '命中缓存省下的钱应被算出来');
  assert.ok(fs.readFileSync(file, 'utf8').trim().split('\n').length === 2, '一行一个 JSON');
});

test('账本：按天/月取 + 事后校正（append-only，不原地改）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-cost2-'));
  const rt = createNodeRuntime({ cwd: dir, storage: { sessionsDir: `${dir}/s`, logsDir: `${dir}/l`, memoryDir: `${dir}/m`, configDir: `${dir}/c` } });
  const led = new CostLedger(rt, `${dir}/cost/ledger.jsonl`);
  await led.load();
  const day1 = Date.UTC(2026, 8, 17, 12);
  const day2 = Date.UTC(2026, 8, 18, 12);
  await led.append(row({ at: day1, cost: 1.2 }));
  await led.append(row({ at: day2, cost: 0.8 }));
  assert.equal(led.rowsBetween(0, day2).length, 1);
  assert.equal(Number(led.totals(led.rowsBetween(day2, day2 + 86_400_000)).cost.toFixed(2)), 0.8);
  await led.adjust({ at: day1 }, 0.3, '价目表补录：Pro 档差价');
  assert.equal(Number(led.totals(led.rowsBetween(0, day2)).cost.toFixed(2)), 1.5);
});

test('纯函数：金额格式化与"这一行为谁花的"角色覆盖', () => {
  const roles: Array<Parameters<typeof rowFromUsage>[0]['role']> = ['main', 'reasoner', 'compact', 'fast', 'subagent', 'digest'];
  for (const role of roles) {
    const r = rowFromUsage({ usage: { inTokens: 1, hitTokens: 0, missTokens: 1, outTokens: 1, reasoningTokens: 0, costUsd: 0 }, provider: 'p', model: 'm', role, sessionId: 's', at: 1, pricing: PRICING });
    assert.equal(r.role, role);
  }
});
