// 模型覆盖（面板里选的模型 → 供应商配置）。**唯一实现**：brain 侧，供工厂与宿主共用。
//
// 为什么要独立成模块并在**配置合并之后**调用：
//   宿主传给 createAgent 的 cli.providers 往往只有 baseUrl（没有 models 字段）——
//   在合并前覆盖会被 "if (!p?.models?.main) continue" 静默跳过，
//   于是只有自带 models 的供应商（如 qwen）才生效。
//
// 语义（"拆压平"）：**只覆盖 main**，fast/compact/subagent 保持供应商分档——
// 「按难度省钱」在 BYOK 轨道同样要生效。

import type { ThinkEffort } from './effort.js';

export interface ProviderLike {
  models?: {
    main?: { id: string; thinking?: boolean; effort?: string };
    reasoner?: { id: string };
    [k: string]: unknown;
  };
  /** Pro 档定价（forceCheapTier 会摘掉它：全 Flash 期不能按 Pro 计价） */
  pricingReasoner?: unknown;
}

// 思考档位类型定义在 effort.ts（内核自动选档同处）；这里转出，调用方不用记两个路径
export type { ThinkEffort } from './effort.js';

/**
 * 把 modelOverride（供应商 → 模型名）应用到供应商配置上（就地修改）。
 * 选中供应商自己的深度模型（reasoner 条目）时，main 也会带上 thinking。
 */
export function applyModelOverride(providers: Record<string, ProviderLike>, modelOverride?: Record<string, string> | null): Record<string, ProviderLike> {
  for (const [n, mid] of Object.entries(modelOverride ?? {})) {
    const p = providers[n];
    if (!p?.models?.main || !mid) continue;
    const thinking = (p.models.reasoner as { id?: string } | undefined)?.id === mid;
    p.models.main = { id: mid, thinking };
  }
  return providers;
}

/**
 * 开发侧全 Flash：给开发/测试用的省钱闸门——跑测试、探针时一律便宜档，不烧 Pro 的钱。
 * **不是产品限制**：打包给用户的应用照旧自由切换模型、按实际切换计价；本函数只在开关打开时生效（默认关）。
 * 把每个供应商的**所有档位**压到它自己的便宜档（fast），并摘掉 reasoner 条目与 Pro 档定价：
 *   - 模型 id：thinking=true 的请求在适配器里先查 models.reasoner，条目摘掉后落到 models[role]，
 *     而 role 全是便宜档 → 任何路由（Tier3 深任务 / 工作模式 / 拆解 / 子代理）都不可能再打到 Pro；
 *   - 计价：适配器按「modelId === models.reasoner.id」判 Pro 档（message-api.ts:108），条目摘掉后
 *     该判定恒为 false；账本的按角色计价（ledger.ts ledgerPricingOf）也因 pricingReasoner 摘掉而回落 Flash。
 * 显式注册表（config.registry）里的 deep 条目由调用方一并摘掉（factory），否则 hub.route({depth:'deep'}) 还能捞回 Pro。
 * 就地修改（纯函数，可直测）；只作用在**合并后的内存配置**上，不落盘——关掉开关下次重建即恢复，无残留。
 *
 * opts.effort：顺带指定**思考档位**（DeepSeek V4.1：low/high/max）。
 * 不指定 = 一个字段都不多发（服务端默认 thinking 开 + high，与旧行为逐字一致）；
 * 指定了但模型不吃这个参数（如 qwen）——服务端会忽略未知字段，不报错。
 */
export function forceCheapTier(
  providers: Record<string, ProviderLike>,
  opts?: { effort?: ThinkEffort },
): Record<string, ProviderLike> {
  for (const p of Object.values(providers ?? {})) {
    const m = p?.models;
    if (!m?.main) continue;
    // 便宜档 = fast（各供应商自己的轻档：deepseek-flash / qwen-turbo…）；没分档就退回 main
    const cheap = (m.fast as { id?: string } | undefined)?.id ?? m.main.id;
    const entry = { id: cheap, thinking: false, ...(opts?.effort ? { effort: opts.effort } : {}) };
    for (const role of ['main', 'fast', 'compact', 'subagent']) m[role] = { ...entry };
    delete m.reasoner;
    delete p.pricingReasoner;
  }
  return providers;
}
