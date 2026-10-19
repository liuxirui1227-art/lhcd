// 压缩的"选择性丢弃"（Selective Drop）
//
// 为什么单独抽出来：压缩不是"一刀切"地整段换成摘要，而是**挑着丢**：
// 旧工具输出（最大头）、重复内容、已完成的中间过程先丢，
// 用户说过的话与她最后说过的话**留着**（那些短、且是"关系资产"）。
//
// 三条规矩（写死在这里，测试守着）：
//   1. **用户消息一条不丢**——她说过的话不该被摘要"转述"掉；
//   2. **最后一条助手消息不丢**——"接着讲"要接得上；
//   3. 只丢"大块头"（超过阈值的工具输出）与**连续重复**的内容；丢掉的原文仍进 `archive.jsonl`
//      （`SessionArchive`），所以是"延迟检索"而不是"丢失"。
import type { ChatMessage } from '../llm/provider.js';
import { messageText } from '../llm/provider.js';
import { estimateTokens } from '../prompt/tokens.js';

export interface SelectOptions {
  /** 超过这个 token 数的**工具输出**才考虑丢（默认 400 ≈ 1200 字符） */
  toolMaxTokens?: number;
  /* ⚠ 别在这里加"某一条之后一律不碰"之类的选项：**留一个不会生效的承诺最坏**——
     照注释传参的人会拿到"尾部照样被丢"的静默结果。尾部保护是调用方的事：
     `compact.ts` 自己 `slice(0, -4)` 把尾巴切出来，压根不进本函数。 */
}

export interface SelectResult {
  /** 留下（原样进历史） */
  kept: ChatMessage[];
  /** 丢掉（进归档 + 喂给摘要） */
  dropped: ChatMessage[];
  /** 人话理由（进事件/日志，便于解释"为什么这次压缩这么狠"） */
  reasons: string[];
}

/** 内容指纹（去重判据；只看正文，不看角色标记） */
function contentKey(m: ChatMessage): string {
  return `${m.role}::${messageText(m).trim()}`;
}

/**
 * 把一段历史切成"留"与"丢"。
 * 纯函数：不改入参、不读盘、不调模型——所以可以直接写单测。
 */
export function selectRegion(region: ChatMessage[], opts: SelectOptions = {}): SelectResult {
  const toolMax = opts.toolMaxTokens ?? 400;
  const kept: ChatMessage[] = [];
  const dropped: ChatMessage[] = [];
  const reasons: string[] = [];
  const lastAssistantIdx = (() => {
    for (let i = region.length - 1; i >= 0; i--) if (region[i]!.role === 'assistant') return i;
    return -1;
  })();
  const lastUserIdx = (() => {
    for (let i = region.length - 1; i >= 0; i--) if (region[i]!.role === 'user') return i;
    return -1;
  })();

  let bigDropped = 0;
  let dupDropped = 0;
  const seen = new Map<string, number>(); // key → 已保留的下标（用于"连续重复"判定）

  region.forEach((m, i) => {
    const text = messageText(m);
    const tokens = estimateTokens(text);

    // 规矩 1/2：用户消息与最后一条助手消息一律留
    if (m.role === 'user') { kept.push(m); seen.set(contentKey(m), i); return; }
    if (i === lastAssistantIdx || i === lastUserIdx) { kept.push(m); seen.set(contentKey(m), i); return; }
    // 摘要块本身（压缩产出的那条 user 消息，走的是 user 分支，这里只防意外）
    if (text.startsWith('【会话压缩摘要')) { kept.push(m); return; }

    // 规矩 3a：连续重复 → **留先出现的那条，丢后一条**（`seen` 存的是"已保留的下标"，
    //   轮到后面那条时命中 → 丢的是**当前**这条）。
    //   两条内容逐字相同，留哪条都一样，以代码为准。
    const key = contentKey(m);
    const prevSame = seen.get(key);
    if (prevSame !== undefined && i - prevSame <= 4 && m.role === 'tool') {
      // 只对工具输出去重：模型连着调同一个工具、拿到一样的结果，是最典型的浪费
      dropped.push(m);
      dupDropped++;
      return;
    }

    // 规矩 3b：大块头工具输出 → 丢（原文进归档）
    if (m.role === 'tool' && tokens > toolMax) {
      dropped.push(m);
      bigDropped++;
      return;
    }

    kept.push(m);
    seen.set(key, i);
  });

  if (bigDropped > 0) reasons.push(`丢掉 ${bigDropped} 条超大工具输出（>${toolMax} token，原文在存档里可检索）`);
  if (dupDropped > 0) reasons.push(`丢掉 ${dupDropped} 条与前面重复的工具输出`);

  /* 配对修复：工具结果被丢 → **必须**把它在 assistant 上那条 `toolCalls` 一起摘掉。
     否则请求体里会出现「有 tool_calls、没有对应 tool 响应」的孤儿，OpenAI 系（DeepSeek / 百炼 / vLLM）
     一律 400 拒收（"An assistant message with 'tool_calls' must be followed by tool messages"）；
     而 mock 适配器不校验，只测 mock 的话这处会静默不报错，只有真 key + 长会话才炸。
     反向孤儿（留着 tool 结果、父消息却不在）在本函数里不可能：assistant 消息一条都不丢。 */
  let orphanFixed = 0;
  const keptToolIds = new Set(kept.filter((m) => m.role === 'tool' && m.toolCallId).map((m) => m.toolCallId!));
  const repaired = kept.map((m) => {
    if (m.role !== 'assistant' || !m.toolCalls?.length) return m;
    const calls = m.toolCalls.filter((c) => keptToolIds.has(c.id));
    if (calls.length === m.toolCalls.length) return m;
    orphanFixed += m.toolCalls.length - calls.length;
    return calls.length ? { ...m, toolCalls: calls } : { ...m, toolCalls: undefined };
  });
  if (orphanFixed > 0) reasons.push(`摘掉 ${orphanFixed} 条失去工具结果的调用记录（不摘会让请求体非法）`);

  return { kept: repaired, dropped, reasons };
}
