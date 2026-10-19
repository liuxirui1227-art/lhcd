// 回合状态机（唯一实现）：
// assemble → infer → decide → execute，异常 repair/retry，收尾 self-check。
// 并行工具执行：非写类并行 ≤4；写类（exclusive）互斥串行；结果按模型返回顺序回写。
import type { ChatEvent, ChatMessage, ToolCall, Usage } from '../llm/provider.js';
import type { ToolResult } from '../tools/registry.js';
import type { ExecCtx } from '../tools/registry.js';
import { zeroUsage } from '../llm/usage.js';
import { deviceLevelFor, deviceUndoHint } from '../tools/app.js';
import type { Session } from './session.js';
import { prepareCalls, type PreparedCall } from './retry.js';
import { compactSession } from './compact.js';
import { selfCheck, collectEvidence } from './selfcheck.js';
import { runHooks } from '../hooks/runner.js';
import { stopVerdict, promiseSeen, stripPromise } from '../task/criteria.js';
import { reviewMutations } from './workcheck.js';
import { TurnSnapshots } from '../session/snapshots.js';
import { maybePersistOutput } from './persist.js';
import { behaviorUpgrade, modePolicyOf } from '../lifecycle/mode.js';
import { buildVerificationReport, verifyNudge, type VerificationReport } from './verify.js';
import { riskLevelOf } from '../policy/risk.js';
import type { CostRole } from '../cost/ledger.js';
import { ArtifactLog, artifactFromMutation } from '../session/artifacts.js';

/** 模型角色 → 账本桶（子代理/压缩/轻活各自单独一桶，别混进"闲聊"账里） */
function costRoleOf(ref: { role: string; thinking?: boolean }): CostRole {
  if (ref.role === 'subagent') return 'subagent';
  if (ref.role === 'compact') return 'compact';
  if (ref.role === 'fast') return 'fast';
  return ref.thinking ? 'reasoner' : 'main';
}

/** 回合的七种"停下"原因（宿主据此出人话、账本据此归类） */
export type LimitReason =
  | 'maxIterations' | 'maxCost' | 'maxContext'   // 迭代 / 成本 / 上下文
  | 'maxTokens' | 'maxRuntime'                    // 累计 token / 墙钟
  | 'waitingUser' | 'policy';                     // 等审批超时 / 策略连续硬拒

export type TurnResult =
  /** `verification`：验证契约（工作模式收尾时产出；闲聊模式不产出）——宿主用它渲染"证据"卡 */
  | { kind: 'final'; text: string; verification?: VerificationReport }
  /** 用户中止但已有半截正文——正文已推进本会话上下文（说"继续"能接着写） */
  | { kind: 'aborted'; text: string }
  | {
      kind: 'limit';
      /** 七种出口，见 LimitReason */
      reason: LimitReason;
      text: string;
    }
  | { kind: 'error'; message: string };

export interface RunTurnOpts {
  /** 插话队列（steer 档）：每个工具轮次结束、下一轮请求前取一次；
   *  取到的文本追加到当轮尾部用户消息（append-only，不破坏前缀缓存），模型在下一轮就能看到。 */
  drainSteers?: () => string[];
  /**
   * **用户原话**（宿主注入的情境提示/世界状态/相关记忆都拼接在 text 里，
   * 但那不是用户说的）。用在"回到这句重说"——回填输入框的必须是她真正打的那句话。
   * 宿主字段：不进请求体（净化是白名单拷贝）。
   */
  rawText?: string;
}

const PARALLEL_LIMIT = 4;

/**
 * 只读工具集：深度任务（tier3/planner deep）从 noTools 纯文本升级为「能查资料再答」。
 * **定义在 `session.ts`**（执行层也要用同一套口径），这里只做转发，老引用不断。
 */
export { READONLY_TOOL_SET } from './session.js';

function addUsage(a: Usage, b: Usage): Usage {
  return {
    inTokens: a.inTokens + b.inTokens,
    hitTokens: a.hitTokens + b.hitTokens,
    missTokens: a.missTokens + b.missTokens,
    outTokens: a.outTokens + b.outTokens,
    reasoningTokens: a.reasoningTokens + b.reasoningTokens,
    costUsd: a.costUsd + b.costUsd,
  };
}

/** 并发池：≤limit 并发执行 */
async function pool<T>(items: T[], limit: number, worker: (t: T) => Promise<void>): Promise<void> {
  let i = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      await worker(items[idx]!);
    }
  });
  await Promise.all(runners);
}

interface ExecutedResult {
  id: string;
  ok: boolean;
  output: string;
  truncated?: boolean;
  error?: { code: string; message: string };
}

/** 设备操作审计：app 工具每一次调用（含被拒/失败）都发 device.action 事件。
 *
 *  `gateAsked`：**内核口径**——这一轮闸门发起了审批请求没有。
 *  `confirmed=true` 只表示"闸门放行了"——低风险自动放行的条目同样是 true，读审计的人
 *  容易把"自动放行"误读成"用户确认过"。所以：
 *    gateAsked=true  + confirmed=true  → 闸门问了，放行（宿主问没问到人另说）
 *    gateAsked=false + confirmed=true  → 没问，风险档低自动放行（**这就是会被误读的那种**）
 *    gateAsked=true  + confirmed=false → 问了没同意（或没人答/等超时）
 *    gateAsked=false + confirmed=false → 策略/钩子直接拒，没问过
 *  ⚠ 它**不是**"用户真的被问了"：宿主还会按作用域（闲聊不问 / 后台回合不打扰）静默代答。
 *  给人看的那份在 `lib.mjs` 的 device_action 审计条目里，叫 `asked`，由宿主算：
 *  内核 gateAsked && 宿主确实把这一问交给了用户（按调用 id 配对）。 */
function emitDeviceAction(session: Session, call: ToolCall, confirmed: boolean, result?: ToolResult, asked = false): void {
  const action = String(((call.args ?? {}) as Record<string, unknown>).action ?? '');
  const outText = result ? (result.error ? `${result.error.code}: ${result.error.message}` : result.output) : '';
  session.emit({
    type: 'device.action',
    id: call.id,
    action,
    level: deviceLevelFor(action),
    confirmed,
    gateAsked: asked,
    ok: result?.ok ?? false,
    output: outText.slice(0, 500),
    undo: deviceUndoHint(action),
    at: session.clock(),
  });
}

/**
 * 行为档（`lifecycle/mode.ts`）：她调用了"改变现实"的工具 → 从闲聊升到工作，并粘住。
 * 只有闲聊档才升（工作档不用）；只读工具不触发（读文件不是"干活"）。
 * 升级后这一件事做完才退出（宿主的粘性逻辑负责"做完才退"，见 `lib.mjs`）。
 */
function noteBehaviorUpgrade(session: Session, toolName: string): void {
  if (session.modeLocked) return; // 用户锁了模式 → 行为档不许自作主张（用户可控性优先）
  const up = behaviorUpgrade(session.mode, toolName);
  if (!up) return;
  session.mode = up.mode;
  const policy = modePolicyOf(up.mode);
  if (policy.model === 'strong') session.modelRef = { role: 'main', thinking: true };
  session.emit({ type: 'mode.change', seq: session.stats.iterations + 1, mode: up.mode, source: 'behavior', reason: up.reason });
}

async function executePrepared(session: Session, prepared: PreparedCall[], signal?: AbortSignal): Promise<ExecutedResult[]> {
  const results: ExecutedResult[] = new Array(prepared.length);
  const ctx: ExecCtx = {
    sessionId: session.id,
    cwd: session.cwd,
    runtime: session.runtime,
    config: session.config,
    policy: session.policy,
    memory: session.memory,
    skills: session.skills,
    loadedSkills: session.loadedSkills,
    subagentRunner: session.subagentRunner,
    cronJobs: session.cronJobs,
    taskStore: session.taskStore,
    ports: session.ports,
    mutations: session.mutations,
    /* 这一回合的快照记录器（未挂快照库时为 undefined → 工具不记、`undo` 如实拒绝） */
    snapshots: session.turnSnapshots,
    snapshotStore: session.snapshots,
    facet: session.facet,
    mode: session.mode, // 工具只读快照（run_agent 用它做"只有工作模式才派子代理"的闸）
    emit: session.emit,
    signal,
  };

  const runOne = async (p: PreparedCall, idx: number): Promise<void> => {
    try {
      await runOneInner(p, idx);
    } finally {
      // 本回合工具账（验证契约的弱证据来源）——放在 finally 里，**所有出口**都记得到
      session.turnToolLog.push({ name: p.call.name, ok: results[idx]?.ok === true });
    }
  };
  const runOneInner = async (p: PreparedCall, idx: number) => {
    // 把**内核算的风险档**随事件送出去——宿主据此决定记不记签名链。
    // 为什么要送：宿主不许另搞一套"按工具名猜风险"，两套判断会打架；
    //   风险档的唯一真源就在下面这个 `riskLevelOf`（同一处也用于审批判定）。
    const risk = riskLevelOf(p.call.name, p.entry?.permissionClass ?? 'write', p.call.args);
    session.emit({ type: 'tool.call', seq: session.stats.iterations + 1, id: p.call.id, name: p.call.name, args: p.call.args, risk });
    if (p.presetResult) {
      session.stats.failedToolCalls++;
      const r = p.presetResult;
      const outText = r.output || (r.error ? `${r.error.code}: ${r.error.message}` : '');
      results[idx] = { id: p.call.id, ok: r.ok, output: r.output, truncated: r.truncated, error: r.error };
      session.emit({ type: 'tool.result', seq: session.stats.iterations + 1, id: p.call.id, ok: r.ok, output: outText, truncated: r.truncated ?? false, risk });
      return;
    }
    const entry = p.entry!;

    // hooks：PreToolUse 可阻断（exit 2）
    const preEvent = { type: 'tool.call' as const, seq: session.stats.iterations + 1, id: p.call.id, name: p.call.name, args: p.call.args };
    const preResults = await runHooks(session.config, 'PreToolUse', {
      runtime: session.runtime,
      sessionId: session.id,
      event: preEvent,
      tool: p.call.name,
      permissionClass: entry.permissionClass,
      cwd: session.cwd,
    });
    for (const hr of preResults) session.emit({ type: 'hook', name: hr.hook, event: 'tool.call', exit: hr.exit });
    if (preResults.some((hr) => hr.blocked)) {
      session.stats.failedToolCalls++;
      // 把守卫**说的那句人话**带回给模型：被拦下要知道为什么、
      // 并且能换个办法继续干活；只说"被 hook 阻止"等于让它猜。截断 400 字，别让 hook 输出吃掉上下文。
      const why = preResults
        .filter((hr) => hr.blocked)
        .map((hr) => hr.output.trim())
        .filter(Boolean)
        .join('；')
        .slice(0, 400);
      const r: ToolResult = {
        ok: false,
        output: '',
        error: {
          code: 'HOOK_BLOCKED',
          message: why ? `PreToolUse 守卫阻止了这条命令：${why}` : 'PreToolUse hook 已阻止该调用',
        },
      };
      results[idx] = { id: p.call.id, ok: r.ok, output: r.output, error: r.error };
      if (p.call.name === 'app') emitDeviceAction(session, p.call, false, r);
      session.emit({ type: 'tool.result', seq: session.stats.iterations + 1, id: p.call.id, ok: r.ok, output: `${r.error!.code}: ${r.error!.message}`, truncated: false, risk });
      return;
    }

    // 权限判定：deny 拒绝；ask 走审批通道（未注入 → 拒绝）
    const decision = session.policy
      ? session.policy.check(p.call.name, entry.permissionClass, p.call.args)
      : { action: 'allow' as const, ruleId: 'no-policy' };
    // 审计语义：这一轮有没有**真的问过用户**——只有 ask 分支才算"问过"，
    // 低风险 allow 是自动放行（confirmed 依旧是 true，别让审计把两者读成一回事）。
    let asked = false;
    if (decision.action === 'deny') {
      session.stats.failedToolCalls++;
      // 把"为什么"和"换个什么办法"一起回给模型——被拦下来时它该换路子，而不是卡住或傻站着
      const reason = decision.warning ?? `策略拒绝（${decision.ruleId}）`;
      const message = decision.alternative ? `${reason}；换个办法：${decision.alternative}` : reason;
      const r: ToolResult = {
        ok: false,
        output: '',
        error: { code: 'POLICY_DENY', message },
      };
      results[idx] = { id: p.call.id, ok: r.ok, output: r.output, error: r.error };
      if (p.call.name === 'app') emitDeviceAction(session, p.call, false, r);
      session.emit({ type: 'approval.result', tool: p.call.name, granted: false });
      session.policyDenials++; // 被否一次记一次（循环顶部看到连续 3 次就停）
      session.emit({ type: 'tool.result', seq: session.stats.iterations + 1, id: p.call.id, ok: r.ok, output: `${r.error!.code}: ${r.error!.message}`, truncated: false, risk });
      return;
    }
    if (decision.action === 'ask') {
      asked = true; // 真的发了 approval.request，宿主那边弹了卡（用户答没答另说）
      // 把**风险档**一起发出去——宿主据此决定"要不要真的打扰用户"
      // （闲聊模式一律不问；工作模式只问 R3+。判据在内核 `policy/risk.ts`，宿主不许另写一套）
      const risk = riskLevelOf(p.call.name, entry.permissionClass, p.call.args);
      /* 先看**有没有被「到这次对话结束都允许」覆盖**——覆盖了就不问，
         但仍如实记一条 `approval.result(by:'session-grant')`：它不是"用户这一次点的头"，
         事后读日志必须分得出来（R5 永远不覆盖，判据在 `Session.grantCovers`）。 */
      let granted = false;
      if (session.grantCovers(p.call.name, decision.ruleId, risk, decision.grantKey)) {
        session.emit({ type: 'approval.result', tool: p.call.name, granted: true, by: 'session-grant' });
        granted = true;
      } else {
        session.emit({ type: 'approval.request', tool: p.call.name, args: p.call.args, ruleId: decision.ruleId, risk });
        // 注：下面 askApproval 多带 `id`（这一轮工具调用 id），宿主用它把"问没问用户"对到 device.action 审计上。
        // 审批等不到人不能无限挂着——用户不在时，回合要能自己收场
        // （到点按"没批准"处理并记下超时，循环顶部据此以 waitingUser 停下；账本那边仍是 blocked/needs_input，
        //  用户回来点一下就能接着干）
        const waitMs = session.config.budget.approvalWaitMs ?? 10 * 60 * 1000;
        let answer: string | undefined;
        if (session.askApproval) {
          answer = await Promise.race([
            session.askApproval({ tool: p.call.name, args: p.call.args, ruleId: decision.ruleId, risk, id: p.call.id }),
            new Promise<string>((res) => {
              const t = setTimeout(() => res('__WAIT_TIMEOUT__'), waitMs);
              // 不拖住事件循环（宿主提前回答时定时器仍会到点，但那时已无副作用）
              if (typeof (t as { unref?: () => void }).unref === 'function') (t as { unref: () => void }).unref();
            }),
          ]);
          if (answer === '__WAIT_TIMEOUT__') session.approvalTimedOut = true;
        }
        // 「到这次对话结束都允许」：记一条会话级授权（内存；下一次同工具+同判据+不更高风险就不问了）
        if (answer === 'allow-session') session.addSessionGrant({ tool: p.call.name, ruleId: decision.ruleId, risk, key: decision.grantKey });
        granted = answer === 'allow' || answer === 'allow-session';
        session.emit({ type: 'approval.result', tool: p.call.name, granted });
      }
      if (!granted) {
        session.stats.failedToolCalls++;
        session.policyDenials++; // 明确被拒也记一次（连续被拒 3 次 → 停下别问了）
        const r: ToolResult = {
          ok: false,
          output: '',
          error: {
            code: 'APPROVAL_DENIED',
            // 三种"没批成"要分开说（`asked` 只表示"发过审批请求"，不能拿来判断有没有人答）
            message: session.approvalTimedOut
              ? '等了很久没有人应答，这一步先不做（用户回来点一下就能接着干）。别原样重试——先把"为什么需要它"说清楚。'
              : session.askApproval
                ? '用户没有同意这一步。别原样重试——先说清你要做什么、为什么需要它，或者换个不需要这一步的做法。'
                : '需要人工确认，但现在没有审批通道（后台回合）——这一步先不做。换个不需要确认的做法，或等用户在的时候再说。',
          },
        };
        results[idx] = { id: p.call.id, ok: r.ok, output: r.output, error: r.error };
        if (p.call.name === 'app') emitDeviceAction(session, p.call, false, r, asked);
        session.emit({ type: 'tool.result', seq: session.stats.iterations + 1, id: p.call.id, ok: r.ok, output: `${r.error!.code}: ${r.error!.message}`, truncated: false, risk });
        return;
      }
    }

    // 行为档：她真的动手了（第一个"改变现实"的工具调用）→ 这一件事按工作模式跑完。
    // 放在执行**之前**：本回合之后的每一次模型请求都会读到新的 modelRef（`runTurn` 每轮现读）。
    noteBehaviorUpgrade(session, p.call.name);

    session.stats.toolCalls++;
    let r: ToolResult;
    try {
      r = await entry.executor(p.call.args, ctx);
    } catch (err) {
      r = { ok: false, output: '', error: { code: 'TOOL_THREW', message: (err as Error).message } };
    }
    if (decision.warning) r = { ...r, output: `${decision.warning}\n${r.output}` };
    // 大输出落盘：超过阈值就把整份存盘、只留预览 + 路径 + "别再重调一遍"（见 loop/persist.ts）。
    // 放在这里是因为这是**所有工具调用的唯一咽喉**（主回合 / 子代理 / planner 全走 executePrepared）。
    if (r.ok) {
      const persisted = await maybePersistOutput(session.runtime, { id: p.call.id, tool: p.call.name, output: r.output });
      if (persisted) r = { ...r, output: persisted, truncated: true };
    }
    if (!r.ok) session.stats.failedToolCalls++;
    if (p.call.name === 'app') emitDeviceAction(session, p.call, true, r, asked);
    results[idx] = { id: p.call.id, ok: r.ok, output: r.output, truncated: r.truncated, error: r.error };
    const resultEvent = {
      type: 'tool.result' as const,
      seq: session.stats.iterations + 1,
      id: p.call.id,
      ok: r.ok,
      output: r.output,
      truncated: r.truncated ?? false,
      // 把失败原因也发出去（事件流是 UI/日志/报告的唯一数据源）
      ...(r.error ? { error: r.error } : {}),
    };
    session.emit(resultEvent);
    // hooks：PostToolUse 后置触发
    const postResults = await runHooks(session.config, 'PostToolUse', {
      runtime: session.runtime,
      sessionId: session.id,
      event: resultEvent,
      tool: p.call.name,
      permissionClass: entry.permissionClass,
      cwd: session.cwd,
    });
    for (const hr of postResults) session.emit({ type: 'hook', name: hr.hook, event: 'tool.result', exit: hr.exit });
  };

  // 写类互斥串行；非写类并行 ≤4
  const exclusive = prepared.filter((p) => p.entry?.exclusive);
  const normal = prepared.filter((p) => !p.entry?.exclusive);
  for (const p of exclusive) await runOne(p, prepared.indexOf(p));
  await pool(normal, PARALLEL_LIMIT, async (p) => runOne(p, prepared.indexOf(p)));
  return results;
}

/** 回合输入：纯文本或带图。`image` 可以是**一张或多张** data URL（调用方已转码；
 *  vision 模型 user 消息 content 数组化，多张就是多个 image_url 块——
 *  输入条存在"截图 1 / 截图 2 混排"那一态，单图撑不起）。 */
export type TurnInput = string | { text: string; image?: string | string[] };

export async function runTurn(session: Session, input: TurnInput, signal?: AbortSignal, opts?: RunTurnOpts): Promise<TurnResult> {
  const text = typeof input === 'string' ? input : input.text;
  const image = typeof input === 'string' ? undefined : input.image;
  const images: string[] = (Array.isArray(image) ? image : image ? [image] : []).filter(Boolean);
  // 护栏②（baseline）：改动清单与"已回插过"标记按**回合**重置——只审这一轮改的，不重报老问题
  session.mutations = [];
  /* 这一回合的回合 id 与快照记录器。
     回合 id 用 `turn-<时钟>-<随机>`：**不依赖宿主**（CLI/评测里也要能回滚），又不会两轮撞车。 */
  const turnId = `turn-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  session.turnSnapshots = session.snapshots ? new TurnSnapshots(session.snapshots, turnId) : undefined;
  session.currentTurnId = turnId;
  session.workChecked = false;
  session.verifyChecked = false; // 验证契约也按回合重置
  session.turnToolLog = [];
  session.subagentSpawns = 0; // 派活数量闸按回合计数（"这一轮最多派几个"）
  // 终止条件用的回合现场
  const turnStartedAt = Date.now();
  const modePol = modePolicyOf(session.mode); // 策略档的 maxIterations（闲聊 40 / 工作 120）
  const maxIterations = Math.min(session.config.budget.maxIterations, modePol.maxIterations);
  session.policyDenials = 0; // 策略连续硬拒次数（模型撞墙还接着撞 → 停下，别烧钱）
  session.approvalTimedOut = false; // 审批等到超时（用户不在）→ 这一回合到此为止
  // ⚠️ 用户消息必须进 session.history——否则模型只看到自己的回复与工具结果，
  // 看不到用户之前说过什么（就像没有记忆的对话）。且**要在压缩之前**进历史
  // （否则压缩保留的"最后 4 条"里没有用户这句话）。
  const firstUserMsg: ChatMessage | undefined = String(text).trim()
    ? (images.length
      ? { role: 'user', content: [{ type: 'text', text }, ...images.map((url) => ({ type: 'image_url' as const, image_url: { url } }))] }
      : { role: 'user', content: text })
    : undefined;
  if (firstUserMsg) {
    if (typeof opts?.rawText === 'string' && opts.rawText.trim()) {
      (firstUserMsg as { rawText?: string }).rawText = opts.rawText;
    }
    session.history.push(firstUserMsg);
  }
  let turnUsage: Usage = zeroUsage();
  let verification: VerificationReport | undefined; // 验证契约（只有工作模式会产出）
  let pendingInput = text;
  let compacted = false;
  /* **追加式上下文不变量**——状态挂在**会话**上（见 `session.lastRequestFingerprints`），
     这样"跨回合"的中途插入也逮得到（只放在回合局部变量里就只能比同一回合内的轮次）。
     唯一的合法例外是**压缩检查点**（显式重建）→ 压缩时清空重来。 */
  const seq = () => session.stats.iterations + 1;

  /** 前缀判定：旧的是否为新的一段前缀（逐条比较；条数只许多不许少） */
  const isPrefix = (prev: string[], next: string[]): boolean => {
    if (prev.length > next.length) return false;
    for (let i = 0; i < prev.length; i++) if (prev[i] !== next[i]) return false;
    return true;
  };

  session.emit({ type: 'user.prompt.submit', seq: seq(), text });
  session.emit({ type: 'turn.start', seq: seq() });

  while (true) {
    if (signal?.aborted) {
      // 还没开口就被叫停，也要留痕（否则日志里只剩一个没有收尾的 turn.start）
      session.emit({ type: 'user.prompt.abort', seq: seq() });
      return { kind: 'error', message: '用户中止' };
    }

    // 上下文预算：多模型适配——上限取「配置上限」与「当前生效模型窗口」的较小值，
    // 换大窗口模型（如 256k）时上下文自动变大，不被配置写死；
    // 压缩点 = 上限留 8k 余量（尽量用满窗口），且不超过配置的 compactAtTokens。
    const modelWindow = session.provider.caps.maxContextTokens || session.config.budget.maxContextTokens;
    const maxCtx = Math.min(session.config.budget.maxContextTokens, modelWindow);
    const compactAt = Math.min(session.config.budget.compactAtTokens, maxCtx - 8192);
    const tokens = session.estimateTokens();
    if (tokens > maxCtx) {
      if (compacted) {
        return { kind: 'limit', reason: 'maxContext', text: '上下文超出上限，且压缩后仍超限。' };
      }
    }
    if (!compacted && tokens > compactAt) {
      compacted = true;
      const cr = await compactSession(session, signal);
      session.lastRequestFingerprints = undefined;   // 压缩 = 唯一合法的重建（显式检查点），指纹从头起算
      if (signal?.aborted) return { kind: 'error', message: '用户中止' };
      if (cr.ok) {
        // 压缩后继续本回合（摘要块 + 最后 4 条已在历史中）
        continue;
      }
      // 降级后继续；若仍超 maxCtx 由上方判定兜底
      continue;
    }

    // 用户消息已在历史里（首条在回合开始时进、续跑的当场进）——这里直接发全量历史
    const messages = session.provider.sanitizeForRequest([...session.history]);
    /* 工具集分档：noTools（纯文本）> toolWhitelist（白名单，后台复盘用）> readonlyTools（只读工具集）> 全量。
       `[]` 也要当"启用了、但一个不给"，所以判的是 `!== undefined` 而不是长度
       （写成 `length ? … : …` 的话空数组会静默退回全量工具）。
       ⚠ 口径收进 `session.allowedTools()` —— **执行层（prepareCalls）读的是同一个方法**：
       两套口径不一致 = 墙上有门（复盘会话能跑 bash）。 */
    const tools = session.allowedTools();

    /* **只在尾部追加**——违反就发 `cache.broken`，把"为什么这轮突然贵了"说清楚。
       比对用的是**净化后**的 messages（`sanitizeForRequest` 会合并相邻同角色纯文本，早比会误报）；
       压缩那一次是白名单例外（压缩分支里会把指纹清空）。 */
    {
      /* 指纹按**真正会发出去的那些字段**算（白名单，和适配器 `sanitizeForRequest` 一个口径）：
         消息上的 `id`/`parentId` 是宿主字段（对话树用），**不是请求内容**。
         ⚠ 不能直接 `JSON.stringify(m)`：mock 适配器的 sanitize 是原样透传，
         那样"给消息补 id"这件事本身就会被误判成"上下文被改了"。 */
      const fingerprints = messages.map((m) => JSON.stringify({
        role: m.role,
        content: m.content,
        ...(m.name !== undefined ? { name: m.name } : {}),
        ...(m.toolCallId !== undefined ? { toolCallId: m.toolCallId } : {}),
        ...(m.toolCalls ? { toolCalls: m.toolCalls } : {}),
        ...(m.reasoning !== undefined ? { reasoning: m.reasoning } : {}),
      }));
      const prevFingerprints = session.lastRequestFingerprints;
      if (prevFingerprints && !isPrefix(prevFingerprints, fingerprints)) {
        session.emit({
          type: 'cache.broken',
          reason: `上下文不是在尾部追加的（上次 ${prevFingerprints.length} 条 → 这次 ${fingerprints.length} 条，前缀对不上）`,
        });
      }
      session.lastRequestFingerprints = fingerprints;
    }
    /* 工具集变了也算前缀作废（tools 属于可缓存前缀的一部分）：noTools / readonlyTools 按回合切，
       如实说出来，别让它静默打穿缓存。 */
    {
      const names = tools.map((t) => t.function.name).join(',');
      const prevToolNames = session.lastRequestToolNames;
      if (prevToolNames !== undefined && prevToolNames !== names) {
        const layers = session.frozen.layerHashes;
        const layerNote = layers ? `；层指纹 stable=${String(layers.stable ?? '-').slice(0, 8)} volatile=${String(layers.volatile ?? '-').slice(0, 8)}` : '';
        session.emit({ type: 'cache.broken', reason: `工具集变了（${prevToolNames || '（空）'} → ${names || '（空）'}），缓存前缀作废${layerNote}` });
      }
      session.lastRequestToolNames = names;
    }
    const stream = session.provider.chat({
      system: session.frozen.system,
      messages,
      tools,
      model: session.modelRef,
      maxOutputTokens: session.config.budget.turnMaxTokens,
      signal,
    });

    let text = '';
    let reasoning = '';
    let calls: ToolCall[] = [];
    try {
      for await (const ev of stream) {
        if (signal?.aborted) {
          // 中止时把半截正文留在上下文（说"继续"能接着写），并补 turn.end
          // 补 user.prompt.abort——日志里要能看出"人叫停过"
          session.emit({ type: 'user.prompt.abort', seq: seq() });
          if (text.trim() && calls.length === 0) {
            session.history.push({ role: 'assistant', content: text });
            session.emit({ type: 'turn.end', seq: seq(), final: false, usage: turnUsage });
            return { kind: 'aborted', text };
          }
          return { kind: 'error', message: '用户中止' };
        }
        switch (ev.type) {
          case 'text.delta':
            text += ev.text;
            session.emit({ type: 'assistant.text.delta', seq: seq(), text: ev.text });
            break;
          case 'reasoning.delta':
            reasoning += ev.text;
            session.emit({ type: 'assistant.reasoning.delta', seq: seq(), text: ev.text });
            break;
          case 'tool_calls':
            calls = ev.calls;
            break;
          case 'done': {
            turnUsage = addUsage(turnUsage, ev.usage);
            // 每次模型调用记一笔账（角色按本回合实际用的档位）
            session.recordUsage(ev.usage, { role: costRoleOf(session.modelRef) });
            session.stats.costUsd += ev.usage.costUsd;
            session.stats.hitTokens += ev.usage.hitTokens;
            session.stats.missTokens += ev.usage.missTokens;
            const total = ev.usage.hitTokens + ev.usage.missTokens;
            session.emit({
              type: 'cache',
              hitTokens: ev.usage.hitTokens,
              missTokens: ev.usage.missTokens,
              hitRate: total > 0 ? ev.usage.hitTokens / total : 0,
            });
            break;
          }
        }
      }
    } catch (err) {
      // 流中断恢复：用户主动中止 → error kind（调用方走中止收尾）；
      // 已收到部分正文且无工具调用 → 保留已得内容作为最终回复（不再整回合丢弃）；
      // 其余（无内容/工具调用中）→ 原样上抛，由调用方翻译成友好错误。
      if (signal?.aborted) {
        // 同流循环内的中止处理——半截正文留在上下文 + 补 turn.end
        session.emit({ type: 'user.prompt.abort', seq: seq() });
        if (text.trim() && calls.length === 0) {
          session.history.push({ role: 'assistant', content: text });
          session.emit({ type: 'turn.end', seq: seq(), final: false, usage: turnUsage });
          return { kind: 'aborted', text };
        }
        return { kind: 'error', message: '用户中止' };
      }
      const msg = (err as Error).message;
      if (text.trim() && calls.length === 0) {
        session.emit({ type: 'error', code: 'STREAM_INTERRUPTED', message: `回复流中断：${msg}` });
        session.emit({ type: 'turn.end', seq: seq(), final: true, usage: turnUsage });
        session.resetRepeat();
        return { kind: 'final', text: `${text}\n（回复中途被意外中断，以上是已收到的部分）` };
      }
      throw err;
    }

    // 判定：无 tool_calls → 最终文本（selfCheck 收尾核对事实，防幻觉）
    if (calls.length === 0) {
      // —— 统一 Stop 管线（**改后自检回插** → 完成判据 → 才允许结束）——
      // 这一轮改过文件 → 收尾前回读核对；有问题就回插一条"补充意见"（护栏：一轮只回插一次）
      if (!session.workChecked && session.mutations.length > 0) {
        session.workChecked = true; // 护栏①：先置位（回插后的下一轮收尾不再触发，否则自检会自己触发自己）
        const work = await reviewMutations(session.mutations, session.runtime);
        if (work.action === 'continue' && work.nudge) {
          session.history.push({ role: 'assistant', content: text });
          session.stats.iterations++;
          session.emit({ type: 'selfcheck.flag', text: (work.problems ?? []).join('；').slice(0, 300), rule: 'workcheck' });
          if (session.stats.iterations >= maxIterations) {
            session.emit({ type: 'error', code: 'MAX_ITERATIONS', message: `达到迭代上限 ${maxIterations}` });
            session.emit({ type: 'turn.end', seq: seq(), final: false, usage: turnUsage });
            return { kind: 'limit', reason: 'maxIterations', text };
          }
          pendingInput = work.nudge;
          if (pendingInput.trim()) session.history.push({ role: 'user', content: pendingInput });
          continue;
        }
      }
      // 手上这件事带着完成信号、而信号还没出现 → 拦回来继续做（「没做到就别说完事了」）
      const activeRun = session.taskStore?.activeWithPromise(session.id) ?? null;
      if (activeRun) {
        const verdict = stopVerdict(activeRun, text);
        if (verdict.action === 'continue') {
          await session.taskStore!.patchRun(activeRun.id, { iterations: activeRun.iterations + 1 }, 'note', { nudge: verdict.nudge.slice(0, 500) });
          session.history.push({ role: 'assistant', content: text });
          session.stats.iterations++;
          if (session.stats.iterations >= maxIterations) {
            session.emit({ type: 'error', code: 'MAX_ITERATIONS', message: `达到迭代上限 ${maxIterations}` });
            session.emit({ type: 'turn.end', seq: seq(), final: false, usage: turnUsage });
            return { kind: 'limit', reason: 'maxIterations', text };
          }
          pendingInput = verdict.nudge;
          if (pendingInput.trim()) session.history.push({ role: 'user', content: pendingInput });
          continue;
        }
        if (verdict.action === 'cap') {
          // 到自己的硬上限 → 停下并诚实说明（绝不无声耗一夜，也不假装做完）
          await session.taskStore!.patchRun(activeRun.id, { state: 'paused', stateDetail: verdict.detail }, 'run_paused', { reason: 'cap', detail: verdict.detail });
          session.emit({ type: 'error', code: 'TASK_ITERATION_CAP', message: verdict.detail });
          session.emit({ type: 'turn.end', seq: seq(), final: false, usage: turnUsage });
          return { kind: 'limit', reason: 'maxIterations', text: verdict.text };
        }
        // 信号到了：这件事真做完了——标记收尾，并从交付文本里剥掉信号（用户不该看到机关）
        if (activeRun.completionPromise && promiseSeen(text, activeRun.completionPromise)) {
          await session.taskStore!.complete(activeRun.id, stripPromise(text, activeRun.completionPromise).slice(0, 200));
          text = stripPromise(text, activeRun.completionPromise);
        }
      }
      // **验证契约**（工作模式才拦）——"做完了"必须拿得出证据。
      // 位置在 workcheck（这一轮改的落没落盘）与完成信号之后：前面都过了，才轮到"凭什么说做完了"。
      if (session.mode === 'work' && modePolicyOf(session.mode).verify && !session.verifyChecked) {
        const didWork = session.mutations.length > 0 || session.turnToolLog.length > 0;
        if (didWork) {
          session.verifyChecked = true; // 护栏：一轮只插一次（同 workChecked 的道理）
          const report = await buildVerificationReport(session, { attempts: session.stats.iterations });
          verification = report;
          session.emit({
            type: 'verify.report',
            seq: seq(),
            passed: report.passed,
            confidence: report.confidence,
            attempts: report.attempts,
            evidence: report.evidence.map((e) => ({ ...e })),
          });
          if (!report.passed) {
            const nudge = verifyNudge(report);
            session.history.push({ role: 'assistant', content: text });
            session.stats.iterations++;
            session.emit({ type: 'selfcheck.flag', text: nudge.split('\n').slice(0, 3).join('；').slice(0, 300), rule: 'verify' });
            if (session.stats.iterations >= maxIterations) {
              session.emit({ type: 'error', code: 'MAX_ITERATIONS', message: `达到迭代上限 ${maxIterations}` });
              session.emit({ type: 'turn.end', seq: seq(), final: false, usage: turnUsage });
              return { kind: 'limit', reason: 'maxIterations', text };
            }
            pendingInput = nudge;
            if (pendingInput.trim()) session.history.push({ role: 'user', content: pendingInput });
            continue;
          }
        }
      }
      let finalText = text;
      if (session.config.reliability.selfCheck) {
        const evidence = collectEvidence(session.history);
        const sc = selfCheck(text, evidence);
        for (const f of sc.flags) {
          session.emit({ type: 'selfcheck.flag', text: f.text, rule: f.rule });
        }
        finalText = sc.text;
      }
      // 最终回复也进历史——否则下一回合模型看不到自己刚说过什么
      if (finalText.trim()) session.history.push({ role: 'assistant', content: finalText });
      /* **产物登记**——她做出/改出来的文件在这里落一次台账（只追加），
         并发一条 `artifact.created`："她刚才做的那份文件在哪"有单一答案。
         只登记写入类工具（见 `PRODUCING_TOOLS`）：读过什么不算产物，那是文件页的活。 */
      await recordArtifacts(session, seq());
      session.stampTree();   // 给这一轮的消息补 id/父指针（幂等，供"回到这句重说"）
      session.emit({ type: 'turn.end', seq: seq(), final: true, usage: turnUsage });
      session.resetRepeat();
      return { kind: 'final', text: finalText, ...(verification ? { verification } : {}) };
    }

    // 校验 + 执行
    const prepared = prepareCalls(session, calls);
    const results = await executePrepared(session, prepared, signal);

    // 回写历史（顺序 = 模型返回顺序）
    const assistantMsg = { role: 'assistant' as const, content: text, toolCalls: calls };
    if (reasoning) Object.assign(assistantMsg, { reasoning });
    session.history.push(assistantMsg);
    for (const r of results) {
      session.history.push({
        role: 'tool' as const,
        content: JSON.stringify({ ok: r.ok, output: r.output, truncated: r.truncated, error: r.error }),
        toolCallId: r.id,
      });
    }
    session.stats.iterations++;

    // 预算兜底（每个出口都带一句"为什么停"给日志）
    const limitOut = (reason: LimitReason, code: string, msg: string): TurnResult => {
      session.emit({ type: 'error', code, message: msg });
      session.emit({ type: 'turn.end', seq: seq(), final: false, usage: turnUsage });
      return { kind: 'limit', reason, text: text || `（${msg}，无最终文本）` };
    };
    if (session.stats.iterations >= maxIterations) {
      return limitOut('maxIterations', 'MAX_ITERATIONS', `达到迭代上限 ${maxIterations}（策略档 ${modePol.label}）`);
    }
    if (session.config.budget.maxCost !== null && session.stats.costUsd > session.config.budget.maxCost) {
      return limitOut('maxCost', 'MAX_COST', `成本超限 ${session.config.budget.maxCost}`);
    }
    // 累计 token：turnUsage 逐轮累加，累计值超限也要有出口
    const turnTokens = turnUsage.inTokens + turnUsage.outTokens;
    const maxTurnTokens = session.config.budget.maxTurnTokens ?? null;
    if (maxTurnTokens !== null && turnTokens > maxTurnTokens) {
      return limitOut('maxTokens', 'MAX_TURN_TOKENS', `本回合累计 token 超限（${turnTokens} > ${maxTurnTokens}）`);
    }
    // 墙钟：干太久的活要有出口（runTurn 按回合起始时间算 elapsed）
    const maxTurnMs = session.config.budget.maxTurnMs ?? null;
    const elapsedMs = Date.now() - turnStartedAt;
    if (maxTurnMs !== null && elapsedMs > maxTurnMs) {
      return limitOut('maxRuntime', 'MAX_TURN_MS', `本回合耗时超限（${Math.round(elapsedMs / 1000)}s > ${Math.round(maxTurnMs / 1000)}s）`);
    }
    // 等审批等到超时（用户不在）——这一轮到此为止，别在这儿无限挂着
    if (session.approvalTimedOut) {
      return limitOut('waitingUser', 'WAITING_USER', '等你确认等了一段时间没等到，我先停下了');
    }
    // 策略连续硬拒：模型撞墙还接着撞（同一件事被否三次）→ 停下，别烧钱
    if (session.policyDenials >= 3) {
      return limitOut('policy', 'POLICY_BLOCKED', '同一件事被策略连续拒绝了 3 次，停下');
    }

    // 重复检测：同一工具+同一参数连续 3 回合 → 回注
    const fingerprint = calls.map((c) => `${c.name}:${JSON.stringify(c.args)}`).join('|');
    const repeatHint = session.markRepeat(fingerprint)
      ? (session.resetRepeat(), '（系统提示）你刚才的工具调用与之前重复，没有任何进展。请更换方案，或直接给出结论。')
      : '';
    // 插话（steer 档）：用户在你干活途中插的话——每个工具轮次后取一次；
    // 追加到下一轮尾部用户消息（append-only：历史只增不改，前缀缓存不失效）
    const steers = opts?.drainSteers?.() ?? [];
    for (const s of steers) session.emit({ type: 'user.steer.submit', seq: seq(), text: s });
    pendingInput = [repeatHint, ...steers].filter(Boolean).join('\n');
    if (pendingInput.trim()) session.history.push({ role: 'user', content: pendingInput });
  }
}

/** 事件收尾：turn.start 起、turn.end 止的完整事件序列由事件文件承载 */
export type { ChatEvent };


/**
 * 把这一轮的产物落进台账并发出事件。
 * 为什么放在"回合正常收尾"这一处：产物是**做完了**才有意义（半途失败/被叫停的那一轮不登记），
 * 而且 `session.mutations` 是回合级的（下一轮开始就被清空）。
 */
async function recordArtifacts(session: Session, turnSeq: number): Promise<void> {
  if (!session.mutations?.length) return;
  const log = new ArtifactLog(session.runtime, session.id);
  for (const m of session.mutations) {
    const at = new Date(m.at || Date.now()).toISOString();
    const a = artifactFromMutation(m, session.id, at, turnSeq);
    if (!a) continue;
    const saved = await log.append(a);
    session.emit({
      type: 'artifact.created',
      seq: turnSeq,
      id: saved.id,
      kind: saved.type,
      ...(saved.path ? { path: saved.path } : {}),
      mimeType: saved.mimeType,
      createdBy: saved.createdBy,
      at: saved.createdAt,
    });
  }
}
