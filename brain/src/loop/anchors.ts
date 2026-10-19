// 锚点索引：正则**机械抠出**精确标识符（编号/路径/报错/网址/日期/金额），完全不过 LLM。
// 为什么需要：一次压缩摘要装不下被压区域的具体信息，摘要转述会把精确东西糊掉。
// 中文会话里最不该被摘要转述的正是**名字、日期、承诺、约定**——那些是"针状事实"，必须原样留。
// 纪律：只做机械提取（正则+计数排序），不做任何"理解"；预算封顶，超了就按频次截断。

export interface AnchorValue {
  value: string;
  count: number;
}

export interface AnchorSection {
  label: string;
  values: AnchorValue[];
}

/** 分类与上限：每类封顶 + 按频次排序 */
const ANCHOR_PATTERNS: Array<{ label: string; re: RegExp; cap: number }> = [
  { label: '文件', re: /(?:[\w.@~-]+\/)+[\w.一-鿿-]+\.(?:ts|tsx|js|mjs|cjs|md|json|ya?ml|toml|sh|py|html|css|txt|log)\b/g, cap: 30 },
  { label: '网址', re: /https?:\/\/[^\s)"'，。]{6,120}/g, cap: 15 },
  { label: '编号', re: /#\d{2,6}\b/g, cap: 20 },
  { label: '提交', re: /\b[0-9a-f]{7,40}\b/g, cap: 10 },
  { label: '报错', re: /\b(?:[A-Z][a-zA-Z]*(?:Error|Exception)|E[A-Z]{3,}|SIG[A-Z]+|Traceback)\b/g, cap: 15 },
  { label: '邮箱', re: /[\w.+-]+@[\w-]+\.[\w.-]+/g, cap: 10 },
  { label: '日期', re: /\b20\d{2}[-/.]\d{1,2}[-/.]\d{1,2}\b|\b\d{1,2}月\d{1,2}日\b/g, cap: 15 },
  // 注意：单位后不能挂 \b——JS 的 \w 不含 CJK，"300 元" 后面永远没有词边界
  { label: '金额', re: /[¥$€]\s?\d[\d,]*(?:\.\d+)?|\d[\d,]*(?:\.\d+)?\s?(?:元|块|美元|日元|欧元)/g, cap: 10 },
];

/** 锚点索引总预算（字符）——摘要块不能因为锚点再膨胀回去 */
export const ANCHOR_BUDGET_CHARS = 1000;

/** 机械提取锚点：按 "频次降序 → 最近出现优先" 排序，每类封顶、总量封顶 */
export function buildAnchorIndex(text: string, budgetChars: number = ANCHOR_BUDGET_CHARS): AnchorSection[] {
  if (!text.trim()) return [];
  const sections: AnchorSection[] = [];
  let used = 0;
  for (const { label, re, cap } of ANCHOR_PATTERNS) {
    const counts = new Map<string, number>();
    const lastSeen = new Map<string, number>();
    let n = 0;
    for (const m of text.matchAll(re)) {
      const value = m[0].trim().replace(/[.,;:，。；：]+$/, '');
      if (!value) continue;
      counts.set(value, (counts.get(value) ?? 0) + 1);
      lastSeen.set(value, n++);
    }
    if (counts.size === 0) continue;
    const ranked = [...counts.keys()]
      .sort((a, b) => (counts.get(b)! - counts.get(a)!) || (lastSeen.get(b)! - lastSeen.get(a)!))
      .slice(0, cap)
      .map((value) => ({ value, count: counts.get(value)! }));
    const lineLen = label.length + 2 + ranked.reduce((s, v) => s + v.value.length + 6, 0);
    if (used + lineLen > budgetChars) {
      // 超预算：按剩余空间截断这一类，然后收工
      const room = budgetChars - used - label.length - 2;
      if (room <= 0) break;
      const kept: AnchorValue[] = [];
      let acc = 0;
      for (const v of ranked) {
        if (acc + v.value.length + 6 > room) break;
        kept.push(v);
        acc += v.value.length + 6;
      }
      if (kept.length > 0) sections.push({ label, values: kept });
      break;
    }
    used += lineLen;
    sections.push({ label, values: ranked });
  }
  return sections;
}

/** 渲染成人话段落（附在摘要块后面给模型看） */
export function renderAnchors(sections: AnchorSection[]): string {
  if (sections.length === 0) return '';
  const lines = sections.map(
    (s) => `${s.label}：${s.values.map((v) => (v.count > 1 ? `${v.value}(×${v.count})` : v.value)).join('、')}`,
  );
  return [
    '## 精确锚点（机械提取，未过模型）',
    ...lines,
    '（这些是被压缩区域里出现过的精确标识符：**原样使用**，不要改写；也可以拿它们当 session_search 的查询锚点去找回完整上下文。）',
  ].join('\n');
}
