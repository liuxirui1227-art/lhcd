// @lhcd/brain · 智能体大脑入口
// 大脑地基：配置加载 + Provider 适配器。

export type {
  Runtime, RuntimeCaps, ReadResult, StatResult, GrepHit, ExecResult,
  NetFetch, NetResponse, AppResult, BrowserResult,
} from './runtime/types.js';

export type {
  Role, ChatMessage, ToolCall, ToolDef, ChatEvent, Usage, ProviderCaps,
  ModelRole, ModelRef, ChatRequest, LLMProvider,
} from './llm/provider.js';

export { isPeakTime, isPeakHour, hourInTimezone, missPrice, makeUsage, zeroUsage, type UsageParts } from './llm/usage.js';
export { MessageApiProvider, createMessageApiProvider, type MessageApiOptions } from './llm/adapters/message-api.js';
export { createFallbackProvider, type FallbackHooks } from './llm/fallback.js';
export { MockProvider, mockText, mockToolCalls, type MockOptions } from './llm/adapters/mock.js';

export type {
  Config, ProviderCfg, ModelCfg, PricingCfg, PermissionsCfg, PolicyRule, AppPolicyCfg,
  MemoryCfg, SkillsCfg, HookName, HookSpec, PolicyAction, PermissionClass,
} from './config/schema.js';
export { DEFAULT_CONFIG } from './config/schema.js';
export { loadConfig, initConfigFile, deepMerge, validateConfig, expandConfigDirs, type LoadOptions } from './config/load.js';

export { ToolRegistry, type ToolEntry, type ToolResult, type ExecCtx, type CapabilityRequirement } from './tools/registry.js';

export {
  eventLine, nullEmitter, EVENT_ORDER,
  // 事件信封（稳定 id + 时间戳）——宿主 / CLI 在**落盘点**各挂一次
  stampEmitter, makeEventIdFactory, coalesceDeltas, type EventEnvelope, type StampedEvent,
  type AgentEvent, type Emitter, type EvSessionStart, type EvSessionEnd, type EvTurnEnd,
  type ForwardedEvent,
} from './session/events.js';

// 产物台账（Agent 不只返回文本）
export { ArtifactLog, artifactFromMutation, classifyArtifact, PRODUCING_TOOLS, type Artifact, type ArtifactType } from './session/artifacts.js';

// 对话树（消息父子指针 / 纯函数投影 / 分支）
export { ensureIds, leafOf, parentOf, projectFrom, cutAt, branchSessionId, parentOfBranch, type TreeMessage } from './session/tree.js';

// 会话事件回放（只读排障入口——轮次/工具/压缩/审批/缓存 + 缺口）
export { replayEvents, replaySession, loadEvents, type ReplayResult, type ReplayedTurn } from './session/replay.js';

// 核心循环 + Runtime Node 实现 + 文件/命令工具
export { createNodeRuntime, type NodeRuntimeOptions } from './runtime/node.js';
export { globToRegExp, matchGlob, walkFiles, listGlob } from './runtime/glob.js';
export { bashTool } from './tools/bash.js';
export { readTool } from './tools/read.js';
export { writeTool } from './tools/write.js';
export { editTool } from './tools/edit.js';
export { grepTool } from './tools/grep.js';
export { globTool } from './tools/glob.js';
export { Session, zeroStats, type SessionStats, type SessionOptions } from './loop/session.js';
// 工作/闲聊模式（执行策略包）+ 动作风险分级 + 外部内容标记
export {
  MODE_POLICIES, modePolicyOf, parseModeIntent, detectMode, behaviorUpgrade, isAgentMode,
  WORK_TOOLS, type AgentMode, type ModePolicy, type ModeDecision, type ModeIntent, type ModeSignals,
} from './lifecycle/mode.js';
// 「冲着 TA 来的」情绪（第二本词典，与情绪引擎同一套否定消解思路）
export { classifyDirected, shouldDelight, type DirectedClass, type DirectedResult } from './lifecycle/directed.js';
export { riskLevelOf, shouldAskForRisk, isMandatoryAsk, MANDATORY_ASK_RISKS, RISK_LABELS, RISK_RANK, type RiskLevel } from './policy/risk.js';
export { markUntrusted, markToolOutput, UNTRUSTED_TAG, UNTRUSTED_TOOLS } from './tools/untrusted.js';
export { runTurn, type TurnResult } from './loop/turn.js';
export { prepareCalls, type PreparedCall } from './loop/retry.js';
export { validateArgs, type SchemaLiteError } from './loop/schema-lite.js';

// 上下文工程
export { BASE_PROMPT } from './prompt/base.js';
export { SUPPORTED_LOCALES, normalizeLocale, languageName, type Locale } from './prompt/language.js';
export { COMPACT_PROMPT, parseCompactJson, type CompactSummary } from './prompt/compact.js';
export { estimateTokens, truncateToTokens } from './prompt/tokens.js';
export { buildFrozen, type Frozen, type AssembleContext } from './prompt/assemble.js';
export { compactSession, summaryMessage, type CompactResult } from './loop/compact.js';
/* 后台复盘（独立 context + 工具白名单 + 只提候选） */
export { runReview, renderTranscript, REVIEW_TOOLS, REVIEWER_SYSTEM, type ReviewInput, type ReviewOutcome } from './review/review.js';
export { selfCheck, collectEvidence, type SelfCheckResult, type SelfCheckFlag } from './loop/selfcheck.js';

// 会话与事件协议
export { SessionStore, type SessionMeta, type LoadedSession } from './session/store.js';
/* KPI 日聚合（纯函数；设置页那五张卡的数字就是它算的） */
export {
  computeKpiDay, formatKpiDay, taskFinalizedOn,
  type KpiDay, type KpiInput, type KpiRatio, type KpiTaskRow, type KpiEventRow,
} from './kpi/aggregate.js';
/* 回合级文件快照（撤销本回合改动） */
export {
  SnapshotStore, TurnSnapshots, MAX_FILES_PER_TURN, MAX_SNAPSHOT_BYTES,
  type SnapshotEntry, type RestorePlan,
} from './session/snapshots.js';
export {
  SessionLog, projectLog, planLogAppend, projectAtLeaf,
  type LogEntry, type LogEntryType, type LabelPayload, type AppendPlan,
} from './session/log.js';
export { createAgent, type Agent, type AgentOptions } from './factory.js';

// 权限与沙箱
export { PolicyEngine, type PolicyDecision } from './policy/engine.js';
export type { NetEgressGuard } from './runtime/node.js';
export { isHardDenied, checkDanger, rmHasForce, type DenyHit } from './policy/deny.js';
export { BUILTIN_DENY_RULES } from './config/schema.js';
export { analyzeCommand, splitSegments, splitWords, executableName, MAX_SHELL_DEPTH, type CommandAnalysis, type PeeledCommand } from './policy/parse.js';
export { BaselineGuard, normalizePath, DEFAULT_READ_ZONES, PROTECTED_INNER_NAMES, PATH_ARG_KEYS, collectPaths, gitdirTargetOf, type BaselineOptions } from './policy/baseline.js';
export { proposePrefixRule, BANNED_PREFIXES, type PrefixRuleSuggestion, type PrefixRuleRefusal } from './policy/suggest.js';
export { diagnoseRules, isRiskyRegex, isTooBroad, MAX_RULES, MAX_RULE_PATTERN, MAX_RULE_TEXT, type RuleIssue, type DiagnoseOptions } from './policy/diagnose.js';
// 参数级 / glob 规则语言（解析、匹配、校验、人话预览）
export {
  parseRuleMatch, paramRuleHits, toolMatches, expandHome,
  // ⚠ 策略这边的 glob 编译器与 `runtime/glob.ts` 的同名（那个是**文件通配**，这个是**规则模式**），
  //   导出时改名避免撞车（两处语义不同：这里 `*` 不跨 `/` 的判据只服务于规则）
  globToRegExp as ruleGlobToRegExp,
  isParamRule, validateParamRule, describeParamRule,
  type ParamRule, type RegexRule, type BadRule,
} from './policy/pattern.js';
export type { ApprovalHandler } from './loop/session.js';
// 压缩锚点 + 历史存档 + 找回工具
export { buildAnchorIndex, renderAnchors, ANCHOR_BUDGET_CHARS, type AnchorSection, type AnchorValue } from './loop/anchors.js';
export { SessionArchive, type ArchivedMessage, type ArchiveHit } from './session/archive.js';
export { sessionSearchTool } from './tools/session-search.js';

// 三层记忆
export { SemanticStore, hasSecret, type SemanticEntry, type ScoredEntry } from './memory/semantic.js';
export { MemoryService, type RememberInput, type Episode } from './memory/service.js';
export { consolidateSession, type ConsolidateResult } from './memory/consolidate.js';
export { rememberTool, recallTool, forgetTool } from './tools/memory.js';

// 技能 + 网络工具
export { scanSkills, skillsIndexText, parseSkillMd, loadSkillBody, type SkillMeta, type ParsedSkill } from './skills/scan.js';
export { loadSkillTool } from './tools/load-skill.js';
export { webSearchTool, parseSearchResults, parseLiteResults, parseMojeekResults, SEARCH_EMPTY_TEXT, type SearchHit } from './tools/web-search.js';
export { webFetchTool, htmlToText } from './tools/web-fetch.js';

// MCP 客户端 v0
export { McpClient, type McpServerConfig, type McpTool } from './mcp/client.js';
export { registerMcpTools, type McpRegistryResult } from './mcp/adapter.js';

// 设备操作 v0
export { appTool } from './tools/app.js';
export { shq, osa, dq } from './runtime/node.js';

// subagent + hooks + 主动性 v0
export { scanAgents, parseAgentMd, agentsIndexText, type AgentSpec, type ParsedAgent } from './agents/scan.js';
export { runSubagent, buildSubagentRunner, type SubagentRunner, type SubagentResult, type SubagentHost } from './agents/runner.js';
export { runAgentTool } from './tools/run-agent.js';
export { runHooks, runHookCommand, matchesHook, type HookRunResult, type HookCtx } from './hooks/runner.js';
export { Scheduler, cronMatches, nextCron, lastMatchMs, type ScheduleCfg, type DueTask, type OrchestrateState } from './orchestrate/scheduler.js';
// 出声仲裁器（唯一"能不能出声"闸门）+ 定时任务表（原子写/补跑/记事本）
export { arbitrate, noteDelivered, inQuietHours, contentHash, dayKey, remainingQuota, type SpeakRequest, type SpeakDecision, type ArbiterState } from './orchestrate/arbiter.js';
export { CronJobs, graceMs, validCron, RETRY_STEPS_MS, GRACE_ON_TIME_MS, type CronJob, type JobStatus, type LedgerEntry } from './orchestrate/jobs.js';

// 任务账本（长活能接着干）+ 完成判据 + 催办退避 + 墓碑 + 状态词
export {
  statusWord, progressOf, indexEntry, isTerminal, TERMINAL_RUN_STATES, STEP_DONE,
  type TaskRun, type TaskStep, type TaskEvent, type TaskEventType, type RunState, type StepState,
  type BlockReason, type StatusWord, type StatusKey, type TaskIndexEntry,
} from './task/types.js';
export { TaskStore, DEFAULT_MAX_ITERATIONS, type CreateRunInput } from './task/store.js';
export { stopVerdict, promiseSeen, stripPromise, completionBriefing, continuationNudge, capText, type StopVerdict } from './task/criteria.js';
export {
  classifyTurnFailure, planRecovery, userMessageFor,
  type RecoveryKind, type RecoveryAction, type RecoveryPlan, type FailureFacts,
} from './task/recovery.js';
export { nudgeDecision, classifyFailure, isUnrecoverable, unrecoverableMessage, limitedMessage, nextNudgeAt, NUDGE_STEPS_MS, NUDGE_MAX_PER_CYCLE, type FailureKind, type NudgeDecision } from './task/nudge.js';
export { TurnTombstone, decideResume, resumePrompt, TOMBSTONE_FRESH_MS, TOMBSTONE_MAX_ATTEMPTS, type Tombstone, type ResumeDecision } from './task/tombstone.js';
export { taskTool } from './tools/task.js';

// 能力端口（Office/回收站，宿主注入）+ office/delete 工具 + 写后验证 + 改后自检回插
export {
  OFFICE_MATRIX, type AgentPorts, type OfficePort, type OfficeChange, type OfficeResult,
  type OfficeFormat, type TrashPort,
} from './ports.js';
export { officeTool } from './tools/office.js';
export { deleteTool } from './tools/delete.js';
export { reviewMutations, workCheckNudge, type FileMutation, type WorkCheckResult } from './loop/workcheck.js';

// 图片/视频处理（随包 ffmpeg；brain 只声明 MediaPort）
export { mediaTool } from './tools/media.js';
export type { MediaPort, MediaOp, MediaInfo, MediaResult, MediaKind } from './ports.js';

// 世界状态差分注入（只发"这次变了什么"；没变一个字都不发）
export {
  WorldStateTracker, mergePatchFrom, prevStateOf,
  type SectionSpec, type SectionState, type WorldStateSnapshot, type DiffResult, type PrevState,
} from './prompt/world-state.js';

// 配置写回四件套（可选乐观锁 / 稀疏合并 / 只写用户层 / 被覆盖要说明）
export {
  writeUserConfig, readLayer, sparseOverlay, clearPath, fingerprint, layerHasPath, USER_LAYER,
  type LayerMeta, type WriteStatus, type WriteConfigInput,
} from './config/write.js';

// 模型覆盖（面板选的模型 → 供应商配置；必须在配置合并后应用）
export { applyModelOverride, forceCheapTier, type ProviderLike } from './llm/apply-override.js';
export { effortFor, type ThinkEffort } from './llm/effort.js';

// 模型清单数据化（随包基线 + 用户/平台覆盖 + 可选联网刷新，只发元数据）
export {
  CatalogStore, parseCatalog, mergeCatalog, normalizeCatalogModel, isValidCatalogModel, refreshCatalog,
  CATALOG_DEFAULTS, REMOTE_CATALOG_ATTEMPT_TIMEOUT_MS, REMOTE_CATALOG_REFRESH_INTERVAL_MS,
  type CatalogModel, type CatalogFile, type CatalogCost, type RefreshResult,
} from './llm/catalog.js';

// 成本本地账本 + "这轮为什么贵"归因
export {
  CostLedger, priceUsage, rowFromUsage, detectCacheMiss, explainCacheMiss, worthMentioning,
  ledgerModelOf, ledgerPricingOf,
  CACHE_TTL_MS, NOISE_FLOOR_TOKENS, DISPLAY_MIN_MISSED_TOKENS, DISPLAY_MIN_MISSED_COST,
  type UsageRow, type CostTotals, type CacheMiss, type CostRole,
} from './cost/ledger.js';

// 关系状态机 + eval
export {
  REL_STAGES, stageFor, initialRelationship, bumpIntimacy, markConflict, resolveConflict,
  type RelationshipState, type RelationStage, type BumpResult,
} from './lifecycle/relationship.js';
export { classifyEmotion, type EmotionClass, type EmotionResult } from './lifecycle/emotion.js';
export {
  birthAgeTierToYears, ageYears, narrativeStage, growthParams, milestoneQueue, milestoneQueueForTier,
  type GrowthParams, type Milestone,
} from './lifecycle/age.js';
export {
  initialWardrobe, acquire, chooseOutfit, wear,
  type WardrobeState, type WardrobeItem, type WardrobeCategory, type WardrobeOrigin, type OutfitContext,
} from './lifecycle/wardrobe.js';
export {
  DEFAULT_FACETS, DOMAINS, DOMAIN_LABELS, domainAccess, filterDomains, facetById, classifyDomain,
  type FacetDef, type Domain,
} from './lifecycle/facets.js';
export {
  runEval, runEvalCase, type EvalCase, type EvalSession, type EvalCheck, type MockTurn,
  type EvalCaseResult, type EvalReport,
} from './eval/runner.js';

// 换脑不换人 + 任务路由 + 能力档位
export {
  routeTask, scoreProfile, qualityScore, latencyScore, costScore, supportsCapability, deriveProfiles,
  type ModelProfile, type TaskProfile, type Capability, type ModelTier,
} from './llm/registry.js';
export {
  detectCapabilityTier, effectiveTier, validTier, TIER_INFO, CAPABILITY_TIERS,
  type CapabilityTier, type DeviceProfile, type TierDetection,
} from './llm/tier.js';
export { ProviderHub } from './llm/hub.js';

// 任务拆解 planner（Task Decomposer）
export {
  decomposeTask, shouldDecompose, validatePlan, executionOrder, planToText, singleStepPlan,
  type Plan, type PlanStep, type PlanValidation,
} from './orchestrate/planner.js';

// 设备操作分级模型 + 审计
export { deviceLevelFor, deviceUndoHint, DEVICE_LEVELS, type DeviceLevel } from './tools/app.js';

// 记忆混合召回
// 来源权威性（sourceAuthority / sourceLabel）——宿主界面显示"这条为什么算数"
export {
  hybridRecall, keywordScore, graphScore, timeDecay, importanceWeight, cosine, tokenize,
  sourceAuthority, sourceLabel,
  type RecallWeights, type HybridOptions, type HybridScoredEntry,
} from './memory/recall.js';
// Identity 上限给宿主界面显示「N / 30」用（真闸门在 IdentityStore.add）
export { IDENTITY_MAX } from './memory/identity.js';
