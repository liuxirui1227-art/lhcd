// eval 系统：用例 + mock 确定性执行 + checks 评估 + 报告。
// 用例格式：JSON（零依赖同构；TODO(spec)：接 yaml）。
// check 类型：output-contains / file-content / cost-under / memory-persisted / no-unverified-number。
import { createAgent } from '../factory.js';
import { runTurn } from '../loop/turn.js';
import { MockProvider } from '../llm/adapters/mock.js';
import { mockText, mockToolCalls } from '../llm/adapters/mock.js';
import type { ChatEvent, ChatMessage } from '../llm/provider.js';
import type { NetResponse } from '../runtime/types.js';
import type { AgentEvent } from '../session/events.js';

export interface MockTurn {
  text?: string;
  calls?: Array<{ id: string; name: string; args: unknown }>;
}

export interface EvalSession {
  name?: string;
  task: string;
  script: MockTurn[];
  /**
   * **seed 历史**——压缩/长上下文类用例的唯一入口：
   * 不给历史的话（每个 session 从零开始），"压缩"这件事在评测里根本触发不了。
   */
  history?: ChatMessage[];
}

export type EvalCheck =
  | { type: 'output-contains'; contains: string; notContains?: string }
  | { type: 'tool-result-contains'; contains: string; notContains?: string }
  | { type: 'approval-denied'; tool: string }
  | { type: 'file-content'; path: string; contains?: string; notContains?: string }
  | { type: 'cost-under'; limit: number }
  | { type: 'memory-persisted'; contains: string }
  | { type: 'no-unverified-number' }
  /** 事件流里出现过某类事件（如 mode.change）——模式切换这类"副作用"只能这样断言 */
  | { type: 'event-contains'; event: string; contains?: string }
  /**
   * **请求体里有没有这句话**——压缩重建这类事只能这么验：
   * 压缩之后发给模型的那份上下文里，必须真的带着"任务现状"（而不是只写在事件里好看）。
   */
  | { type: 'request-contains'; contains: string; notContains?: string }
  /**
   * **按字段断言事件**（子串匹配不够用——`recovered:true` 这种只能这么验）。
   * `path` 形如 `recovered` / `usage.costUsd`；只比第一件命中的事件。
   */
  | { type: 'event-field'; event: string; path: string; equals?: unknown; exists?: boolean }
  /** 记忆的**状态**（active/candidate/deprecated）——候选态那类用例只能这么验。 */
  | { type: 'memory-status'; contains: string; status: string };

export interface EvalCase {
  id: string;
  name: string;
  task?: string;
  setup?: { files?: Record<string, string>; skills?: Record<string, string>; agents?: Record<string, string> };
  sessions: EvalSession[];
  checks: EvalCheck[];
  /** 可选：mock 网络响应（web_search/web_fetch 用） */
  net?: Record<string, string>;
  /** 可选：本用例跑在哪个模式（缺省 'chat'）。子代理/长活类用例要写 'work'。 */
  mode?: 'chat' | 'work';
  /**
   * 可选：预算覆盖——压缩类用例要靠它把压缩点压到很小，
   * 否则 80 万 token 的默认压缩点永远碰不到。
   */
  budget?: { compactAtTokens?: number; maxContextTokens?: number };
  /**
   * 可选：审批注入——`grant` = 这个用例里"用户点了允许"，`deny` = 点了不允许。
   * 缺省不注入：内核把"没通道"当拒绝（老行为不变）。不注入的话，"用户点了允许"这条路永远测不到。
   */
  approval?: 'grant' | 'deny';
}

export interface EvalCaseResult {
  id: string;
  name: string;
  passed: boolean;
  failures: string[];
  outputs: string[];
  costUsd: number;
  events: AgentEvent[];
}

function toScript(script: MockTurn[]): ChatEvent[][] {
  return script.map((t) => (t.calls ? mockToolCalls(t.calls) : mockText(t.text ?? '')));
}

export async function runEvalCase(c: EvalCase): Promise<EvalCaseResult> {
  const failures: string[] = [];
  const outputs: string[] = [];
  let costUsd = 0;
  const events: AgentEvent[] = [];

  try {
    // 隔离工作目录（fixture 文件/技能/subagent 都在这里）
    const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const dir = mkdtempSync(path.join(os.tmpdir(), 'brain-eval-'));

    for (const [rel, content] of Object.entries(c.setup?.files ?? {})) {
      writeFileSync(path.join(dir, rel), content, { flag: 'w' });
    }
    for (const [name, md] of Object.entries(c.setup?.skills ?? {})) {
      mkdirSync(path.join(dir, '.agent', 'skills', name), { recursive: true });
      writeFileSync(path.join(dir, '.agent', 'skills', name, 'SKILL.md'), md);
    }
    for (const [name, md] of Object.entries(c.setup?.agents ?? {})) {
      mkdirSync(path.join(dir, '.agent', 'agents', name), { recursive: true });
      writeFileSync(path.join(dir, '.agent', 'agents', name, 'AGENT.md'), md);
    }

    // mock 网络（按 URL 前缀匹配）
    const netResponses = c.net ?? {};
    const netFetch = async (url: string): Promise<NetResponse> => {
      const key = Object.keys(netResponses).find((k) => url.includes(k));
      const body = key ? netResponses[key]! : '';
      return { status: 200, ok: true, text: async () => body, json: async () => ({}) };
    };

    // 每会话独立 provider 脚本（memory-persisted 跨会话用例共享同一记忆目录）
    let agent: Awaited<ReturnType<typeof createAgent>> | undefined;
    const providers: MockProvider[] = [];
    for (const s of c.sessions) {
      const provider = new MockProvider({ script: toScript(s.script) });
      providers.push(provider);
      agent = await createAgent({
        cwd: dir,
        home: dir,
        provider,
        cli: {
          ...(c.budget ? { budget: c.budget } : {}),
          sessions: { dir: `${dir}/sessions` },
          log: { dir: `${dir}/logs` },
          memory: { autoDir: `${dir}/memory`, semanticDir: `${dir}/memory/semantic`, episodesDir: `${dir}/memory/episodes` },
          skills: { dirs: [`${dir}/.agent/skills`] },
          agents: { dirs: [`${dir}/.agent/agents`] },
        },
      });
      agent.runtime = { ...agent.runtime, net: { fetch: netFetch } };
      const session = agent.createSession(c.approval
        ? { askApproval: async () => (c.approval === 'grant' ? 'allow' : 'deny') }
        : {});
      if (s.history?.length) session.history = structuredClone(s.history); // seed 历史（压缩用例的入口）
      session.mode = c.mode ?? 'chat'; // 模式影响工具闸（如 run_agent 只在工作模式可用）
      session.emit = (ev) => events.push(ev);
      const result = await runTurn(session, s.task);
      outputs.push(result.kind === 'final' ? result.text : `[${result.kind}] ${('text' in result ? result.text : '')}`);
      costUsd += session.stats.costUsd;
    }
    const mem = agent?.memory;

    // checks 评估
    for (const ch of c.checks) {
      switch (ch.type) {
        case 'output-contains': {
          const last = outputs[outputs.length - 1] ?? '';
          if (!last.includes(ch.contains)) failures.push(`output-contains 未命中: ${ch.contains}`);
          if (ch.notContains && last.includes(ch.notContains)) failures.push(`output-contains 不应包含: ${ch.notContains}`);
          break;
        }
        case 'request-contains': {
          // 所有 mock 请求体拼起来找（含压缩请求与压缩之后的正常请求）
          const all = providers.flatMap((p) => p.requests).map((r) => JSON.stringify(r)).join('\n');
          if (!all.includes(ch.contains)) failures.push(`request-contains 未命中: ${ch.contains}`);
          if (ch.notContains && all.includes(ch.notContains)) failures.push(`request-contains 不应包含: ${ch.notContains}`);
          break;
        }
        case 'event-contains': {
          const hit = events.filter((e) => e.type === ch.event);
          if (hit.length === 0) failures.push(`event-contains 未命中事件: ${ch.event}`);
          else if (ch.contains && !JSON.stringify(hit).includes(ch.contains)) failures.push(`event-contains 事件里没有: ${ch.contains}`);
          break;
        }
        case 'tool-result-contains': {
          // 失败的工具结果 output 可能为空、错误码在 error 里（如 MODE_NOT_WORK）——
          // 检查要同时看两处，否则"被拦下"这类断言永远看不到
          const hits = events
            .filter((e) => e.type === 'tool.result')
            .map((e) => {
              const r = e as { output?: string; error?: unknown };
              return `${r.output ?? ''}\n${r.error ? JSON.stringify(r.error) : ''}`;
            })
            .join('\n');
          if (!hits.includes(ch.contains)) failures.push(`tool-result-contains 未命中: ${ch.contains}`);
          if (ch.notContains && hits.includes(ch.notContains)) failures.push(`tool-result-contains 不应包含: ${ch.notContains}`);
          break;
        }
        case 'approval-denied': {
          const denied = events.some(
            (e) => e.type === 'approval.result' && (e as { tool: string; granted: boolean }).tool === ch.tool && !(e as { granted: boolean }).granted,
          );
          if (!denied) failures.push(`approval-denied 未触发: ${ch.tool}`);
          break;
        }
        case 'file-content': {
          try {
            const content = (await agent!.runtime.fs.read(ch.path, { limit: 1_000_000 })).content;
            if (ch.contains && !content.includes(ch.contains)) failures.push(`file-content 未命中: ${ch.path} / ${ch.contains}`);
            if (ch.notContains && content.includes(ch.notContains)) failures.push(`file-content 不应包含: ${ch.path} / ${ch.notContains}`);
          } catch (err) {
            failures.push(`file-content 读取失败: ${ch.path} (${(err as Error).message})`);
          }
          break;
        }
        case 'cost-under':
          if (costUsd > ch.limit) failures.push(`cost-under 超限: ${costUsd} > ${ch.limit}`);
          break;
        case 'event-field': {
          const hits = events.filter((e) => (e as { type: string }).type === ch.event);
          if (hits.length === 0) { failures.push(`event-field：没有 ${ch.event} 事件`); break; }
          const at = (obj: unknown, path: string): unknown =>
            path.split('.').reduce<unknown>((cur, k) => (cur && typeof cur === 'object' ? (cur as Record<string, unknown>)[k] : undefined), obj);
          const got = at(hits[0], ch.path);
          if (ch.exists === true && got === undefined) failures.push(`event-field：${ch.event}.${ch.path} 不存在`);
          if (ch.exists === false && got !== undefined) failures.push(`event-field：${ch.event}.${ch.path} 不该存在（实际 ${JSON.stringify(got)}）`);
          if ('equals' in ch && JSON.stringify(got) !== JSON.stringify(ch.equals)) {
            failures.push(`event-field：${ch.event}.${ch.path} = ${JSON.stringify(got)}，期望 ${JSON.stringify(ch.equals)}`);
          }
          break;
        }
        case 'memory-status': {
          const hits = (await mem!.search(ch.contains, 20, { includeDeprecated: true }));
          const hit = hits.find((h) => h.entry.content.includes(ch.contains));
          if (!hit) { failures.push(`memory-status：没找到含「${ch.contains}」的记忆`); break; }
          const st = (hit.entry as { status?: string }).status ?? 'active';
          if (st !== ch.status) failures.push(`memory-status：状态是 ${st}，期望 ${ch.status}`);
          break;
        }
        case 'memory-persisted': {
          const recall = (await mem!.search(ch.contains)).map((h) => h.entry.content).join('\n');
          if (!recall.includes(ch.contains)) failures.push(`memory-persisted 未召回: ${ch.contains}`);
          break;
        }
        case 'no-unverified-number': {
          const last = outputs[outputs.length - 1] ?? '';
          if (!last.includes('【未核实】')) failures.push('no-unverified-number：未核实数字未被标注');
          break;
        }
      }
    }
  } catch (err) {
    failures.push(`执行异常: ${(err as Error).message}`);
  }

  return { id: c.id, name: c.name, passed: failures.length === 0, failures, outputs, costUsd, events };
}

export interface EvalReport {
  total: number;
  passed: number;
  failed: number;
  cases: EvalCaseResult[];
}

export async function runEval(cases: EvalCase[]): Promise<EvalReport> {
  const results: EvalCaseResult[] = [];
  for (const c of cases) results.push(await runEvalCase(c));
  const passed = results.filter((r) => r.passed).length;
  return { total: cases.length, passed, failed: cases.length - passed, cases: results };
}
