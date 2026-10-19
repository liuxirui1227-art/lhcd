// 模型注册表 + 任务画像路由（大脑可换 · 多脑协同）。
// 关系：档位决定「可用模型池」；注册表决定池内「如何选」——
// 每个子任务按画像打分路由：能力匹配 × 质量需求 × 成本 × 延迟，取最优，失败按序回退备选。
// 纯函数模块：不持有网络/密钥，单测零成本。

export type Capability = 'text' | 'vision' | 'audio' | 'reasoning';
export type ModelTier = 'light' | 'standard' | 'deep';

export interface ModelProfile {
  /** 注册表条目 id（如 deepseek.chat / deepseek.reasoner）；同一供应商可挂多个条目 */
  id: string;
  /** config.providers 配置键 */
  provider: string;
  /** wire 模型名（发往服务商） */
  model: string;
  capabilities: Capability[];
  tier: ModelTier;
  /** 深度条目（如 deepseek-reasoner）：推理链任务优先 */
  thinking?: boolean;
  /** 延迟画像 1（最快）~5（最慢）；缺省 3 */
  latency?: number;
  /** 成本画像：输出价近似（元/M）；缺省 0 = 未知 */
  costPerMOut?: number;
}

export interface TaskProfile {
  /** 模态（多模态分工）；注册表条目必须含该能力才可路由 */
  modality: Capability;
  /** 任务深度档 */
  depth: ModelTier;
  /** 质量需求 0..1；缺省 0.5 */
  qualityNeed?: number;
  /** 延迟敏感 0..1（1=最敏感）；缺省 0.5 */
  latencySensitive?: number;
  /** 成本敏感 0..1（1=最敏感）；缺省 0.5 */
  costSensitive?: number;
}

const TIER_RANK: Record<ModelTier, number> = { light: 0, standard: 1, deep: 2 };

/** 能力门：条目必须包含任务模态（reasoning 是附加能力，非路由门） */
export function supportsCapability(p: ModelProfile, modality: Capability): boolean {
  return p.capabilities.includes(modality);
}

/** 质量匹配：档位差越小越好（0.5~1） */
export function qualityScore(p: ModelProfile, depth: ModelTier): number {
  const diff = Math.abs(TIER_RANK[p.tier] - TIER_RANK[depth]);
  return 1 - diff / 2;
}

/** 延迟分：latency 1→1.0，5→0 */
export function latencyScore(p: ModelProfile): number {
  const lat = p.latency ?? 3;
  return 1 - (lat - 1) / 4;
}

/** 成本分（输出价近似）：未知 0.6；≤4 元 1.0；≤8 元 0.8；≤15 元 0.5；更贵 0.2 */
export function costScore(p: ModelProfile): number {
  const c = p.costPerMOut ?? 0;
  if (c === 0) return 0.6;
  if (c <= 4) return 1;
  if (c <= 8) return 0.8;
  if (c <= 15) return 0.5;
  return 0.2;
}

/**
 * 任务路由打分：
 * score = wQ·质量 + wL·延迟 + wC·成本，权重由任务画像的需求强度决定；
 * 质量权重有 0.5 底仓（能力匹配是硬门，档位匹配不能为零权）。
 * 返回 { profile, score } 按分数降序 = 失败回退链。
 */
export function scoreProfile(p: ModelProfile, task: TaskProfile): { profile: ModelProfile; score: number } {
  const qn = task.qualityNeed ?? 0.5;
  const ln = task.latencySensitive ?? 0.5;
  const cn = task.costSensitive ?? 0.5;
  const wQ = 0.5 + 0.4 * qn;   // 0.5~0.9
  const wL = 0.4 * ln;         // 0~0.4
  const wC = 0.4 * cn;         // 0~0.4
  const sum = wQ + wL + wC;
  const score = (wQ * qualityScore(p, task.depth) + wL * latencyScore(p) + wC * costScore(p)) / sum;
  return { profile: p, score };
}

/**
 * 按任务画像路由：能力门过滤 → 打分 → 降序。
 * 返回数组即回退链（首个最优；调用失败按序回退备选）。
 */
export function routeTask(profiles: ModelProfile[], task: TaskProfile): ModelProfile[] {
  return profiles
    .filter((p) => supportsCapability(p, task.modality))
    .map((p) => scoreProfile(p, task))
    .sort((a, b) => b.score - a.score)
    .map((s) => s.profile);
}

/**
 * 从 providers 配置派生缺省注册表（无 registry 配置时）：
 * main → standard/text（main.vision=true 时加 vision）；reasoner → deep/text+reasoning（thinking）。
 * 保证换脑不换人零配置可用：加一个供应商配置即自动进池。
 */
export function deriveProfiles(
  providers: Record<string, {
    models: { main: { id: string; vision?: boolean }; reasoner?: { id: string } };
  }>,
): ModelProfile[] {
  const out: ModelProfile[] = [];
  for (const name of Object.keys(providers)) {
    const m = providers[name]!.models;
    out.push({
      id: `${name}.main`,
      provider: name,
      model: m.main.id,
      capabilities: m.main.vision ? ['text', 'vision'] : ['text'],
      tier: 'standard',
    });
    if (m.reasoner) {
      out.push({
        id: `${name}.reasoner`,
        provider: name,
        model: m.reasoner.id,
        capabilities: ['text', 'reasoning'],
        tier: 'deep',
        thinking: true,
        costPerMOut: 13.5, // DeepSeek Pro 输出价近似（缺省派生用）；registry 配置可覆盖
      });
    }
  }
  return out;
}
