// 定时任务表——把 cron 从"重启即丢"变成"答应的事会兑现"。
//
// 三条不变量（顺序即正确性）：
//   ① **触发之前先把下一次时间推进掉**（claim：firingAt=now + nextRunAt=下一个未来时刻 + 原子落盘）
//      → 同一格最多被取走一次；进程崩了，恢复时按 firingAt 只补跑一次，绝不 N 次重放
//   ② 错过策略分档：≤5 分钟算准时；≤宽限 max(120s, min(周期/2, 2h)) 正常跑一次（不补课）；
//      超宽限 → 跳过累积的缺失，只在"现在"跑一次；**一次性提醒过期直接作废**（不会半夜弹出三周前的会）
//   ③ **零花费才重试**：瞬时网络错误且这一跑一个模型调用都没完成 → 5/15/30 分钟梯；否则不重试
//
// 记事本：每任务 KV，单值 16KB / 单任务 64KB，**超限报错不静默截断**；空的时候渲染成空字符串
//（用不到该功能的任务提示词逐字节不变，缓存友好）。
import type { Runtime } from '../runtime/types.js';
import { cronMatches, nextCron } from './scheduler.js';

export type JobKind = 'cron' | 'once';
export type JobStatus = 'ok' | 'failed' | 'skipped' | 'missed' | 'expired' | 'deferred';
export type DueDisposition = 'due' | 'retry' | 'recover' | 'missed' | 'expired';

export interface CronJob {
  id: string;
  kind: JobKind;
  /** cron 表达式（5 字段）或一次性提醒的 ISO 时间 */
  spec: string;
  /** 交给 TA 的自然语言任务（触发时作为用户消息送进当前会话） */
  task: string;
  enabled: boolean;
  createdAt: number;
  /** 下一次应触发的时刻；null = 不再触发（一次性已跑完/已作废） */
  nextRunAt: number | null;
  /** 已被取走但未认领的戳（崩溃恢复依据；跑完清空） */
  firingAt?: number | null;
  lastRunAt?: number | null;
  lastStatus?: JobStatus;
  /** 零花费重试：下次可重试时刻与已重试次数 */
  retryAt?: number | null;
  retryCount?: number;
  /** 任务记事本（KV） */
  notepad?: Record<string, string>;
  /** continuity——上一次有内容的输出 */
  lastOutput?: string;
  origin?: 'user' | 'assistant';
}

export interface LedgerEntry {
  at: number;
  jobId: string;
  status: JobStatus;
  detail?: string;
  costUsd?: number;
}

export interface JobsFile {
  version: 1;
  jobs: CronJob[];
  ledger: LedgerEntry[];
}

export const GRACE_ON_TIME_MS = 5 * 60 * 1000;                    // ≤5 分钟 = 准时
export const RETRY_STEPS_MS = [5, 15, 30].map((m) => m * 60 * 1000); // 零花费重试梯
export const NOTE_VALUE_MAX = 16 * 1024;
export const NOTE_JOB_MAX = 64 * 1024;
export const LEDGER_MAX = 200;

/** 错过宽限：max(120s, min(周期/2, 2h)) */
export function graceMs(periodMs: number): number {
  return Math.min(Math.max(120 * 1000, periodMs / 2), 2 * 3600 * 1000);
}

function makeId(now: Date): string {
  return `job-${now.getTime().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

export class CronJobs {
  private file: JobsFile = { version: 1, jobs: [], ledger: [] };
  private readonly running = new Set<string>(); // 本进程内在跑的 job（recover 判定要避开它们）

  constructor(
    private readonly runtime: Runtime,
    private readonly filePath: string,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async load(): Promise<JobsFile> {
    try {
      const r = await this.runtime.fs.read(this.filePath);
      const parsed = JSON.parse(r.content) as JobsFile;
      if (parsed?.version === 1 && Array.isArray(parsed.jobs)) {
        this.file = { version: 1, jobs: parsed.jobs, ledger: Array.isArray(parsed.ledger) ? parsed.ledger : [] };
      }
    } catch {
      /* 首次运行 / 文件损坏 → 空表（不阻断） */
    }
    return this.file;
  }

  /** 原子落盘（临时文件 + fsync + rename）——半个 JSON 不允许存在 */
  async save(): Promise<void> {
    await this.runtime.fs.writeAtomic(this.filePath, JSON.stringify(this.file, null, 2));
  }

  list(): CronJob[] {
    return this.file.jobs.map((j) => ({ ...j }));
  }

  ledger(): LedgerEntry[] {
    return [...this.file.ledger];
  }

  /** 建任务：cron 表达式或一次性 ISO 时间（必须未来）；返回人话错误。 */
  async create(input: { spec: string; task: string; kind?: JobKind; origin?: 'user' | 'assistant' }): Promise<{ ok: boolean; job?: CronJob; error?: string }> {
    const now = this.clock();
    const task = String(input.task ?? '').trim();
    if (!task) return { ok: false, error: '任务内容不能为空' };
    const spec = String(input.spec ?? '').trim();
    const kind: JobKind = input.kind ?? (/^\d{4}-\d{2}-\d{2}T/.test(spec) ? 'once' : 'cron');
    let nextRunAt: number | null = null;
    if (kind === 'once') {
      const t = new Date(spec);
      if (Number.isNaN(t.getTime())) return { ok: false, error: `时间格式看不懂：${spec}（用 ISO 如 2026-09-19T08:00:00）` };
      if (t.getTime() <= now.getTime()) return { ok: false, error: '这个时间已经过去了' };
      nextRunAt = t.getTime();
    } else {
      const next = nextCron(spec, now);
      if (!next) return { ok: false, error: `cron 表达式无效：${spec}（5 字段：分 时 日 月 周）` };
      nextRunAt = next.getTime();
    }
    const job: CronJob = {
      id: makeId(now), kind, spec, task, enabled: true, createdAt: now.getTime(),
      nextRunAt, firingAt: null, lastRunAt: null, retryAt: null, retryCount: 0,
      origin: input.origin ?? 'user',
    };
    this.file.jobs.push(job);
    await this.save();
    return { ok: true, job: { ...job } };
  }

  async cancel(id: string): Promise<{ ok: boolean; error?: string }> {
    const i = this.file.jobs.findIndex((j) => j.id === id);
    if (i < 0) return { ok: false, error: '没有这个任务' };
    this.file.jobs.splice(i, 1);
    await this.save();
    return { ok: true };
  }

  /** 记事本写入（超限报错，不静默截断） */
  async setNote(id: string, key: string, value: string): Promise<{ ok: boolean; error?: string }> {
    const job = this.file.jobs.find((j) => j.id === id);
    if (!job) return { ok: false, error: '没有这个任务' };
    const v = String(value ?? '');
    if (v.length > NOTE_VALUE_MAX) return { ok: false, error: `单值超过 16KB（${v.length} 字符）——记事本不是正文仓库` };
    const next = { ...(job.notepad ?? {}), [String(key)]: v };
    const total = Object.entries(next).reduce((n, [k, val]) => n + k.length + val.length, 0);
    if (total > NOTE_JOB_MAX) return { ok: false, error: `任务记事本超过 64KB（${total} 字符）——请清理无用的 key` };
    job.notepad = next;
    await this.save();
    return { ok: true };
  }

  /** 记事本渲染进提示词；**空 → 返回空字符串**（保证无此功能的任务提示词逐字节不变） */
  renderSection(job: CronJob): string {
    const parts: string[] = [];
    const notes = Object.entries(job.notepad ?? {});
    if (notes.length) parts.push('【任务记事本】\n' + notes.map(([k, v]) => `- ${k}: ${v}`).join('\n'));
    if (job.lastOutput?.trim()) parts.push('【上次的输出】\n' + job.lastOutput.trim());
    return parts.join('\n');
  }

  /**
   * 到期判定（只读+落状态，不执行）。宿主拿到 disposition 后：
   * due/retry/recover/missed → claim() → 执行；expired → 已作废（无需执行）。
   */
  async due(now: Date): Promise<Array<{ job: CronJob; disposition: DueDisposition; lateMs?: number }>> {
    const out: Array<{ job: CronJob; disposition: DueDisposition; lateMs?: number }> = [];
    let dirty = false;
    for (const job of this.file.jobs) {
      if (!job.enabled) continue;
      if (this.running.has(job.id)) continue;

      // 崩溃恢复：被取走但没跑完（且不是本进程在跑）→ 只补跑一次
      if (job.firingAt && (job.lastRunAt ?? 0) < job.firingAt && now.getTime() - job.firingAt > 15 * 1000) {
        out.push({ job: { ...job }, disposition: 'recover' });
        continue;
      }
      // 零花费重试到点
      if (job.retryAt && now.getTime() >= job.retryAt) {
        out.push({ job: { ...job }, disposition: 'retry' });
        continue;
      }
      if (job.nextRunAt === null) continue;

      if (now.getTime() < job.nextRunAt) continue;
      const late = now.getTime() - job.nextRunAt;

      if (job.kind === 'once') {
        if (late <= graceMs(60 * 1000)) {
          out.push({ job: { ...job }, disposition: 'due', lateMs: late });
        } else {
          job.enabled = false;
          job.nextRunAt = null;
          job.lastStatus = 'expired';
          this.pushLedger({ at: now.getTime(), jobId: job.id, status: 'expired', detail: `过期 ${Math.round(late / 60000)} 分钟未开机，作废` });
          dirty = true;
        }
        continue;
      }

      // cron：分档错过策略
      const period = this.periodMs(job);
      const grace = graceMs(period);
      if (late <= grace) {
        out.push({ job: { ...job }, disposition: 'due', lateMs: late });
      } else {
        // 超过宽限：跳过累积的缺失，只把"现在"这一次跑掉
        const next = nextCron(job.spec, now);
        job.nextRunAt = next ? next.getTime() : null;
        this.pushLedger({ at: now.getTime(), jobId: job.id, status: 'missed', detail: `错过 ${Math.round(late / 60000)} 分钟，跳过累积` });
        dirty = true;
        out.push({ job: { ...job }, disposition: 'missed' });
      }
    }
    if (dirty) await this.save();
    return out;
  }

  /** 触发前推进（不变量①）：firingAt=now + nextRunAt 推到未来 + 原子落盘。跑之前必须先调它。 */
  async claim(id: string): Promise<{ ok: boolean; job?: CronJob; error?: string }> {
    const job = this.file.jobs.find((j) => j.id === id);
    if (!job) return { ok: false, error: '没有这个任务' };
    const now = this.clock();
    job.firingAt = now.getTime();
    job.retryAt = null;
    if (job.kind === 'cron') {
      const next = nextCron(job.spec, now);
      job.nextRunAt = next ? next.getTime() : null;
    } else {
      job.nextRunAt = null; // 一次性：取走即不再触发
    }
    this.running.add(job.id);
    await this.save();
    return { ok: true, job: { ...job } };
  }

  /** 跑完（无论成败都要调）：清 firingAt + 记状态 + 进账本 + 原子落盘。 */
  async complete(id: string, status: JobStatus, detail?: string, costUsd?: number, output?: string): Promise<void> {
    const job = this.file.jobs.find((j) => j.id === id);
    if (!job) return;
    const now = this.clock();
    job.firingAt = null;
    job.lastRunAt = now.getTime();
    job.lastStatus = status;
    if (status === 'ok') {
      job.retryAt = null;
      job.retryCount = 0;
      // 只有"有内容的成功输出"才更新 continuity（静默/空输出不算）
      if (output?.trim()) job.lastOutput = output.trim().slice(0, 8000);
    }
    if (job.kind === 'once') job.enabled = false; // 一次性：跑过即退场
    this.pushLedger({ at: now.getTime(), jobId: id, status, detail, costUsd });
    this.running.delete(id);
    await this.save();
  }

  /**
   * 失败处理：**零花费才重试**——瞬时网络错误 + 一次模型调用都没完成（costUsd 未增加）。
   * 重试梯 5/15/30 分钟，最多 3 次；否则记失败不重试。
   */
  async fail(id: string, opts: { zeroCost: boolean; transient: boolean; detail?: string }): Promise<{ retryInMs?: number }> {
    const job = this.file.jobs.find((j) => j.id === id);
    if (!job) return {};
    const now = this.clock();
    job.firingAt = null;
    job.lastRunAt = now.getTime();
    job.lastStatus = 'failed';
    if (job.kind === 'once') job.enabled = false;
    let retryInMs: number | undefined;
    const n = job.retryCount ?? 0;
    if (opts.zeroCost && opts.transient && n < RETRY_STEPS_MS.length) {
      retryInMs = RETRY_STEPS_MS[n];
      job.retryAt = now.getTime() + retryInMs;
      job.retryCount = n + 1;
    } else {
      job.retryAt = null;
    }
    this.pushLedger({ at: now.getTime(), jobId: id, status: 'failed', detail: opts.detail });
    this.running.delete(id);
    await this.save();
    return retryInMs ? { retryInMs } : {};
  }

  /** 周期估算（宽限用）：相邻两次 nextCron 的间隔 */
  private periodMs(job: CronJob): number {
    const now = this.clock();
    const a = nextCron(job.spec, now);
    if (!a) return 24 * 3600 * 1000;
    const b = nextCron(job.spec, new Date(a.getTime() + 60 * 1000));
    return b ? Math.max(60 * 1000, b.getTime() - a.getTime()) : 24 * 3600 * 1000;
  }

  private pushLedger(e: LedgerEntry): void {
    this.file.ledger.push(e);
    if (this.file.ledger.length > LEDGER_MAX) this.file.ledger.splice(0, this.file.ledger.length - LEDGER_MAX);
  }
}

/** cron 表达式是否合法（建任务时人话校验用；也供工具/UI 复用） */
export function validCron(spec: string): boolean {
  return cronMatches(spec, new Date()) || nextCron(spec, new Date()) !== null;
}
