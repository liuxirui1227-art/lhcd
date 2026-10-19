// 会话日志：只追加的事件日志 + 纯函数投影。
//
// 原来的问题：`messages.jsonl` 是**每次 save 全量重写的快照**——压缩一发生，原文就从这份文件里消失
// （靠 `archive.jsonl` 兜着）；"上下文是从日志投影出来的"这句话在落盘层**不成立**。
//
// 于是多一份 `log.jsonl`，**只追加**，四种条目：
//   · `message`  一条消息（带 id/parentId）
//   · `compact`  压缩检查点**（关键）**：它把"从这里往后读"的基准换成了新的一段（摘要块 + 保留的原文）
//   · `branch`   分支来源（这条会话是从哪条会话的哪条消息分出来的）
//   · `custom`   预留（标签之类以后用）
// 于是"当前上下文"= **从最后一条 compact 起算，叠加其后的 message 条目**——一个**纯函数**，
// 同一份日志投影两次结果逐字节相同。`messages.jsonl` 仍然写，但降级成**派生快照**（本机可读可审、排障用）。
//
// 不迁移老数据：老会话没有 `log.jsonl` → 读的时候回落到 `messages.jsonl`（行为与从前一致）。
import type { Runtime } from '../runtime/types.js';
import type { ChatMessage } from '../llm/provider.js';
import { ensureIds, projectFrom, type TreeMessage } from './tree.js';

export type LogEntryType = 'message' | 'compact' | 'branch' | 'custom';

/**
 * 标签：**给某条消息打一句人话标记**（"纪念日""那个决定"）。
 * 为什么落在日志的 `custom` 条目上：标签是**追加事实**（改主意就再打一条空的），不是改消息本身——
 * 老会话不改写，也不需要新文件。
 */
export interface LabelPayload {
  kind: 'label';
  /** 打给哪条消息（会话内 id） */
  target: string;
  /** 标签文字；**空串 = 摘掉这个标签** */
  text: string;
}

export interface LogEntry {
  /** 会话内单调（从 1 开始） */
  seq: number;
  type: LogEntryType;
  /** 什么时候写的（ISO） */
  at: string;
  /** 仅 message：这条消息的 id（与 `parentId` 一起构成树） */
  id?: string;
  parentId?: string | null;
  /** message: 消息本身；compact: 压缩后的**基准**（摘要块 + 保留的原文）；branch/custom: 任意小载荷 */
  payload?: unknown;
}

/** 从日志投影出当前上下文（**纯函数**：不改入参、不读盘） */
export function projectLog(entries: LogEntry[]): ChatMessage[] {
  // 找最后一条 compact：它是"从这里往后读"的起点
  let base: ChatMessage[] = [];
  let from = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i]!.type === 'compact') {
      base = Array.isArray(entries[i]!.payload) ? (entries[i]!.payload as ChatMessage[]) : [];
      from = i + 1;
      break;
    }
  }
  const rest: ChatMessage[] = [];
  for (let i = from; i < entries.length; i++) {
    const e = entries[i]!;
    if (e.type === 'message' && e.payload) {
      const m = e.payload as ChatMessage;
      rest.push({ ...m, id: e.id ?? (m as Partial<TreeMessage>).id ?? '', parentId: e.parentId ?? null } as ChatMessage);
    }
  }
  return [...base, ...rest] as ChatMessage[];
}

export interface AppendPlan {
  entries: LogEntry[];
  /** 为什么走了重建（人话，进日志/事件用；null = 正常尾部追加） */
  rebuiltBecause: string | null;
}

/**
 * 算出"这次 save 要追加哪些条目"（**纯函数**，好测）。
 * 正常情况 = 尾部多了 N 条 → 追加 N 条 message；
 * 对不上（压缩把历史换了 / 有人改了历史）= **追加一条 compact 检查点**，把当前历史立成新基准。
 * 这条兜底很重要：宁可多一条 compact，也不能让日志与上下文对不上。
 */
export function planLogAppend(existing: LogEntry[], history: ChatMessage[], at: string): AppendPlan {
  const projected = projectLog(existing);
  const nextSeq = (existing[existing.length - 1]?.seq ?? 0) + 1;
  const samePrefix = projected.length <= history.length
    && projected.every((m, i) => sameRequestFields(m, history[i]!));

  if (samePrefix) {
    const tail = history.slice(projected.length);
    return {
      entries: tail.map((m, i) => {
        const t = m as Partial<TreeMessage>;
        return {
          seq: nextSeq + i,
          type: 'message' as const,
          at,
          ...(typeof t.id === 'string' ? { id: t.id } : {}),
          ...(t.parentId !== undefined ? { parentId: t.parentId } : {}),
          payload: strip(m),
        };
      }),
      rebuiltBecause: null,
    };
  }
  return {
    entries: [{ seq: nextSeq, type: 'compact', at, payload: history.map((m) => strip(m)) }],
    rebuiltBecause: projected.length === 0
      ? '日志还是空的（第一条基准）'
      : `上下文与日志对不上（日志投影 ${projected.length} 条 / 现在 ${history.length} 条）→ 立新基准`,
  };
}

/**
 * 比"这条消息是不是同一条"——只比**真正会发出去的字段**（白名单）。
 * ⚠ 不能整体 JSON 比：投影出来的消息带着 `id`/`parentId`（对话树要），原文里可能没有，
 * 整体比会把"正常追加"误判成"上下文被换了"。
 */
function sameRequestFields(a: ChatMessage, b: ChatMessage): boolean {
  const pick = (m: ChatMessage) => JSON.stringify({
    role: m.role,
    content: m.content,
    ...(m.name !== undefined ? { name: m.name } : {}),
    ...(m.toolCallId !== undefined ? { toolCallId: m.toolCallId } : {}),
    ...(m.toolCalls ? { toolCalls: m.toolCalls } : {}),
    ...(m.reasoning !== undefined ? { reasoning: m.reasoning } : {}),
  });
  return pick(a) === pick(b);
}

/**
 * 落盘前**原样保留**（消息上的宿主字段 `id`/`parentId`/`rawText` 都要留着）：
 *   · `rawText` 是"回到这句重说"要回填的**她的原话**——丢了它，重启之后回填就变成带注入前缀的整段；
 *   · 它只落本机文件、**永远不进请求体**（净化是白名单拷贝）。
 * 这里仍然留一个函数：将来真要剥字段时，改一处就够。
 */
function strip(m: ChatMessage): ChatMessage {
  return { ...(m as unknown as Record<string, unknown>) } as unknown as ChatMessage;
}

/** 会话日志文件（只追加；`sessions/<id>/log.jsonl`） */
export class SessionLog {
  constructor(private readonly runtime: Runtime, private readonly sessionId: string) {}

  private get file(): string {
    return `${this.runtime.storage.sessionsDir()}/${this.sessionId}/log.jsonl`;
  }

  async list(): Promise<LogEntry[]> {
    let raw: string;
    try {
      raw = (await this.runtime.fs.read(this.file, { limit: 100_000_000 })).content;
    } catch {
      return []; // 没有日志 = 老会话（读的时候回落 messages.jsonl）
    }
    const out: LogEntry[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line) as LogEntry); } catch { /* 坏行跳过，不让它拖垮整份日志 */ }
    }
    return out;
  }

  /** 保存时调用：把"该追加的"追加进去（返回重建原因，供调用方记日志） */
  async sync(history: ChatMessage[], at: string): Promise<{ appended: number; rebuiltBecause: string | null }> {
    const existing = await this.list();
    const plan = planLogAppend(existing, history, at);
    if (plan.entries.length === 0) return { appended: 0, rebuiltBecause: null };
    const rows = plan.entries.map((e) => JSON.stringify(e)).join('\n');
    try {
      await this.runtime.fs.append(this.file, `${rows}\n`);
    } catch {
      return { appended: 0, rebuiltBecause: null }; // 日志写不进去不该拖垮保存（快照仍然写了）
    }
    return { appended: plan.entries.length, rebuiltBecause: plan.rebuiltBecause };
  }

  /** 从日志投影出上下文（**纯函数**的那一步在 `projectLog`；这里只负责读） */
  async project(): Promise<ChatMessage[]> {
    return projectLog(await this.list());
  }

  /** 追加一条自定义事实（标签就走这儿；只追加，不改历史） */
  async appendCustom(payload: Record<string, unknown>, at: string): Promise<LogEntry> {
    const existing = await this.list();
    const entry: LogEntry = { seq: (existing[existing.length - 1]?.seq ?? 0) + 1, type: 'custom', at, payload };
    try {
      await this.runtime.fs.append(this.file, `${JSON.stringify(entry)}\n`);
    } catch { /* 标签写失败不该抛（界面会照实说没成） */ }
    return entry;
  }

  /**
   * 当前有效的标签（**最后一条赢**：同一个 target 再打一条空串就摘掉了）。
   * 返回 `{ [messageId]: text }`。
   */
  async labels(): Promise<Record<string, string>> {
    const entries = await this.list();
    const out: Record<string, string> = {};
    for (const e of entries) {
      if (e.type !== 'custom') continue;
      const p = e.payload as Partial<LabelPayload> | undefined;
      if (!p || p.kind !== 'label' || typeof p.target !== 'string') continue;
      const text = String(p.text ?? '').trim();
      if (text) out[p.target] = text; else delete out[p.target];
    }
    return out;
  }

  /** 日志里的消息条目（带 id/parentId）——对话树/排障用 */
  async messages(): Promise<TreeMessage[]> {
    const entries = await this.list();
    const msgs = entries.filter((e) => e.type === 'message' && e.payload).map((e) => e.payload as ChatMessage);
    return ensureIds(msgs);
  }
}

/** 投影到某个叶子（对话树用；纯函数，喂给 `tree.projectFrom`） */
export function projectAtLeaf(entries: LogEntry[], leafId: string | null): ChatMessage[] {
  return projectFrom(ensureIds(projectLog(entries)), leafId);
}
