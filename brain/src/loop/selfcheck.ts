// 自我校验 selfCheck（防幻觉）：零成本纯本地规则匹配，不调用外部模型。
// 最终回答前执行一次（config.reliability.selfCheck=true，默认开）：
//   1) 扫描最终文本中的具体事实/数字/文件名/URL/日期；
//   2) 与最近 4 个 tool_result 及历史已确认事实一致性核对；
//   3) 找不到依据的 → 就地标注【未核实】或删除；
//   4) 冲突复核由 reliability.reflect 控制（默认关，避免成本；TODO(spec) 复核回路）。
import type { ChatMessage } from '../llm/provider.js';
import { messageText } from '../llm/provider.js';

export interface SelfCheckFlag {
  text: string;
  rule: string;
}

export interface SelfCheckResult {
  text: string;
  flags: SelfCheckFlag[];
}

// 数字事实：**必须带单位、或至少两位、或带小数点**才算"可核对的事实"。
// 由来：旧正则把「文件 1」「第 3 段」里的单个数字也当事实去要来源，
// 于是整段回答被标成一排【未核实】——噪声把真正的无依据数字（比如编造的"20 KB"）淹没了。
const NUMBER_RE = /\b(?:\d{2,}(?:\.\d+)?|\d+\.\d+)(?: ?(?:%|元|块|万|亿|千|百|个|条|次|秒|分|小时|天|周|月|年|岁|GB|MB|KB|TB|km|m|kg|g|tokens?))?\b|\b\d+(?:\.\d+)? ?(?:%|元|块|万|亿|GB|MB|KB|TB|tokens?)\b/;
const FILENAME_RE = /[\w./~-]+\.(?:md|txt|ts|js|mjs|json|yaml|yml|php|py|sh|html|css|vue|png|jpg|jpeg|gif|webp|pdf|docx|xlsx|pptx|zip|sql)\b/;
const URL_RE = /https?:\/\/[^\s"'，。；、）】]+/;
const DATE_RE = /\b\d{4}[-/年]\d{1,2}(?:[-/月]\d{1,2})?(?:日|号)?\b|\b\d{1,2}月\d{1,2}日\b/;

interface FactMatch {
  fact: string;
  start: number;
  end: number;
  rule: string;
}

const FACT_RULES: Array<{ re: RegExp; rule: string }> = [
  { re: URL_RE, rule: 'url-no-source' },
  { re: FILENAME_RE, rule: 'filename-no-source' },
  { re: DATE_RE, rule: 'date-no-source' },
  { re: NUMBER_RE, rule: 'number-no-source' },
];

/** 采集事实（带位置）；重叠时长匹配优先（如日期 2026-08-21 覆盖其数字片段） */
function findFacts(text: string): FactMatch[] {
  const matches: FactMatch[] = [];
  for (const { re, rule } of FACT_RULES) {
    for (const m of text.matchAll(new RegExp(re.source, 'g'))) {
      if (m.index === undefined) continue;
      matches.push({ fact: m[0], start: m.index, end: m.index + m[0].length, rule });
    }
  }
  matches.sort((a, b) => a.start - b.start || b.end - a.end);
  const kept: FactMatch[] = [];
  let coveredUntil = -1;
  for (const m of matches) {
    if (m.start < coveredUntil) continue;
    kept.push(m);
    coveredUntil = m.end;
  }
  return kept;
}

/**
 * 证据来源：三处都算——① 最近 6 条 tool_result ② 最近 3 条 assistant 消息里的**工具调用参数**
 * ③ 最近一条 assistant 正文（她把文件名/数字写在**自己调用的工具参数**里，
 * 旧口径只看 tool_result 正文 → 文件名与数字被大面积标成【未核实】）。
 */
export function collectEvidence(history: ChatMessage[]): string {
  const parts: string[] = [];
  const toolMsgs = history.filter((m) => m.role === 'tool').slice(-6);
  for (const m of toolMsgs) parts.push(messageText(m));
  for (const m of history.filter((x) => x.role === 'assistant').slice(-3)) {
    for (const call of m.toolCalls ?? []) {
      try { parts.push(`${call.name} ${JSON.stringify(call.args ?? {})}`); } catch { /* 忽略无法序列化的参数 */ }
    }
  }
  const assistants = history.filter((m) => m.role === 'assistant');
  if (assistants.length > 0) parts.push(messageText(assistants[assistants.length - 1]!));
  return parts.join('\n');
}

/**
 * 校验最终文本。无 tool_result 证据（纯对话）时跳过——selfCheck 守护工具产出的回答，
 * 纯聊天的常识性数字不误伤。TODO(spec)：reflect=true 时返回 needsReflect 供模型复核。
 */
export function selfCheck(text: string, evidence: string): SelfCheckResult {
  if (evidence.length === 0) return { text, flags: [] };
  const flags: SelfCheckFlag[] = [];
  let out = text;
  for (const m of findFacts(text)) {
    if (evidence.includes(m.fact)) continue; // 有依据 → 保留
    out = out.replace(m.fact, `${m.fact}【未核实】`);
    flags.push({ text: m.fact, rule: m.rule });
  }
  return { text: out, flags };
}
