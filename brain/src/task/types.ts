// 任务账本 · 类型与状态词。
//
// 为什么任务不绑会话：TA 是常驻的——用户可能从 Pet 说一句、从 Quick 说一句、由定时任务触发。
// **任务属于 TA，不属于某次对话**，这也是"关掉软件再打开能接着干"的前提。
//
// 状态词要能分开说清「卡住了 / 被限流了 / 额度用完了」——
// 这对"要不要打扰用户、要不要继续催"是决定性输入（催办退避据此判断该不该催、催几次）。

/** 步骤的可见态（模型看到的一面：4 态，降低认知负担） */
export type StepStateVisible = 'pending' | 'in_progress' | 'completed' | 'blocked';

/** 步骤的落库态（精确态） */
export type StepState = 'pending' | 'running' | 'completed' | 'failed' | 'blocked' | 'skipped' | 'cancelled';

/**
 * 运行态（比可见态多出"为什么停下"）。
 * usage_limited / budget_limited **必须分开**：一个等一会儿就好，一个得用户去充值/换脑。
 */
export type RunState =
  | 'pending'
  | 'running'
  | 'paused'          // 被中断（重启/用户叫停/到上限）——可继续，但不自动跑
  | 'blocked'         // 卡住：等依赖 / 等用户决定 / 出错
  | 'usage_limited'   // 被服务商限流（429 之类）——等一会儿能自己好
  | 'budget_limited'  // 额度/预算用尽（402 余额、成本上限）——用户不动作就好不了
  | 'completed'
  | 'failed'
  | 'cancelled';

/** 卡住的原因（决定"要不要开口问人"） */
export type BlockReason = 'needs_input' | 'dependency' | 'error';

/** 状态词的机器名（UI 按它上色/出图标；人话在 label） */
export type StatusKey = 'active' | 'paused' | 'needs_input' | 'blocked' | 'usage_limited' | 'budget_limited' | 'completed' | 'failed' | 'cancelled';

export interface StatusWord {
  key: StatusKey;
  /** 人话（直接说给用户听） */
  label: string;
  /** 补充一句（为什么会这样 / 接下来怎么办） */
  hint: string;
  /** 是否已经停住（停住的状态才需要"催办/打扰"判定） */
  stopped: boolean;
}

/** 步骤的终态集合（依赖就绪判定用） */
export const STEP_DONE: ReadonlySet<StepState> = new Set<StepState>(['completed', 'skipped']);

export interface TaskStep {
  /** 稳定 id（模型据此更新；人类可读如 s1/s2） */
  id: string;
  sequence: number;
  title: string;
  goal: string;
  /** 依赖的前置步骤 id（DAG 边） */
  dependencies: string[];
  /** 验收标准（写给人看，也是模型自查依据） */
  acceptance: string;
  state: StepState;
  resultSummary?: string;
  /** 产物绝对路径 */
  artifacts: string[];
  retryCount: number;
  startedAt?: string;
  completedAt?: string;
  /** 失败/阻塞原因（人话，可回灌模型） */
  detail?: string;
}

export interface TaskRun {
  id: string;
  /** 发起来源（TA 可能从任一入口接活） */
  origin: 'pet' | 'home' | 'quick' | 'cron' | 'chat';
  /** 发起时的会话 id（重启后仍能回到同一份记录；不强绑会话生命周期） */
  sessionId?: string;
  title: string;
  /** 为什么做这件事（人话，用于进度播报） */
  explanation: string;
  state: RunState;
  /** 工作区根 */
  workspace?: string;
  steps: TaskStep[];
  createdAt: string;
  updatedAt: string;
  completedAt?: string;

  // —— 完成判据（"没做到就别说完事了"）——
  /** 完成信号：模型必须**原样输出**这个字符串才算做完（字面比较，不用 glob/regex） */
  completionPromise?: string;
  /** 硬迭代上限（防"无限循环"；到上限停下并诚实说明，绝不无声耗一夜） */
  maxIterations: number;
  /** 已消耗的续跑轮次 */
  iterations: number;

  // —— "我需要你决定一件事"是一等状态 ——
  /** 卡住时要问用户的话（人话）；blocked + needs_input 时才有 */
  question?: string;
  blockReason?: BlockReason;
  blockedAt?: number;

  // —— 催办退避曲线（30 分 → 1 小时 → 2 小时；每周期最多 3 次）——
  nudgeCount: number;
  lastNudgeAt?: number;
  /** 用户最后一次回应这条任务的时刻（用户一说话就重置催办周期） */
  lastUserAt?: number;

  /** 状态原因（人话，直接能说给用户听） */
  stateDetail?: string;
}

/** 终态：到了就不再推进（重启恢复也不会动它） */
export const TERMINAL_RUN_STATES: ReadonlySet<RunState> = new Set<RunState>(['completed', 'failed', 'cancelled']);

export function isTerminal(state: RunState): boolean {
  return TERMINAL_RUN_STATES.has(state);
}

/** 把落库状态翻译成"能直接说出口的一句话" */
export function statusWord(run: Pick<TaskRun, 'state' | 'question' | 'blockReason' | 'stateDetail'>): StatusWord {
  switch (run.state) {
    case 'pending':
    case 'running':
      return { key: 'active', label: '进行中', hint: run.stateDetail ?? '', stopped: false };
    case 'paused':
      return { key: 'paused', label: '暂停了，可以接着干', hint: run.stateDetail ?? '上次被打断了，说一声我就继续', stopped: true };
    case 'blocked':
      if (run.blockReason === 'needs_input') {
        return { key: 'needs_input', label: '卡住了，需要你决定一件事', hint: run.question ?? run.stateDetail ?? '', stopped: true };
      }
      if (run.blockReason === 'dependency') {
        return { key: 'blocked', label: '卡住了，前面的步骤没成', hint: run.stateDetail ?? '', stopped: true };
      }
      return { key: 'blocked', label: '卡住了', hint: run.stateDetail ?? '', stopped: true };
    case 'usage_limited':
      return { key: 'usage_limited', label: '被限流了，等一会儿自己能好', hint: run.stateDetail ?? '服务商临时限流', stopped: true };
    case 'budget_limited':
      return { key: 'budget_limited', label: '额度用完了，得你处理一下', hint: run.stateDetail ?? '账户余额不足或到了花费上限', stopped: true };
    case 'completed':
      return { key: 'completed', label: '完成了', hint: run.stateDetail ?? '', stopped: true };
    case 'failed':
      return { key: 'failed', label: '没做成', hint: run.stateDetail ?? '', stopped: true };
    case 'cancelled':
      return { key: 'cancelled', label: '不做了', hint: run.stateDetail ?? '', stopped: true };
  }
}

/** 进度（"3/7 步"；无步骤的任务返回 null——它只有 run 层状态） */
export function progressOf(run: Pick<TaskRun, 'steps'>): { done: number; total: number } | null {
  if (!run.steps.length) return null;
  return { done: run.steps.filter((s) => STEP_DONE.has(s.state)).length, total: run.steps.length };
}

/** 事件流类型（真相源；重放即可重建任何状态——"断电后能接着做"的物理基础） */
export type TaskEventType =
  | 'run_created'
  | 'plan_set'
  | 'step_started'
  | 'step_completed'
  | 'step_failed'
  | 'step_blocked'
  | 'step_retried'
  | 'step_completed_by_user'
  | 'run_paused'
  | 'run_resumed'
  | 'run_cancelled'
  | 'run_finalized'
  | 'needs_input'                  // 卡住要人拍板
  | 'nudge_sent'                   // 催了一次
  | 'recovered_requires_confirmation' // 重启后被置 paused
  | 'limited'                      // 限流/额度/上下文，分开记
  | 'artifact_created'
  | 'note';

export interface TaskEvent {
  seq: number;
  at: string;
  type: TaskEventType;
  stepId?: string;
  payload: Record<string, unknown>;
}

/** 轻量索引条目（管理界面/启动扫描不加载全部事件） */
export interface TaskIndexEntry {
  id: string;
  title: string;
  state: RunState;
  status: StatusKey;
  label: string;
  progress: { done: number; total: number } | null;
  hasQuestion: boolean;
  updatedAt: string;
}

export function indexEntry(run: TaskRun): TaskIndexEntry {
  const w = statusWord(run);
  return {
    id: run.id,
    title: run.title,
    state: run.state,
    status: w.key,
    label: w.label,
    progress: progressOf(run),
    hasQuestion: !!run.question && run.state === 'blocked',
    updatedAt: run.updatedAt,
  };
}
