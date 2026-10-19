// 成本核算（DeepSeek 峰谷价扩展）。
// cost = hit/1e6×hit + miss/1e6×miss + out/1e6×out + reasoning/1e6×(reasoning||out)
// DeepSeek 峰谷分时计价（北京时间）：高峰 = 每日 9:00–12:00 与 14:00–18:00，
// 输入缓存命中价 ×2（hitPeak，缺省 hit×2）、未命中价 ×2（missPeak，缺省 miss×2）。

import type { PricingCfg } from '../config/schema.js';
import type { Usage } from './provider.js';

const PEAK_WINDOWS: Array<[number, number]> = [[9, 12], [14, 18]]; // 北京时间（含起点，不含终点）

/** 取日期在指定时区的墙钟小时（Intl 标准 API，零依赖） */
export function hourInTimezone(date: Date, timeZone = 'Asia/Shanghai'): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: '2-digit',
    hourCycle: 'h23',
    minute: '2-digit',
  }).formatToParts(date);
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
  return Number.isFinite(hour) ? hour : 0;
}

/** 是否高峰时段（北京时间 9:00–12:00 / 14:00–18:00） */
export function isPeakTime(date: Date): boolean {
  const h = hourInTimezone(date);
  return PEAK_WINDOWS.some(([start, end]) => h >= start && h < end);
}

/** 兼容旧名（isPeakHour → isPeakTime） */
export const isPeakHour = isPeakTime;

/** 缓存命中输入单价：高峰 hitPeak，缺省 hit×2 */
export function hitPrice(pricing: PricingCfg, date: Date): number {
  if (isPeakTime(date)) return pricing.hitPeak ?? pricing.hit * 2;
  return pricing.hit;
}

/** 未命中输入单价：高峰 missPeak，缺省 miss×2 */
export function missPrice(pricing: PricingCfg, date: Date): number {
  if (isPeakTime(date)) return pricing.missPeak ?? pricing.miss * 2;
  return pricing.miss;
}

export interface UsageParts {
  hitTokens: number;
  missTokens: number;
  outTokens: number;
  reasoningTokens?: number;
}

export function makeUsage(parts: UsageParts, pricing: PricingCfg, date: Date): Usage {
  const hit = parts.hitTokens;
  const miss = parts.missTokens;
  const out = parts.outTokens;
  const reasoning = parts.reasoningTokens ?? 0;
  const costUsd =
    (hit / 1e6) * hitPrice(pricing, date) +
    (miss / 1e6) * missPrice(pricing, date) +
    (out / 1e6) * pricing.out +
    (reasoning / 1e6) * (pricing.reasoning ?? pricing.out);
  return {
    inTokens: hit + miss,
    hitTokens: hit,
    missTokens: miss,
    outTokens: out,
    reasoningTokens: reasoning,
    costUsd: round4(costUsd),
  };
}

function round4(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

/** 无 usage 字段时的零成本兜底（TODO(spec)：缺 usage 时按 token 估算补全） */
export function zeroUsage(): Usage {
  return { inTokens: 0, hitTokens: 0, missTokens: 0, outTokens: 0, reasoningTokens: 0, costUsd: 0 };
}
