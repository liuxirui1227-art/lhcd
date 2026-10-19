// 对话树（「回到那句话之前，重新说一遍」）
//
// 会话原来是**一条直线**——`messages.jsonl` 是数组，`fork()` 是"整目录复制成新 id"，
// 用户想说"我上次那句说重了，重来"只能另开会话、把原来的丢掉。
//
// 做法：给消息**补两个宿主字段**：`id`（一行一个）与 `parentId`（父条目）——
// 于是"跳到历史任意一点继续"就是"把叶子指针挪过去"，天然长成一棵树；
// 再配一个**纯函数投影**（从叶子沿 parentId 上溯），上下文就是"这棵树的一条路径"。
//
// 两条纪律：
//   ① 这两个字段**不会漏给模型**：`sanitizeForRequest` 是白名单拷贝（见 adapters/message-api.ts），
//      实测过——加宿主字段不影响请求体；
//   ② **老会话不改写**：没有 id 的历史在读入时**内存里补齐**（`ensureIds`），文件不动。
import type { ChatMessage } from '../llm/provider.js';
import { messageText } from '../llm/provider.js';

/** 带宿主字段的消息（`id`/`parentId` 只在本机流转，不进请求体） */
export interface TreeMessage extends ChatMessage {
  id: string;
  parentId: string | null;
}

export interface EnsureIdsOptions {
  /** id 前缀（默认 'm'）：同一会话内唯一即可 */
  prefix?: string;
  /** 已有 id 的条目从哪个序号继续（默认按现有数量推） */
  startAt?: number;
}

/** 内容是纯文本还是多模态（分支回溯只回填纯文本原文） */
function plainText(m: ChatMessage): string {
  return messageText(m);
}

/**
 * 给一段历史补齐 `id` / `parentId`（**幂等、不改写文件**）。
 * 已有 id 的条目原样保留（所以重复调用不会把指针改乱）；新条目接在最后一条的后面。
 */
export function ensureIds(history: ChatMessage[], opts: EnsureIdsOptions = {}): TreeMessage[] {
  const prefix = opts.prefix ?? 'm';
  let n = opts.startAt ?? 0;
  let prev: string | null = null;
  const out: TreeMessage[] = [];
  for (const m of history) {
    const t = m as Partial<TreeMessage>;
    const id = typeof t.id === 'string' && t.id ? t.id : `${prefix}${++n}`;
    if (typeof t.id === 'string' && t.id) {
      const num = Number(t.id.replace(prefix, ''));
      if (Number.isFinite(num) && num > n) n = num; // 跟已有编号对齐，别撞
    }
    out.push({ ...(m as ChatMessage), id, parentId: typeof t.parentId === 'string' ? t.parentId : prev });
    prev = id;
  }
  return out;
}

/** 当前叶子（最后一个条目的 id）；空历史给 null */
export function leafOf(history: ChatMessage[]): string | null {
  const last = history[history.length - 1] as Partial<TreeMessage> | undefined;
  return typeof last?.id === 'string' ? last.id : null;
}

/** 某个条目的父条目 id（找不到该条目给 null） */
export function parentOf(entries: TreeMessage[], id: string): string | null {
  return entries.find((e) => e.id === id)?.parentId ?? null;
}

/**
 * **纯函数投影**：从叶子沿 `parentId` 上溯，返回这条路径上的消息（顺序 = 对话顺序）。
 * 这是"上下文 = 日志的投影"这句话的落地：同一份日志 + 不同叶子 → 不同上下文，不改任何文件。
 * 返回的是**去掉宿主字段**的消息（直接可以发请求）。
 */
export function projectFrom(entries: TreeMessage[], leafId: string | null): ChatMessage[] {
  if (!leafId) return [];
  const byId = new Map(entries.map((e) => [e.id, e]));
  const path: TreeMessage[] = [];
  const seen = new Set<string>();
  let cur: string | null = leafId;
  while (cur) {
    if (seen.has(cur)) break; // 坏数据（成环）→ 停在这儿，别死循环
    seen.add(cur);
    const node = byId.get(cur);
    if (!node) break;         // 指针指向不存在的条目：如实停下（调用方自己决定怎么报）
    path.push(node);
    cur = node.parentId;
  }
  path.reverse();
  // 宿主字段一个都不许进请求体：id / parentId / rawText 全剥掉
  return path.map(({ id: _id, parentId: _parentId, ...rest }) => {
    const r = rest as Record<string, unknown>;
    if ('rawText' in r) delete r.rawText;
    return r as unknown as ChatMessage;
  });
}

export interface CutResult {
  /** 保留的部分（不含被回退的那一条及其之后） */
  kept: TreeMessage[];
  /** 被回退掉的部分 */
  removed: TreeMessage[];
  /** 回填输入框用的原文（只对**用户消息**有意义；助手/工具条目给空串） */
  text: string;
}

/**
 * "回到这句重说"：把叶子挪到指定条目的**父节点**。
 * 选中用户消息 → 原话回填输入框；选中助手/工具条目 → 输入框留空。
 */
export function cutAt(entries: TreeMessage[], messageId: string): CutResult {
  const idx = entries.findIndex((e) => e.id === messageId);
  if (idx < 0) return { kept: entries, removed: [], text: '' };
  const target = entries[idx]!;
  const kept = entries.slice(0, idx);
  const removed = entries.slice(idx);
  /* 用户消息优先给**她的原话**（`rawText`）——宿主会把情境提示/世界状态/相关记忆拼进 content，
     那是宿主加的，不是她说的；回填输入框必须是她真正打的那句。 */
  const text = target.role === 'user'
    ? ((target as { rawText?: string }).rawText ?? plainText(target))
    : '';
  return { kept, removed, text };
}

/** 分支会话 id：`<父会话>~b<序号>`（一眼看得出它从哪来） */
export function branchSessionId(parentId: string, n: number): string {
  return `${parentId}~b${n}`;
}

/** 会话 id 是不是一个分支；是的话返回父会话 id（用于界面上标"从哪条分支来"） */
export function parentOfBranch(sessionId: string): string | null {
  const i = sessionId.lastIndexOf('~b');
  return i > 0 ? sessionId.slice(0, i) : null;
}
