// 完成判据：把"任务做完了"从模型的自由发挥，变成**必须原样输出的字符串信号**。
//
// **只借有上限的续跑形态**——"无限循环、不可手动停"在终端可接受，
// **会主动出声的桌面伙伴不可接受**：必须有硬迭代上限，且用户随时能叫停。
//
// **统一 Stop 管线 + 固定顺序**：`后台自检回插 → 完成判据 → 才允许结束`
//（后台复核将来插在完成判据前面一格）。
//
// 三条防作弊纪律（硬编码，不信模型自觉）：
//   ① 信号**字面比较**（不用 glob/regex）——`<promise>` 原样出现才算数
//   ② 续跑提示词反复禁止"为了脱身而谎报完成"，并点名"基本完成/差不多了"这类话术
//   ③ 到上限 → 停下并诚实说明（宁可说"我还没做完"，也不假装做完了）

import type { TaskRun } from './types.js';

/**
 * 完成信号的判定：**最后一行非空正文原样等于信号**。
 *
 * 不能用 `includes()`——太松：模型只要在正文里**提到**信号就算完成
 * （"我还没做完，所以现在不能输出 DONE-ALL" 会被判做完了，而用户根本看不到那个词，
 * 因为交付文本会剥掉信号）。也不用标签，改用"最后一行"：
 * 与续跑提示词里那句"在回复的最后单独一行，原样输出这个完成信号"配套。
 */
export function promiseSeen(text: string, promise: string): boolean {
  const p = String(promise ?? '').trim();
  if (!p) return false;
  const lines = String(text ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
  return lines.length > 0 && lines[lines.length - 1] === p;
}

/** 交付给用户的文本：剥掉完成信号（用户不该看到 `DONE` 这种机关） */
export function stripPromise(text: string, promise: string): string {
  const p = String(promise ?? '');
  if (!p) return String(text ?? '');
  return String(text ?? '')
    .split(p)
    .join('')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export type StopVerdict =
  | { action: 'allow' }                                  // 放行（可以结束这一回合）
  | { action: 'continue'; nudge: string }                // 还没做到 → 拦回来继续
  | { action: 'cap'; text: string; detail: string };     // 到硬上限 → 停下并诚实说明

export interface StopInput {
  /** 本次已经续跑了多少轮（run.iterations，由调用方回写） */
  iteration: number;
  /** 硬上限（默认 12；模型建任务时可调，封顶 50） */
  maxIterations: number;
  title: string;
}

/** 续跑提示词（硬编码防作弊话术；作为一条**用户侧追加消息**回灌，不动 system 前缀缓存） */
export function continuationNudge(title: string, promise: string, n: number, max: number): string {
  return [
    `（系统提示·第 ${n}/${max} 次续跑）你手上这件事还没做完：「${title}」。`,
    '没做到就别说完事了——**不要为了脱身而谎报完成**，不要为了让对话结束就说做完了，也不要用"基本完成/差不多了/主要部分已经做完"这类说法代替真做完。',
    '接着做，把剩下的做完。真做完之后，在回复的最后单独一行，原样输出这个完成信号（一个字都不能改）：',
    promise,
  ].join('\n');
}

/** 到上限的话（诚实说明，不假装） */
export function capText(title: string, max: number): { text: string; detail: string } {
  return {
    text: `（这件事我还没做完——续跑了 ${max} 次到了我自己设的上限，先停下，免得一直烧下去。你说一声"继续"，我接着来。）`,
    detail: `续跑 ${max} 次到上限，停下等你`,
  };
}

/**
 * 统一 Stop 管线的当前实现（"后台自检回插"那一格将来插在它前面）。
 * 返回 allow 时，调用方负责把信号从交付文本里剥掉、并把 run 标完成。
 */
export function stopVerdict(run: Pick<TaskRun, 'title' | 'completionPromise' | 'maxIterations' | 'iterations'> | null, text: string, opts?: { increment?: boolean }): StopVerdict {
  if (!run?.completionPromise) return { action: 'allow' };
  const iteration = Number(run.iterations ?? 0) + (opts?.increment ? 1 : 0);
  if (promiseSeen(text, run.completionPromise)) return { action: 'allow' };
  const max = Math.max(1, Number(run.maxIterations ?? 12));
  if (iteration >= max) {
    const c = capText(run.title, max);
    return { action: 'cap', text: c.text, detail: c.detail };
  }
  return { action: 'continue', nudge: continuationNudge(run.title, run.completionPromise, iteration + 1, max) };
}

/**
 * 模型建任务时看到的"完成判据"说明（进工具返回值，不进 system——保住冻结前缀）。
 * 说清三件事：什么算做完、怎么表示做完、做不到时会怎样。
 */
export function completionBriefing(promise: string, maxIterations: number): string {
  return [
    `这件事有完成判据：**没做到就别说完事了**。`,
    `· 真做完之后，在回复最后单独一行原样输出：${promise}`,
    `· 在那之前，每一次你想收尾都会被拦回来继续做（我最多拦 ${maxIterations} 次，到上限我会停下并如实告诉你还没做完）`,
    `· 不要为了脱身而谎报完成——"基本完成"不算完成`,
  ].join('\n');
}

/** 状态机：把一次续跑记进 run（上游持久化由 store 做） */
export function bumpIterations(run: Pick<TaskRun, 'iterations'>): number {
  return Number(run.iterations ?? 0) + 1;
}
