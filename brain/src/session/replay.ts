// 会话事件回放
//
// 为什么要有它：`sessions/<id>/events.jsonl` 一直是**只写不读**的——
// UI 不读、上下文不读，没有任何一处能把它读回来。
// 于是"她这轮到底做了什么、为什么停下来"只能靠人肉翻文件。任务那条线早有事件溯源 + 重放
// （`task/store.ts`），这里把同一套做法搬到会话事件上。
//
// 边界（有意）：**只重建"发生了什么"，不重建消息正文**。
//   正文的权威在 `messages.jsonl`（当前历史快照）与 `archive.jsonl`（被压缩掉的原档），
//   事件流里只有 delta 片段——拿它拼正文既有重复风险（retry 会重发）又会把内存撑爆。
//   回放给的是：轮次 / 工具调用与结果 / 压缩 / 审批 / 缓存 / 缺口。
import type { Runtime } from '../runtime/types.js';
import type { AgentEvent, EventEnvelope } from './events.js';

/** 事件的信封（新老事件都可能没有——老日志没有 `env`） */
type Env = Partial<EventEnvelope>;

export interface ReplayedToolCall {
  id: string;
  name: string;
  risk?: string;
  ok?: boolean;
  truncated?: boolean;
  error?: { code: string; message: string };
  /** 结果事件的时刻（首次） */
  at?: string;
  /** 从 call 到 result 的毫秒数（两边都有信封时才给） */
  ms?: number;
}

export interface ReplayedTurn {
  /** `turn.start` 那一刻的 `seq`（注意：它是**迭代号**，不是轮次号，见 turn.end 分支的注释） */
  seq: number;
  /** `turn.end` 那一刻的 `seq`（一轮里会变大：每次模型调用 +1） */
  endSeq?: number;
  startedAt?: string;
  endedAt?: string;
  /** turn.end 的 `final`（true = 正常收尾；false = 中止/未完成） */
  final?: boolean;
  /** 本轮的正文增量（只统计字数，不回放原文） */
  textChars: number;
  reasoningChars: number;
  tools: ReplayedToolCall[];
  /** 收尾时的用量（turn.end 带） */
  usage?: { inTokens: number; hitTokens: number; missTokens: number; outTokens: number; costUsd: number };
}

export interface ReplayedCompaction {
  ok: boolean;
  beforeTokens: number;
  afterTokens?: number;
  reason?: string;
  at?: string;
}

export interface ReplayResult {
  turns: ReplayedTurn[];
  compactions: ReplayedCompaction[];
  approvals: Array<{ tool: string; granted: boolean; by?: string; risk?: string; ruleId?: string; at?: string }>;
  cache: { calls: number; hitTokens: number; missTokens: number; lastHitRate?: number };
  /** 事件类型 → 条数（回放里没用上但要看得到的，也如实数出来） */
  counts: Record<string, number>;
  /** 缺口与异常（**这是回放最值钱的输出**：日志"看着完整"和"真的完整"是两件事） */
  gaps: string[];
  /** 最早/最晚事件时刻（都来自信封；老日志没有 → undefined） */
  from?: string;
  to?: string;
}

const envOf = (ev: AgentEvent): Env => ((ev as { env?: Env }).env ?? {});
const ms = (iso?: string): number | undefined => {
  if (!iso) return undefined;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : undefined;
};

/** 纯函数：一串事件 → 一份"发生了什么"的重建（不读盘、不改任何状态） */
export function replayEvents(events: AgentEvent[]): ReplayResult {
  const out: ReplayResult = {
    turns: [], compactions: [], approvals: [],
    cache: { calls: 0, hitTokens: 0, missTokens: 0 },
    counts: {}, gaps: [],
  };
  const openTools = new Map<string, ReplayedToolCall>();
  let turn: ReplayedTurn | undefined;
  let openCompaction = false;

  for (const ev of events) {
    const type = String((ev as { type: string }).type);
    out.counts[type] = (out.counts[type] ?? 0) + 1;
    const env = envOf(ev);
    if (env.at) {
      if (!out.from || env.at < out.from) out.from = env.at;
      if (!out.to || env.at > out.to) out.to = env.at;
    }
    const seqOf = () => Number((ev as { seq?: number }).seq ?? NaN);

    switch (type) {
      case 'turn.start': {
        // 上一轮没收到 turn.end 就开了新一轮 → 记缺口（实测确实存在：209 start / 208 end）
        if (turn) out.gaps.push(`第 ${turn.seq} 轮没有 turn.end（下一个 turn.start 已开始）`);
        turn = { seq: seqOf(), startedAt: env.at, textChars: 0, reasoningChars: 0, tools: [] };
        out.turns.push(turn);
        break;
      }
      case 'assistant.text.delta':
        if (turn) turn.textChars += String((ev as { text?: string }).text ?? '').length;
        break;
      case 'assistant.reasoning.delta':
        if (turn) turn.reasoningChars += String((ev as { text?: string }).text ?? '').length;
        break;
      case 'tool.call': {
        const e = ev as { id: string; name: string; risk?: string };
        const call: ReplayedToolCall = { id: e.id, name: e.name, ...(e.risk ? { risk: e.risk } : {}), ...(env.at ? { at: env.at } : {}) };
        openTools.set(e.id, call);
        turn?.tools.push(call);
        break;
      }
      case 'tool.result': {
        const e = ev as { id: string; ok: boolean; truncated?: boolean; error?: { code: string; message: string }; risk?: string };
        const call = openTools.get(e.id);
        if (!call) {
          out.gaps.push(`tool.result 没有对应的 tool.call（id=${e.id}）`);
          break;
        }
        openTools.delete(e.id);
        call.ok = e.ok;
        if (e.truncated) call.truncated = true;
        if (e.error) call.error = e.error;
        if (e.risk && !call.risk) call.risk = e.risk;
        const a = ms(call.at); const b = ms(env.at);
        if (a !== undefined && b !== undefined && b >= a) call.ms = b - a;
        break;
      }
      case 'turn.end': {
        if (!turn) { out.gaps.push(`turn.end 没有对应的 turn.start（seq=${seqOf()}）`); break; }
        /* ⚠ `seq` **不是轮次号**：它是 `session.stats.iterations + 1`（见 `loop/turn.ts`），
           一轮里每调一次模型就变——实测 6309 行里只有 8 个不同值、`seq=1` 重复 4407 次。
           所以这里**只记下来，不做"对不上"判定**（按轮次号比会报出一堆假缺口）。 */
        turn.endSeq = seqOf();
        turn.endedAt = env.at;
        turn.final = Boolean((ev as { final?: boolean }).final);
        const usage = (ev as { usage?: ReplayedTurn['usage'] }).usage;
        if (usage) turn.usage = usage;
        turn = undefined;
        break;
      }
      case 'compact.start':
        out.compactions.push({ ok: false, beforeTokens: Number((ev as { beforeTokens?: number }).beforeTokens ?? 0), ...(env.at ? { at: env.at } : {}) });
        openCompaction = true;
        break;
      case 'compact.end': {
        const last = out.compactions[out.compactions.length - 1];
        if (!last || !openCompaction) { out.gaps.push('compact.end 没有对应的 compact.start'); break; }
        last.ok = true;
        last.afterTokens = Number((ev as { afterTokens?: number }).afterTokens ?? 0);
        openCompaction = false;
        break;
      }
      case 'compact.failed': {
        const last = out.compactions[out.compactions.length - 1];
        const reason = String((ev as { reason?: string }).reason ?? '');
        if (last && openCompaction) {
          last.reason = reason;      // 这一次压缩失败（还留着 beforeTokens）
          openCompaction = false;
        } else {
          // 没有开着的压缩：如实记一条 + 报缺口（别把它悄悄并到上一次里）
          out.gaps.push('compact.failed 没有对应的 compact.start');
          out.compactions.push({ ok: false, beforeTokens: Number((ev as { beforeTokens?: number }).beforeTokens ?? 0), reason, ...(env.at ? { at: env.at } : {}) });
        }
        break;
      }
      case 'approval.request': {
        const e = ev as { tool: string; ruleId?: string; risk?: string };
        out.approvals.push({ tool: e.tool, granted: false, ...(e.risk ? { risk: e.risk } : {}), ...(e.ruleId ? { ruleId: e.ruleId } : {}), ...(env.at ? { at: env.at } : {}) });
        break;
      }
      case 'approval.result': {
        const e = ev as { tool: string; granted: boolean; by?: 'user' | 'session-grant' };
        const last = out.approvals[out.approvals.length - 1];
        if (last && last.tool === e.tool) { last.granted = e.granted; if (e.by) last.by = e.by; }
        else out.approvals.push({ tool: e.tool, granted: e.granted, ...(e.by ? { by: e.by } : {}), ...(env.at ? { at: env.at } : {}) });
        break;
      }
      case 'cache': {
        const e = ev as { hitTokens?: number; missTokens?: number; hitRate?: number };
        out.cache.calls++;
        out.cache.hitTokens += Number(e.hitTokens ?? 0);
        out.cache.missTokens += Number(e.missTokens ?? 0);
        if (typeof e.hitRate === 'number') out.cache.lastHitRate = e.hitRate;
        break;
      }
      default:
        break;
    }
  }

  if (turn) out.gaps.push(`第 ${turn.seq} 轮没有 turn.end（日志到此为止）`);
  for (const id of openTools.keys()) out.gaps.push(`工具调用没有结果（id=${id}）`);
  return out;
}

/** 读某个会话的事件流（一行一条 JSON；坏行跳过并如实记缺口） */
export async function loadEvents(runtime: Runtime, id: string): Promise<{ events: AgentEvent[]; badLines: number }> {
  const path = `${runtime.storage.sessionsDir()}/${id}/events.jsonl`;
  let raw: string;
  try {
    raw = (await runtime.fs.read(path, { limit: 200_000_000 })).content;
  } catch {
    return { events: [], badLines: 0 }; // 没有事件流 = 从没跑过（不是错误）
  }
  const events: AgentEvent[] = [];
  let badLines = 0;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line) as AgentEvent);
    } catch {
      badLines++;
    }
  }
  return { events, badLines };
}

/** 读 + 回放（排障入口）。坏行会写进 `gaps`，不静默吞掉。 */
export async function replaySession(runtime: Runtime, id: string): Promise<ReplayResult> {
  const { events, badLines } = await loadEvents(runtime, id);
  const out = replayEvents(events);
  if (badLines > 0) out.gaps.unshift(`事件流里有 ${badLines} 行解析失败（已跳过）`);
  return out;
}
