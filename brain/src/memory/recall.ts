// 混合召回：score = α·图谱遍历 + β·向量相似 + γ·时间衰减 + δ·重要性加权。
// - 图谱 v0：标签共现邻接（同标签=轻量图谱边；查询命中的种子条目标签集合与候选做 Jaccard）
// - 向量：embedder（provider.embed）余弦相似；无 embedder 时向量权重让渡给关键词（BM25 降级路径保留）
// - 时间衰减：exp(-ln2 · 年龄/半衰期)
// - 重要性：confidence（high 1.5 / medium 1.0 / low 0.6）× 情绪峰值加成（情绪标签 ×1.25）
// 纯函数 + 可选 embedder 注入；无 embedder 时零网络依赖，双环境可单测。
import type { SemanticEntry } from './semantic.js';
import { entryBody, entryText, scoreText, textSimilarity, tokenize } from './text.js';

// 分词/打分统一收口在 text.ts（CJK 重叠双字）；tokenize 从这里再导出，保持既有导入面不变
export { tokenize };

export interface RecallWeights {
  /** 关键词/图谱类权重 */
  alpha?: number;
  /** 向量相似权重（无 embedder 时自动归零让渡给 alpha/gamma/delta） */
  beta?: number;
  gamma?: number;
  delta?: number;
}

export interface HybridOptions extends RecallWeights {
  /** 时间衰减半衰期（天）；缺省 30 */
  halfLifeDays?: number;
  /** 基准时间 ISO；缺省 Date.now */
  now?: string;
  /** 向量化（texts[0]=query，其余为条目文本，顺序与 entries 一致）；未提供则纯关键词降级 */
  embed?: (texts: string[]) => Promise<number[][]>;
}

export interface HybridScoredEntry {
  entry: SemanticEntry;
  score: number;
  components: { keyword: number; graph: number; vector: number; time: number; importance: number };
}

/** 关键词分（0~1）：命中 1 + 词频 0.5（封顶 3），按词数归一；CJK 走 text.ts 的双字+连续命中 */
export function keywordScore(entry: SemanticEntry, query: string): number {
  return scoreText(entryText(entry), query).score;
}

/** 图谱分（0~1，标签共现 Jaccard）：种子 = 关键词分最高的前 3 条条目的标签并集 */
export function graphScore(entry: SemanticEntry, seedTags: Set<string>): number {
  if (seedTags.size === 0 || entry.tags.length === 0) return 0;
  const overlap = entry.tags.filter((t) => seedTags.has(t)).length;
  return overlap / (seedTags.size + entry.tags.length - overlap);
}

/** 时间衰减（0~1）：exp(-ln2 · 年龄天数 / 半衰期) */
export function timeDecay(updatedAt: string, now: string, halfLifeDays: number): number {
  const age = Date.parse(now) - Date.parse(updatedAt);
  if (!Number.isFinite(age) || age <= 0) return 1;
  return Math.exp(-Math.LN2 * (age / 86_400_000) / halfLifeDays);
}

/** 情绪标签集合（情绪峰值事件权重高） */
const EMOTION_TAGS = new Set(['情绪', 'emotion', '开心', '难过', '感动', '生气', '委屈', '焦虑', 'emo']);

/**
 * 来源权威性：同一句话，**谁说的分量不一样**。
 * 用户当面纠正 > 用户/界面明说 > 日程同步 > 她自己提炼 > 会话摘要里滚出来的。
 * 记忆该按**来路**定权重，而不是"被写得越多越算数"。
 * 未知来源（含 remember 工具传的 sessionId）= 1.0，不影响老行为。
 */
const SOURCE_AUTHORITY: ReadonlyArray<{ re: RegExp; w: number; label: string }> = [
  { re: /^user-correction/, w: 1.3, label: '用户纠正' },
  { re: /^user\b|^runtime-api/, w: 1.2, label: '用户/界面明说' },
  { re: /^info-sync/, w: 1.1, label: '日程同步' },
  { re: /^chat-digest/, w: 1.0, label: '聊天提炼' },
  { re: /^scene-report/, w: 0.95, label: '约会记录' },
  { re: /^session[.-]/, w: 0.85, label: '会话摘要' },
];

/** 来源权重（缺省 1.0）：给 importance 用，也供诊断/界面显示"这条为什么权重高" */
export function sourceAuthority(source: string): number {
  const s = String(source ?? '');
  for (const it of SOURCE_AUTHORITY) if (it.re.test(s)) return it.w;
  return 1;
}

/** 来源标签（人话，给界面/审计用；未知来源回空串 = 不显示） */
export function sourceLabel(source: string): string {
  const s = String(source ?? '');
  for (const it of SOURCE_AUTHORITY) if (it.re.test(s)) return it.label;
  return '';
}

/**
 * 候选态权重：**还没得到你确认的记忆，不该占着最稳的位置。**
 * active（含没写 status 的老条目）= 1；candidate = 0.8；deprecated = 0（不该再被想起来；
 * 正常路径上它已经被过滤掉了，这里留一道保险，防有人直接拿 entries 调本模块）。
 */
export function statusWeight(entry: SemanticEntry): number {
  if (entry.status === 'candidate') return 0.8;
  if (entry.status === 'deprecated') return 0;
  return 1;
}

/**
 * 信任分系数：**乘在相关性上**（不是加在总分里）。
 * 0.5（缺省/老条目）= ×1.0，完全不动老行为；满分 1 → ×1.5；0 分 → ×0.5。
 * 打分口径见 `SemanticStore.rateTrust`（有用 +0.05 / 没用 −0.10，罚是奖的两倍）。
 */
export function trustFactor(entry: SemanticEntry): number {
  const t = typeof entry.trust === 'number' ? entry.trust : 0.5;
  return 0.5 + Math.min(1, Math.max(0, t));
}

/**
 * 重要性权重：confidence 档 × 情绪峰值加成 × 来源权威性 × 候选态权重。
 * 显式 importance（0~1）优先于 confidence 档 —— 折算到同量纲（0 → 0.4，1 → 1.6）。
 */
export function importanceWeight(entry: SemanticEntry): number {
  const explicit = typeof entry.importance === 'number' ? 0.4 + 1.2 * entry.importance : null;
  const base = explicit ?? (entry.confidence === 'high' ? 1.5 : entry.confidence === 'low' ? 0.6 : 1.0);
  const emotional = entry.tags.some((t) => EMOTION_TAGS.has(t.toLowerCase())) ? 1.25 : 1;
  return base * emotional * sourceAuthority(entry.source) * statusWeight(entry);
}

/**
 * 矛盾检测：**同一个主语、说法却不一样** = 疑似打架。
 * `contradiction = 共享实体占比 × (1 − 词集相似度)`
 *   · 共享实体 = 交集 / 较小集合（containment）——"同一主语"的证据：多数词都重合；
 *   · 词集相似度 = 词集 Jaccard——换了说法/改了数目/加了否定，它会掉下来；
 *   · 完全重复的两条：共享占比高、相似度也高 ⇒ 分低（那是重复，不是矛盾）。
 *
 * ⚠ **这是启发式"提示"，不是判决**（如实记）：真矛盾的句子天然共享一大半字面（主语+句式），
 * 所以真实冲突对的分落在 0.3~0.5，无关对是 0、重复对 <0.1 —— 阈值取 0.3 是"宁可多提示一条
 * 给人看一眼"的取向。**不做任何自动改写/自动合并**，只负责把它端到用户面前。
 */
export function contradictionScore(a: SemanticEntry, b: SemanticEntry): number {
  /* 词集改成**跨体词集**（原文 ∪ 简体候选）：原来简繁两条说同一件事时词集不重叠 →
     会被算成"无关"（该提示的不提示）；更糟的是"同一件事两条写法"还可能被当成
     "同主语说法不一样"去提示矛盾。 */
  const { contain: overlap, jaccard } = textSimilarity(entryBody(a), entryBody(b));
  if (overlap === 0) return 0;
  /* 矛盾 = 共享实体占比 × (1 − 词集相似度)：主语是同一个（重合多），但说法变了（相似度低）。 */
  return Math.max(0, Math.min(1, overlap * (1 - jaccard)));
}

/**
 * 疑似**重复**（含简繁跨体）：两头都要高才算"同一件事"——多数词重合（contain）**且**整体词集接近（jaccard）。
 * 取 **min** 是有意的：`火锅` vs `拉面` 那类"同主语换了说法" contain 很高但 jaccard 会掉下来，
 * 不该被当成重复（它们是**矛盾检测**那一头的事）。
 */
export function duplicateScore(a: SemanticEntry, b: SemanticEntry): number {
  const { contain, jaccard } = textSimilarity(entryBody(a), entryBody(b));
  return Math.max(0, Math.min(1, Math.min(contain, jaccard)));
}

/** 余弦相似（向量维度不一致时按短边截断） */
export function cosine(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const n = Math.min(a.length, b.length);
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return 0;
  return Math.max(0, dot / (Math.sqrt(na) * Math.sqrt(nb)));
}

/** 余弦转 0~1 相似度（余弦 ∈ [-1,1] → 相似 ∈ [0,1]，与其余分量同域） */
function cosineToSim(c: number): number {
  return (c + 1) / 2;
}

function resolveWeights(opts: HybridOptions, hasEmbed: boolean): Required<Pick<HybridOptions, 'alpha' | 'beta' | 'gamma' | 'delta'>> {
  if (hasEmbed) {
    return {
      alpha: opts.alpha ?? 0.3,
      beta: opts.beta ?? 0.35,
      gamma: opts.gamma ?? 0.15,
      delta: opts.delta ?? 0.2,
    };
  }
  // 无向量：beta 让渡（关键词承担召回主力，时间/重要性增权）
  return {
    alpha: opts.alpha ?? 0.5,
    beta: 0,
    gamma: opts.gamma ?? 0.2,
    delta: opts.delta ?? 0.3,
  };
}

/**
 * 混合召回：对 entries 全量打分，返回降序结果（components 供诊断/审计）。
 * embedder 抛错时降级为纯关键词路径（不阻塞主流程）。
 */
export async function hybridRecall(
  query: string,
  entries: SemanticEntry[],
  opts: HybridOptions = {},
): Promise<HybridScoredEntry[]> {
  const now = opts.now ?? new Date().toISOString();
  const halfLifeDays = opts.halfLifeDays ?? 30;

  // 关键词分（全部条目）→ 种子标签（图谱邻接锚点）
  const kw = entries.map((e) => keywordScore(e, query));
  const seedTags = new Set<string>();
  entries
    .map((e, i) => ({ e, s: kw[i]! }))
    .sort((a, b) => b.s - a.s)
    .slice(0, 3)
    .filter((x) => x.s > 0)
    .forEach((x) => x.e.tags.forEach((t) => seedTags.add(t)));

  // 向量分（embedder 可用时）
  let vecs: number[][] | null = null;
  const hasEmbed = typeof opts.embed === 'function';
  if (hasEmbed) {
    try {
      const texts = [query, ...entries.map((e) => `${e.name} ${e.description} ${e.content}`)];
      vecs = await opts.embed!(texts);
    } catch {
      vecs = null; // 降级：纯关键词路径
    }
  }

  const w = resolveWeights(opts, vecs !== null);
  const qVec = vecs?.[0] ?? null;
  const scored: HybridScoredEntry[] = entries.map((e, i) => {
    const keyword = kw[i]!;
    const graph = graphScore(e, seedTags);
    const vector = qVec && vecs?.[i + 1] ? cosineToSim(cosine(qVec, vecs[i + 1]!)) : 0;
    const time = timeDecay(e.updatedAt, now, halfLifeDays);
    const importance = importanceWeight(e);
    // α 分量 = 关键词 + 图谱共现的混合（图谱遍历 v0 与词频检索同源，加权融合）
    const alphaComp = 0.7 * keyword + 0.3 * graph;
    // 信任分乘在**相关性**上：用户说"没用"的那条，同样的相关性下排后面；
    // 时间衰减与重要性不吃这个乘子（它们是"新鲜度/分量"，不是"可不可信"）。
    const relevance = (w.alpha * alphaComp + w.beta * vector) * trustFactor(e);
    const score = relevance + w.gamma * time + w.delta * importance;
    return { entry: e, score, components: { keyword, graph, vector, time, importance } };
  });

  return scored.sort((a, b) => b.score - a.score);
}
