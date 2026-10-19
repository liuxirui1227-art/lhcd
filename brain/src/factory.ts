// Agent 组装工厂：config → provider → runtime → registry → session。
// runtime Electron 宿主与 CLI 共用此入口；测试用 provider/runtime 覆盖注入 mock。
import { loadConfig, type LoadOptions } from './config/load.js';
import type { Config } from './config/schema.js';
import type { LLMProvider } from './llm/provider.js';
import { ProviderHub } from './llm/hub.js';
import type { Runtime } from './runtime/types.js';
import { createNodeRuntime, type NetEgressGuard } from './runtime/node.js';
import { ToolRegistry } from './tools/registry.js';
import type { ToolEntry } from './tools/registry.js';
import { bashTool } from './tools/bash.js';
import { readTool } from './tools/read.js';
import { writeTool } from './tools/write.js';
import { editTool } from './tools/edit.js';
import { grepTool } from './tools/grep.js';
import { globTool } from './tools/glob.js';
import { buildFrozen } from './prompt/assemble.js';
import { Session, type SessionOptions } from './loop/session.js';
import type { Emitter } from './session/events.js';
import { PolicyEngine } from './policy/engine.js';
import { diagnoseRules, type RuleIssue } from './policy/diagnose.js';
import { MemoryService } from './memory/service.js';
import { rememberTool, recallTool, forgetTool } from './tools/memory.js';
import { scanSkills, skillsIndexText } from './skills/scan.js';
import { loadSkillTool } from './tools/load-skill.js';
import { sessionSearchTool } from './tools/session-search.js';
import { webSearchTool } from './tools/web-search.js';
import { webFetchTool } from './tools/web-fetch.js';
import { registerMcpTools } from './mcp/adapter.js';
import { appTool } from './tools/app.js';
import { undoTool } from './tools/undo.js';
import { scanAgents, agentsIndexText } from './agents/scan.js';
import { buildSubagentRunner } from './agents/runner.js';
import { runAgentTool } from './tools/run-agent.js';
import { scheduleTool } from './tools/schedule.js';
import { todoTool } from './tools/todo.js';
import { CronJobs } from './orchestrate/jobs.js';
import { TaskStore } from './task/store.js';
import { taskTool } from './tools/task.js';
import { TurnTombstone } from './task/tombstone.js';
import { officeTool } from './tools/office.js';
import { deleteTool } from './tools/delete.js';
import { mediaTool } from './tools/media.js'; // 图片/视频处理
import type { AgentPorts } from './ports.js';
import { CostLedger } from './cost/ledger.js';
import { applyModelOverride, forceCheapTier, type ThinkEffort } from './llm/apply-override.js';

export interface AgentOptions {
  config?: Config;
  cli?: LoadOptions['cli'];
  cwd?: string;
  home?: string;
  /** 测试/宿主注入覆盖 */
  provider?: LLMProvider;
  runtime?: Runtime;
  /** 项目记忆（AGENTS.md / 宪法渲染块），缺省从 config.memory.projectFiles 读取 */
  projectMemory?: string;
  semanticItems?: string[];
  /** Identity 层渲染文本（测试/宿主可覆盖；缺省从 memory.identity 读） */
  identityItems?: string;
  skillsIndex?: string;
  /** 宿主注入的能力端口（Office 六动作 / 回收站）；缺失时对应工具如实拒绝 */
  ports?: AgentPorts;
  /**
   * 模型覆盖**必须在配置合并之后应用**：宿主传进来的 cli.providers 常常只有 baseUrl
   * （没有 models 字段）——在合并前覆盖，会因为"这个 provider 没有 models.main"被跳过
   * （只有自带 models 的供应商才生效）。
   */
  modelOverride?: Record<string, string>;
  /**
   * 全 Flash（默认关）：所有档位压到便宜档，摘掉 reasoner 条目与 Pro 定价。
   * 在 modelOverride **之后**应用——开关优先于手选（省钱优先，选了 Pro 也不给走）。
   * 传字符串 = 同时指定思考档位（`'max'`：能力拉满但仍是 Flash 价）。
   * 产品面不受影响：用户端自由切换模型，按实际切换计价。
   */
  forceFlash?: boolean | ThinkEffort;
  /**
   * 内置分身目录：随包分发的 3 个 AGENT.md（查证员/资料员/整理员）。
   * 排在 config.agents.dirs **之后**——scanAgents 遇到同名取先发现者，所以用户自己写的同名分身可以覆盖内置的。
   */
  builtinAgentsDir?: string;
  /**
   * 出站守卫：宿主给的判据函数——发请求前看一眼这次出去的内容里有没有
   * 她的私密材料。缺省不设闸（老调用方与测试不受影响）。
   */
  netGuard?: NetEgressGuard;
  /**
   * 时间锚点：宿主算好的那一行（跨天才给）。缺省不加。
   */
  timeAnchor?: string;
  /**
   * 宿主工具：需要 **agent 实例**才能造出来的工具（如 `plan_task` 要 agent 自己）。
   * 宿主把造工具的函数交回来，工厂在**渲染冻结前缀之前**注册它们，目录与 schema 同源
   * （否则这些工具只有 schema、没有目录自述）；缺省不注册（老调用方与测试一字不变）。
   */
  hostTools?: (agent: Agent) => ToolEntry[];
}

export interface Agent {
  config: Config;
  provider: LLMProvider;
  /** 模型注册表 + 供应商池（换脑不换人、任务路由、档位模型池） */
  hub: ProviderHub;
  runtime: Runtime;
  registry: ToolRegistry;
  memory: MemoryService;
  /** 定时任务表（宿主 tick 用同一实例；schedule 工具写的就是它） */
  cronJobs: CronJobs;
  /** 任务账本（长活的进度与状态；task 工具 + 完成判据写的就是它） */
  taskStore: TaskStore;
  /** 回合墓碑（崩溃的回合留墓碑、重开接着做完） */
  tombstone: TurnTombstone;
  /** 能力端口（Office/回收站；宿主注入，工具按需取用） */
  ports: AgentPorts;
  /** 本地成本账本（宿主查询"花了多少/为什么贵"用同一实例） */
  costLedger: CostLedger;
  /**
   * **规则体检**结果——"永远不会按预期生效"的规则（正则写错 / 被兜底规则挡死 /
   * 工具名打错 / 灾难性回溯 / 过宽 / 超上限），每条带可执行的修法。
   * 宿主启动时读它写进诊断日志——体检不接线，等于"写歪的规则比没有规则更危险"那句话没人执行。
   */
  policyIssues: RuleIssue[];
  createSession(opts?: Partial<SessionOptions>): Session;
}

export async function createAgent(opts: AgentOptions = {}): Promise<Agent> {
  const config = opts.config ?? loadConfig({ cli: opts.cli, cwd: opts.cwd, home: opts.home });
  // 面板选的模型：**在合并后的完整配置上**覆盖（只动 main；fast/compact/subagent 保持供应商分档 = 拆压平）
  if (opts.modelOverride) applyModelOverride(config.providers, opts.modelOverride);
  // 全 Flash：压平所有档位 + 摘 reasoner/Pro 定价 + 摘注册表 deep 条目（不然 hub.route 还能捞回 Pro）
  if (opts.forceFlash) {
    forceCheapTier(config.providers, { effort: typeof opts.forceFlash === 'string' ? opts.forceFlash : undefined });
    if (config.registry?.profiles) config.registry.profiles = config.registry.profiles.filter((p) => p.tier !== 'deep');
  }
  const cwd = opts.cwd ?? process.cwd();

  const hub = new ProviderHub(config);
  const provider: LLMProvider = opts.provider ?? hub.defaultProvider();

  const runtime: Runtime = opts.runtime ?? createNodeRuntime({
    cwd,
    storage: {
      sessionsDir: config.sessions.dir,
      logsDir: config.log.dir,
      memoryDir: config.memory.autoDir,
      configDir: cwd,
    },
    netGuard: opts.netGuard,
  });

  const registry = new ToolRegistry();
  // 常驻核心工具（文件/命令 + 记忆 + 技能/网络 + 设备操作）
  for (const t of [
    bashTool(), readTool(), writeTool(), editTool(), grepTool(), globTool(),
    rememberTool(), recallTool(), forgetTool(),
    loadSkillTool(), webSearchTool(), webFetchTool(), sessionSearchTool(),
    appTool(),
    undoTool(), // 撤销本回合改动（未挂快照库时如实拒绝）
  ]) {
    registry.register(t);
  }

  // 定时任务表——原子写 + 触发前推进 + 崩溃只补一次 + 一次性过期作废 + 任务记事本。
  // 与调度器同源（cron 解析复用 orchestrate/scheduler）；宿主从 agent.cronJobs 取同一实例跑 tick。
  const cronBase = config.sessions.dir.replace(/[\\/][^\\/]*$/, '');
  const cronJobs = new CronJobs(runtime, `${cronBase}/cron/jobs.json`);
  await cronJobs.load();
  registry.register(scheduleTool(cronJobs));

  // 任务账本——append-only 事件流 + 快照（不引 SQLite，零原生依赖）。
  // 落在 <sessions 上级>/tasks/（与 cron 同级）；宿主 tick/启动恢复用同一实例。
  const taskStore = new TaskStore(runtime, `${cronBase}/tasks`);
  await taskStore.load();
  registry.register(taskTool(taskStore));
  // 回合墓碑（一轮对话开始时写，任何正常结束都清——留下的只可能是被强杀的那一轮）
  const tombstone = new TurnTombstone(runtime, `${cronBase}/turns/tombstone.json`);

  // Office 六动作 + 删文件进回收站——都由**宿主注入的端口**提供
  // （库在 runtime 侧，brain 保持零运行时依赖）；端口缺失时工具如实拒绝，不假装成功。
  const ports: AgentPorts = opts.ports ?? {};

  // 成本账本——append-only JSONL，落在 <sessions 上级>/cost/ledger.jsonl。
  // **完全本地算**（价目表是元数据），一个字节都不往外发。
  const costLedger = new CostLedger(runtime, `${cronBase}/cost/ledger.jsonl`);
  await costLedger.load();
  registry.register(officeTool());
  registry.register(deleteTool());
  registry.register(todoTool());   // 待办（她能从闲聊里记一条；端口没注入时工具如实拒绝）
  registry.register(mediaTool()); // 图片/视频（随包 ffmpeg；未注入端口时如实拒绝）

  // 记忆服务（语义 + 情景；可选向量化器来自默认大脑 → recall 混合召回路径）
  const memory = new MemoryService(runtime, config.memory.semanticDir, config.memory.episodesDir, {
    embed: provider.embed ? (texts: string[]) => provider.embed!(texts) : undefined,
    identityFile: config.memory.identityFile, // Identity 层文件（缺省落在语义目录旁边）
  });

  // 项目记忆：显式注入优先，其次读 config.memory.projectFiles 第一个存在
  let projectMemory = opts.projectMemory;
  if (projectMemory === undefined) {
    for (const f of config.memory.projectFiles) {
      try {
        projectMemory = (await runtime.fs.read(f, { limit: 100_000 })).content;
        break;
      } catch {
        // 不存在则试下一个
      }
    }
  }

  // **TTL 真正生效**：**默认关**——关着时一次都不清（"记忆只进不出"是产品要求）；
  // 用户打开后才在每次启动清一次（confidence=high 的永不清，见 SemanticStore.purgeExpired）。
  if (config.memory.ttlEnabled === true) {
    try {
      await memory.purgeExpired(config.memory.ttlDays, runtime.clock());
    } catch {
      // 清理失败不阻塞启动（记忆是增强，不是启动前提）
    }
  }

  // 语义记忆注入（这里只取"稳定核心"，排序 importance→recency；
  // 当轮说了什么 → 每轮由宿主按相关性注入，见 runtime/lib.mjs 的相关记忆前缀）
  let semanticItems = opts.semanticItems;
  if (semanticItems === undefined) {
    const hits = await memory.search('', config.memory.topK);
    // 候选态明标：还没得到用户确认的记忆，不许看起来像板上钉钉的事实
    semanticItems = hits.map((h) => (h.entry.status === 'candidate' ? `〔待确认〕${h.entry.content}` : h.entry.content));
  }

  // 技能扫描：索引进冻结前缀；清单随会话供 load_skill
  const skills = await scanSkills(runtime, config.skills.dirs);
  const skillsIndex = opts.skillsIndex ?? skillsIndexText(skills);

  // subagent 扫描：0 个 agent → run_agent 不注册
  const agents = await scanAgents(runtime, [
    ...config.agents.dirs,
    ...(opts.builtinAgentsDir ? [opts.builtinAgentsDir] : []),
  ]);
  if (agents.length > 0) registry.register(runAgentTool());

  // MCP 工具快照（可选）：mcp.<server>.<tool> 进注册表；失败仅诊断不阻断
  if (config.mcp?.servers.length) {
    const r = await registerMcpTools(registry, config, runtime);
    if (r.failed.length > 0) {
      // 无 logger 前静默降级；TODO(spec)：接 obs/logger
    }
  }

  // Identity 层：用户立下的长期规矩 → 进冻结前缀（它变得很少，缓存代价可忽略）。
  // 读法**必须确定性**（文件顺序 → 同一段字节）。
  const identityItems = opts.identityItems ?? (await memory.identity.render());
  const timeAnchor = opts.timeAnchor;   // 宿主给的那一行（跨天才给）
  /* 冻结前缀"可重渲一次"——宿主工具（hostTools）注册完之后要再渲一次目录，
     否则那 4 个工具只有 schema、没有"一句话 + 何时别用"（目录与 tools 不同源）。 */
  const renderFrozen = () => buildFrozen({
    config,
    registry,
    runtime,
    projectMemory,
    semanticItems,
    identityItems,
    timeAnchor,
    skillsIndex,
    agentsIndex: agentsIndexText(agents), // 让她知道有活可以派（空名册 → 空串，前缀不变）
  });
  let frozen = renderFrozen();

  const policy = new PolicyEngine(config.permissions);
  // 规则体检**在装配时跑一次**（拿得到真实工具名），结果挂给宿主。
  // 纯本地、零成本；只报告不改行为——引擎侧另有"灾难性回溯直接跳过"那条硬动作。
  /* 体检多喂两样——家目录（参数级规则的 `~/` 展开）与**每个工具的入参名**
     （不喂这两样，"参数名根本不存在"这类写歪的规则就查不出来）。 */
  const argNames: Record<string, string[]> = {};
  for (const e of registry.all()) {
    const props = (e.schema?.function?.parameters as { properties?: Record<string, unknown> } | undefined)?.properties ?? {};
    argNames[e.name] = Object.keys(props);
  }
  const policyIssues = diagnoseRules(config.permissions, { tools: registry.all().map((e) => e.name), argNames });

  const agent: Agent = {
    config,
    provider,
    hub,
    runtime,
    registry,
    memory,
    cronJobs,
    taskStore,
    tombstone,
    ports,
    costLedger,
    policyIssues,
    createSession(extra: Partial<SessionOptions> = {}): Session {
      const emit: Emitter = extra.emit ?? (() => undefined);
      let session: Session | undefined;
      const subagentRunner = agents.length > 0
        ? buildSubagentRunner({ session: () => session!, runtime: agent.runtime, config, provider, registry, agents })
        : undefined;
      session = new Session({
        cwd,
        config,
        provider,
        runtime: agent.runtime, // 经 agent 间接引用：测试可注入 stub runtime（网络等）
        registry,
        system: frozen.system,
        layerHashes: frozen.layerHashes,
        emit,
        policy,
        memory,
        skills,
        subagentRunner,
        cronJobs,
        taskStore,
        ports,
        costLedger,
        ...extra,
      });
      return session;
    },
  };

  /* 宿主工具在**这里**注册（它们需要 agent 实例），注册完**重渲冻结前缀**——目录与 schema 从此同源。
     宿主在 createSession 之前调 createAgent，所以这一次重渲总在第一个会话之前发生，
     会话内仍然只构建一次（前缀冻结不变量不破）。 */
  if (opts.hostTools) {
    for (const entry of opts.hostTools(agent)) {
      if (!registry.get(entry.name)) registry.register(entry);
    }
    frozen = renderFrozen();
  }

  return agent;
}
