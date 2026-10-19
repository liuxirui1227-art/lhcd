// ProviderHub（换脑不换人 + 档位 → 模型池）：
// - 按 config.providers 惰性构建 OpenAI 兼容供应商适配器（每个供应商一份默认映射）；
// - 模型注册表条目（registry 配置或缺省派生）各有一份「单模型钉死」适配器实例（providerFor）；
// - route(task) 按任务画像在可用池内打分路由（见 registry.ts），失败按序回退。
// 换脑 = 切换「默认供应商」；宪法/范例/记忆注入不变（三层注入保证换脑不换人）。
import type { Config, ModelProfileCfg, ProviderCfg } from '../config/schema.js';
import type { LLMProvider } from './provider.js';
import { createMessageApiProvider } from './adapters/message-api.js';
import { deriveProfiles, routeTask, type ModelProfile, type TaskProfile } from './registry.js';

/** 单模型钉死：把 profile.model 映射到全部角色 + reasoner（thinking 条目） */
function pinnedModels(profile: ModelProfile, providerCfg: ProviderCfg): Record<string, { id: string; thinking: boolean }> {
  const m = { id: profile.model, thinking: !!profile.thinking };
  return {
    main: m,
    fast: m,
    compact: m,
    subagent: m,
    ...(profile.thinking ? { reasoner: m } : {}),
  };
}

/** 思考回放字段：**由 caps.reasoning 判定**（此前 caps 声明与 reasoningField 各说各话，现在绑起来）：
 *  · 'content-field' = 思考以内容字段回传 → 用配置的字段名（缺省 reasoning_content）
 *  · 'none' / 'thinking-blocks' = 不走内容字段路径 → 一律不发（thinking-blocks 的解析尚未实现，
 *    **不许假装支持**：声明它就得真解析，否则宁可不发 delta） */
export function reasoningFieldOf(cfg: ProviderCfg): string | null {
  if (cfg.caps?.reasoning !== 'content-field') return null;
  return cfg.reasoningField ?? 'reasoning_content';
}

export class ProviderHub {
  /** 供应商名 → 适配器（默认模型映射；惰性构建） */
  private readonly providers = new Map<string, LLMProvider>();
  /** 注册表条目 id → 单模型钉死适配器（惰性构建） */
  private readonly pinned = new Map<string, LLMProvider>();
  private readonly profilesCache: ModelProfile[];

  constructor(private readonly config: Config) {
    this.profilesCache = this.resolveProfiles(config);
  }

  /** 注册表条目（registry 配置优先；缺省按 providers 派生） */
  private resolveProfiles(config: Config): ModelProfile[] {
    if (config.registry?.profiles?.length) {
      // 只保留指向已配置供应商的条目；非法 provider 静默跳过（路由可用性优先）
      return config.registry.profiles
        .filter((p) => config.providers[p.provider])
        .map((p) => this.normalizeProfile(p));
    }
    return deriveProfiles(
      Object.fromEntries(
        Object.entries(config.providers).map(([name, cfg]) => [name, { models: cfg.models }]),
      ) as Record<string, { models: { main: { id: string }; reasoner?: { id: string } } }>,
    );
  }

  private normalizeProfile(p: ModelProfileCfg): ModelProfile {
    return {
      id: p.id,
      provider: p.provider,
      model: p.model,
      capabilities: p.capabilities,
      tier: p.tier,
      thinking: p.thinking,
      latency: p.latency,
      costPerMOut: p.costPerMOut,
    };
  }

  /** 注册表全部条目（可用池；池过滤由宿主按档位裁剪） */
  profiles(): ModelProfile[] {
    return [...this.profilesCache];
  }

  profile(id: string): ModelProfile | undefined {
    return this.profilesCache.find((p) => p.id === id);
  }

  /** 供应商默认适配器（换脑后的默认大脑） */
  provider(name: string): LLMProvider | undefined {
    const cfg = this.config.providers[name];
    if (!cfg) return undefined;
    let p = this.providers.get(name);
    if (!p) {
      p = createMessageApiProvider(name, {
        baseUrl: cfg.baseUrl,
        apiKeyEnv: cfg.apiKeyEnv,
        apiKey: cfg.apiKey, // 面板存的 key 直连注入（dist/llm/hub.js 此前漏传 → 打包态回退到 env → 误报「缺少 API Key」）
        reasoningField: reasoningFieldOf(cfg),
        caps: cfg.caps,
        pricing: cfg.pricing,
        pricingReasoner: cfg.pricingReasoner,
        models: cfg.models as unknown as Record<string, { id: string; thinking: boolean } | undefined>,
        temperature: cfg.temperature,
      });
      this.providers.set(name, p);
    }
    return p;
  }

  /** 当前默认供应商（config.provider.default） */
  defaultProvider(): LLMProvider {
    const p = this.provider(this.config.provider.default);
    if (!p) throw new Error(`默认供应商未配置: ${this.config.provider.default}`);
    return p;
  }

  /** 默认供应商名（换脑切换的读写对象） */
  defaultName(): string {
    return this.config.provider.default;
  }

  /**
   * 注册表条目适配器（单模型钉死）：按条目 id 精确使用指定供应商的指定模型，
   * 定价随条目所属供应商配置（reasoner 条目走 pricingReasoner 档）。
   */
  providerFor(profile: ModelProfile): LLMProvider {
    let p = this.pinned.get(profile.id);
    if (!p) {
      const cfg = this.config.providers[profile.provider];
      if (!cfg) throw new Error(`注册表条目指向未配置供应商: ${profile.id} → ${profile.provider}`);
      p = createMessageApiProvider(profile.id, {
        baseUrl: cfg.baseUrl,
        apiKeyEnv: cfg.apiKeyEnv,
        apiKey: cfg.apiKey, // 同上
        reasoningField: reasoningFieldOf(cfg),
        caps: cfg.caps,
        pricing: cfg.pricing,
        pricingReasoner: cfg.pricingReasoner,
        models: pinnedModels(profile, cfg),
        temperature: cfg.temperature,
      });
      this.pinned.set(profile.id, p);
    }
    return p;
  }

  /** 按任务画像路由：最优 → 备选链（能力门 → 打分降序） */
  route(task: TaskProfile): ModelProfile[] {
    return routeTask(this.profilesCache, task);
  }
}
