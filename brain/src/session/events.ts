// 事件协议唯一出处。每行 JSON 是 UI/日志/hooks/评测的唯一数据源。
// 模块禁止直接 console.log 事件——只经本模块 emit。
// 事件流同时接入 core 签名日志链（防篡改审计主干）。

export interface EvSessionStart {
  type: 'session.start';
  id: string;
  cwd: string;
  provider: string;
  model: string;
  startedAt: string;
}
export interface EvSessionResume { type: 'session.resume'; id: string; resumedAt: string }
export interface EvSessionFork { type: 'session.fork'; id: string; parentId: string }
export interface EvUserPromptSubmit { type: 'user.prompt.submit'; seq: number; text: string }
export interface EvUserPromptAbort { type: 'user.prompt.abort'; seq: number }
/** steer 档：用户在本回合干活途中插的话——落到下一轮请求尾部的用户消息里 */
export interface EvUserSteerSubmit { type: 'user.steer.submit'; seq: number; text: string }
export interface EvTurnStart { type: 'turn.start'; seq: number }
export interface EvTextDelta {
  type: 'assistant.text.delta';
  seq: number;
  text: string;
  /** **落盘时合并**过的标志 */
  coalesced?: boolean;
  /** 这一条由几块拼成（界面上是几段，文件里一行） */
  chunks?: number;
  /** 第一块/最后一块的时刻（合并后仍然留得住"她流了多久"） */
  firstAt?: string;
  lastAt?: string;
}
export interface EvReasoningDelta {
  type: 'assistant.reasoning.delta';
  seq: number;
  text: string;
  coalesced?: boolean;
  chunks?: number;
  firstAt?: string;
  lastAt?: string;
}
/** 风险档（R0~R5）的唯一真源是 `policy/risk.ts`；随工具事件一起发出去，宿主据此决定记不记签名链。
 *  **宿主不许自己按工具名再猜一套**——那样同一件事会有两个判断。 */
export type EvRisk = 'R0' | 'R1' | 'R2' | 'R3' | 'R4' | 'R5';

export interface EvToolCall { type: 'tool.call'; seq: number; id: string; name: string; args: unknown; risk?: EvRisk }
export interface EvToolResult {
  type: 'tool.result';
  seq: number;
  id: string;
  ok: boolean;
  output: string;
  truncated: boolean;
  /** 失败原因（错误码 + 人话）——只有 `ok:false` 与空 output 的话，
   *  UI/日志/报告都看不出"为什么没成"（每个动作必须可观察）。 */
  error?: { code: string; message: string };
  /** 与 `tool.call` 同源的 R 档（宿主拿它决定"这一笔值不值得进签名链"） */
  risk?: EvRisk;
}
export interface EvTurnEnd {
  type: 'turn.end';
  seq: number;
  final: boolean;
  usage: { inTokens: number; hitTokens: number; missTokens: number; outTokens: number; reasoningTokens: number; costUsd: number };
}
export interface EvCompactStart { type: 'compact.start'; beforeTokens: number }
export interface EvCompactEnd { type: 'compact.end'; beforeTokens: number; afterTokens: number }
export interface EvCompactFailed { type: 'compact.failed'; beforeTokens: number; reason: string }
/** 摘要输入超预算 → 均匀采样后发送（省略条数可审计） */
export interface EvCompactSampled { type: 'compact.sampled'; elided: number; chars: number }
export interface EvCache { type: 'cache'; hitTokens: number; missTokens: number; hitRate: number }
export interface EvCacheBroken { type: 'cache.broken'; reason: string }
export interface EvApprovalRequest {
  type: 'approval.request';
  tool: string;
  args: unknown;
  ruleId: string;
  /** 动作风险档（R0~R5，内核 `policy/risk.ts` 是唯一出处）。老事件缺它 = 未知档。 */
  risk?: string;
}
export interface EvApprovalResult {
  type: 'approval.result';
  tool: string;
  granted: boolean;
  /**
   * 这一下是**谁**放的——不写清楚，事后读日志会把三件事读成一回事：
   *   'user'          用户在卡片上点的（真问过）
   *   'session-grant' 之前那次「到这次对话结束都允许」覆盖了（**没问**）
   *   省略            没通道/超时（granted=false 那条路）
   */
  by?: 'user' | 'session-grant';
}
/** 模式切换（闲聊↔工作）。宿主据此换界面，日志据此记"为什么进了工作模式"。 */
export interface EvModeChange {
  type: 'mode.change';
  seq: number;
  mode: 'chat' | 'work';
  /** explicit 用户明说 / rule 命中规则 / behavior 她动手了 / host 宿主（锁定、启动恢复） */
  source: 'explicit' | 'rule' | 'behavior' | 'host';
  reason: string;
}
/** 设备操作审计：每次设备操作一个事件（动作/分级/确认/结果/撤销信息）→ 宿主入签名日志 */
export interface EvDeviceAction {
  type: 'device.action';
  id: string;
  action: string;
  level: 'observe' | 'suggest' | 'execute' | 'highRisk';
  /** 闸门放行了（注意：低风险**自动放行**也是 true——别当成"用户确认过"，那要看 asked） */
  confirmed: boolean;
  /** **内核口径**：闸门发起了审批请求没有。
   *  ⚠ 它不等于"用户真的被问了"——宿主还会按作用域（闲聊档不问 / 后台回合不打扰）静默代答。
   *  审计条目里给人看的那个 `asked` 由**宿主**算：gateAsked && 宿主确实把这一问交给了用户。 */
  gateAsked: boolean;
  ok: boolean;
  output: string;
  undo: string;
  at: string;
}
export interface EvHook { type: 'hook'; name: string; event: string; exit: number }
export interface EvMemoryWrite {
  type: 'memory.write';
  scope: string;
  key: string;
  action: 'write' | 'overwrite' | 'delete' | 'redacted';
}
export interface EvMemoryConsolidate { type: 'memory.consolidate'; added: number; updated: number; deleted: number }
export interface EvSelfcheckFlag { type: 'selfcheck.flag'; text: string; rule: string }
/** 验证契约（工作模式收尾时产出；UI 用它渲染"证据"卡，日志用它审计"凭什么说做完了"） */
export interface EvVerifyReport {
  type: 'verify.report';
  seq: number;
  passed: boolean;
  confidence: number;
  attempts: number;
  evidence: Array<{ type: string; target: string; status: string; detail: string }>;
}
export interface EvSessionEnd {
  type: 'session.end';
  stats: {
    iterations: number;
    costUsd: number;
    cacheHitRate: number;
    compactions: number;
    subagentCostUsd: number;
    failedToolCalls: number;
    memoryWrites: number;
  };
}
export interface EvError { type: 'error'; code: string; message: string }
/** 失败分类与恢复——她为什么停下来、为什么自动重来。
 *  没有这个事件，"她没做完"和"她试过了但不行"分不出来。 */
export interface EvRecoveryPlan {
  type: 'recovery.plan';
  seq: number;
  /** 归一后的处境：transient/usage/budget/auth/context/loop/bad_args/permission/env/unknown */
  kind: string;
  /** 处置：retry/repair/replan/ask/fix_env/escalate */
  action: string;
  /** true = 带提示自动重来一次；false = 停下来报清楚 */
  auto: boolean;
  why: string;
  /** 第几次尝试（1 = 第一次就停/就重来；2 = 重来之后） */
  attempt?: number;
  /** 只在"重来之后成了"这一条上为 true —— 恢复成功率就是数它 */
  recovered?: boolean;
}

/** 她做出/改出了一个文件（产物登记）——"Agent 不只返回文本"。 */
export interface EvArtifactCreated {
  type: 'artifact.created';
  seq: number;
  id: string;
  kind: string;
  path?: string;
  uri?: string;
  mimeType: string;
  size?: number;
  createdBy: string;
  at: string;
}

/**
 * **后台复盘产出的候选**——人批准才生效。
 * 为什么单开事件而不是直接写记忆：复盘者与执行者分离，它**只能提候选，不能改核心行为**；
 * "她自己在背后改了我的记忆"是不可接受的。两个事件的 payload 都带 `why`（凭什么这么提），
 * 用户/界面据此判断值不值得批准。
 */
export interface EvMemoryCandidate {
  type: 'memory.candidate';
  /** 候选记忆的键（批准后就是语义记忆的 name） */
  key: string;
  /** 一句话正文（截断后的） */
  content: string;
  /** 提这条候选的理由（复盘者自述，给用户看） */
  why: string;
  /** 谁提的：'review' = 后台复盘 */
  by: string;
}

export interface EvSkillCandidate {
  type: 'skill.candidate';
  name: string;
  description: string;
  why: string;
  by: string;
}

/**
 * 「撤销这一轮改动」真的做了（还原动作进事件流 + 签名链）。
 * 为什么单独一个事件：回滚是**改用户文件**的动作，必须与工具调用一样可查——
 * "谁在什么时候把我的三个文件退回去了"要说得清（`restored`/`removed`/`failed` 三个数）。
 */
export interface EvUndoDone {
  type: 'undo.done';
  /** 退的是哪个回合 */
  turnId: string;
  /** 写回原样的文件数 */
  restored: number;
  /** 这一轮新建、被删掉（进回收站）的文件数 */
  removed: number;
  /** 没退成的文件数（>0 时调用方必须如实告诉用户是哪几个） */
  failed: number;
  why: string;
}

export type AgentEvent =
  | EvSessionStart | EvSessionResume | EvSessionFork
  | EvUserPromptSubmit | EvUserPromptAbort | EvUserSteerSubmit
  | EvTurnStart | EvTextDelta | EvReasoningDelta | EvToolCall | EvToolResult | EvTurnEnd
  | EvCompactStart | EvCompactEnd | EvCompactFailed | EvCompactSampled
  | EvCache | EvCacheBroken
  | EvApprovalRequest | EvApprovalResult
  | EvModeChange
  | EvDeviceAction
  | EvHook
  | EvMemoryWrite | EvMemoryConsolidate
  | EvSelfcheckFlag
  | EvVerifyReport
  | EvArtifactCreated
  | EvMemoryCandidate | EvSkillCandidate | EvUndoDone
  | EvSessionEnd
  | EvError
  | EvRecoveryPlan;

/** 顺序恒为：user.prompt.submit → turn.start → (delta/tool.call/tool.result)* → turn.end → … → session.end */
export const EVENT_ORDER: string[] = [
  'session.start', 'session.resume', 'session.fork',
  'user.prompt.submit', 'user.prompt.abort', 'user.steer.submit',
  'turn.start', 'assistant.text.delta', 'assistant.reasoning.delta',
  'tool.call', 'tool.result', 'turn.end',
  'compact.start', 'compact.end', 'compact.failed', 'compact.sampled',
  'cache', 'cache.broken',
  'approval.request', 'approval.result',
  'mode.change',
  'device.action',
  'hook', 'memory.write', 'memory.consolidate',
  'selfcheck.flag', 'verify.report', 'recovery.plan', 'artifact.created',
  'memory.candidate', 'skill.candidate', 'undo.done', 'session.end', 'error',
];

/** 每行 JSON（事件文件行格式） */
export function eventLine(ev: AgentEvent): string {
  return JSON.stringify(ev);
}

/**
 * 事件信封：
 *   ① **稳定 id**：一行一个，跨进程不撞（`ev-<epoch36>-<计数器>`），排障/回放/去重都靠它；
 *   ② **时间戳**：ISO 8601（与记忆、签名链同一口径）——"什么时候发生的"从此有答案。
 *
 * ⚠ **为什么不直接加 `id` / `at` 两个平铺字段**：
 *   `tool.call` / `tool.result` / `approval.*` **本来就带 `id`**，而且**调用与结果共用同一个 id**——
 *   把它当"事件 id"用，一行一个唯一 id 这件事立刻不成立，还会破坏"调用↔结果"的关联。
 *   所以信封**单独放一层** `env`：老字段一个不动，消费方按需读 `ev.env?.id`。
 *
 * 纪律：`stampEmitter` 是**唯一**该盖信封的地方（宿主落盘点 / CLI 落盘点各挂一次）；
 * 已经有 `env` 的事件不重复盖（幂等）。
 */
export interface EventEnvelope {
  /** 事件 id：`ev-<epoch36>-<计数器>`（同进程单调，跨进程靠 epoch 前缀） */
  id: string;
  /** ISO 8601 时间戳 */
  at: string;
  /**
   * **事件序号**（从 1 开始，同进程单调）。
   * ⚠ 老字段 `seq` 不是序号——它是 `session.stats.iterations + 1`（"第几轮/第几次模型调用"），
   * 一轮里会重复很多次（实测 6309 行只有 8 个不同值、`seq=1` 出现 4407 次）。
   * 要"按顺序读事件"就用 `env.n`。
   */
  n: number;
}

export type StampedEvent = AgentEvent & { env?: EventEnvelope };

/** 盖信封的发射器包装：`inner` 是真正的落点（写文件 / 转发界面） */
export function stampEmitter(inner: Emitter, nextId: () => string, clock: () => string): Emitter {
  let n = 0;
  return (ev: AgentEvent) => {
    const e = ev as StampedEvent;
    if (e.env?.id && e.env?.at && typeof e.env.n === 'number') return inner(ev);
    inner({
      ...e,
      env: { id: e.env?.id ?? nextId(), at: e.env?.at ?? clock(), n: e.env?.n ?? ++n },
    } as unknown as AgentEvent);
  };
}

/**
 * **落盘合并**：
 * 流式增量在**界面上照旧一块一块地到**（那是真流式的体感，不能动），
 * 但**写进 `events.jsonl` 时合并成一行**——否则 5000 多行 delta 各背一个信封（id/at/n），
 * 文件接近翻倍（实测 6309 行事件里 5225 行是 delta）。
 *
 * 用法：**只在落盘点套一层**（`coalesceDeltas(写文件的那个 emitter)`），
 * 绝不能套在通往界面的那条路上——套错了界面的流式就变成"说完才出现"。
 *
 * 合并规则：同类的 text / reasoning delta 攒着，遇到**任何别的类型的事件**（或攒到 maxChars）就冲一行；
 * 冲出去的那条仍是原类型，带 `coalesced/chunks/firstAt/lastAt`，原顺序不变。
 */
export function coalesceDeltas(inner: Emitter, opts: { maxChars?: number; clock?: () => string } = {}): Emitter {
  const maxChars = opts.maxChars ?? 8000;
  const clock = opts.clock ?? (() => new Date().toISOString());
  let bufType: 'assistant.text.delta' | 'assistant.reasoning.delta' | null = null;
  let bufText = '';
  let chunks = 0;
  let firstAt = '';
  let seq = 0;
  let lastAt = '';

  const flush = () => {
    if (bufType === null) return;
    const ev = {
      type: bufType, seq, text: bufText, coalesced: true, chunks,
      ...(firstAt ? { firstAt } : {}), ...(lastAt ? { lastAt } : {}),
    } as unknown as AgentEvent;
    bufType = null; bufText = ''; chunks = 0; firstAt = ''; lastAt = '';
    inner(ev);
  };

  return (ev: AgentEvent) => {
    const e = ev as { type: string; text?: string; seq?: number };
    if (e.type === 'assistant.text.delta' || e.type === 'assistant.reasoning.delta') {
      if (bufType !== null && bufType !== e.type) flush(); // 换了种类 → 先把上一类冲掉
      if (bufType === null) {
        bufType = e.type === 'assistant.text.delta' ? 'assistant.text.delta' : 'assistant.reasoning.delta';
        seq = Number(e.seq ?? 0);
        firstAt = clock();
      }
      bufText += String(e.text ?? '');
      chunks += 1;
      lastAt = clock();
      if (bufText.length >= maxChars) flush();
      return;
    }
    flush();          // 别的任何事件 → 先把攒着的冲出去（保证顺序）
    inner(ev);
  };
}

/** 造一个 id 生成器（一个进程一个：同 ms 内用计数器保顺序） */
export function makeEventIdFactory(prefix = 'ev'): () => string {
  let n = 0;
  return () => `${prefix}-${Date.now().toString(36)}-${(++n).toString(36)}`;
}

/**
 * 子代理转发的事件带 `by`（分身名）。
 * 宿主据此把"分身说的"和"她说的"分开——子代理的字不许进她的气泡，它的步骤要挂在派活那行下面。
 */
export type ForwardedEvent = AgentEvent & { by?: string };

export type Emitter = (ev: AgentEvent) => void;

/** 无操作 emitter：模块内安全缺省 */
export function nullEmitter(): Emitter {
  return () => undefined;
}
