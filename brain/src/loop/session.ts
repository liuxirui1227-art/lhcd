// Session 状态：id/cwd/config/history/frozen/budget。
import type { ChatMessage, LLMProvider, ToolDef } from '../llm/provider.js';
import { messageText } from '../llm/provider.js';
import type { Runtime } from '../runtime/types.js';
import type { Config } from '../config/schema.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { Emitter } from '../session/events.js';
import { nullEmitter } from '../session/events.js';
import { estimateTokens } from '../prompt/tokens.js';
import { isMandatoryAsk, RISK_RANK, type RiskLevel } from '../policy/risk.js';
import type { PolicyEngine } from '../policy/engine.js';
import type { CronJobs } from '../orchestrate/jobs.js';
import type { TaskStore } from '../task/store.js';
import type { AgentMode } from '../lifecycle/mode.js';
import type { AgentPorts } from '../ports.js';
import type { FileMutation } from './workcheck.js';
import type { CostLedger, CostRole } from '../cost/ledger.js';
import { rowFromUsage, ledgerModelOf, ledgerPricingOf } from '../cost/ledger.js';
import type { Usage } from '../llm/provider.js';
import type { MemoryService } from '../memory/service.js';
import type { SkillMeta } from '../skills/scan.js';
import type { ModelRef } from '../llm/provider.js';
import type { SubagentRunner } from '../agents/runner.js';
import { ensureIds, leafOf } from '../session/tree.js';

/** 审批处理器（宿主注入：弹窗/JSON approval.request 挂起；缺省视为拒绝）。
 *  带 `risk`（R0~R5）：宿主按**模式作用域**决定要不要真的打扰用户
 *  （闲聊一律不问；工作只问 R3+），判据出处是内核 `policy/risk.ts`，宿主不许另写一套。
 *  带 `id`（= 这一次工具调用的 id）：宿主据此把"这一问到底交没交给用户"
 *  和该次调用的 device.action 审计条目对上（审计的 `asked` 字段以宿主口径为准）。 */
export type ApprovalHandler = (req: { tool: string; args: unknown; ruleId: string; risk?: string; id?: string }) =>
  Promise<'allow' | 'deny' | 'allow-session'>;

export interface SessionStats {
  iterations: number;
  costUsd: number;
  hitTokens: number;
  missTokens: number;
  toolCalls: number;
  failedToolCalls: number;
  compactions: number;
  /** subagent 独立成本 */
  subagentCostUsd: number;
}

export function zeroStats(): SessionStats {
  return { iterations: 0, costUsd: 0, hitTokens: 0, missTokens: 0, toolCalls: 0, failedToolCalls: 0, compactions: 0, subagentCostUsd: 0 };
}

/**
 * 只读工具集：深度任务（tier3/planner deep）从 noTools 纯文本升级为「能查资料再答」——
 * 只读检索类工具放行（禁写禁执行），reasoner 可以先读文件/搜网络再下结论。
 * ⚠ **执行层（`prepareCalls`）也要按同一套判**——而 retry.ts 不能反向 import turn.ts（循环），
 *   所以口径收在 session 这一层，两边都用。
 */
export const READONLY_TOOL_SET = new Set(['read', 'grep', 'glob', 'recall', 'web_search', 'web_fetch', 'load_skill', 'session_search']);

export interface SessionOptions {
  id?: string;
  cwd: string;
  config: Config;
  provider: LLMProvider;
  runtime: Runtime;
  registry: ToolRegistry;
  emit?: Emitter;
  /** 冻结前缀 system（由 prompt/assemble.ts 构建；当前由宿主注入） */
  system?: string;
  /** 分层指纹：缓存作废时用来指认"是哪一层变了"（`cache.broken` 的 reason） */
  layerHashes?: Record<string, string>;
  policy?: PolicyEngine;
  /** 审批通道：ask 判定时调用；未注入则 ask 视为拒绝 */
  askApproval?: ApprovalHandler;
  memory?: MemoryService;
  skills?: SkillMeta[];
  /** subagent 执行器（run_agent 工具调用；未注入则工具不注册） */
  subagentRunner?: SubagentRunner;
  /** 定时任务表（schedule 工具；宿主注入） */
  cronJobs?: CronJobs;
  /** 任务账本（task 工具 + 完成判据；宿主注入） */
  taskStore?: TaskStore;
  /** 宿主注入的能力端口（Office / 回收站） */
  ports?: AgentPorts;
  /** 本地成本账本（宿主注入；未注入则不记账） */
  costLedger?: CostLedger;
  /** 回合级快照库（宿主/工厂注入；未注入则 `undo` 不注册） */
  snapshots?: import('../session/snapshots.js').SnapshotStore;
  /** 主模型角色（subagent 用 fast 等；默认 main） */
  modelRef?: ModelRef;
  /** Tier3 深度模式：true 时冻结前缀不带工具（reasoner 纯文本深度长谈；须在首回合前设置） */
  noTools?: boolean;
  /** 只读工具模式：true 时本回合仅带只读工具集（read/grep/glob/recall/网络/技能，禁写禁执行） */
  readonlyTools?: boolean;
  /**
   * **只带这些工具**（按名字过滤注册表；空数组 = 一个工具都不给）。
   * 后台复盘那条路要的正是这个：可读 + 只能提候选，**绝不给 bash/write/edit/delete**——
   * 比 `readonlyTools` 更紧（那个连 web_fetch 都给），且**白名单写死在复盘模块里**，不靠模型自觉。
   */
  toolWhitelist?: string[];
  /** 当前侧面（facet key 或 'companion'）；仅影响运行期记忆检索过滤，不动冻结前缀 */
  facet?: string;
  clock?: () => string;
}

export class Session {
  readonly id: string;
  readonly cwd: string;
  readonly config: Config;
  readonly provider: LLMProvider;
  readonly runtime: Runtime;
  readonly registry: ToolRegistry;
  /** 事件发射器（store 挂接时以链式 emitter 替换） */
  emit: Emitter;
  readonly clock: () => string;
  policy?: PolicyEngine;
  askApproval?: ApprovalHandler;
  memory?: MemoryService;
  skills?: SkillMeta[];
  subagentRunner?: SubagentRunner;
  /** 定时任务表（schedule 工具的落地；宿主注入） */
  cronJobs?: CronJobs;
  /** 任务账本（task 工具 + 完成判据的落地；宿主注入） */
  taskStore?: TaskStore;
  /** 能力端口（office/trash；未注入时对应工具如实拒绝） */
  ports?: AgentPorts;
  /** 成本账本（记每次模型调用的用量与分项成本） */
  costLedger?: CostLedger;
  /** 回合级快照库（`undo` 用；未注入则退不回去） */
  snapshots?: import('../session/snapshots.js').SnapshotStore;
  /** 本回合改动清单（回合开始清空；收尾前回读核对——护栏②"只审这一轮改的"） */
  mutations: FileMutation[] = [];
  /** 当前回合 id（快照按它归档；`undo` 不带参数时退最近一个） */
  currentTurnId: string | null = null;
  /** 当前回合的快照记录器（**一个回合一个**——同一文件只记第一次） */
  turnSnapshots?: import('../session/snapshots.js').TurnSnapshots;
  /** 回插护栏①——一轮只回插一次，否则自检会自己触发自己 */
  workChecked = false;
  /** 验证契约回插护栏（同 workChecked 的道理：一轮只插一次） */
  verifyChecked = false;
  /** 本回合用过的工具（名字 + 成没成）——验证契约的"弱证据"来源；回合开始清空 */
  turnToolLog: Array<{ name: string; ok: boolean }> = [];
  /**
   * 用户点过「**到这次对话结束都允许**」的那些授权。
   * 三条纪律写在这里，免得以后被放松：
   *   ① **只在内存**（不落盘、不写配置）——"这次对话"就是它的字面意思，重启即失效；
   *   ② 覆盖范围是「**同一个工具 + 同一条判据 + 风险档不高于当初批准的那一档**」——
   *      不是"这个工具以后随便用"；
   *   ③ **R5（不可逆）永远不覆盖**：那一档任何情况都要问（`policy/risk.ts` 的 isMandatoryAsk）。
   */
  sessionGrants: Array<{ tool: string; ruleId: string; risk: string; key?: string }> = [];

  /**
   * 这次调用被"到对话结束"的授权覆盖了吗（R5 永远不覆盖）。
   * ⚠ 带 `key` 的授权只覆盖**同一把 key** 的调用：
   *   批准过"读这一份下载来的文件"之后，换一份新文件**会再问一次**（那是另一份别人的字）。
   */
  grantCovers(tool: string, ruleId: string, risk: string, key?: string): boolean {
    if (isMandatoryAsk(risk as RiskLevel)) return false;
    return this.sessionGrants.some((g) => g.tool === tool && g.ruleId === ruleId
      && (g.key ?? '') === (key ?? '')
      && RISK_RANK[risk as RiskLevel] <= RISK_RANK[g.risk as RiskLevel]);
  }

  /** 记一条"到对话结束"的授权（去重：同一工具+判据+key 只留最宽的那条） */
  addSessionGrant(g: { tool: string; ruleId: string; risk: string; key?: string }): void {
    if (isMandatoryAsk(g.risk as RiskLevel)) return; // 不可逆那一档不给
    const i = this.sessionGrants.findIndex((x) => x.tool === g.tool && x.ruleId === g.ruleId && (x.key ?? '') === (g.key ?? ''));
    if (i >= 0) {
      if (RISK_RANK[g.risk as RiskLevel] > RISK_RANK[this.sessionGrants[i]!.risk as RiskLevel]) this.sessionGrants[i] = g;
    } else this.sessionGrants.push(g);
  }
  /** 本回合已经派出去几个分身（run_agent 计数；回合开始清空）——数量闸 maxChildren 的计数依据 */
  subagentSpawns = 0;
  /** 本回合审批等到过超时（用户不在）——循环据此以 waitingUser 收场；回合开始清空 */
  approvalTimedOut = false;
  /** 本回合被策略/审批连拒几次——连续 3 次就停下，别撞墙烧钱；回合开始清空 */
  policyDenials = 0;
  /** 模型角色（Tier3 深度任务可在回合前切换 thinking=true） */
  modelRef: ModelRef;
  /** Tier3 深度模式：true 时冻结前缀不带工具（reasoner 纯文本） */
  noTools: boolean;
  /** 只读工具模式：true 时本回合仅带只读工具集（read/grep/glob/recall/网络/技能，禁写禁执行）；
   *  noTools 优先——两者都 true 时仍不带任何工具 */
  readonlyTools: boolean;
  /** 工具白名单（undefined = 不启用白名单；`[]` = 一个都不给） */
  toolWhitelist?: string[];
  /** 当前侧面：facet key 或 'companion'（默认）；切换 = 改本字段 + 记忆检索过滤 */
  facet: string;
  /**
   * 当前模式：'chat'（闲聊，默认）| 'work'（工作）。
   * 与 facet **正交**（侧面管怎么说，模式管用多大资源）——两边互不覆盖。
   * 策略表见 `lifecycle/mode.ts`；谁能改它：宿主（用户显式切换/锁定）+ loop（行为档自动升）。
   */
  mode: AgentMode = 'chat';
  /** 模式被用户**锁定**（宿主从 state.json 同步）。锁定后行为档不许自动升级——
   *  用户说了"就聊"，她不能因为顺手调了个工具就自己切成工作模式（哲学：用户可控性优先）。 */
  modeLocked = false;
  /** 本会话已加载技能名（load_skill 每技能仅一次） */
  readonly loadedSkills: Set<string> = new Set();

  history: ChatMessage[] = [];
  /**
   * 上一次请求的"尾巴"（追加式上下文不变量）：
   * 净化后每条消息的指纹 + 当时的工具名。**必须挂在会话上**——
   * 放在 `runTurn` 的局部变量里就只能比得了"同一回合内的工具轮次"，
   * 跨回合的中途插入（真正会打穿缓存的那些）一个都逮不到。
   */
  /** 对话树：当前叶子条目 id（直线会话里 = 最后一条） */
  leafId: string | null = null;
  lastRequestFingerprints?: string[];
  lastRequestToolNames?: string;
  /** 只构建一次（前缀冻结）：首次访问惰性固化——真实用法中工具注册先于首回合 */
  private _frozen: { system: string; tools: ToolDef[]; layerHashes?: Record<string, string> } | undefined;
  private readonly systemText: string;
  /** 层指纹（可选；来自 `buildFrozen`） */
  private readonly layerHashes: Record<string, string> | undefined;
  stats: SessionStats = zeroStats();

  /** 修复计数：args 损坏最多修 2 次 / schema 不符 1 次修复机会 */
  private readonly repairCounts = new Map<string, number>();
  /** 重复检测：同一工具+同一参数连续 3 回合 → 回注"无进展，请换方案" */
  private lastFingerprint = '';
  private repeatCount = 0;
  /** 最近一次压缩摘要（自动巩固的事实来源） */
  lastSummary?: import('../prompt/compact.js').CompactSummary;

  constructor(opts: SessionOptions) {
    this.id = opts.id ?? `sess-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    this.cwd = opts.cwd;
    this.config = opts.config;
    this.provider = opts.provider;
    this.runtime = opts.runtime;
    this.registry = opts.registry;
    this.emit = opts.emit ?? nullEmitter();
    this.clock = opts.clock ?? (() => opts.runtime.clock());
    this.policy = opts.policy;
    this.askApproval = opts.askApproval;
    this.memory = opts.memory;
    this.skills = opts.skills;
    this.subagentRunner = opts.subagentRunner;
    this.cronJobs = opts.cronJobs;
    this.taskStore = opts.taskStore;
    this.ports = opts.ports;
    this.costLedger = opts.costLedger;
    this.snapshots = opts.snapshots;
    this.modelRef = opts.modelRef ?? { role: 'main', thinking: false };
    this.noTools = opts.noTools ?? false;
    this.readonlyTools = opts.readonlyTools ?? false;
    this.toolWhitelist = opts.toolWhitelist;
    this.facet = opts.facet ?? 'companion';
    this.systemText = opts.system ?? '';
    this.layerHashes = opts.layerHashes;
  }

  /** 冻结前缀：会话内只构建一次，字节级复用（由 assemble 保证字节级稳定） */
  get frozen(): { system: string; tools: ToolDef[]; layerHashes?: Record<string, string> } {
    if (!this._frozen) {
      this._frozen = {
        system: this.systemText,
        ...(this.layerHashes ? { layerHashes: this.layerHashes } : {}),
        tools: this.registry.schemasFor(this.config, this.runtime.capabilities),
      };
    }
    return this._frozen;
  }

  /**
   * 这一轮**允许用**的工具（唯一口径）：`noTools` > `toolWhitelist` > `readonlyTools` > 全量。
   *
   * ⚠ 立这条口径的原因：白名单/只读若**只作用于"发给模型的清单"**
   * 而执行层 `prepareCalls` 只查 `session.registry`，复盘会话的 registry 是
   * "她的全套工具 + 两个提候选"的**副本**，于是模型只要吐出一个
   * 清单外的名字（幻觉，或被摘录里的内容带偏），注册表里找得到 → **照执行不误**，
   * 而复盘会话跑在 chat 档（`approval='silent'`）→ 静默改/删用户文件，还不进她的对话。
   * 发出去一张清单、执行时另一套 = 墙上有门。现在两处都走本方法。
   */
  allowedTools(): ToolDef[] {
    if (this.noTools) return [];
    if (this.toolWhitelist !== undefined) {
      return this.frozen.tools.filter((t) => this.toolWhitelist!.includes(t.function.name));
    }
    if (this.readonlyTools) return this.frozen.tools.filter((t) => READONLY_TOOL_SET.has(t.function.name));
    return this.frozen.tools;
  }

  /** 执行闸：**这一个工具名允不允许用**（策略判据，`noTools` > `toolWhitelist` > `readonlyTools` > 全量）。
   *  ⚠ 与 `allowedTools()` 的分工：那个是"发给模型的清单"（基于 `frozen` 快照，晚注册的工具不在里面）；
   *  这个是"能不能执行"——**不看快照**，否则 setup 之后才注册的工具（宿主后挂、测试现注册）会被误杀。
   *  两层判据都收在本文件，就是为了"发出去一张清单、执行时另一套"不再发生（别在墙上留门） */
  toolAllowed(name: string): boolean {
    if (this.noTools) return false;
    if (this.toolWhitelist !== undefined) return this.toolWhitelist.includes(name);
    if (this.readonlyTools) return READONLY_TOOL_SET.has(name);
    return true;
  }

  /** 历史 token 估算（启发式，见 prompt/tokens.ts；TODO(spec) 精确 tokenizer） */
  estimateTokens(): number {
    let total = 0;
    for (const m of this.history) {
      total += estimateTokens(messageText(m)) + 8;
      if (m.reasoning) total += estimateTokens(m.reasoning);
    }
    total += estimateTokens(this.frozen.system);
    return total;
  }

  /**
   * 给历史补上 `id` / `parentId` 并更新叶子。
   * **幂等**（已有的 id 不动），所以随便调；文件一个字节都不改（宿主字段只在内存里）。
   */
  stampTree(): void {
    this.history = ensureIds(this.history) as ChatMessage[];
    this.leafId = leafOf(this.history);
  }

  /**
   * 记一笔账：把一次模型调用的用量写进本地账本（含四项分项成本）。
   * **不 await**——记账绝不能拖慢回合；写失败也只是少一行（账本是 append-only 的旁路）。
   */
  recordUsage(usage: Usage, opts: { role: CostRole; provider?: string; model?: string; at?: number }): void {
    if (!this.costLedger) return;
    try {
      const providerName = opts.provider ?? this.provider.name;
      const row = rowFromUsage({
        usage,
        provider: providerName,
        model: opts.model ?? ledgerModelOf(this.config as never, providerName, opts.role),
        // 注：查不到配置条目时 ledgerModelOf 回落到供应商名（不写 'unknown'——那等于账算不清）
        role: opts.role,
        sessionId: this.id,
        at: opts.at ?? Date.now(),
        pricing: ledgerPricingOf(this.config as never, providerName, opts.role),
      });
      void this.costLedger.append(row);
    } catch { /* 记账失败静默：绝不因此影响对话 */ }
  }

  /** 修复计数：返回是否仍允许修复 */
  bumpRepair(key: string, max: number): boolean {
    const n = (this.repairCounts.get(key) ?? 0) + 1;
    this.repairCounts.set(key, n);
    return n <= max;
  }

  /** 重复检测：返回是否连续 3 回合同一指纹 */
  markRepeat(fingerprint: string): boolean {
    if (fingerprint === this.lastFingerprint) {
      this.repeatCount++;
    } else {
      this.lastFingerprint = fingerprint;
      this.repeatCount = 1;
    }
    return this.repeatCount >= 3;
  }

  resetRepeat(): void {
    this.lastFingerprint = '';
    this.repeatCount = 0;
  }
}
