// 催办退避曲线 + 不可恢复自动解除 + 失败分类。
//
// 这是"管家"和"骚扰源"的分水岭：TA 不会没完没了地催；但它真等不到你的时候也不会傻等。
//
// 三条：
//   ① 退避曲线 30 分 → 1 小时 → 2 小时；**每周期最多催 3 次**（用户回一句话再给 3 次）
//   ② 只有"等用户拍板"（blocked/needs_input）才催；等依赖/等限流不催人
//   ③ **不可恢复错误自动解除**（凭证吊销/余额耗尽/上下文爆掉）——把目标放下并说明，而不是一直挂着

import type { TaskRun } from './types.js';

/** 退避梯：第 1 次 30 分钟，第 2 次 1 小时，第 3 次 2 小时 */
export const NUDGE_STEPS_MS = [30 * 60 * 1000, 60 * 60 * 1000, 2 * 60 * 60 * 1000];
/** 每周期最多催几次（用户一回应，周期重置） */
export const NUDGE_MAX_PER_CYCLE = NUDGE_STEPS_MS.length;

export type FailureKind =
  | 'usage_limited'    // 服务商限流（429）——等一会儿自己能好
  | 'budget_limited'   // 余额/额度/成本上限——用户不动作就好不了
  | 'auth'             // Key 无效/被吊销——不可恢复，自动解除
  | 'context'          // 上下文爆掉——这一轮做不完，需要人介入
  | 'transient'        // 网络抖动——可重试
  | 'unknown';

/** 把失败原文分类成"能不能自愈、要不要叫人" */
export function classifyFailure(message: string): FailureKind {
  const m = String(message ?? '');
  if (/余额不足|insufficient|HTTP 402|quota exceeded|budget/i.test(m)) return 'budget_limited';
  if (/429|限流|rate.?limit|too many requests/i.test(m)) return 'usage_limited';
  if (/HTTP 401|HTTP 403|invalid.*key|key.*invalid|吊销|revoked|authentication/i.test(m)) return 'auth';
  if (/上下文|maxContext|context length|too long|超出上限/i.test(m)) return 'context';
  if (/网络|fetch|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|socket|超时|timeout|5\d\d/i.test(m)) return 'transient';
  return 'unknown';
}

/**
 * 不可恢复：自动解除目标（不再挂着、也不再催人），并把原因说清楚。
 * **余额耗尽（budget_limited）也算**——它和吊销/上下文爆掉是同一类：用户不动作就好不了，
 * 一直挂着不如放下并说明（与本文件头部"不可恢复错误自动解除"的说明保持一致）。
 */
export function isUnrecoverable(kind: FailureKind): boolean {
  return kind === 'auth' || kind === 'context' || kind === 'budget_limited';
}

export interface NudgeDecision {
  due: boolean;
  /** 为什么催/为什么不催（进账本事件，便于事后解释"她为什么没催/为什么催了"） */
  reason: string;
  message: string;
  /** 本次决定之后该记的周期计数（用户回过话 → 归零重算；due 时 = 本周期第几次） */
  nextCount: number;
}

const NOT_DUE = (reason: string, nextCount: number): NudgeDecision => ({ due: false, reason, message: '', nextCount });

/**
 * 该不该催（纯函数）：
 * · 只有 blocked + needs_input 才催（等用户拍板）；别的状态催人就是骚扰
 * · **用户在上次催办之后说过话 → 周期重置**（他人在，不用催；回一句再给 3 次）
 * · 退避没到点 → 不催
 * · 本周期催满 3 次 → 不催（下一次等用户开口）
 */
export function nudgeDecision(run: Pick<TaskRun, 'state' | 'blockReason' | 'question' | 'nudgeCount' | 'lastNudgeAt' | 'blockedAt' | 'lastUserAt' | 'title'>, now: number, lastUserActivityAt: number): NudgeDecision {
  if (run.state !== 'blocked' || run.blockReason !== 'needs_input') return NOT_DUE('不是在等你拍板', 0);
  if (!run.question) return NOT_DUE('没有要问的问题', Number(run.nudgeCount ?? 0));

  const lastNudge = Number(run.lastNudgeAt ?? 0);
  const userAt = Math.max(Number(run.lastUserAt ?? 0), Number(lastUserActivityAt ?? 0));
  // 周期计数：我催过、而你之后说过话 → 这一轮作废，从头再给 3 次
  const count = lastNudge > 0 && userAt > lastNudge ? 0 : Number(run.nudgeCount ?? 0);
  if (count >= NUDGE_MAX_PER_CYCLE) return NOT_DUE(`这一轮已经催了 ${count} 次（先不催了）`, count);

  const anchor = lastNudge > 0 && count > 0 ? lastNudge : Number(run.blockedAt ?? now);
  const wait = NUDGE_STEPS_MS[Math.min(count, NUDGE_STEPS_MS.length - 1)]!;
  if (now - anchor < wait) return NOT_DUE(`还没到下一次（${Math.round(wait / 60000)} 分钟一档）`, count);

  const order = count + 1;
  const message = [
    `（我还在等你的一个决定·第 ${order} 次问）`,
    `上次我说过：${String(run.question).slice(0, 160)}`,
    '你回一句就行；要是这件事先不做了，也告诉我一声，我就不惦记了。',
  ].join('\n');
  return { due: true, reason: `等你拍板超过 ${Math.round(wait / 60000)} 分钟（第 ${order} 次）`, message, nextCount: order };
}

/** 自动解除时的交代话术（不可恢复错误 → 放下目标并说明，而不是一直挂着） */
export function unrecoverableMessage(run: Pick<TaskRun, 'title'>, kind: FailureKind, detail?: string): string {
  const why = kind === 'auth'
    ? '大脑的密钥被服务商拒绝了（密钥无效或已过期）——得你去「管理中心 → 大脑」换一个 Key'
    : kind === 'context'
      ? '这件事要处理的内容超出了我能一次拿住的量'
      : '遇到了我处理不了的错误';
  return `「${run.title}」这件事我先放下了：${why}${detail ? `（${String(detail).slice(0, 120)}）` : ''}。你处理完说一声，我接着来。`;
}

/** 可自愈状态（限流）的交代话术：不叫人，只是如实说为什么停 */
export function limitedMessage(run: Pick<TaskRun, 'title'>, kind: 'usage_limited' | 'budget_limited', detail?: string): string {
  const why = kind === 'usage_limited'
    ? '大脑那边临时限流了（不是坏了）'
    : '额度用完了（余额不足或到了花费上限）';
  return `「${run.title}」我先停在这儿：${why}${detail ? `——${String(detail).slice(0, 120)}` : ''}。`;
}

/** run 的下一步可催时刻（管理界面显示"下次大概什么时候问你"；不催返回 null） */
export function nextNudgeAt(run: Pick<TaskRun, 'state' | 'blockReason' | 'nudgeCount' | 'lastNudgeAt' | 'blockedAt'>): number | null {
  if (run.state !== 'blocked' || run.blockReason !== 'needs_input') return null;
  const count = Number(run.nudgeCount ?? 0);
  if (count >= NUDGE_MAX_PER_CYCLE) return null;
  const anchor = Number(run.lastNudgeAt ?? 0) > 0 ? Number(run.lastNudgeAt) : Number(run.blockedAt ?? 0);
  if (!anchor) return null;
  return anchor + NUDGE_STEPS_MS[Math.min(count, NUDGE_STEPS_MS.length - 1)]!;
}
