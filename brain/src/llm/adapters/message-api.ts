// message-api 适配器：标准消息数组协议（OpenAI 兼容，默认）。
// 默认配置 = DeepSeek：
//   baseUrl        https://api.deepseek.com/v1（也兼容无 /v1 后缀；runtime/.env 已有 DEEPSEEK_API_KEY）
//   chat 流式     stream=true + stream_options.include_usage=true（DeepSeek 需显式开启 usage 回传）
//   usage 字段    prompt_cache_hit_tokens / prompt_cache_miss_tokens / prompt_tokens /
//                 completion_tokens / completion_tokens_details.reasoning_tokens
//   思考字段      deepseek-reasoner 回传 reasoning_content（reasoningField 配置注入）
//   计价          CNY 元/M；峰谷分时（北京时间 9:00–12:00 与 14:00–18:00 输入未命中 ×2）——见 ../usage.ts
//   costUsd 字段按 spec 契约命名，数值为 CNY（本项目成本曲线以元计，见 eval/pricing-notes.md）。

import type { ChatEvent, ChatMessage, ChatRequest, LLMProvider, ProviderCaps, ToolCall, ToolDef, Usage } from '../provider.js';
import type { NetFetch } from '../../runtime/types.js';
import type { PricingCfg } from '../../config/schema.js';
import { makeUsage, zeroUsage } from '../usage.js';
// 思考档位：内核按"这一轮在干什么"自动选（闲聊 low / 轻活 low / 深任务与工作模式 max）
import { effortFor } from '../effort.js';
import { decodeBody } from '../../runtime/stream.js';

export interface MessageApiOptions {
  name?: string;
  baseUrl: string;
  apiKeyEnv: string;
  reasoningField?: string | null;
  caps: ProviderCaps;
  pricing: PricingCfg;
  /** reasoner（Pro 档）独立定价；缺省沿用 pricing（记账会低估 Pro 消耗） */
  pricingReasoner?: PricingCfg;
  /** http 注入（缺省 globalThis.fetch）：测试用 stub 不触网 */
  http?: NetFetch;
  /** 时钟注入（峰谷计价测试用） */
  now?: () => Date;
  apiKey?: () => string;
  temperature?: number;
  /** 总时长上限 ms（默认 900s：单次回复上限已到 64k，
   *  按真实生成速度 300s 只够 1~2 万 token，不改超时的话抬上限是虚设的）；首 token 15s */
  totalTimeoutMs?: number;
  firstTokenTimeoutMs?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 单次输出上限：取"配置值"与"供应商物理上限"的较小者（缺省 4096 保底） */
export function clampMaxTokens(want: number | undefined, cap: number | undefined): number {
  const w = Number.isFinite(want) && (want as number) > 0 ? (want as number) : 4096;
  return cap !== undefined && Number.isFinite(cap) && cap > 0 ? Math.min(w, cap) : w;
}

export class MessageApiProvider implements LLMProvider {
  readonly name: string;
  readonly caps: ProviderCaps;
  private readonly baseUrl: string;
  private readonly apiKeyEnv: string;
  private readonly reasoningField: string | null;
  private readonly pricing: PricingCfg;
  private readonly pricingReasoner?: PricingCfg;
  private readonly http: NetFetch;
  private readonly now: () => Date;
  private readonly apiKey: () => string;
  private readonly temperature: number;
  private readonly totalTimeoutMs: number;
  private readonly firstTokenTimeoutMs: number;
  /** 供应商的单次输出物理上限（caps.maxOutputTokens）；缺省不限 */
  private readonly maxOutputTokens?: number;
  /** 该供应商是否吃 reasoning_effort（caps 申报；缺省不发，BYOK 严格端点安全） */
  private readonly thinkingEffort: boolean;

  constructor(opts: MessageApiOptions) {
    this.name = opts.name ?? 'message-api';
    this.caps = opts.caps;
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.apiKeyEnv = opts.apiKeyEnv;
    this.reasoningField = opts.reasoningField ?? null;
    this.pricing = opts.pricing;
    this.pricingReasoner = opts.pricingReasoner;
    /* ⚠ 默认这条路原来是 `fetch(...) as NetResponse`——返回的是**原生 Response**，
       它没有 `streamText`，于是适配器退回整包 `text()`（注入 http 的流式、默认这条整包）。
       现在默认这条路也把它包成带 `streamText` 的 NetResponse。 */
    this.http = opts.http ?? (async (url: string, init?: Record<string, unknown>) => {
      const res = await fetch(url, init as RequestInit);
      return {
        status: res.status,
        ok: res.ok,
        text: () => res.text(),
        json: () => res.json() as Promise<unknown>,
        ...(res.body ? { streamText: () => decodeBody(res.body as ReadableStream<Uint8Array>) } : {}),
      } as unknown as Awaited<ReturnType<NetFetch>>;
    });
    this.now = opts.now ?? (() => new Date());
    this.apiKey = opts.apiKey ?? (() => process.env[this.apiKeyEnv] ?? '');
    this.temperature = opts.temperature ?? 0.7;
    // 900s（原 300s）：上限抬到 64k 后，超时是更早的墙——实测最长交付 14,911 token
    // 就已贴着 300s，故同步抬。首 token 仍是 15s（管的是"卡住不动"，与"生成得久"分开）。
    this.totalTimeoutMs = opts.totalTimeoutMs ?? 900_000;
    this.firstTokenTimeoutMs = opts.firstTokenTimeoutMs ?? 15_000;
    this.thinkingEffort = opts.caps.thinkingEffort === true;
    this.maxOutputTokens = opts.caps.maxOutputTokens;
  }

  /** 模型 ID 解析：thinking=true 且配置 reasoner 时用 reasoner 条目（TODO(spec)：由 core/router Tier3 路由） */
  resolveModelId(models: Record<string, { id: string; thinking: boolean } | undefined>, role: string, thinking: boolean): string {
    if (thinking && models.reasoner) return models.reasoner.id;
    const m = models[role];
    return m ? m.id : 'deepseek-chat';
  }

  /** 同上，但返回整个条目——body 还要用它的 effort（思考档位） */
  private resolveModelEntry(
    models: Record<string, { id: string; thinking: boolean; effort?: string } | undefined>,
    role: string,
    thinking: boolean,
  ): { id: string; thinking: boolean; effort?: string } | undefined {
    if (thinking && models.reasoner) return models.reasoner;
    return models[role];
  }

  async *chat(req: ChatRequest): AsyncIterable<ChatEvent> {
    const key = this.apiKey();
    if (!key) throw new Error(`缺少 API Key（环境变量 ${this.apiKeyEnv}）`);
    // 由工厂注入的模型映射（见 createMessageApiProvider）
    const entry = this.resolveModelEntry(
      this.models as Record<string, { id: string; thinking: boolean; effort?: string } | undefined>,
      req.model.role,
      req.model.thinking,
    );
    const modelId = entry?.id ?? 'deepseek-chat';
    const effort = this.thinkingEffort ? entry?.effort ?? effortFor(req.model) : undefined;
    const body: Record<string, unknown> = {
      model: modelId,
      messages: [
        { role: 'system', content: req.system },
        // 消息已由调用方 sanitize（runTurn 统一净化）；此处不再二次处理
        ...req.messages,
      ],
      stream: true,
      stream_options: { include_usage: true },
      // 按供应商物理上限夹取（全局 64k 对 DeepSeek 合法，对 qwen 是非法的 400）
      max_tokens: clampMaxTokens(req.maxOutputTokens, this.maxOutputTokens),
      temperature: req.temperature ?? this.temperature,
      // 思考档位（DeepSeek V4.1：low/high/max）。优先级：模型条目写死的 effort（开发侧开关）>
      // 内核自动选档（effortFor：闲聊 low / 轻活 low / 深任务与工作模式 max）。
      // 供应商没申报 caps.thinkingEffort 就一个字段都不发（严格校验的 BYOK 端点收到未知字段会 422）。
      ...(effort ? { reasoning_effort: effort } : {}),
    };
    if (req.tools.length > 0) {
      body.tools = req.tools;
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`,
    };

    // Pro 档独立定价：reasoner 请求（thinking + 配置了 reasoner 条目）按 pricingReasoner 记账
    const isReasoner = this.models?.reasoner?.id === modelId;
    const pricing = isReasoner && this.pricingReasoner ? this.pricingReasoner : this.pricing;
    const events = this.streamEvents(body, headers, pricing, req.signal);
    for await (const ev of events) yield ev;
  }

  /** SSE 流解析：text.delta / reasoning.delta / tool_calls / done(usage) */
  private async *streamEvents(
    body: Record<string, unknown>,
    headers: Record<string, string>,
    pricing: PricingCfg,
    signal?: AbortSignal,
  ): AsyncGenerator<ChatEvent> {
    const attempts = 3;
    const backoffMs = [500, 1000, 2000];
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (signal?.aborted) throw new Error('请求已中止');
      const deadline = Date.now() + this.totalTimeoutMs;
      let res: Awaited<ReturnType<NetFetch>>;
      try {
        res = await this.http(`${this.baseUrl}/chat/completions`, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: signal as AbortSignal | undefined,
        });
      } catch (err) {
        // 网络错误：指数退避重试（4xx 不重试——无 status 的网络错误视为可重试）
        if (attempt < attempts - 1) {
          await sleep(backoffMs[attempt]! + Math.floor(Math.random() * 200));
          continue;
        }
        throw new Error(`网络错误（重试 ${attempts} 次后放弃）: ${(err as Error).message}`);
      }
      // 4xx 不重试（429 限流除外，退避重试）；5xx 退避重试
      if (!res.ok) {
        if ((res.status >= 500 || res.status === 429) && attempt < attempts - 1) {
          await sleep(backoffMs[attempt]! + Math.floor(Math.random() * 200));
          continue;
        }
        const text = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
      }
      yield* this.parseSse(res, deadline, pricing, signal);
      return;
    }
  }

  /** SSE 行来源：有 `streamText` 就增量吐行，没有就整包 split（老 mock / 老端点零影响）。
   *  跨块的半行先攒着——SSE 的一行可能被 TCP 切成两段，直接 parse 会丢掉那一块正文。 */
  private async *sseLines(res: { text(): Promise<string>; streamText?(): AsyncIterable<string> }): AsyncIterable<string> {
    const stream = res.streamText?.();
    if (!stream) {
      const raw = await res.text();
      for (const line of raw.split('\n')) yield line;
      return;
    }
    let buf = '';
    for await (const chunk of stream) {
      buf += chunk;
      let idx = buf.indexOf('\n');
      while (idx >= 0) {
        yield buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        idx = buf.indexOf('\n');
      }
    }
    if (buf) yield buf;   // 最后一行没有换行结尾
  }

  private async *parseSse(
    res: Awaited<ReturnType<NetFetch>>,
    deadline: number,
    pricing: PricingCfg,
    signal?: AbortSignal,
  ): AsyncGenerator<ChatEvent> {
    const start = Date.now();
    const acc: {
      content: string;
      reasoning: string;
      toolCalls: Array<{ id: string; name: string; argsRaw: string }>;
    } = { content: '', reasoning: '', toolCalls: [] };
    let usage: Usage = zeroUsage();
    let sawData = false;

    // 真流式：**边收边解**。以前这里是 `const raw = await res.text()` —— 整包收完才开始解析，于是：
    //   · 长回复期间界面一个字都不出（靠"正在思考 · 已 N 秒"那行兜着）；
    //   · `firstTokenTimeoutMs` 形同虚设（第一行总是"已经到齐"之后才被看到）。
    // 现在按 SSE 行增量解析；端点/runtime 不支持流（没有 `streamText`）时**原样退回整包**。
    for await (const line of this.sseLines(res)) {
      if (signal?.aborted) throw new Error('请求已中止');
      if (!sawData && Date.now() - start > this.firstTokenTimeoutMs) {
        throw new Error(`首 token 超时（${this.firstTokenTimeoutMs}ms）`);
      }
      if (Date.now() > deadline) throw new Error(`总时长超限（${this.totalTimeoutMs}ms）`);
      const t = line.trim();
      if (!t.startsWith('data:')) continue;
      const payload = t.slice(5).trim();
      if (payload === '[DONE]') continue;
      sawData = true;
      let chunk: Record<string, unknown>;
      try {
        chunk = JSON.parse(payload) as Record<string, unknown>;
      } catch {
        continue;
      }
      const choices = (chunk.choices as Array<Record<string, unknown>> | undefined) ?? [];
      const choice = choices[0] as Record<string, unknown> | undefined;
      if (choice) {
        const delta = choice.delta as Record<string, unknown> | undefined;
        if (delta) {
          if (typeof delta.content === 'string' && delta.content.length > 0) {
            acc.content += delta.content;
            yield { type: 'text.delta', text: delta.content };
          }
          const rf = this.reasoningField;
          if (rf && typeof delta[rf] === 'string' && (delta[rf] as string).length > 0) {
            acc.reasoning += delta[rf] as string;
            yield { type: 'reasoning.delta', text: delta[rf] as string };
          }
          const tcs = delta.tool_calls as Array<Record<string, unknown>> | undefined;
          if (tcs) {
            for (const tc of tcs) {
              const idx = Number(tc.index ?? 0);
              const fn = (tc.function ?? {}) as Record<string, unknown>;
              while (acc.toolCalls.length <= idx) {
                acc.toolCalls.push({ id: '', name: '', argsRaw: '' });
              }
              const cur = acc.toolCalls[idx]!;
              if (typeof tc.id === 'string' && tc.id) cur.id = tc.id;
              if (typeof fn.name === 'string' && fn.name) cur.name += fn.name;
              if (typeof fn.arguments === 'string' && fn.arguments) cur.argsRaw += fn.arguments;
            }
          }
        }
      }
      const u = chunk.usage as Record<string, unknown> | undefined;
      if (u) {
        const details = (u.completion_tokens_details ?? {}) as Record<string, unknown>;
        usage = makeUsage(
          {
            hitTokens: num(u.prompt_cache_hit_tokens),
            missTokens: num(u.prompt_cache_miss_tokens) || num(u.prompt_tokens),
            outTokens: num(u.completion_tokens),
            reasoningTokens: num(details.reasoning_tokens),
          },
          pricing,
          this.now(),
        );
      }
    }
    if (!sawData) throw new Error('空响应（无 SSE data 行）');

    // 工具调用片段 → 解析 args JSON 后统一发射 tool_calls 事件（模型返回顺序固定）
    const calls = acc.toolCalls.map((c) => {
      let args: unknown = c.argsRaw;
      if (c.argsRaw) {
        try {
          args = JSON.parse(c.argsRaw);
        } catch {
          args = { _raw: c.argsRaw };
        }
      }
      return { id: c.id, name: c.name, args } as ToolCall;
    });
    if (calls.length > 0) yield { type: 'tool_calls', calls };
    yield { type: 'done', usage };
  }

  /**
   * 净化（wire 格式）：相邻同角色合并；tool 消息用 tool_call_id（蛇形）；
   * tool_calls 转 OpenAI 格式 {id,type,function:{name,arguments}}（arguments 为 JSON 字符串）；
   * reasoning 用服务商思考字段名（reasoningField）；无 tool_calls 的 assistant 剥离 reasoning。
   * 返回元素为 wire 消息对象（类型上仍按 ChatMessage 透传，供 chat() 直接序列化）。
   */
  sanitizeForRequest(msgs: ChatMessage[]): ChatMessage[] {
    const out: Array<Record<string, unknown>> = [];
    for (const m of msgs) {
      const copy: Record<string, unknown> = { role: m.role, content: m.content };
      if (m.name !== undefined) copy.name = m.name;
      if (m.toolCallId !== undefined) copy.tool_call_id = m.toolCallId;
      if (m.role === 'assistant') {
        if (m.toolCalls && m.toolCalls.length > 0) {
          copy.tool_calls = m.toolCalls
            .filter((tc) => tc.id) // 防御：空 id 的伪调用不发（DeepSeek 并发补位场景）
            .map((tc) => ({
              id: tc.id,
              type: 'function',
              function: { name: tc.name, arguments: JSON.stringify(tc.args ?? {}) },
            }));
          // 有 tool_calls 时保留思考（若服务商配置了思考回放字段）
          if (this.reasoningField && m.reasoning !== undefined) copy[this.reasoningField] = m.reasoning;
        }
        // 无 tool_calls → 剥离 reasoning（不再需要回放）
      } else if (this.reasoningField && m.reasoning !== undefined) {
        copy[this.reasoningField] = m.reasoning;
      }
      // 相邻同角色合并（仅纯文本可拼接；多模态 content 数组不合并，独立入队——image_url 拼接会破坏 wire 格式）
      const last = out[out.length - 1];
      if (
        last && last.role === copy.role && last.role !== 'tool'
        && !copy.tool_calls && !last.tool_calls
        && typeof last.content === 'string' && typeof copy.content === 'string'
      ) {
        last.content = `${last.content}\n${copy.content}`;
      } else {
        out.push(copy);
      }
    }
    return out as unknown as ChatMessage[];
  }

  injectCacheMarkers(_system: string, _tools: ToolDef[]): void {
    // message-api 自动缓存：无显式标记（DeepSeek 上下文硬盘缓存自动生效，前缀 ≥64 token 命中）
  }

  /** 模型映射由工厂注入（resolveModelId 用；effort = DeepSeek V4.1 思考档位 low/high/max，缺省不发） */
  private models: Record<string, { id: string; thinking: boolean; effort?: string } | undefined> = {};
  setModels(models: Record<string, { id: string; thinking: boolean; effort?: string } | undefined>): this {
    this.models = models;
    return this;
  }
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/** 从 provider 配置构造 message-api 适配器（含 DeepSeek 峰谷价模型映射；支持直连 apiKey） */
export function createMessageApiProvider(
  name: string,
  cfg: {
    baseUrl?: string;
    apiKeyEnv: string;
    apiKey?: string;
    reasoningField?: string | null;
    caps: ProviderCaps;
    pricing: PricingCfg;
    pricingReasoner?: PricingCfg;
    models: Record<string, { id: string; thinking: boolean; effort?: string } | undefined>;
    temperature?: number;
  },
  extra?: { http?: NetFetch; now?: () => Date; apiKey?: () => string },
): MessageApiProvider {
  const p = new MessageApiProvider({
    name,
    baseUrl: cfg.baseUrl ?? 'https://api.deepseek.com/v1',
    apiKeyEnv: cfg.apiKeyEnv,
    reasoningField: cfg.reasoningField,
    caps: cfg.caps,
    pricing: cfg.pricing,
    pricingReasoner: cfg.pricingReasoner,
    temperature: cfg.temperature,
    // 直接注入的 key 优先（自定义供应商），其次调用方 extra，最后环境变量
    ...(cfg.apiKey ? { apiKey: () => cfg.apiKey! } : {}),
    ...(extra ?? {}),
  });
  return p.setModels(cfg.models);
}
