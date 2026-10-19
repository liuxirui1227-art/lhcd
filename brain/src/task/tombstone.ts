// 崩溃回合留墓碑、重开接着做完。
//
// 语义：一轮对话开始时在磁盘写一条"我正在做这件事，用户的原始请求是 XXX"；
// **任何正常结束都清掉，只有进程被杀死才会留下**。下次启动读到墓碑、且够新 → 自动把原始请求
// 重新提交一次，并附一句"先看现状再动手"。
//
// 三条护栏（缺一条就会变成烧钱循环或重复副作用）：
//   ① 新鲜度窗口（默认 15 分钟）——三天前的墓碑不续（你早就不关心那件事了）
//   ② 次数上限（默认 2 次）——重启后反复崩，不能无限续跑
//   ③ 提示词明写"**先看现状再动手**"——否则有副作用的步骤（改文件/发消息）会被重复做一遍
import type { Runtime } from '../runtime/types.js';

export interface Tombstone {
  sessionId: string;
  /** 用户的原始请求（续跑时原样重新提交） */
  text: string;
  startedAt: number;
  /** 已经续跑过的次数（每次续跑 +1；到上限不再续） */
  attempts: number;
}

export const TOMBSTONE_FRESH_MS = 15 * 60 * 1000;
export const TOMBSTONE_MAX_ATTEMPTS = 2;

export interface ResumeDecision {
  resume: boolean;
  reason: 'ok' | 'none' | 'stale' | 'exhausted' | 'empty';
  prompt?: string;
}

/** 续跑提示词：原样重提原始请求 + 明写"先看现状再动手" */
export function resumePrompt(t: Tombstone): string {
  return [
    '（接着刚才的做）应用或后端在完成前停止了，有些工作可能已经完成。',
    `你刚才在处理这件事：「${String(t.text).slice(0, 500)}」`,
    '**先看现状再动手**（先去确认已经做到哪一步了，别把做过的重做一遍——改文件、发消息这类动过手的事尤其要看清楚），然后把这件事做完，用你自己的口吻告诉我结果。',
  ].join('\n');
}

/** 纯判定：该不该续（可单测；IO 在外面） */
export function decideResume(t: Tombstone | null | undefined, now: number): ResumeDecision {
  if (!t) return { resume: false, reason: 'none' };
  if (!String(t.text ?? '').trim()) return { resume: false, reason: 'empty' };
  if (Number(t.attempts ?? 0) >= TOMBSTONE_MAX_ATTEMPTS) return { resume: false, reason: 'exhausted' };
  const age = now - Number(t.startedAt ?? 0);
  if (!(age >= 0) || age > TOMBSTONE_FRESH_MS) return { resume: false, reason: 'stale' };
  return { resume: true, reason: 'ok', prompt: resumePrompt(t) };
}

/** 墓碑文件读写（`<dir>/tombstone.json`；单文件 = 当前未完成的那一轮） */
export class TurnTombstone {
  constructor(
    private readonly runtime: Runtime,
    private readonly file: string,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  /** 回合开始：写墓碑（只在**用户主动发起**的回合写；心跳/定时任务的合成文本不算"用户交代的事"） */
  async write(sessionId: string, text: string, attempts = 0): Promise<void> {
    const t: Tombstone = { sessionId, text: String(text ?? '').slice(0, 2000), startedAt: this.clock().getTime(), attempts };
    await this.runtime.fs.writeAtomic(this.file, JSON.stringify(t, null, 2));
  }

  /** 任何正常结束（成功/失败/中止/到上限）都要清——留下墓碑 = 只可能是被杀。 */
  async clear(): Promise<void> {
    try {
      await this.runtime.fs.write(this.file, '');
    } catch { /* 清不掉不阻断收尾 */ }
  }

  async read(): Promise<Tombstone | null> {
    try {
      const raw = (await this.runtime.fs.read(this.file)).content.trim();
      if (!raw) return null;
      const t = JSON.parse(raw) as Tombstone;
      if (!t || typeof t.text !== 'string') return null;
      return { sessionId: String(t.sessionId ?? 'main'), text: t.text, startedAt: Number(t.startedAt ?? 0), attempts: Number(t.attempts ?? 0) };
    } catch {
      return null;
    }
  }

  /** 续跑前把尝试次数 +1 落盘（崩在续跑里也不会无限循环） */
  async bumpAttempts(t: Tombstone): Promise<void> {
    await this.write(t.sessionId, t.text, Number(t.attempts ?? 0) + 1);
  }
}
