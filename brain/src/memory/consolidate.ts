// 自动巩固：会话结束时抽取稳定事实写入语义层 + 情景归档。
// v0 策略（零额外 API 成本）：以会话内最后一次压缩摘要为事实来源；
// 未压缩过的会话跳过语义巩固，仅写情景归档。TODO(spec)：独立 compact 角色抽取回路。
import type { Session } from '../loop/session.js';
import { messageText } from '../llm/provider.js';
import type { CompactSummary } from '../prompt/compact.js';
import { MemoryService } from './service.js';
import { hasSecret } from './semantic.js';
import { classifyDomain } from '../lifecycle/facets.js';

export interface ConsolidateResult {
  added: number;
  updated: number;
  redacted: number;
  episodeWritten: boolean;
}

/**
 * 把压缩摘要的 facts 落为语义条目（低置信，供检索注入；用户确认可升级）。
 * @param opts.episodeId 情景归档的文件名（缺省 = session.id）。宿主用**按天的 id**
 *   （`main-2026-09-23`），好让"我们哪天一起干了什么"留下一条时间线。
 * @param opts.goalHint 这一段"在干什么"的**用户原话**（宿主给）。不给就退回会话里第一条用户消息——
 *   但那条可能带着宿主注入的前缀（情境提示/世界状态/相关记忆），所以宿主知道原话时应当给。
 */
export async function consolidateSession(
  session: Session,
  memory: MemoryService,
  summary?: CompactSummary,
  opts: { episodeId?: string; goalHint?: string } = {},
): Promise<ConsolidateResult> {
  const out: ConsolidateResult = { added: 0, updated: 0, redacted: 0, episodeWritten: false };

  if (summary && Array.isArray(summary.facts) && summary.facts.length > 0) {
    for (const fact of summary.facts) {
      const factText = String(fact).trim();
      if (!factText || hasSecret(factText)) {
        if (factText) out.redacted++;
        continue;
      }
      const key = `session.${session.id}.fact.${factText.slice(0, 24)}`;
      const r = await memory.remember({
        scope: 'project',
        key,
        content: factText,
        description: factText.slice(0, 80),
        confidence: 'low',
        source: session.id,
        domain: classifyDomain(factText), // 自动打域标签，facet 分区过滤生效
      });
      if (r.action === 'write') out.added++;
      else if (r.action === 'overwrite') out.updated++;
      else out.redacted++;
    }
  }

  // 情景归档：goal = 摘要 goal 或首条用户输入；lessons = warnings
  // ⚠ **没有用户消息时不许抛**。巩固在"退出前"也会跑（宿主三个边界之一），
  //   而"打开应用、一句话没说就退出"这条路上 firstUser/lastAssistant 都是 undefined——
  //   原来的 `messageText(firstUser!)` 会当场抛（Cannot read properties of undefined
  //   (reading 'content')）。非空断言骗过了编译器，骗不过真实会话。
  const firstUser = session.history.find((m) => m.role === 'user');
  const lastAssistant = [...session.history].reverse().find((m) => m.role === 'assistant');
  const goal = (opts.goalHint?.trim() || summary?.goal || (firstUser ? messageText(firstUser) : '')).slice(0, 200);
  const result = lastAssistant ? messageText(lastAssistant).slice(0, 500) : '';
  // 一句话没说、也没有摘要 → 这一天没有"干了什么"可写：**不写空 episode**（按天归档的时间线别被空行糊住）
  if (!goal && !result && !(summary?.facts && summary.facts.length > 0)) {
    out.episodeWritten = false;
    return out;
  }
  const episodeWritten = await memory
    .writeEpisode({
      sessionId: opts.episodeId ?? session.id,
      startedAt: session.clock(),
      goal,
      result,
      decisions: summary?.facts ?? [],
      files: summary?.files ?? [],
      lessons: summary?.warnings ?? [],
    })
    .then(() => true);
  out.episodeWritten = episodeWritten;
  return out;
}
