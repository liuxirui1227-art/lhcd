// 压缩：历史 token > compactAtTokens 触发。
// 统一路径：compact.start → compact 角色（temperature 0.3）独立请求（输出 JSON）
//   → 成功替换为 [摘要块, ...最后 4 条原文]；失败降级保留最后 8 条 + 首条 user。
// 不变量：只动历史，frozen 原样。
// 另外两件：① 压缩前先把要丢的原文**归档**（"压缩 = 延迟检索"而不是"压缩 = 丢失"）；
//            ② 摘要块后面附**锚点索引**（机械提取的精确标识符）与**找回提示**（点名 session_search，别猜）。
import type { Session } from './session.js';
import { COMPACT_PROMPT, parseCompactJson, type CompactSummary } from '../prompt/compact.js';
import { buildAnchorIndex, renderAnchors, type AnchorSection } from './anchors.js';
import { SessionArchive } from '../session/archive.js';
import { messageText } from '../llm/provider.js';
import { selectRegion } from './select.js';
import { renderPreviousSummary } from '../prompt/compact.js';
import { estimateTokens } from '../prompt/tokens.js';

export interface CompactResult {
  ok: boolean;
  beforeTokens: number;
  afterTokens: number;
  reason?: string;
  /** 本次归档进 archive.jsonl 的条数（0 = 没有可归档的原文） */
  archived?: number;
}

/** 摘要输入预算（字符）。超过就把"要压缩的历史"**均匀采样**后再发——别让摘要请求自己装不下。
 *  出处：hermes `agent/context_compressor.py:3178 _sample_summary_input`（"EVEN SAMPLING … head+tail
 *  truncation would hide the entire middle"）。没有这道护栏的话：历史一长，发给压缩模型的就是一整坨，
 *  撞上装不下只会静默走"JSON 解析失败→降级丢原文"。 */
export const SUMMARY_INPUT_MAX_CHARS = 60_000;

/**
 * 均匀采样：头、尾各留，中间**按等间隔抽**——掐头去尾会把整段中段藏起来，而那正是最需要摘要的部分。
 * 返回 { text, elided }；elided = 被抽掉的行数（0 表示没抽）。
 */
export function sampleForSummary(lines: string[], maxChars: number): { text: string; elided: number } {
  const all = lines.join('\n');
  if (all.length <= maxChars || lines.length <= 3) return { text: all, elided: 0 };
  const avg = Math.max(1, Math.ceil(all.length / lines.length));
  const keep = Math.max(3, Math.floor(maxChars / avg)); // 大约能放下多少条
  if (keep >= lines.length) return { text: all, elided: 0 };
  const picked: string[] = [];
  const head = Math.max(1, Math.floor(keep / 4));      // 开头 1/4：交代来龙
  const tail = Math.max(1, Math.floor(keep / 4));      // 结尾 1/4：最近发生的事
  const mid = keep - head - tail;
  for (let i = 0; i < head; i++) picked.push(lines[i]!);
  picked.push(`…（中间省略 ${lines.length - keep} 条，原文完整保留在会话存档里——用 session_search 能取回）…`);
  const midStart = head;
  const midEnd = lines.length - tail;
  const step = Math.max(1, Math.floor((midEnd - midStart) / Math.max(1, mid)));
  for (let i = midStart; i < midEnd && picked.length < keep + 1; i += step) picked.push(lines[i]!);
  for (let i = Math.max(midEnd, lines.length - tail); i < lines.length; i++) picked.push(lines[i]!);
  return { text: picked.join('\n'), elided: lines.length - keep };
}

/** 摘要块消息（user 角色承载，供下一回合继续执行） */
export function summaryMessage(summary: CompactSummary) {
  return {
    role: 'user' as const,
    content: `【会话压缩摘要（结构化）】\n${JSON.stringify(summary, null, 2)}`,
  };
}

/** 被压缩区域的锚点索引（纯正则，零模型调用） */
export function anchorsFor(messages: Array<{ role: string; content: unknown; toolCallId?: string }>): AnchorSection[] {
  const text = messages.map((m) => messageText(m as never)).join('\n');
  return buildAnchorIndex(text);
}

/**
 * 摘要块全文 = 结构化摘要 + 锚点索引 + 找回提示。
 * 找回提示必须点名真实存在的工具与真实存在的存档，否则就是空话。
 */
/**
 * 状态重建：把八项摊成一段**人话的"任务现状"**放在摘要块最前面。
 * 为什么不能只丢一份 JSON 进去：模型对着 JSON 容易"读过就算"，而这一段是"接着干"的行动清单——
 * 压缩之后她要能直接答出"还剩什么没做 / 卡在哪 / 定过什么 / 哪些文件动过 / 什么还没验证"。
 */
export function renderStateBlock(summary: CompactSummary): string {
  const line = (label: string, arr: string[]) => (arr.length ? `- **${label}**：${arr.join('；')}` : '');
  const rows = [
    line('目标', summary.goal ? [summary.goal] : []),
    line('已完成', summary.done),
    line('正在做', summary.in_progress),
    line('卡住（卡在哪）', summary.blocked),
    line('已定的决定', summary.decisions),
    line('必须遵守的约束', summary.constraints),
    line('试过没成的（别再撞）', summary.failures),
    line('文件状态', summary.file_states),
    line('做完但没验证', summary.todo_verify),
  ].filter(Boolean);
  if (rows.length <= 1) return ''; // 只有目标 → 没什么可重建的，不硬凑一段
  return ['## 任务现状（压缩后据此接着干）', ...rows].join('\n');
}

export function renderCompactBlock(summary: CompactSummary, anchors: AnchorSection[], regionLen: number): string {
  const state = renderStateBlock(summary);
  const parts = [
    state ? `${state}\n\n【会话压缩摘要（结构化）】\n${JSON.stringify(summary, null, 2)}` : `【会话压缩摘要（结构化）】\n${JSON.stringify(summary, null, 2)}`,
  ];
  const anchorText = renderAnchors(anchors);
  if (anchorText) parts.push(anchorText);
  if (regionLen > 0) {
    parts.push(
      [
        '## 找回路径',
        `被压缩的 ${regionLen} 条消息**完整保留**在会话存档里（没有删）。这份摘要没带的细节——原始命令输出、文件内容、报错原文、早先的推理、原话——`,
        "用 `session_search(query='<关键词>')` 就能取回；锚点里的标识符可以直接当查询词。",
        '**能查到就别猜**：不确定的细节先查再答。',
      ].join('\n'),
    );
  }
  return parts.join('\n\n');
}

export async function compactSession(session: Session, signal?: AbortSignal): Promise<CompactResult> {
  const beforeTokens = session.estimateTokens();
  session.emit({ type: 'compact.start', beforeTokens });

  /* 选择性丢弃：把"要压缩的那段"先切一刀——
     大块头工具输出与重复的工具输出**丢**（原文进归档），用户说过的话与她最后说过的话**留**。
     这样"她说过的话"不会被摘要转述掉，而真正占地方的东西照样出上下文（要用时 session_search 取回）。 */
  const tailLen = 4;
  const region = session.history.slice(0, Math.max(0, session.history.length - tailLen));
  const { kept, dropped, reasons: dropReasons } = selectRegion(region, { toolMaxTokens: 400 });
  /* 兜底：如果"留下来的"本身就很占地方（超过压缩点的一成五），就退回老路（整段换摘要），
     免得"选择性丢弃"变成"什么都没省"。 */
  const keptTokens = kept.reduce((n, m) => n + estimateTokens(messageText(m)), 0);
  /* 两个条件同时成立才"保留原文"：
     ① **真的丢了东西**（`dropped.length > 0`）——一条都没丢时整段换摘要才有意义，否则上下文根本不缩；
     ② 留下来的没占太多地方（< 压缩点的 15%，且不少于 2000 token 的兜底）。
     两条都不满足 → 退回老路（整段换摘要 + 留最后 4 条）。这条兜底很重要：
     `runTurn` 一个回合只压一次，压完还超上限就直接判 `limit` 收场了。 */
  const keepVerbatim = dropped.length > 0 && keptTokens < Math.max(2000, Math.floor(session.config.budget.compactAtTokens * 0.15));
  const anchors = anchorsFor(region);
  let archived = 0;
  /* 归档"真正会离开上下文的那些"：走选择性丢弃时只归档被丢的（留下的还在上下文里），
     走兜底路径时归档整段。**压缩 = 延迟检索，不是丢失**。 */
  const leaving = keepVerbatim ? dropped : region;
  try {
    archived = await new SessionArchive(session.runtime, session.id).append(leaving, session.clock());
  } catch {
    // 归档失败不阻塞压缩（宁可摘要少一层保障，也不能卡住主流程）
  }

  // 摘要输入本身也要有长度护栏——**均匀采样**，不是掐头去尾
  const dumpLines = session.history.map((m) => `[${m.role}${m.toolCallId ? `(${m.toolCallId})` : ''}] ${m.content}`);
  const sampled = sampleForSummary(dumpLines, SUMMARY_INPUT_MAX_CHARS);
  /* **增量摘要**——把上一次的摘要一起喂进去，要求"在此基础上更新"而不是从零重写。
     来源是 `session.lastSummary`（本进程内最近一次）或落盘的 `summary.json`（跨重启）。 */
  const prevSummary = session.lastSummary ?? undefined;
  const historyDump = prevSummary ? `${renderPreviousSummary(prevSummary)}\n\n【这一次要并进去的历史】\n${sampled.text}` : sampled.text;
  if (sampled.elided > 0) session.emit({ type: 'compact.sampled', elided: sampled.elided, chars: historyDump.length });
  const request = session.provider.chat({
    system: COMPACT_PROMPT,
    messages: [{ role: 'user', content: historyDump }],
    tools: [], // 压缩请求不带工具
    model: { role: 'compact', thinking: false },
    maxOutputTokens: 1500,
    temperature: 0.3,
    signal,
  });

  let raw = '';
  let compactUsage: import('../llm/provider.js').Usage | undefined;
  for await (const ev of request) {
    if (signal?.aborted) return { ok: false, beforeTokens, afterTokens: beforeTokens, reason: '用户中止' };
    if (ev.type === 'text.delta') raw += ev.text;
    if (ev.type === 'done') compactUsage = ev.usage;
  }
  // 压缩也是钱——单独记一桶（"摘要与工具自己的调用"不与闲聊混在一起）
  if (compactUsage) session.recordUsage(compactUsage, { role: 'compact' });

  const summary = parseCompactJson(raw);
  /* **看起来被截断的摘要不落盘**。
     判据（保守、零成本）：解析不出 JSON，或原文里连一个右花括号都没有 —— 那多半是生成到一半被切断的。
     ⚠ 精确的判据是"读适配器的 finish_reason"，这里只做"形态判据"，不假装读了 finish_reason。 */
  const looksTruncated = !summary && !raw.includes('}');
  if (summary) {
    const keep = session.history.slice(-tailLen);
    session.lastSummary = summary;
    /* 增量摘要的"上一份"要能跨重启 —— 只放内存的话，重开一次就从零重写（旧结论蒸发）。
       落一份 `sessions/<id>/summary.json`（覆盖写，只有最近一份）。 */
    try {
      await session.runtime.fs.write(`${session.runtime.storage.sessionsDir()}/${session.id}/summary.json`, JSON.stringify(summary, null, 2));
    } catch { /* 落盘失败不阻塞压缩 */ }
    const block = {
      role: 'user' as const,
      content: renderCompactBlock(summary, anchors, region.length)
        + (keepVerbatim && kept.length ? `\n\n## 以下原文保留（没有被摘要掉）\n（${dropReasons.join('；') || '无丢弃'}）` : ''),
    };
    session.history = keepVerbatim ? [block, ...kept, ...keep] : [block, ...keep];
    session.stats.compactions++;
    session.lastSummary = summary; // 供自动巩固使用
    const afterTokens = session.estimateTokens();
    session.emit({ type: 'compact.end', beforeTokens, afterTokens });
    return { ok: true, beforeTokens, afterTokens, archived };
  }

  // 失败降级：保留最后 8 条 + 首条 user。
  // 降级会多丢"倒数 5~8 条"（成功路径本来要保留的），这部分补归档，别让它在存档里缺席。
  const n = session.history.length;
  try {
    archived += await new SessionArchive(session.runtime, session.id).append(
      session.history.slice(Math.max(0, n - 8), Math.max(0, n - 4)),
      session.clock(),
    );
  } catch {
    // 同上：归档失败不阻塞
  }
  const firstUser = session.history.find((m) => m.role === 'user');
  session.history = [...(firstUser ? [firstUser] : []), ...session.history.slice(-8)];
  session.emit({
    type: 'compact.failed',
    beforeTokens,
    reason: looksTruncated
      ? '摘要输出看起来被截断了（连右花括号都没有）→ 拒绝落盘，已降级保留原文'
      : '摘要 JSON 解析失败，已降级保留原文',
  });
  return { ok: false, beforeTokens, afterTokens: session.estimateTokens(), reason: 'degrade', archived };
}
