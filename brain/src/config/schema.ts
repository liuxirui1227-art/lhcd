// 配置类型唯一出处（别处不要再抄一份）。
// 加载顺序：CLI 参数 > <cwd>/agent.json > ~/.agent/agent.json > 内置默认（见 load.ts）。

export interface ProviderCapsCfg {
  cache: { kind: 'explicit' } | { kind: 'automatic'; minPrefixTokens: number } | { kind: 'none' };
  reasoning: 'none' | 'thinking-blocks' | 'content-field';
  parallelToolCalls: boolean;
  compaction: 'server' | 'client';
  maxContextTokens: number;
  /** 该供应商吃 `reasoning_effort`（思考档位 low/high/max）；缺省不发（BYOK 严格端点安全） */
  thinkingEffort?: boolean;
  /** 单次输出物理上限（max_tokens 会被夹到这里）；缺省不限 */
  maxOutputTokens?: number;
  embedding?: { model: string; dims: number };
}

export interface ModelCfg {
  id: string;
  thinking: boolean;
  /** 多模态视觉能力（vision 任务路由依据；缺省 false） */
  vision?: boolean;
}

/**
 * 定价（元 / 百万 tokens）。
 * DeepSeek 峰谷分时计价（北京时间）：高峰 = 每日 9:00–12:00 与 14:00–18:00，高峰价为空闲价 2 倍。
 * hitPeak / missPeak 缺省时按 hit × 2 / miss × 2 计（见 llm/usage.ts）。
 */
export interface PricingCfg {
  hit: number;
  /** 高峰时段缓存命中输入价；缺省 = hit × 2 */
  hitPeak?: number;
  miss: number;
  /** 高峰时段输入未命中价；缺省 = miss × 2 */
  missPeak?: number;
  out: number;
  /** 思考 token 价；缺省按 out 计 */
  reasoning?: number;
  /** 显式缓存写单价（Anthropic 类；缺省按 miss 价） */
  cacheWrite?: number;
  /** 阶梯价：按 **input+cacheRead+cacheWrite 总量**选"门槛最高且低于总量"的那档 */
  tiers?: Array<{ inputTokensAbove: number; hit: number; miss: number; out: number }>;
}

export interface ProviderCfg {
  adapter: 'message-api' | 'system-channel';
  baseUrl?: string;
  apiKeyEnv: string;
  /** 直接注入的 API Key（自定义供应商配置；优先于 apiKeyEnv 环境变量） */
  apiKey?: string;
  /** message-api 服务商思考字段名（如 DeepSeek 的 reasoning_content）；无思考回放则为 null */
  reasoningField?: string | null;
  caps: ProviderCapsCfg;
  models: {
    main: ModelCfg;
    fast: ModelCfg;
    compact: ModelCfg;
    subagent: ModelCfg;
    /** 可选：Tier3 深度推理模型（thinking=true 时使用）。TODO(spec) 由 core/router 路由 */
    reasoner?: ModelCfg;
  };
  /** 主档定价（main/fast/compact/subagent） */
  pricing: PricingCfg;
  /** 可选：reasoner（Pro 档）独立定价；缺省沿用 pricing（记账会低估 Pro 消耗） */
  pricingReasoner?: PricingCfg;
  /** 采样温度默认值；compact 角色固定 0.3 覆盖 */
  temperature?: number;
}

/**
 * 权限类**唯一出处**（`tools/registry.ts` 从这里 re-export，别处不要再抄一份）。
 *
 * ⚠ 别在这里之外再抄一份联合类型：两份定义迟早起漂，加新类时只改一处，
 * 编译报错（"xxx 不存在于 Record<PermissionClass, …>"）会很难查。
 *
 * `screen`：**看屏幕**——有独立的类，能像别的类一样被用户规则收紧（`screen → deny` = 一刀切不看屏幕）。
 */
export type PermissionClass = 'read' | 'write' | 'bash' | 'net' | 'app' | 'internal' | 'screen';
export type PolicyAction = 'allow' | 'ask' | 'deny';

export interface PolicyRule {
  id: string;
  tool: string;
  match: string;
  action: PolicyAction;
  /**
   * 这条是**内置默认**（不是用户写的）。只在一个地方用得上——`autonomy: 'auto'` 档下
   * 内置的 `ask` 兜底规则要让路（它的意思是"拿不准就问"，而 auto 的意思就是"别问我"），
   * 而**用户自己写的规则一律照办**（显式意图优先）。判定见 `policy/engine.ts` 的 matchRules。
   */
  builtin?: true;
}

/**
 * app 权限扩展：设备操作 = 宿主权限确认 + 指定应用白名单；
 * 可开最高权限（trusted 信任模式），但必须由宿主给出警告提示。
 */
export interface AppPolicyCfg {
  /** whitelist：仅白名单内应用可被 app 工具操作；trusted：全部放行（宿主先警告） */
  mode: 'whitelist' | 'trusted';
  whitelist: string[];
}

export interface PermissionsCfg {
  autonomy: 'interactive' | 'auto';
  defaults: Record<PermissionClass, PolicyAction>;
  rules: PolicyRule[];
  app: AppPolicyCfg;
  /**
   * 禁区路径：读/写/改一律拒，**任何放行、审批、规则都不解除**。
   * 缺省 = [`~/.lhcd`]（人格·记忆·凭据三件套所在），见 policy/baseline.ts。
   */
  readZones?: string[];
  /**
   * **授权目录**：用户交给她的文件夹。配了之后，会动到文件系统的调用
   * 必须落在其中之一的里面，否则走审批（ask）——是"门"，不是"墙"。
   *
   * **缺省不配 = 不设边界**：灵核的产品前提是"她帮你处理你电脑上的文件"，
   * 一刀切限制落点会砍掉正功能（见 `baseline.ts` 开头的同类说明）。
   * ⚠ 与 `readZones` 不同：这里**只约束写类落点**，读不受限。
   */
  workspaceDirs?: string[];
  /**
   * **外部来源目录**：从这些地方读文件 = 读"别人的东西"（下载来的、邮件附件），
   * 第一次会问你一句"要读吗"（同一条对话里同一份文件只问一次）。
   *
   * 缺省 = `['~/Downloads']`。为什么只对下载目录开口：**这条最容易做成"烦人"**——
   * 所有读操作都问一遍，用户第一件事就是把它关掉，那还不如不做。
   */
  externalSourceDirs?: string[];
}

export interface HookSpec {
  matcher: string;
  command: string;
}

export type HookName = 'PreToolUse' | 'PostToolUse' | 'UserPromptSubmit' | 'SessionStart' | 'SessionEnd';

export interface SkillsCfg {
  dirs: string[];
  autoLoad?: boolean;
}

export interface MemoryCfg {
  /** 项目记忆文件（第一个存在优先，可合并）：AGENTS.md > .agent/MEMORY.md */
  projectFiles: string[];
  autoDir: string;
  semanticDir: string;
  episodesDir: string;
  /** Identity 层文件：用户给 TA 定过的长期规矩，一条一行、可直接手改 */
  identityFile?: string;
  /** 语义记忆注入条数上限 */
  topK: number;
  /** 每条注入 token 上限 */
  perItemTokens: number;
  autoConsolidate: boolean;
  ttlDays: number;
  /**
   * TTL 开关：**默认关** —— 关着时 `purgeExpired` 谁都不许调，记忆只进不出。
   * 打开后按 ttlDays 清（confidence=high 的永不清；有 expiresAt 的按 expiresAt）。
   */
  ttlEnabled?: boolean;
}

/**
 * 模型注册表条目（多模型任务路由）。
 * 缺省由 providers 自动派生（main → standard/text；reasoner → deep/text+reasoning），零配置可用；
 * 显式配置可挂第三方供应商的多模态/多档条目。
 */
export interface ModelProfileCfg {
  id: string;
  /** 指向 config.providers 键 */
  provider: string;
  /** wire 模型名 */
  model: string;
  capabilities: Array<'text' | 'vision' | 'audio' | 'reasoning'>;
  tier: 'light' | 'standard' | 'deep';
  thinking?: boolean;
  /** 延迟画像 1~5；缺省 3 */
  latency?: number;
  /** 输出价近似（元/M，路由打分用） */
  costPerMOut?: number;
}

export interface Config {
  /** 输出语言：zh-CN / zh-Hant / en / ja / ko；缺省 zh-CN（行为不变）。
   *  只影响提示词的「用{X}回复」指令；人格/记忆原文不翻译。 */
  language?: string;
  provider: { default: string };
  providers: Record<string, ProviderCfg>;
  /** 可选：模型注册表；缺省按 providers 派生（见 llm/registry.ts deriveProfiles） */
  registry?: { profiles: ModelProfileCfg[] };
  budget: {
    maxIterations: number;
    maxCost: number | null;
    maxContextTokens: number;
    compactAtTokens: number;
    turnMaxTokens: number;
    /** 派活的四道闸（深度/数量/成本/时长）。
     *  可选——缺省走 DEFAULT_CONFIG 的值；手写 config 不给这一段也不影响（runner 侧有兜底）。 */
    subagent?: { maxDepth: number; maxChildren: number; maxCost: number; maxRuntimeMs: number };
    /** 单回合累计 token 上限（输入+输出，含思考）——一轮不能把余额烧穿；null = 不限 */
    maxTurnTokens?: number | null;
    /** 单回合墙钟上限 ms——干太久的活先停下来说清楚；null = 不限 */
    maxTurnMs?: number | null;
    /** 审批等待上限 ms——用户不在时回合不能无限挂着（到点停下，回来接着干） */
    approvalWaitMs?: number;
  };
  reliability: { selfCheck: boolean; reflect: boolean };
  tools: {
    enabled: string[];
    /** 是否在冻结前缀里渲染"能力自述目录"（默认开；关掉 = 只靠 JSON schema） */
    catalog?: boolean;
  };
  permissions: PermissionsCfg;
  hooks: Record<HookName, HookSpec[]>;
  skills: SkillsCfg;
  agents: { dirs: string[] };
  memory: MemoryCfg;
  sessions: { dir: string };
  /** 可选：网络工具后端配置 */
  net?: {
    /** 搜索后端基础 URL（默认 DuckDuckGo HTML，零 key） */
    searchBase?: string;
    userAgent?: string;
  };
  /** 可选：MCP 服务器（启动时快照工具列表） */
  mcp?: {
    servers: Array<{ name: string; url: string; enabled?: boolean }>;
  };
  /** 可选：调度（主动性 v0）。5 字段 cron：分 时 日 月 周 */
  orchestrate?: {
    schedules: Array<{
      id: string;
      cron: string;
      timezone?: string;
      task: string;
    }>;
  };
  ui: { mode: 'tui' | 'print' | 'json' | 'rpc' };
  log: { dir: string };
}

/** 内置默认配置（DeepSeek 供应商，峰谷分时计价）。 */
/**
 * **内置 deny 规则**（内置规则不可禁用）：它们**不在** `permissions.rules` 里，引擎每次都先查
 * 这张表——所以**任何配置都删不掉、也压不住**（配置只能加码不能降级）：`deepMerge` 对数组是
 * **整体替换**，一份普通的 `<cwd>/agent.json` 只要写上 `permissions.rules`，默认那几条就会被整表换掉。
 * deny 判据分三层，**都不可降级**：① `policy/deny.ts` 的硬表（按可执行名+参数逐层判）
 * → ② 这张表（按文本、锚在命令位置）→ ③ 用户规则（可以更严，不能更松）。
 */
export const BUILTIN_DENY_RULES: readonly PolicyRule[] = [
  {
    id: 'builtin:dangerous-bash',
    tool: 'bash',
    match: '(^|[;&|]\\s*)(rm\\s+-[a-z]*r[a-z]*|mkfs|dd\\s+of=|shutdown)',
    action: 'deny',
  },
];

export const DEFAULT_CONFIG: Config = {
  // 输出语言（国际化）：默认中文；由宿主（runtime）按 prefs.language 覆盖
  language: 'zh-CN',
  provider: { default: 'deepseek' },
  providers: {
    deepseek: {
      adapter: 'message-api',
      baseUrl: 'https://api.deepseek.com/v1',
      apiKeyEnv: 'DEEPSEEK_API_KEY',
      // 在售两档（deepseek-flash / deepseek-v4-pro）**默认开思考**：开着思考时服务端把思考过程
      // 放在 `reasoning_content` 里回传；思考档为 none 时该字段根本不出现 → 不发 reasoning delta（无害）。
      reasoningField: 'reasoning_content',
      caps: {
        // DeepSeek 上下文硬盘缓存：自动生效，前缀 ≥64 token 即可命中（官方最小粒度 64）
        cache: { kind: 'automatic', minPrefixTokens: 64 },
        reasoning: 'content-field',
        parallelToolCalls: true,
        compaction: 'client',
        // DeepSeek V4.1 上下文 1M（旧值 128k 是 deepseek-chat 时代的）
        maxContextTokens: 1000000,
        // DeepSeek V4.1 吃 reasoning_effort（low/high/max）→ 内核自动选档可以发；
        // 没申报的供应商（BYOK 自定义端点）一个字段都不发（严格校验的端点收到未知字段会 422）
        thinkingEffort: true,
        // 官方标称最大输出 384K（《Models & Pricing》）；请求里的 64k 上限远在它之内 ✓
        maxOutputTokens: 384_000,
      },
      // 官方 /models 在售的是 **deepseek-flash / deepseek-v4-pro**
      // （旧的 deepseek-chat / deepseek-reasoner 已不在列表里，官方仍保留别名能跑，但不该再写死）
      models: {
        main: { id: 'deepseek-flash', thinking: false },
        fast: { id: 'deepseek-flash', thinking: false },
        compact: { id: 'deepseek-flash', thinking: false },
        subagent: { id: 'deepseek-flash', thinking: false },
        // Tier3 深度任务（Pro 档）：按任务画像路由
        reasoner: { id: 'deepseek-v4-pro', thinking: true },
      },
      // DeepSeek 官方峰谷价（元/M，北京时间 9:00–12:00 / 14:00–18:00 高峰 ×2）：
      // Flash 档：hit 0.05（高峰 0.10）/ miss 1.5（高峰 3.0）/ out 4.5（高峰 9.0）
      // Pro 档（reasoner）：hit 0.15（高峰 0.30）/ miss 4.5（高峰 9.0）/ out 13.5（高峰 27.0）
      // 见 eval/pricing-notes.md；reasoning 按 out 计
      pricing: { hit: 0.05, hitPeak: 0.10, miss: 1.5, missPeak: 3.0, out: 4.5 },
      pricingReasoner: { hit: 0.15, hitPeak: 0.30, miss: 4.5, missPeak: 9.0, out: 13.5 },
      temperature: 0.8,
    },
  },
  budget: {
    // 单条消息的防失控迭代上限（非对话限制——每条新消息重新计数；120 轮正常任务永远用不到，
    // 仅为防止模型死循环烧钱；成本上限保持关闭，上下文上限=模型物理窗口）
    maxIterations: 120,
    maxCost: null,
    // 上下文上限 = 模型物理窗口 1M
    maxContextTokens: 1000000,
    // 压缩点推迟到 80 万（80% 窗口）——「上下文尽量大」（到 800000 才自动压缩）
    compactAtTokens: 800000,
    // 单次回复上限（**同时也是思考预算**：DeepSeek 把 reasoning token 计入 max_tokens）。
    // 从 8192 抬到 64k：实测 max 档思考胃口 6.6k~9.9k token，8192 会被思考吃光
    // → 正文返回空（`finish_reason=length`、正文 0 字）。
    // 64k ≈ 10 万汉字正文（实测 1.37 万字 ≈ 5,105 token，四倍余量）。
    // 官方最大 384K，不拉满：上限的第二重身份是**失控保险丝**（64k → flash ¥0.29 / pro ¥0.86 非高峰）。
    // 配套：适配器总时长上限同步抬到 900s（不然长生成会被超时先掐断）。
    turnMaxTokens: 65536,
    /**
     * **派活的四道闸**（多 Agent 不是越多越好）：子代理若只受 maxIterations 约束，
     * 模型在一个回合里连派十个分身就是十倍的钱（成本敏感，必须有成本/时长/数量上限）。
     */
    subagent: {
      /** 深度上限：1 = 只允许宿主派一层（子代理不能再派） */
      maxDepth: 1,
      /** 每回合最多派几个（同一个回合里模型连调 run_agent 的总数） */
      maxChildren: 8,
      /** 单个子代理的成本上限（元）；子代理自己声明的 maxCost 只能更小 */
      maxCost: 2,
      /** 单个子代理的时长上限（ms）——卡住的分身不能拖着宿主 */
      maxRuntimeMs: 600_000,
    },
    // **终止条件补齐**：除迭代/成本/上下文三个闸之外，「一轮累计烧了多少」「一轮干了多久」
    // 「审批一直没人回」也得有出口。
    // 默认值取得很宽松：正常任务一辈子碰不到，只在失控时才响（它们是保险丝，不是配额）。
    maxTurnTokens: 3_000_000, // 一轮累计 300 万 token（flash 约 ¥4.5；正常工作远用不到）
    maxTurnMs: 30 * 60 * 1000, // 一轮 30 分钟
    approvalWaitMs: 10 * 60 * 1000, // 审批等 10 分钟
  },
  reliability: { selfCheck: true, reflect: false },
  tools: {
    enabled: [
      'bash', 'read', 'write', 'edit', 'grep', 'glob', 'load_skill', 'run_agent',
      'web_search', 'web_fetch', 'remember', 'recall', 'forget', 'app', 'browser',
      // 宿主注册的工具（runtime 注册进 registry；CLI 环境无此注册项则自然过滤）
      'plan_task', 'install_skill', 'save_skill', 'install_mcp',
      // 后台复盘的**提候选**工具——**只进复盘者那份注册表**（宿主建副本时注册），
      // 她的常用注册表里没有它们，所以这行不是"给她多两个工具"，是"复盘者能看见它们"。
      'propose_memory', 'propose_skill',
      // 漏在白名单外 = 模型根本看不到这些工具（"自然语言入口"是空话）。
      // 注册表里有、白名单里没有 = 死功能——这条教训对应的守卫测试见 tools-guard.test.ts。
      'schedule', 'session_search', 'task',
      // Office 六动作 + 删文件进回收站（能力由宿主注入端口提供；缺端口时工具如实拒绝）
      'office', 'delete',
      // 撤销本回合改动（回合级快照）
      'undo',
      // 图片/视频处理（随包 ffmpeg；缺引擎时如实拒绝）
      'media',
      // 待办——她把「闲聊里聊出来的事」记进家里右栏那张卡
      'todo',
    ],
  },
  permissions: {
    autonomy: 'interactive',
    defaults: {
      read: 'allow',
      write: 'allow',
      bash: 'ask',
      net: 'allow',
      app: 'ask',
      internal: 'allow',
      // 看屏幕默认 **问**（画面会离开本机去识别）。
      // 定时观察那条路走"开关即授权"，不进这里（见 policy/engine.ts 的 screen 底线）。
      screen: 'ask',
    },
    rules: [
      { id: 'r1', tool: 'bash', match: '^git ', action: 'allow', builtin: true },
      // 注：`rm -rf|mkfs|dd of=|shutdown` → deny 那条在 `BUILTIN_DENY_RULES`（配置删不掉的那张表）：
      // 放在默认规则表里，一份用户配置就能把它整表换掉、或者用一条排在前面的 allow 把它盖住。
      // 低风险只读命令免审（列出/查看文件类）。安全加固：
      // 拒绝一切 shell 元字符（; | & 反引号 $ 重定向 <> 换行）——杜绝拼接命令/命令替换绕过；
      // find 不进白名单（-exec/-delete 攻击面大，读文件请用 read/grep/glob 工具）。
      { id: 'r4', tool: 'bash', match: '^(ls|cat|head|tail|grep|wc|pwd|date|echo)(\\s|$)(?!.*[;|&`$<>\\n])', action: 'allow', builtin: true },
      { id: 'r3', tool: 'bash', match: '.*', action: 'ask', builtin: true },
    ],
    app: { mode: 'whitelist', whitelist: [] },
  },
  hooks: { PreToolUse: [], PostToolUse: [], UserPromptSubmit: [], SessionStart: [], SessionEnd: [] },
  skills: { dirs: ['~/.lhcd/skills', '.agent/skills'] },
  agents: { dirs: ['~/.lhcd/agents', '.agent/agents'] },
  memory: {
    projectFiles: ['AGENTS.md', '.agent/MEMORY.md'],
    autoDir: '~/.lhcd/memory',
    semanticDir: '~/.lhcd/memory/semantic',
    episodesDir: '~/.lhcd/memory/episodes',
    identityFile: '~/.lhcd/memory/identity.md',
    // 超强记忆：注入条数 12、每条 800 token、TTL 10 年
    //（high 置信条目本就永存不清理——长期记忆不蒸发）
    topK: 12,
    perItemTokens: 800,
    autoConsolidate: true,
    ttlDays: 3650,
    ttlEnabled: false, // 默认关（记忆只进不出是产品要求，清理要用户明确打开）
  },
  sessions: { dir: '~/.lhcd/sessions' },
  net: { searchBase: 'https://html.duckduckgo.com/html', userAgent: 'lhcd-agent/0.1' },
  ui: { mode: 'print' },
  log: { dir: '~/.lhcd/logs' },
};
