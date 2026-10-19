// subagent 运行器：独立 Session（独立历史/预算；system = 宿主冻结前缀 + AGENT.md 正文；
// tools = spec.tools ∩ 注册表，独立构建 frozen；不可见宿主历史；成本独立记账）。
import type { Runtime } from '../runtime/types.js';
import type { Config } from '../config/schema.js';
import type { LLMProvider } from '../llm/provider.js';
import { ToolRegistry } from '../tools/registry.js';
import { Session } from '../loop/session.js';
import { runTurn } from '../loop/turn.js';
import type { AgentSpec } from './scan.js';
import type { ForwardedEvent } from '../session/events.js';
import { deepMerge } from '../config/load.js';

export interface SubagentResult {
  ok: boolean;
  output: string;
  error?: { code: string; message: string };
}

export type SubagentRunner = (name: string, task: string) => Promise<SubagentResult>;

export interface SubagentHost {
  /** 宿主会话（惰性获取：runner 在 Session 创建后注入） */
  session: () => Session;
  runtime: Runtime;
  config: Config;
  provider: LLMProvider;
  registry: ToolRegistry;
  agents: AgentSpec[];
  /** 当前深度——宿主派的 = 1，子代理再派 = 2…（缺省 1）。深度闸 maxDepth 据此判定。 */
  depth?: number;
}

/** 派活的四道闸（缺省值见 config/schema.ts budget.subagent） */
const DEFAULT_CAPS = { maxDepth: 1, maxChildren: 8, maxCost: 2, maxRuntimeMs: 600_000 };

function subagentCaps(config: Config): typeof DEFAULT_CAPS {
  return config.budget?.subagent ?? DEFAULT_CAPS;
}

/** 子代理运行选项（多子代理并行执行用） */
export interface SubagentOptions {
  /** 宿主中止信号透传（用户停止 → 子代理同步中止） */
  signal?: AbortSignal;
  /** thinking 深度子代理（true 时按 provider 规则走 reasoner 模型） */
  thinking?: boolean;
}

export async function runSubagent(spec: AgentSpec, task: string, host: SubagentHost, opts: SubagentOptions = {}): Promise<SubagentResult> {
  const hostSession = host.session();
  const caps = subagentCaps(host.config);
  const depth = host.depth ?? 1;

  // 闸① 深度：子代理不能再派（默认 maxDepth=1）——显式判，不靠"子会话没注入 runner"的副作用。
  if (depth > caps.maxDepth) {
    return { ok: false, output: '', error: { code: 'SUBAGENT_DEPTH', message: `分身最深只能派到第 ${caps.maxDepth} 层。` } };
  }
  // 闸② 数量：一个回合里模型连调 run_agent 的总数上限（计数在宿主会话上，回合开始清零）
  const nth = (hostSession.subagentSpawns = (hostSession.subagentSpawns ?? 0) + 1);
  if (nth > caps.maxChildren) {
    return {
      ok: false, output: '',
      error: { code: 'SUBAGENT_LIMIT', message: `这一回合派出去的分身已经到上限（${caps.maxChildren} 个）——先把手上的结论收拢，需要更多就说一声。` },
    };
  }

  // 工具白名单：spec.tools ∩ 注册表
  const subRegistry = new ToolRegistry();
  for (const t of host.registry.all()) {
    if (spec.tools.includes(t.name)) subRegistry.register(t);
  }
  // 闸③ 成本：宿主预算 / 全局闸 / 分身自述，三者取最小（子代理只能更省，不能更贵）
  const costCandidates = [caps.maxCost, spec.maxCost, host.config.budget.maxCost]
    .filter((x): x is number => typeof x === 'number' && x > 0);
  const maxCost = costCandidates.length ? Math.min(...costCandidates) : null;
  const subConfig = deepMerge(host.config, {
    budget: {
      maxIterations: Math.min(spec.maxIterations, 20),
      ...(maxCost !== null ? { maxCost } : {}),
    },
  }) as Config;
  // 闸④ 时长：分身卡住不能拖着宿主。
  // **夹取**——分身自述的 maxRuntime 只能更小（和成本闸同样的道理）：AGENT.md 是可能从外面
  // 下载来的文件，写个 maxRuntime: 86400 就等于把全局保险丝拆了。
  // 另：用显式标记区分"超时"与"用户主动中止"——否则超时会一路报成"用户中止"，排查时全是误导。
  const runtimeMs = Math.max(0, Math.min(spec.maxRuntimeSec ? spec.maxRuntimeSec * 1000 : caps.maxRuntimeMs, caps.maxRuntimeMs));
  let timedOut = false;
  const budgetSignal = runtimeMs && runtimeMs > 0 ? AbortSignal.timeout(runtimeMs) : undefined;
  budgetSignal?.addEventListener('abort', () => { timedOut = true; });
  const signal = opts.signal && budgetSignal ? AbortSignal.any([opts.signal, budgetSignal]) : (opts.signal ?? budgetSignal);
  const sub = new Session({
    id: `${hostSession.id}-sub-${spec.name}-${Math.random().toString(36).slice(2, 8)}`,
    cwd: hostSession.cwd,
    config: subConfig,
    provider: host.provider,
    runtime: host.runtime,
    registry: subRegistry,
    // system = 宿主冻结前缀 + 角色正文（独立 frozen，宿主历史不可见）
    system: `${hostSession.frozen.system}\n\n【子任务角色：${spec.name}】\n${spec.body}`,
    modelRef: { role: spec.model, thinking: opts.thinking ?? false },
    policy: hostSession.policy,
    // 审批通道透传——子代理的 ask 判定同样推到宿主审批 UI（缺省拒绝）
    askApproval: hostSession.askApproval,
    memory: hostSession.memory,
    skills: hostSession.skills,
    costLedger: hostSession.costLedger, // 子代理的调用单独记账（'subagent' 桶）
    // 子事件转发宿主（事件协议唯一数据源，可观测 subagent 过程）。
    // **带上 `by = 分身名`**——宿主据此把子代理的话挡在她的气泡之外、把它的步骤挂在派活那行下面
    // （裸转发会让子代理吐的字被当成她的发言推进界面 = 串台）。
    emit: (ev) => hostSession.emit({ ...ev, by: spec.name } as ForwardedEvent),
  });
  // 深度闸决定要不要给子代理"再派"的能力（maxDepth=1 → 不注入，子代理就是干活的手，不是包工头）
  if (depth < caps.maxDepth) {
    sub.subagentRunner = buildSubagentRunner({ ...host, session: () => sub, depth: depth + 1 });
  }
  const result = await runTurn(sub, task, signal);
  // 成本独立记账
  hostSession.stats.subagentCostUsd += sub.stats.costUsd;
  if (result.kind === 'final') return { ok: true, output: result.text };
  if (result.kind === 'limit') {
    const why = result.reason === 'maxCost' ? `花到上限（¥${maxCost}）` : result.reason === 'maxContext' ? '上下文满了' : '达迭代上限';
    return { ok: false, output: result.text, error: { code: 'SUBAGENT_LIMIT', message: `分身 ${spec.name} ${why}` } };
  }
  // 中止但已有半截 → 半截照常交还（不整段丢弃）。超时中止也走这里（说清是超时）
  if (result.kind === 'aborted') {
    return {
      ok: false, output: result.text,
      error: {
        code: timedOut ? 'SUBAGENT_TIMEOUT' : 'SUBAGENT_ABORTED',
        message: timedOut ? `分身 ${spec.name} 超时（${Math.round((runtimeMs ?? 0) / 1000)} 秒）已中止，半截结论照常交回` : `subagent ${spec.name} 被中止`,
      },
    };
  }
  // 还没吐字就被超时掐断 → 走的是 error 分支（turn 里没有半截可保），这里同样要说清是超时
  if (timedOut) {
    return { ok: false, output: '', error: { code: 'SUBAGENT_TIMEOUT', message: `分身 ${spec.name} 超时（${Math.round((runtimeMs ?? 0) / 1000)} 秒）` } };
  }
  return { ok: false, output: '', error: { code: 'SUBAGENT_ERROR', message: result.message } };
}

export function buildSubagentRunner(host: SubagentHost): SubagentRunner {
  return async (name: string, task: string) => {
    const spec = host.agents.find((a) => a.name === name);
    if (!spec) {
      return {
        ok: false,
        output: '',
        error: { code: 'UNKNOWN_AGENT', message: `subagent ${name} 不存在。可用：${host.agents.map((a) => a.name).join('、') || '（无）'}` },
      };
    }
    return runSubagent(spec, task, host);
  };
}
