// 工作模式 / 闲聊模式
//
// ⚠️ 与「侧面」（`facets.ts`：话题领域 → 怎么说话 + 记忆分区）**正交、互不干涉**：
//    · 侧面管「怎么说」；模式管「**用多大资源、会不会问你、要不要证据**」
//    · 两套并存（`facets.ts` 不动）
//    · **新模式自述一律写「工作模式 / 闲聊模式」，绝不使用"职场模式"字样**（那是侧面的词）
//
// 设计：默认轻量对话 → 需要执行时自动进入 Task 模式 → 实时显示 → 危险动作才审批 → 结果 + 证据。
// 模式差别只落在 **工具权限 / 上下文策略 / 验证标准 / 执行时间与后台**，**不复制六套 Agent**。
// 所以这里不新增 Agent、不换人格、不换脸——只换一张**策略表**。

export type AgentMode = 'chat' | 'work';

export interface ModePolicy {
  key: AgentMode;
  /** 界面用的人话 */
  label: string;
  /** 模型档：standard = 维持现状按需路由；strong = 强制最强档 + 思考常开（"质量第一"） */
  model: 'standard' | 'strong';
  /** 工具面：standard = 现状（深度任务只读）；full = 放开写与执行 */
  tools: 'standard' | 'full';
  /** 子代理：只有工作模式放（内置 AGENT.md 后才真正有活可派） */
  subagents: boolean;
  /** 审批作用域：silent = 绝不打断（尊重「不要二次确认」）；askR3 = 只问 R3 及以上的动作 */
  approval: 'silent' | 'askR3';
  /** 出声策略：normal = 可主动搭话；quiet = 静默为主，只报进度与"要你决策的事" */
  voice: 'normal' | 'quiet';
  /** 形象策略：free = 自由漫步；fixed = 固定不动（免得你追着她点） */
  presence: 'free' | 'fixed';
  /** 单回合循环上限（工作模式允许更长：长活要能一口气做完） */
  maxIterations: number;
  /** 收尾要不要"拿得出证据"（验证契约） */
  verify: boolean;
}

export const MODE_POLICIES: Record<AgentMode, ModePolicy> = {
  chat: {
    key: 'chat', label: '闲聊',
    model: 'standard', tools: 'standard', subagents: false,
    approval: 'silent', voice: 'normal', presence: 'free',
    maxIterations: 40, verify: false,
  },
  work: {
    key: 'work', label: '工作',
    model: 'strong', tools: 'full', subagents: true,
    approval: 'askR3', voice: 'quiet', presence: 'fixed',
    maxIterations: 120, verify: true,
  },
};

export function modePolicyOf(mode: AgentMode): ModePolicy {
  return MODE_POLICIES[mode] ?? MODE_POLICIES.chat;
}

export function isAgentMode(v: unknown): v is AgentMode {
  return v === 'chat' || v === 'work';
}

// ---------- 显式切换（第一档：用户说了算） ----------

export interface ModeIntent {
  mode: AgentMode;
  /** 显式要求"锁住，别再自动切" */
  lock?: boolean;
}

/** 显式意图：比侧面切换**先判**（`工作模式` 这四个字属于模式，不属于侧面） */
export function parseModeIntent(text: string): ModeIntent | null {
  const t = String(text ?? '');
  if (!t || t.length > 60) return null; // 长消息不猜意图（同 parseFacetIntent 的纪律）
  if (/(?:不要|别|先别|不用|不必|无需).{0,8}(?:进入|开始|切|换|退出|关闭|锁定)/.test(t)) return null; // 否定不切
  const lock = /锁定|别再自动|不要自动|固定住/.test(t);
  // **先判"退出"**：否则 `退出工作模式` 会被下面的 `工作模式` 抢先命中（单测锁死这条）
  if (/(?:退出|结束|离开|关闭)\s*工作模式/.test(t) || /(?:回到|切回|进入)?\s*闲聊模式/.test(t) || /(?:回到|切回)(?:闲聊|聊天)/.test(t)) {
    return { mode: 'chat', ...(lock ? { lock: true } : {}) };
  }
  if (/(?:进入|开始|切到|切换到|转为|用|启用)?\s*工作模式/.test(t) || /(?:开始|我要)(?:干活|工作了)/.test(t)) {
    return { mode: 'work', ...(lock ? { lock: true } : {}) };
  }
  return null;
}

// ---------- 自动判定（第二档：规则；第三档：行为） ----------

export interface ModeSignals {
  /** 带了文件/图片（拖进来或选了文件） */
  hasAttachment?: boolean;
  /** 账本上还有没做完的活 */
  hasActiveTask?: boolean;
  /** 宿主侧的"深度任务"判定（沿用 needsDeepThinking） */
  deepThinking?: boolean;
}

export interface ModeDecision {
  mode: AgentMode;
  /** 判定来源：explicit 用户明说 / rule 命中规则 / behavior 她真动了手 / default 默认闲聊 */
  source: 'explicit' | 'rule' | 'behavior' | 'default';
  /** 人话理由（进日志；界面上不显示） */
  reason: string;
}

/** 要"干活"的动作词 */
const WORK_VERBS = /(?:帮我|给我|替我|麻烦)?\s*(?:改|写|做|整理|生成|转换|导出|汇总|排版|修复|翻译|处理|清洗|合并|拆分|重命名|归类)(?:一下|一个|一份|一张|个|份|张|下|好)?/;
/** 要"交付物"的宾语提示（**没有它就不算活**——"帮我查一下天气"是闲聊，不是工作） */
const WORK_OBJECTS = /(文件|文档|表格|图片|照片|视频|音频|截图|报告|周报|月报|附件|文件夹|目录|清单|名单|简历|合同|方案|PPT|ppt|Excel|excel|Word|word|PDF|pdf|代码|脚本|数据|表格|报表)/;
/** 文本里直接点了文件（带后缀） */
const FILE_HINT = /[\w一-龥-]+\.(?:docx|xlsx|pptx|pdf|md|txt|csv|json|png|jpe?g|gif|webp|mp4|mov|mp3|wav|zip)\b/i;

/**
 * 三档自动判定（"从快到准"）：
 *   ① 命中规则 → 立刻判（零成本）② 拿不准 → **默认闲聊**，等她真的动手（第一个写/执行类工具调用）再靠"行为档"升上去。
 *
 * 第三档用"行为档"（她真调用了写/执行工具 → 粘住工作模式）而不是"一次极便宜的判定调用（fast 档一问一答）"，理由：
 *   · 每句拿不准的话都调一次模型 = 每句闲聊都多花钱多等一秒，而"闲聊"恰恰是最高频的场景；
 *   · 判定器的假阳性会把闲聊判成工作（强档 + 静默 + 形象固定），代价比假阴性大得多；
 *   · "她真的动手了"是**最强的行为信号**，零成本、零延迟、不会误判。
 */
export function detectMode(text: string, sig: ModeSignals = {}): ModeDecision {
  if (sig.hasAttachment) return { mode: 'work', source: 'rule', reason: '带了文件/图片' };
  if (sig.hasActiveTask) return { mode: 'work', source: 'rule', reason: '账上还有没做完的活' };
  if (sig.deepThinking) return { mode: 'work', source: 'rule', reason: '命中深度任务（要动脑子/要拿结果）' };
  const t = String(text ?? '');
  if (FILE_HINT.test(t)) return { mode: 'work', source: 'rule', reason: '消息里点了具体文件' };
  if (WORK_VERBS.test(t) && WORK_OBJECTS.test(t)) return { mode: 'work', source: 'rule', reason: '是"帮我做东西"的活' };
  return { mode: 'chat', source: 'default', reason: '没命中工作规则（拿不准先当闲聊）' };
}

/** 行为档：她真的调用了"写/执行"类工具 → 这一件事按工作模式跑完（`turn.ts` 用它） */
export function behaviorUpgrade(mode: AgentMode, toolName: string): ModeDecision | null {
  if (mode === 'work') return null;
  if (WORK_TOOLS.has(toolName)) {
    return { mode: 'work', source: 'behavior', reason: `她动手了（${toolName}）——这一件事按工作模式跑完` };
  }
  return null;
}

/**
 * 会"改变现实"的工具（行为档据此升级）；只读类不算。
 * **注意不含 `run_agent` / `plan_task`**：这两个是"元工具"（派活/拆解），如果它们也能触发行为升级，
 * 那"子代理只在工作模式放开"的成本闸就永远关不上（她一派活就先把自己升成工作模式，闸门形同虚设）。
 * 所以这两颗的语义是：**先用规则/显式进工作模式，才允许派活**（见 `tools/run-agent.ts` 的 MODE_NOT_WORK）。
 */
export const WORK_TOOLS = new Set([
  'write', 'edit', 'office', 'media', 'delete', 'bash', 'app', 'schedule',
  'save_skill', 'install_skill', 'install_mcp',
]);
