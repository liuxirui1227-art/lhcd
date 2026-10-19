// 调度器（承载"主动性 v0"）：
// 5 字段 cron（分 时 日 月 周，支持 * / a-b / */n / 逗号列表）；过期 >20 分钟跳过不补发；
// 状态持久化（lastRun/结果哈希）幂等防重。
import type { Runtime } from '../runtime/types.js';

export interface ScheduleCfg {
  id: string;
  cron: string;
  timezone?: string;
  task: string;
}

export interface OrchestrateState {
  runs: Record<string, { lastRun: string; lastHash: string }>;
}

const OVERDUE_MS = 20 * 60 * 1000;

function fieldMatches(field: string, value: number, min: number, max: number): boolean {
  const v = value;
  for (const part of field.split(',')) {
    const p = part.trim();
    if (p === '*' || p === '') return true;
    if (p.includes('/')) {
      const [base, stepStr] = p.split('/');
      const step = Number(stepStr);
      const start = base === '*' ? min : Number(base);
      if (v >= start && v <= max && (v - start) % step === 0) return true;
      continue;
    }
    if (p.includes('-')) {
      const [a, b] = p.split('-').map(Number);
      if (v >= a! && v <= b!) return true;
      continue;
    }
    if (Number(p) === v) return true;
  }
  return false;
}

/** 5 字段 cron 是否命中（本地时间） */
export function cronMatches(cron: string, date: Date): boolean {
  const [min, hour, dom, mon, dow] = cron.trim().split(/\s+/);
  if (!min || !hour || !dom || !mon || !dow) return false;
  return (
    fieldMatches(min, date.getMinutes(), 0, 59) &&
    fieldMatches(hour, date.getHours(), 0, 23) &&
    fieldMatches(dom, date.getDate(), 1, 31) &&
    fieldMatches(mon, date.getMonth() + 1, 1, 12) &&
    fieldMatches(dow, date.getDay(), 0, 6)
  );
}

/** 下一个命中时刻（分钟粒度扫描，上限 limit 默认 7 天） */
export function nextCron(cron: string, from: Date, limitMs = 7 * 24 * 3600 * 1000): Date | null {
  if (!cron.trim().split(/\s+/)[0]) return null;
  const deadline = from.getTime() + limitMs;
  const t = new Date(from.getTime());
  t.setSeconds(0, 0);
  while (t.getTime() <= deadline) {
    t.setTime(t.getTime() + 60_000);
    if (cronMatches(cron, t)) return t;
  }
  return null;
}

/** 最近一次命中时刻（回溯 windowMs 内的分钟；无命中返回 null） */
export function lastMatchMs(cron: string, now: Date, windowMs = OVERDUE_MS): number | null {
  const t = new Date(now.getTime());
  t.setSeconds(0, 0);
  const floor = now.getTime() - windowMs;
  while (t.getTime() >= floor) {
    if (cronMatches(cron, t)) return t.getTime();
    t.setTime(t.getTime() - 60_000);
  }
  return null;
}

export interface DueTask {
  schedule: ScheduleCfg;
  /** due：现在命中或宽限内补跑；overdue-skip：错过 >20 分钟，跳过并记录 */
  disposition: 'due' | 'overdue-skip';
}

export class Scheduler {
  constructor(
    private readonly runtime: Runtime,
    private readonly stateFile: string,
    private readonly schedules: ScheduleCfg[] = [],
  ) {}

  async loadState(): Promise<OrchestrateState> {
    try {
      const raw = (await this.runtime.fs.read(this.stateFile, { limit: 1_000_000 })).content;
      const s = JSON.parse(raw) as OrchestrateState;
      return { runs: s.runs ?? {} };
    } catch {
      return { runs: {} };
    }
  }

  async saveState(state: OrchestrateState): Promise<void> {
    await this.runtime.fs.write(this.stateFile, JSON.stringify(state, null, 2));
  }

  /**
   * 到期判定（幂等）：
   * - 回溯 25h 内最近一次 cron 命中时刻 lastMatch；
   * - lastMatch ≤ lastRun → 该窗口已处理，无动作；
   * - now − lastMatch ≤ 20 分钟 → due（含宽限补跑）；
   * - 错过 >20 分钟 → overdue-skip（记录 lastRun 防重复评估）。
   */
  async dueTasks(now: Date): Promise<DueTask[]> {
    const state = await this.loadState();
    const out: DueTask[] = [];
    let dirty = false;
    for (const s of this.schedules) {
      const rec = state.runs[s.id];
      const last = rec ? Date.parse(rec.lastRun) : -1;
      const lastMatch = lastMatchMs(s.cron, now, 25 * 3600 * 1000);
      if (lastMatch === null) continue; // 近 25h 无命中窗口
      if (lastMatch <= last) continue;   // 该窗口已执行/已跳过
      if (now.getTime() - lastMatch <= OVERDUE_MS) {
        out.push({ schedule: s, disposition: 'due' });
      } else {
        state.runs[s.id] = { lastRun: new Date(lastMatch).toISOString(), lastHash: 'skipped' };
        out.push({ schedule: s, disposition: 'overdue-skip' });
        dirty = true;
      }
    }
    if (dirty) await this.saveState(state);
    return out;
  }

  /** 记录执行（幂等：lastRun 更新后同窗口不重复） */
  async recordRun(id: string, now: Date, resultHash: string): Promise<void> {
    const state = await this.loadState();
    state.runs[id] = { lastRun: now.toISOString(), lastHash: resultHash };
    await this.saveState(state);
  }
}
