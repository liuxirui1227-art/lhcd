// 中文召回的分词与打分：CJK 连续段切**重叠双字**，两字词也能命中。
// 洞的机理：旧分词只按空白/标点切，中文整句是一个 token ——"上次我们聊的那个项目" 永远 includes 不上；
// 两字词只有在"整条 query 恰好就是这个词"时才命中。中文优先的产品里，这是零隐私代价的大收益。
// 本模块是 recall.ts（混合召回）与 semantic.ts（BM25 检索）**共用的唯一分词/打分源**（旧实现两份近似拷贝）。
// 边界：非 CJK 段原样保留（与旧行为一致）；query 里只有单个 CJK 字时保留该单字（不把 1 字查询变成 0 词）。
// 与 SQLite FTS5 场景的差异：本架构是线性子串扫描（无倒排索引），所以**不需要**写入侧的 bigram 变体，只改查询侧。
//
// ── 五语（简/繁/英/日/韩）同一套分词口径，改了两处 ──
// ① **分段按 Unicode 来，不认死标点**：原来只切 `空白 ，。,.、`，于是 `going?` `report!` 这种
//    标点黏在词尾的拉丁词成了永远匹配不上的检索词，CJK 侧的 `？` 还变成一个垃圾词去稀释分母
//    （cover 的分母是词数）。现在按"非字母非数字"切：五种语言的标点、符号、emoji 一视同仁。
// ② **简繁归一**：港台用户拿繁体问句，搜不到他以前用简体存下的记忆
//    （实测 0.963 → 0.000）。现在查询与记忆**两侧都试简体候选，取最高分**——繁体问句 `專案進度`
//    对简体记忆 `项目进度` 拿到的分，与简体问句打同一条记忆**完全一致**。
//    候选表是生成的（`brain/src/memory/hans.ts`），一对多的不硬选、全试。

import { hansCandidates } from './hans.js';

/** 中日韩：平假名/片假名、CJK 扩展 A、CJK 统一表意、兼容表意、谚文音节（写成码点，别用肉眼分不清的字面量） */
const CJK_RE = /[\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uAC00-\uD7AF]/;
/** 分段：**非字母非数字**都算分隔符（空白 / 标点 / 符号 / emoji）——五语同一套口径 */
const SEP_RE = /[^\p{L}\p{N}]+/u;

export function isCjk(ch: string): boolean {
  return CJK_RE.test(ch);
}

/** 一句话切出来的检索词 */
export interface TermSet {
  /** 全部检索词：非 CJK 段原样 + CJK 重叠双字（单字段保留单字），去重保序 */
  terms: string[];
  /** 合并后的 CJK 串（跨标点/空格）——只用于"连续命中"判定 */
  cjk: string;
}

export interface QueryTerms extends TermSet {
  /**
   * 同一句话的**其它写法**（简繁归一后的简体候选，多半是空的）。
   * 打分时逐个试、取最高——这样"繁体问句"与"简体问句"打同一条记忆拿到的分一致。
   */
  alts: TermSet[];
}

/** 切词：非字母数字分段，段内 CJK 连续串切重叠双字（"那个项目" → 那个/个项/项目） */
function tokenizeChunks(lower: string): TermSet {
  const terms: string[] = [];
  const cjk: string[] = [];
  for (const chunk of lower.split(SEP_RE)) {
    if (!chunk) continue;
    const chars = [...chunk];
    for (let i = 0; i < chars.length; ) {
      const cjkRun = isCjk(chars[i]!);
      let j = i;
      while (j < chars.length && isCjk(chars[j]!) === cjkRun) j++;
      const run = chars.slice(i, j).join('');
      if (!cjkRun || run.length === 1) {
        terms.push(run); // 非 CJK 段原样；单字 CJK 保留（避免 1 字查询无词）
      } else {
        for (let k = 0; k + 2 <= run.length; k++) terms.push(run.slice(k, k + 2));
      }
      i = j;
    }
    for (const ch of chars) if (isCjk(ch)) cjk.push(ch);
  }
  return { terms: [...new Set(terms)], cjk: cjk.join('') };
}

export function analyzeQuery(query: string): QueryTerms {
  const lower = query.toLowerCase();
  const base = tokenizeChunks(lower);
  // 简繁归一：只有"真的会变体"的句子才多切几次（纯简体/纯拉丁/纯日韩走下来只有一次）
  const alts: TermSet[] = [];
  for (const cand of hansCandidates(lower, 3)) {
    if (cand === lower) continue;
    const set = tokenizeChunks(cand);
    if (set.terms.length) alts.push(set);
  }
  return { ...base, alts };
}

export interface TextSimilarity {
  /** 交集 / 较小集合（"同一主语/同一件事"的证据：多数词都重合） */
  contain: number;
  /** 词集 Jaccard（换了说法/改了数目就会掉下来） */
  jaccard: number;
}

/**
 * 两段文本的相似度（**跨体一致**）：在"原文/简体候选"两边的**所有配对里取最像的那一组**。
 *
 * 为什么要配对而不是把候选并成一个集合：并集会让"繁体那一侧"的词集凭空变大，
 * Jaccard 被稀释——实测同一件事的简繁两条反而比"同主语换了说法"的两条**更像不相关**
 * （简/繁 same fact contain .82/jaccard .53 vs 火锅/拉面 .82/.69），判断就反了。
 * 配对之后：简繁同一件事 ≈ 1.0（因为繁体归一化那条路会把词集对齐），火锅/拉面仍是 .69。
 */
export function textSimilarity(a: string, b: string): TextSimilarity {
  const formsA = hansCandidates(String(a).toLowerCase(), 3).map((f) => tokenizeChunks(f).terms);
  const formsB = hansCandidates(String(b).toLowerCase(), 3).map((f) => tokenizeChunks(f).terms);
  let best: TextSimilarity = { contain: 0, jaccard: 0 };
  let bestRank = -1;
  for (const ta of formsA) {
    if (ta.length === 0) continue;
    const setA = new Set(ta);
    for (const tb of formsB) {
      if (tb.length === 0) continue;
      const setB = new Set(tb);
      let inter = 0;
      for (const t of setA) if (setB.has(t)) inter++;
      if (inter === 0) continue;
      const contain = inter / Math.min(setA.size, setB.size);
      const jaccard = inter / (setA.size + setB.size - inter);
      const rank = Math.min(contain, jaccard);   // "两边都像"才算这一组更像
      if (rank > bestRank) { bestRank = rank; best = { contain, jaccard }; }
    }
  }
  return best;
}

/**
 * 条目**正文**（description + content）——"是不是同一件事"只该看它俩。
 * 为什么不带 name/tags：键是**内部字段**（`session.<id>.fact.<text>` 之类），
 * 拿来做相似度会把所有条目都拉近一点（实测同一件事的简繁两条只到 0.87，卡在阈值边上）；
 * 检索打分那边照旧用 `entryText`（带 name/tags，按名字搜得到）。
 */
export function entryBody(e: { description: string; content: string }): string {
  return `${e.description} ${e.content}`;
}

/** 兼容入口：只要检索词（旧 tokenize 的签名） */
export function tokenize(query: string): string[] {
  return analyzeQuery(query).terms;
}

/** 条目可检索文本（name/description/tags/content 拼接，与旧实现一致） */
export function entryText(e: { name: string; description: string; tags: string[]; content: string }): string {
  return `${e.name} ${e.description} ${e.tags.join(' ')} ${e.content}`;
}

export interface KeywordScore {
  /** 0~1 */
  score: number;
  /** 最长连续命中字符数（0=无 / 1=单字 / 2=双字词 / 3 / N…） */
  bestRun: number;
  /** 命中的检索词数 */
  hits: number;
}

/**
 * 连续命中加成：run=2（两字词命中）已是有意义证据；长 query 里 cover 会被词数稀释，由它兜底。
 * hits 加分：命中多个**独立**词是更强的证据（否则"只命中一个常见双字词"会与"命中两个关键词"打平）。
 */
function runBoost(run: number, hits: number): number {
  const base = run >= 4 ? 0.9 : run === 3 ? 0.72 : run === 2 ? 0.45 : 0;
  if (base === 0) return 0;
  return base + Math.min(hits - 1, 4) * 0.05;
}

/** 出现次数（tf），封顶 5（打分侧 min(tf,4) 只需知道 ≥4） */
function countOccurrences(text: string, needle: string): number {
  let n = 0;
  let i = text.indexOf(needle);
  while (i !== -1 && n < 5) {
    n++;
    i = text.indexOf(needle, i + 1);
  }
  return n;
}

/**
 * 最长连续命中（字符数）：CJK 串上相邻双字是否都出现在文本里。
 * 近似"最长公共子串"——只判"相邻双字都在"，不做位置对齐（记忆条目短，误报代价低；换掉 O(n·m) 的动态规划）。
 */
function bestRunChars(cjk: string, hit: (s: string) => boolean): number {
  const chars = [...cjk];
  if (chars.length === 0) return 0;
  if (chars.length === 1) return hit(chars[0]!) ? 1 : 0;
  let best = 0;
  let cur = 0;
  for (let i = 0; i + 2 <= chars.length; i++) {
    if (hit(chars[i]! + chars[i + 1]!)) {
      cur++;
      if (cur + 1 > best) best = cur + 1;
    } else {
      cur = 0;
    }
  }
  return best;
}

/**
 * 软上限：0.9 以下线性（各阈值语义不变），以上渐近趋近 1。
 * 不用 min(1,x)：那会在 1.0 处形成平台，把 tf 差异抹平——评测里"猫×6 vs 猫×2"曾因此打平（新条目反而赢）。
 */
function softCap(x: number): number {
  if (x <= 0.9) return x;
  return 1 - 0.1 * Math.exp(-(x - 0.9) / 0.1);
}

/** 一种写法对一种写法打分（原实现，一字未动） */
function scoreOne(t: string, q: TermSet): KeywordScore {
  if (q.terms.length === 0) return { score: 0, bestRun: 0, hits: 0 };
  const matched = new Map<string, boolean>();
  let raw = 0;
  let hits = 0;
  for (const term of q.terms) {
    const tf = countOccurrences(t, term);
    matched.set(term, tf > 0);
    if (tf === 0) continue;
    hits++;
    raw += 1 + Math.min(tf, 4) * 0.5;
  }
  const cover = raw / (2 * q.terms.length);
  const run = bestRunChars(q.cjk, (s) => matched.get(s) ?? t.includes(s));
  return { score: softCap(Math.max(cover, runBoost(run, hits))), bestRun: run, hits };
}

/**
 * 打分：词数归一覆盖度与"最长连续命中"取大（0~1）。
 * 简繁两种写法各试一遍取最高——**取最高**这件事本身就是"两种写法判断一致"的保证
 * （同一句话写成繁体或简体，打同一条记忆的分不会不一样）。
 */
export function scoreTerms(text: string, q: QueryTerms): KeywordScore {
  if (q.terms.length === 0 && q.alts.length === 0) return { score: 0, bestRun: 0, hits: 0 };
  const t = text.toLowerCase();
  const forms: TermSet[] = [q, ...(q.alts ?? [])];
  let best: KeywordScore = { score: 0, bestRun: 0, hits: 0 };
  for (const tf of hansCandidates(t, 3)) {
    for (const qf of forms) {
      const s = scoreOne(tf, qf);
      if (s.score > best.score || (s.score === best.score && s.hits > best.hits)) best = s;
      if (best.score >= 0.9) return best; // 顶格了，别的写法不可能更高
    }
  }
  return best;
}

/** 便捷入口：原始查询 + 文本 */
export function scoreText(text: string, query: string): KeywordScore {
  return scoreTerms(text, analyzeQuery(query));
}
