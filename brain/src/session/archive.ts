// 压缩存档：压缩**之前**把即将丢掉的消息追加进 archive.jsonl（只追加、不重写）。
// 为什么必须：messages.jsonl 是"当前历史的快照"——一压缩，原文就没了；那样摘要里写"需要细节就去查"
// 就是空话。存档让"压缩 = 延迟检索"而不是"压缩 = 丢失"，格式刻意保持最简单（一行一条 JSON）。
import type { Runtime } from '../runtime/types.js';
import type { ChatMessage } from '../llm/provider.js';
import { messageText } from '../llm/provider.js';
import { scoreText } from '../memory/text.js';

export interface ArchivedMessage {
  at: string;
  role: string;
  content: string;
  toolCallId?: string;
}

export interface ArchiveHit {
  msg: ArchivedMessage;
  score: number;
  /** 命中处附近的片段（便于直接读，不用把整条历史倒出来） */
  excerpt: string;
}

/** 压缩摘要块（合成消息）不重复入档：它以「【会话压缩摘要」开头 */
const SUMMARY_PREFIX = '【会话压缩摘要';

export class SessionArchive {
  constructor(private readonly runtime: Runtime, private readonly sessionId: string) {}

  private get path(): string {
    return `${this.runtime.storage.sessionsDir()}/${this.sessionId}/archive.jsonl`;
  }

  /** 追加归档（跳过摘要块与空内容）；返回实际归档条数 */
  async append(messages: ChatMessage[], at: string): Promise<number> {
    const rows: string[] = [];
    for (const m of messages) {
      const content = messageText(m);
      if (!content.trim() || content.startsWith(SUMMARY_PREFIX)) continue;
      const row: ArchivedMessage = { at, role: m.role, content, ...(m.toolCallId ? { toolCallId: m.toolCallId } : {}) };
      rows.push(JSON.stringify(row));
    }
    if (rows.length === 0) return 0;
    await this.runtime.fs.append(this.path, `${rows.join('\n')}\n`);
    return rows.length;
  }

  async list(limit = 20_000): Promise<ArchivedMessage[]> {
    let raw: string;
    try {
      raw = (await this.runtime.fs.read(this.path, { limit: 50_000_000 })).content;
    } catch {
      return []; // 没有档 = 从没压缩过
    }
    const out: ArchivedMessage[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as ArchivedMessage);
      } catch {
        // 跳过坏行
      }
    }
    return out.slice(-limit);
  }

  /** 检索历史原文：复用召回打分的（中文双字/连续命中——中文历史里同样管用） */
  async search(query: string, max = 5): Promise<ArchiveHit[]> {
    const msgs = await this.list();
    if (msgs.length === 0) return [];
    const scored = msgs
      .map((msg) => ({ msg, ...scoreText(msg.content, query) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(1, max));
    return scored.map((x) => ({ msg: x.msg, score: x.score, excerpt: excerptAround(x.msg.content, query) }));
  }
}

/** 截取命中附近的一段（找不到命中词就取开头），最长 400 字 */
function excerptAround(content: string, query: string, span = 400): string {
  if (content.length <= span) return content;
  const terms = query.toLowerCase().split(/[\s，。,.、]+/).filter(Boolean);
  const lower = content.toLowerCase();
  let at = -1;
  for (const t of terms) {
    const i = lower.indexOf(t);
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  const start = at < 0 ? 0 : Math.max(0, at - Math.floor(span / 3));
  const head = start > 0 ? '…' : '';
  const tail = start + span < content.length ? '…' : '';
  return `${head}${content.slice(start, start + span)}${tail}`;
}
