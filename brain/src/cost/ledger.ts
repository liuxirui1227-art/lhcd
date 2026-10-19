// 成本账本 + "这轮为什么突然贵了"。
//
// **这份账完全本地算**（价目表是元数据），一个字节都不往外发。
//
// 三个最容易算错的点：
//   ① 阶梯档按 **(input + cacheRead + cacheWrite) 总量**选"门槛最高且低于总量"的那档——不是只看 input
//   ② 1 小时缓存写按 **2 倍 input 价**计（Anthropic 的计费方式；DeepSeek 自动缓存没这项，字段留 0 即可）
//   ③ 缓存未命中的"浪费"要用**本行自己的付费单价**算，不能拿价目表猜（缓存写有溢价）

import type { Runtime } from '../runtime/types.js';
import type { PricingCfg } from '../config/schema.js';
import type { Usage } from '../llm/provider.js';

/** 这次请求是替谁干活的（分桶用：主体对话 / 深度档 / 压缩 / 轻活 / 子代理 / 记忆提炼） */
export type CostRole = 'main' | 'reasoner' | 'compact' | 'fast' | 'subagent' | 'digest';

export interface CostBucket {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** 一行用量（持久化账本行；带 adjustment 可事后校正） */
export interface UsageRow {
  at: number;
  sessionId: string;
  provider: string;
  model: string;
  role: CostRole;
  /** 未命中缓存的输入（= Usage.missTokens） */
  inputTokens: number;
  /** 命中缓存的输入（= Usage.hitTokens） */
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cacheWrite1hTokens: number;
  outTokens: number;
  reasoningTokens: number;
  cost: number;
  /** 四项分项成本（"这轮为什么贵"要按分项看） */
  breakdown: CostBucket;
  /** 事后校正（如价目表补录后回填差额） */
  adjustment?: { amount: number; note: string };
}

/** 缓存 TTL：距上次请求超过它 → 未命中基本就是"缓存过期" */
export const CACHE_TTL_MS = 5 * 60 * 1000;
/** 噪声地板：未命中不到 1024 token 不算浪费，不报 */
export const NOISE_FLOOR_TOKENS = 1024;
/**
 * **展示门槛**（与噪声地板是两回事）：
 * 未命中到这个量级才值得跟用户提一句——不然天天刷"缓存没命中"没人看。
 */
export const DISPLAY_MIN_MISSED_TOKENS = 20_000;
export const DISPLAY_MIN_MISSED_COST = 0.1;

export function worthMentioning(miss: CacheMiss): boolean {
  return miss.missedTokens >= DISPLAY_MIN_MISSED_TOKENS || miss.missedCost >= DISPLAY_MIN_MISSED_COST;
}

export interface CacheMiss {
  at: number;
  /** 白付了多少 token（本该命中缓存的部分） */
  missedTokens: number;
  /** 多花了多少钱（按本行实际付费单价 − 缓存读单价） */
  missedCost: number;
  /** 距上次请求空闲多久 */
  idleMs: number;
  /** 中途换了模型（换了模型 = 缓存身份变了，未命中不算"浪费"而是必要开销） */
  modelChanged: boolean;
}

/**
 * 缓存未命中检测（逐行扫）：
 * · 上一行都没有 / 这次没有 prompt token / 供应商压根不报缓存活动 → 不算
 * · missedTokens ≤ 噪声地板 → 不算
 * · 浪费 = 未命中 token × max(0, 本行付费单价 − 缓存读单价)
 */
export function detectCacheMiss(prev: UsageRow | undefined, row: UsageRow, opts?: { prevReportedCache?: boolean }): CacheMiss | undefined {
  const promptTokens = row.inputTokens + row.cacheReadTokens + row.cacheWriteTokens;
  const reportedCache = row.cacheReadTokens + row.cacheWriteTokens > 0;
  if (!prev || promptTokens <= 0) return undefined;
  // 「之前报过缓存活动吗」：默认由上一行自己推（扫描时把它一路带下来，这里用 opts 兼容）
  const prevReported = opts?.prevReportedCache ?? (prev.cacheReadTokens + prev.cacheWriteTokens > 0);
  if (!reportedCache && !prevReported) return undefined;

  const prevPrompt = prev.inputTokens + prev.cacheReadTokens + prev.cacheWriteTokens;
  const missedTokens = Math.min(prevPrompt, promptTokens) - row.cacheReadTokens;
  if (missedTokens <= NOISE_FLOOR_TOKENS) return undefined;

  // 付费的 token 只会落在 input 或 cacheWrite 两个桶里 → 付费单价直接由本行分项成本得出
  const paidTokens = row.inputTokens + row.cacheWriteTokens;
  const paidPerToken = paidTokens > 0 ? (row.breakdown.input + row.breakdown.cacheWrite) / paidTokens : 0;
  const readPerToken = row.cacheReadTokens > 0 ? row.breakdown.cacheRead / row.cacheReadTokens : 0;

  return {
    at: row.at,
    missedTokens,
    missedCost: missedTokens * Math.max(0, paidPerToken - readPerToken),
    idleMs: Math.max(0, row.at - prev.at),
    modelChanged: `${row.provider}/${row.model}` !== `${prev.provider}/${prev.model}`,
  };
}

/** 给人话原因（"这轮为什么突然贵了"的那个答案） */
export function explainCacheMiss(miss: CacheMiss, fmtMoney: (n: number) => string): string {
  const mins = Math.round(miss.idleMs / 60000);
  const why = miss.modelChanged
    ? `中途换了模型（换了模型缓存身份就变了，这次从头算账——不是浪费，是必要开销）`
    : miss.idleMs > CACHE_TTL_MS
      ? `距上次请求隔了 ${mins >= 60 ? `${(mins / 60).toFixed(1)} 小时` : `${mins} 分钟`}——超过了缓存有效期（${CACHE_TTL_MS / 60000} 分钟），上一轮的缓存已经过期`
      : `这一段上下文是新的（首轮、或刚压缩过，之前没被缓存过）`;
  return `有 ${miss.missedTokens} token 本该命中缓存却重新算了：${why}，多花了约 ${fmtMoney(miss.missedCost)}。`;
}

// ---------- 账本 ----------

export interface CostTotals {
  calls: number;
  cost: number;
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outTokens: number;
  /** 按角色分桶（主体 / 压缩摘要 / 记忆提炼 / 子代理…——"摘要与工具自己的调用"单独一桶） */
  byRole: Record<string, { calls: number; cost: number }>;
  /** 按供应商/模型分桶 */
  byModel: Record<string, { calls: number; cost: number }>;
  /** 缓存省下的钱（命中 token × (未命中价 − 命中价)，按各行实际单价估） */
  cacheSaved: number;
}

/** 账本行落盘格式：一行一个 JSON（append-only；可事后审计、可手工校正） */
export class CostLedger {
  private rows: UsageRow[] = [];
  private loaded = false;

  constructor(
    private readonly runtime: Runtime,
    private readonly file: string,
  ) {}

  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = (await this.runtime.fs.read(this.file, { limit: 8_000_000 })).content;
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        try { this.rows.push(JSON.parse(line) as UsageRow); } catch { /* 尾部半行跳过 */ }
      }
    } catch {
      /* 首次运行：账本是空的 */
    }
  }

  /** 追加一行（append-only；写失败不阻断主流程——记账不能拖垮聊天） */
  async append(row: UsageRow): Promise<void> {
    this.rows.push(row);
    try {
      await this.runtime.fs.append(this.file, `${JSON.stringify(row)}\n`);
    } catch { /* 记账失败静默 */ }
  }

  /** 事后校正：价目表补录后回填（原行不改，追加一条校正行，保持 append-only） */
  async adjust(match: { at: number; model?: string }, amount: number, note: string): Promise<void> {
    const hit = this.rows.find((r) => r.at === match.at && (!match.model || r.model === match.model));
    if (!hit) return;
    hit.adjustment = { amount, note };
    try {
      await this.runtime.fs.append(this.file, `${JSON.stringify({ kind: 'adjustment', at: hit.at, amount, note })}\n`);
    } catch { /* 同上 */ }
  }

  rowsBetween(from: number, to: number): UsageRow[] {
    return this.rows.filter((r) => r.at >= from && r.at < to);
  }

  /** 最近一行（"刚才那轮为什么贵"的输入） */
  last(role?: CostRole): UsageRow | undefined {
    for (let i = this.rows.length - 1; i >= 0; i--) {
      const r = this.rows[i]!;
      if (!role || r.role === role) return r;
    }
    return undefined;
  }

  totals(rows: UsageRow[] = this.rows): CostTotals {
    const t: CostTotals = {
      calls: rows.length, cost: 0, inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outTokens: 0,
      byRole: {}, byModel: {}, cacheSaved: 0,
    };
    for (const r of rows) {
      const cost = r.cost + (r.adjustment?.amount ?? 0);
      t.cost += cost;
      t.inputTokens += r.inputTokens;
      t.cacheReadTokens += r.cacheReadTokens;
      t.cacheWriteTokens += r.cacheWriteTokens;
      t.outTokens += r.outTokens;
      (t.byRole[r.role] ??= { calls: 0, cost: 0 });
      t.byRole[r.role]!.calls++;
      t.byRole[r.role]!.cost += cost;
      const mk = `${r.provider}/${r.model}`;
      (t.byModel[mk] ??= { calls: 0, cost: 0 });
      t.byModel[mk]!.calls++;
      t.byModel[mk]!.cost += cost;
      // 缓存省下的钱：命中价 vs 未命中价（用本行自己的单价，价目表缺项时跳过）
      if (r.cacheReadTokens > 0 && r.inputTokens > 0) {
        const missPer = r.breakdown.input / r.inputTokens;
        const hitPer = r.breakdown.cacheRead / r.cacheReadTokens;
        t.cacheSaved += r.cacheReadTokens * Math.max(0, missPer - hitPer);
      }
    }
    return t;
  }

  size(): number {
    return this.rows.length;
  }

  all(): UsageRow[] {
    return [...this.rows];
  }
}

// ---------- 从 Usage 造账本行（四项分项成本在这里算清） ----------

/**
 * 计价（两条规矩）：
 *   ① 阶梯档按 input+cacheRead+cacheWrite 总量选"门槛最高且低于总量"的档
 *   ② 1h 缓存写按 2×input 价计（其余缓存写按 cacheWrite 价；DeepSeek 无此项，值恒为 0）
 */
export function priceUsage(
  pricing: PricingCfg,
  u: { inputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; cacheWrite1hTokens: number; outTokens: number; reasoningTokens: number },
): CostBucket {
  const totalIn = u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens;
  let rates: { hit: number; miss: number; out: number } = { hit: pricing.hit, miss: pricing.miss, out: pricing.out };
  let matched = -1;
  for (const tier of pricing.tiers ?? []) {
    if (totalIn > tier.inputTokensAbove && tier.inputTokensAbove > matched) {
      rates = { hit: tier.hit, miss: tier.miss, out: tier.out };
      matched = tier.inputTokensAbove;
    }
  }
  const longWrite = u.cacheWrite1hTokens;
  const shortWrite = Math.max(0, u.cacheWriteTokens - longWrite);
  const reasoningPrice = pricing.reasoning ?? rates.out;
  const input = (u.inputTokens / 1e6) * rates.miss;
  const cacheRead = (u.cacheReadTokens / 1e6) * rates.hit;
  const cacheWrite = ((shortWrite * (pricing.cacheWrite ?? rates.miss)) + longWrite * rates.miss * 2) / 1e6;
  const output = (u.outTokens / 1e6) * rates.out + (u.reasoningTokens / 1e6) * reasoningPrice;
  return { input, output, cacheRead, cacheWrite };
}

/** 从 config 查这个供应商在某个角色下实际用的模型 id（宿主已把 modelOverride 应用到 config） */
export function ledgerModelOf(config: { providers: Record<string, { models: Record<string, { id: string }> }> }, providerName: string, role: CostRole): string {
  const p = config.providers?.[providerName];
  const key = role === 'digest' ? 'fast' : role === 'reasoner' ? 'reasoner' : role;
  // 查不到就用供应商名兜底（自建/测试供应商没有配置条目——账本里记 'unknown' 就等于"算不清"）
  return p?.models?.[key]?.id ?? p?.models?.main?.id ?? providerName;
}

/** 从 config 查计价（reasoner 走 pricingReasoner，缺省回落到主档价） */
export function ledgerPricingOf(config: { providers: Record<string, { pricing: PricingCfg; pricingReasoner?: PricingCfg }> }, providerName: string, role: CostRole): PricingCfg {
  const p = config.providers?.[providerName];
  if (!p) return { hit: 0, miss: 0, out: 0 };
  if (role === 'reasoner' && p.pricingReasoner) return p.pricingReasoner;
  return p.pricing;
}

/** Usage（引擎内部形态）→ 账本行 */
export function rowFromUsage(input: {
  usage: Usage; provider: string; model: string; role: CostRole; sessionId: string; at: number; pricing: PricingCfg;
}): UsageRow {
  const u = input.usage;
  const cacheWriteTokens = u.cacheWriteTokens ?? 0;
  const cacheWrite1hTokens = u.cacheWrite1hTokens ?? 0;
  const parts = {
    inputTokens: u.missTokens,
    cacheReadTokens: u.hitTokens,
    cacheWriteTokens,
    cacheWrite1hTokens,
    outTokens: u.outTokens,
    reasoningTokens: u.reasoningTokens ?? 0,
  };
  const breakdown = priceUsage(input.pricing, parts);
  const cost = input.usage.costUsd > 0
    ? input.usage.costUsd // 适配器已算过（含峰谷价）→ 以它为准，分项用于归因
    : breakdown.input + breakdown.output + breakdown.cacheRead + breakdown.cacheWrite;
  return {
    at: input.at, sessionId: input.sessionId, provider: input.provider, model: input.model, role: input.role,
    ...parts, cost, breakdown,
  };
}
