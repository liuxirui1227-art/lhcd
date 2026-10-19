// 记忆服务（三层模型中的语义+情景层入口；工具层不得直接写记忆文件，只经本模块）。
import type { Runtime } from '../runtime/types.js';
import type { Domain } from '../lifecycle/facets.js';
import { SemanticStore, type MemoryStatus, type SemanticEntry, type ScoredEntry } from './semantic.js';
import { IdentityStore } from './identity.js';
import type { HybridOptions, HybridScoredEntry } from './recall.js';
import { contradictionScore, duplicateScore } from './recall.js';
import { classifyEmotion } from '../lifecycle/emotion.js';

export interface RememberInput {
  scope: 'global' | 'project';
  key: string;
  content: string;
  description?: string;
  confidence?: 'high' | 'medium' | 'low';
  source: string; // 无 source 不写入（引用纪律）
  /** 数据域标签（权限矩阵列）；缺省按 schedule 域可见性处理 */
  domain?: Domain;
  // ── 生命周期 / 候选态字段，**全部可选**（老调用方一字不改）──
  /** 显式重要性 0~1；缺省由 confidence 派生 */
  importance?: number;
  /** 候选态：缺省 active（用户明说的）/ candidate（自动提炼的，待用户批准） */
  status?: MemoryStatus;
  /** 到期时间（TTL 打开时才算；显式给出优先） */
  expiresAt?: string;
  /**
   * 标签。缺省由 `deriveTags()` 现算（见下）；显式传了 tags 的调用方优先（老行为对显式调用方不变）。
   */
  tags?: string[];
}

/** 情绪档 → 标签词（与 `recall.ts` 的 EMOTION_TAGS 同口径：这些词命中就吃 1.25× 情绪加成）。
 *  comfort 那档在 EMOTION_TAGS 里没有对应词，统一靠「情绪」兜住加成，具体词只在图谱共现里起作用。 */
const EMO_TAG: Record<string, string> = { joy: '开心', sad: '难过', angry: '生气', anxious: '焦虑', comfort: '疲惫' };

/**
 * 缺省标签：没人传 tags 时，至少让这一维**有区分度**。
 * 背景：此前一律写死 `['auto']` —— "人人都是 auto"⇒ 图谱共现（Jaccard）对谁都一样、
 * 情绪加成永不触发，召回这两个维度等于死的。
 * 现算只取本条目已有的两样东西，不额外调模型、不加延迟：
 *   ① `domain`（调用方给了就带上）；② 内容情绪——用内核**同一套** `classifyEmotion`
 *   （lifecycle/emotion.ts，词库加权 + 否定消解），非 neutral 就打「情绪」+ 具体档词。
 * 显式传 tags 的调用方优先级更高，这条只兜底；什么都没算出来才退 `['auto']`。
 */
function deriveTags(input: RememberInput): string[] {
  const tags: string[] = [];
  if (input.domain) tags.push(input.domain);
  try {
    const emo = classifyEmotion(input.content).emotion;
    if (emo !== 'neutral') {
      tags.push('情绪');
      const word = EMO_TAG[emo];
      if (word && !tags.includes(word)) tags.push(word);
    }
  } catch { /* 分类器异常绝不影响写入 */ }
  return tags.length > 0 ? tags : ['auto'];
}

export interface Episode {
  sessionId: string;
  startedAt: string;
  goal: string;
  result: string;
  decisions: string[];
  files: string[];
  lessons: string[];
}

export class MemoryService {
  readonly semantic: SemanticStore;
  /** Identity 层：**用户定过的长期规矩** —— 与语义/情景并列的第三层 */
  readonly identity: IdentityStore;
  /** 可选向量化器（provider.embed）：recall 混合召回路径用；缺省走纯关键词混合（β 让渡） */
  readonly embedder?: (texts: string[]) => Promise<number[][]>;

  constructor(
    private readonly runtime: Runtime,
    semanticDir: string,
    private readonly episodesDir: string,
    opts?: { embed?: (texts: string[]) => Promise<number[][]>; identityFile?: string },
  ) {
    this.semantic = new SemanticStore(runtime, semanticDir);
    // 缺省落在语义目录旁边（memory/identity.md）——三层记忆同处一个目录，人找起来是一处
    this.identity = new IdentityStore(runtime, opts?.identityFile ?? `${episodesDir}/../identity.md`);
    this.embedder = opts?.embed;
  }

  async remember(input: RememberInput): Promise<{ action: 'write' | 'overwrite' | 'redacted'; key: string }> {
    const now = this.runtime.clock();
    const entry: SemanticEntry = {
      name: input.key,
      scope: input.scope,
      description: input.description ?? '',
      confidence: input.confidence ?? 'medium',
      source: input.source,
      tags: input.tags && input.tags.length > 0 ? input.tags : deriveTags(input),
      ...(input.domain ? { domain: input.domain } : {}),
      updatedAt: now,
      createdAt: now,
      content: input.content,
      ...(input.importance !== undefined ? { importance: input.importance } : {}),
      // 候选态：调用方没显式表态时**不在这一层定** —— 由 SemanticStore.write 判
      // （"首次写入才应用默认"，覆盖时保留老状态：用户批准过的不许被打回候选）
      ...(input.status ? { status: input.status } : {}),
      ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
    };
    return this.semantic.write(entry);
  }

  /** 召回回流：被注入/被检索到的记忆记一笔 lastUsedAt（不动 updatedAt） */
  async touch(key: string): Promise<boolean> {
    return this.semantic.touch(key);
  }

  /** 候选态：批准 → active；忽略 → deprecated */
  async setStatus(key: string, status: MemoryStatus): Promise<boolean> {
    return this.semantic.setStatus(key, status);
  }

  /** TTL 清理：**开关由调用方把关**（config.memory.ttlEnabled 默认关），本方法不自己判断 */
  async purgeExpired(ttlDays: number, now: string): Promise<number> {
    return this.semantic.purgeExpired(ttlDays, now);
  }

  async forget(key: string): Promise<boolean> {
    return this.semantic.delete(key);
  }

  /** 读取单条语义记忆（forget 权限校验等需要先查域标签） */
  async get(key: string): Promise<SemanticEntry | null> {
    return this.semantic.read(key);
  }

  async search(query: string, max = 8, opts?: { includeDeprecated?: boolean }): Promise<ScoredEntry[]> {
    return this.semantic.search(query, max, opts);
  }

  /** 用户打分："这条有用/没用"。返回新信任分；条目不存在返回 null。 */
  async rateTrust(name: string, kind: 'useful' | 'useless'): Promise<number | null> {
    return this.semantic.rateTrust(name, kind);
  }

  /**
   * 找矛盾对：两两比一遍，返回超过阈值的配对（分高在前）。
   * deprecated 不参与（用户已经处理过那条了）；**只提示、不改数据** —— 交给人决定。
   * 规模小（个人记忆库百来条）时两两比对是 O(n²) 可接受；真要上千条再谈索引。
   */
  async findContradictions(threshold = 0.3, max = 20): Promise<Array<{ a: string; b: string; score: number }>> {
    const entries = (await this.semantic.list()).filter((e) => e.status !== 'deprecated');
    const out: Array<{ a: string; b: string; score: number }> = [];
    for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) {
        const score = contradictionScore(entries[i]!, entries[j]!);
        if (score >= threshold) out.push({ a: entries[i]!.name, b: entries[j]!.name, score: Math.round(score * 100) / 100 });
      }
    }
    return out.sort((x, y) => y.score - x.score).slice(0, max);
  }

  /**
   * 找**疑似重复**（跨体去重）：同一件事存了两遍——
   * **尤其是简繁两条**（同一件事一条用简体存、一条用繁体存；界面切过语言就会出现）。
   *
   * 判据 = 跨体词集相似度（contain 与 jaccard 取小）：简繁同一件事实测 **1.00**，
   * 而"同主语换了值"（火锅 vs 拉面）只有 .71 —— 阈值 .85 卡在中间，宁缺毋滥。
   * **只提示、不改数据**：去重是用户的事（界面上可以"忘掉其中一条"），我们不做自动删。
   */
  async findDuplicates(threshold = 0.85, max = 20): Promise<Array<{ a: string; b: string; score: number }>> {
    const entries = (await this.semantic.list()).filter((e) => e.status !== 'deprecated');
    const out: Array<{ a: string; b: string; score: number }> = [];
    for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) {
        const score = duplicateScore(entries[i]!, entries[j]!);
        if (score >= threshold) out.push({ a: entries[i]!.name, b: entries[j]!.name, score: Math.round(score * 100) / 100 });
      }
    }
    return out.sort((x, y) => y.score - x.score).slice(0, max);
  }

  /** 混合召回：图谱 + 向量 + 时间衰减 + 重要性；运行期注入路径 */
  async searchHybrid(query: string, max = 8, opts?: HybridOptions): Promise<HybridScoredEntry[]> {
    return this.semantic.searchHybrid(query, max, opts);
  }

  /** recall 渲染：条目列表文本（供工具回传与注入）；候选态明标「待确认」 */
  render(results: ScoredEntry[]): string {
    if (results.length === 0) return '（没有检索到相关记忆）';
    return results
      .map((r) => `- [${r.entry.name}] ${r.entry.description || r.entry.content.slice(0, 80)}（confidence=${r.entry.confidence}，source=${r.entry.source}${r.entry.domain ? `，domain=${r.entry.domain}` : ''}${r.entry.status === 'candidate' ? '，待你确认' : ''}）`)
      .join('\n');
  }

  /** 情景记忆：每次会话归档（只追加语义：同一 sessionId 覆盖为最新快照） */
  async writeEpisode(episode: Episode): Promise<void> {
    await this.runtime.fs.write(
      `${this.episodesDir}/${episode.sessionId}.json`,
      JSON.stringify(episode, null, 2),
    );
  }

  async readEpisode(sessionId: string): Promise<Episode | null> {
    try {
      const raw = (await this.runtime.fs.read(`${this.episodesDir}/${sessionId}.json`, { limit: 1_000_000 })).content;
      return JSON.parse(raw) as Episode;
    } catch {
      return null;
    }
  }
}
