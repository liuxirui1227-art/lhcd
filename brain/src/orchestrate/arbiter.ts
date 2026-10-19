// 出声仲裁器——四套机制都向它"申报"，不自带抑制逻辑。
// 唯一回答四个问题：① 现在能不能出声 ② 走什么渠道 ③ 本周期配额还剩多少 ④ 是不是免打扰时段。
// 纯函数（状态由宿主传入/回写），可单测；宿主（runtime/lib.mjs）负责持久化与投递。
//
// 五层抑制（每层配一条"该响必须响"的对偶约束）：
//   ① 免打扰时段与每日配额——**用户显式设的提醒（kind='reminder'）永不受这两条约束**
//   ② 沉默标记（SILENT）——由投递方处理（只对成功回合生效；失败永远投递）
//   ③ 变化门——内容哈希没变 → 整个不叫醒（探子失败报错，绝不算"没有变化"，由调用方保证）
//   ④ 内容感知退避——同源重复内容 → 间隔翻倍（1m→2m→4m→…→15m 封顶）；一变立刻回最小
//   ⑤ 提示词层——"没什么可说的就停下，别自己找活干"（在心跳注入的文本里，不在 system）

export type SpeakKind = 'reminder' | 'proactive';
export type SpeakChannel = 'bubble' | 'silent'; // bubble = 气泡+TTS；silent = 不打扰（只进对话/信箱）

export interface BackoffEntry { intervalMs: number; lastHash: string; lastSpokeAt: number }

export interface ArbiterState {
  /** 已消费配额的日期（本地 YYYY-MM-DD）；跨日自动归零 */
  day: string;
  count: number;
  /** 按 source 的退避状态 */
  backoff: Record<string, BackoffEntry>;
}

export interface SpeakRequest {
  source: string;              // 'cron' | 'heartbeat' | 'milestone' | 'info-sync' | 'social' | 'screen' | 'letter'
  kind: SpeakKind;
  content?: string;            // 变化门/退避摘要用（提醒可省）
  now: Date;
  quietStart?: number;         // 0~23，缺省 23
  quietEnd?: number;           // 缺省 8
  maxPerDay?: number;          // 缺省 3
}

export interface SpeakDecision {
  allow: boolean;
  reason: 'ok' | 'quiet' | 'quota' | 'unchanged' | 'backoff';
  channel: SpeakChannel;
  /** 退避状态下，建议的下一次最早时刻（毫秒时间戳）；无退避为 undefined */
  notBefore?: number;
  state: ArbiterState;
}

const MIN_INTERVAL_MS = 60 * 1000;        // 退避起点 1 分钟
const MAX_INTERVAL_MS = 15 * 60 * 1000;   // 封顶 15 分钟

/** 本地日期键（跨日重置的锚） */
export function dayKey(now: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

/** 免打扰判定（支持跨午夜，如 23–8；起止相同=关闭） */
export function inQuietHours(now: Date, quietStart = 23, quietEnd = 8): boolean {
  const h = now.getHours();
  if (quietStart === quietEnd) return false;
  return quietStart < quietEnd ? (h >= quietStart && h < quietEnd) : (h >= quietStart || h < quietEnd);
}

/** 稳定内容哈希（剥掉时间戳/空白，否则"每次都不一样"会让退避形同虚设） */
export function contentHash(text: string): string {
  const normalized = String(text ?? '')
    .replace(/\d{1,2}:\d{2}(:\d{2})?/g, '')   // 时间戳
    .replace(/\d{4}-\d{2}-\d{2}/g, '')        // 日期
    .replace(/\s+/g, ' ')
    .trim();
  let h = 2166136261;
  for (let i = 0; i < normalized.length; i++) {
    h ^= normalized.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

function normalizeState(state: ArbiterState | undefined, now: Date): ArbiterState {
  const day = dayKey(now);
  if (!state || state.day !== day) return { day, count: 0, backoff: state?.backoff ?? {} };
  return { day: state.day, count: Number(state.count ?? 0), backoff: state.backoff ?? {} };
}

/** 出声前的唯一闸门。返回的 state 由宿主回写（含配额消费与退避推进）。 */
export function arbitrate(req: SpeakRequest, state?: ArbiterState): SpeakDecision {
  const now = req.now;
  const st = normalizeState(state, now);

  // ① 用户显式设的提醒：不受免打扰/配额约束（你自己设的 7:00 提醒就该 7:00 响）
  if (req.kind === 'reminder') {
    return { allow: true, reason: 'ok', channel: 'bubble', state: st };
  }

  // ② 免打扰时段
  if (inQuietHours(now, req.quietStart, req.quietEnd)) {
    return { allow: false, reason: 'quiet', channel: 'silent', state: st };
  }

  // ③ 每日配额（TA 自发的出声才计数；用户提醒不计）
  const cap = Number(req.maxPerDay ?? 3);
  if (st.count >= cap) {
    return { allow: false, reason: 'quota', channel: 'silent', state: st };
  }

  // ④ 变化门 + 内容感知退避（无 content 的来源跳过——它自己保证不重复）
  const entry = st.backoff[req.source];
  if (req.content !== undefined) {
    const hash = contentHash(req.content);
    if (entry && entry.lastHash === hash) {
      // 内容没变：不叫醒；退避翻倍（下次更晚再来问）
      const interval = Math.min(Math.max(entry.intervalMs * 2, MIN_INTERVAL_MS), MAX_INTERVAL_MS);
      const next: ArbiterState = {
        ...st,
        backoff: { ...st.backoff, [req.source]: { intervalMs: interval, lastHash: hash, lastSpokeAt: entry.lastSpokeAt } },
      };
      return { allow: false, reason: 'unchanged', channel: 'silent', notBefore: entry.lastSpokeAt + interval, state: next };
    }
    if (entry && now.getTime() - entry.lastSpokeAt < entry.intervalMs) {
      // 退避窗口内（内容变了也要等）
      return { allow: false, reason: 'backoff', channel: 'silent', notBefore: entry.lastSpokeAt + entry.intervalMs, state: st };
    }
  }

  return { allow: true, reason: 'ok', channel: 'bubble', state: st };
}

/** 出声之后（投递成功）才调用：消费配额 + 记摘要哈希 + 退避复位到最小间隔。 */
export function noteDelivered(state: ArbiterState | undefined, source: string, content: string | undefined, now: Date): ArbiterState {
  const st = normalizeState(state, now);
  const backoff = { ...st.backoff };
  if (content !== undefined) {
    backoff[source] = { intervalMs: MIN_INTERVAL_MS, lastHash: contentHash(content), lastSpokeAt: now.getTime() };
  }
  return { ...st, count: st.count + 1, backoff };
}

/** 出声被用户忽略（投递成功但没回应）不算——退避只认"内容没变"，这里提供手动推进（如 cron 空跑）。 */
export function remainingQuota(state: ArbiterState | undefined, maxPerDay: number, now: Date): number {
  const st = normalizeState(state, now);
  return Math.max(0, Number(maxPerDay ?? 3) - st.count);
}
