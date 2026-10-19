// 降级匹配：四档从紧到松——"精确 → 忽略行尾空白 → 两端 trim → Unicode 标点归一"。
//
// 出处（逐条对照过源码）：
//   · codex `codex-rs/apply-patch/src/seek_sequence.rs:39-112` —— **四档顺序**（精确 / trim_end / trim / 归一）
//     及归一表的码点清单（破折号 2010~2015+2212、引号 2018~201B|201C~201F、异体空格 00A0/2002~200A/202F/205F/3000）
//   · pi `packages/coding-agent/src/core/tools/edit-diff.ts:27-55` —— normalizeForFuzzyMatch（NFKC + 逐行 trimEnd
//     + 同三张表）；`:207-245` 匹配阶梯（它只有两档：精确 / 一次全开）；`:328-331` 唯一性在**归一化空间**里数
//
// 与上面两家实现的两处不同（都是有意为之）：
//   ① **回报用了哪一档**——pi 的 `usedFuzzyMatch`（`:183`）只在内部用于选替换策略，**从不进给模型的文本**
//      （`:203-211` 一律回 `Successfully replaced N block(s)`）；codex 无此概念。模型于是不知道自己
//      "是靠归一化蒙对的"，也就不会复核这一处。我们必须把档位写进成功话术，并请它核对。
//   ② **每一档都要求唯一**——codex 首命中即返回（无唯一性检查，`:39-112` 全程只有一个 `return Some(i)`）；
//      我们沿用自家红线：多处命中必须报错并要求补上下文（静默改错行不可接受）。
//      因此精确档命中 >1 处时**直接判失败、不再往下降级**——更宽松的档只会命中更多，不可能更唯一。
//
// 另：归一化做了**下标映射**（map[i] = 归一化字符 i 在原串里的位置），所以替换发生在**原串**上，
// 只换掉命中的那一段，其余字节一个不动。pi 是反过来"整个文件在归一化空间里替换再决定写回多少"
// （`edit-diff.ts:317-318/353-355`），那样有把全角标点顺手改成半角的风险——改文档不能有这种副作用。

export type MatchTier = 'exact' | 'rstrip' | 'trim' | 'punct';

/** 档位顺序即降级顺序（codex `seek_sequence.rs:39/45/58/72` 四段循环的顺序） */
export const TIER_ORDER: MatchTier[] = ['exact', 'rstrip', 'trim', 'punct'];

/** 档位人话（进给模型的话术；别改字面量时漏改测试） */
export const TIER_LABEL: Record<MatchTier, string> = {
  exact: '逐字相同',
  rstrip: '忽略行尾空白',
  trim: '忽略行首行尾空白',
  punct: '标点/空格归一（全角引号、破折号、全角空格与 ASCII 等价）',
};

/**
 * 逐字符归一表（长度不变）。码点清单逐条对照 codex `seek_sequence.rs:76-97` 的 `normalise`。
 * 只做"等价写法"的映射，不做大小写折叠、不做 NFKC——NFKC 会改变长度（`ﬁ`→`fi` 这类），
 * 破坏我们的下标映射（pi 用了 NFKC，代价是它必须整篇在归一化空间里替换，见文件头 ③ 条）。
 */
const PUNCT_MAP = new Map<string, string>([
  // 破折号/连字符家族 → '-'
  ['‐', '-'], ['‑', '-'], ['‒', '-'], ['–', '-'],
  ['—', '-'], ['―', '-'], ['−', '-'],
  // 花引号 → ASCII 引号
  ['‘', "'"], ['’', "'"], ['‚', "'"], ['‛', "'"],
  ['“', '"'], ['”', '"'], ['„', '"'], ['‟', '"'],
  // 异体空格 → 普通空格
  [' ', ' '], [' ', ' '], [' ', ' '], [' ', ' '], [' ', ' '],
  [' ', ' '], [' ', ' '], [' ', ' '], [' ', ' '], [' ', ' '],
  [' ', ' '], [' ', ' '], ['　', ' '],
]);

// 全角 ASCII 形式（U+FF01~U+FF5E）→ 对应 ASCII（U+0021~U+007E，减 0xFEE0）：
// 全角逗号/冒号/问号/括号、全角字母数字都在这段里。与 pi 的 `.normalize("NFKC")`（`edit-diff.ts:33`）
// 在这段上等价，但**逐字符 1:1**——这就是我们不做全局 NFKC 的原因：NFKC 有 1:N 映射（`ﬁ`→`fi`、
// 半角片假名合成），会破坏下标对齐，逼得调用方"整篇在归一化空间里替换再决定写回多少"
// （pi `:317-355`），那有把文档标点悄悄改成半角的风险。codex 的手写表里没有这一段
// （`seek_sequence.rs:76-97`），所以「全角逗号/冒号 vs 半角」在它那里匹配不上，在我们这里能。
for (let c = 0xff01; c <= 0xff5e; c++) PUNCT_MAP.set(String.fromCharCode(c), String.fromCharCode(c - 0xfee0));

export interface MatchResult {
  found: boolean;
  /** 命中次数：0=没找到；1=唯一命中；>1=多处命中（按我们的红线，这是个**失败**，不是"取第一个"） */
  count: number;
  /** 原串里的替换区间 [start, end)（仅在 count===1 时有意义） */
  start: number;
  end: number;
  /** 实际命中的档（found=true 时有效）；exact 以外的档 = "降级命中"，调用方必须回报给模型 */
  tier: MatchTier;
  /** 依次试过哪些档（回显用：让模型知道"连最宽松的档都没匹配上"） */
  triedTiers: MatchTier[];
}

function countOf(text: string, needle: string): number {
  if (!needle) return 0;
  return text.split(needle).length - 1;
}

/**
 * 归一化副本 + 下标映射。
 * rstrip：逐行去行尾空白；trim：逐行去首尾空白；punct：逐字符查表（长度不变）。
 * map[i] = 归一化串第 i 个字符在原串里的下标。
 */
function normalizeWithMap(text: string, mode: Exclude<MatchTier, 'exact'>): { out: string; map: number[] } {
  let out = '';
  const map: number[] = [];
  let pos = 0; // 当前行的起始下标
  const lines = text.split('\n');
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li]!;
    let from = 0;
    let to = line.length;
    if (mode === 'trim') {
      while (from < to && /\s/.test(line[from]!)) from++;
    }
    if (mode === 'trim' || mode === 'rstrip') {
      while (to > from && /\s/.test(line[to - 1]!)) to--;
    }
    for (let i = from; i < to; i++) {
      const ch = line[i]!;
      out += mode === 'punct' ? (PUNCT_MAP.get(ch) ?? ch) : ch;
      map.push(pos + i);
    }
    if (li < lines.length - 1) {
      out += '\n';
      map.push(pos + line.length);
    }
    pos += line.length + 1;
  }
  return { out, map };
}

/**
 * 按四档从紧到松找一个唯一命中。返回的 [start,end) 是**原串**上的区间。
 * 精确档多处命中 → 立即返回 count（不再降级：更宽松的档不可能更唯一）。
 */
export function findMatch(original: string, old: string): MatchResult {
  const tried: MatchTier[] = [];
  if (!old) return { found: false, count: 0, start: -1, end: -1, tier: 'exact', triedTiers: tried };

  for (const tier of TIER_ORDER) {
    tried.push(tier);
    if (tier === 'exact') {
      const count = countOf(original, old);
      if (count > 1) return { found: false, count, start: -1, end: -1, tier, triedTiers: tried };
      if (count === 1) {
        const start = original.indexOf(old);
        return { found: true, count, start, end: start + old.length, tier, triedTiers: tried };
      }
      continue;
    }
    // 降级档：在归一化空间里找，再用下标映射回到原串
    const doc = normalizeWithMap(original, tier);
    const pat = normalizeWithMap(old, tier);
    if (!pat.out) continue;
    const count = countOf(doc.out, pat.out);
    if (count > 1) return { found: false, count, start: -1, end: -1, tier, triedTiers: tried };
    if (count === 1) {
      const i = doc.out.indexOf(pat.out);
      const start = doc.map[i]!;
      const end = doc.map[i + pat.out.length - 1]! + 1;
      return { found: true, count, start, end, tier, triedTiers: tried };
    }
  }
  return { found: false, count: 0, start: -1, end: -1, tier: 'exact', triedTiers: tried };
}
