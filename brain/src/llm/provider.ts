// 契约二：Provider 抽象层类型唯一出处。
// 除 src/llm/adapters/ 外，任何代码不得出现模型/API 专属逻辑。

export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface ToolCall {
  id: string;
  name: string;
  args: unknown;
}

/** 多模态内容块（OpenAI 兼容 wire 格式；image_url 支持 data URL / http(s) URL） */
export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

export interface ChatMessage {
  role: Role;
  /** 纯文本（历史/工具消息）或多模态内容数组（vision 模型 user 消息） */
  content: string | ContentPart[];
  reasoning?: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  name?: string;
}

/** 消息文本提取（兼容多模态 content 数组：取 text 块拼接；纯文本原样返回） */
export function messageText(m: ChatMessage): string {
  return typeof m.content === 'string'
    ? m.content
    : m.content
        .filter((p): p is Extract<ContentPart, { type: 'text' }> => p.type === 'text')
        .map((p) => p.text)
        .join(' ');
}

export interface ToolDef {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: object;
  };
}

export type ChatEvent =
  | { type: 'text.delta'; text: string }
  | { type: 'reasoning.delta'; text: string }
  | { type: 'tool_calls'; calls: ToolCall[] }
  | { type: 'done'; usage: Usage };

export interface Usage {
  /** 输入 token 总数 = hit + miss */
  inTokens: number;
  hitTokens: number;
  missTokens: number;
  outTokens: number;
  reasoningTokens: number;
  /** 显式缓存写 token（Anthropic 类供应商有；DeepSeek 自动缓存无此项，缺省 0） */
  cacheWriteTokens?: number;
  /** 其中按 1 小时 TTL 写的部分（计费按 2×input，见 cost/ledger.ts） */
  cacheWrite1hTokens?: number;
  /** 成本。DeepSeek 官方以 CNY 计价：本项目 pricing 填元/M，本字段数值即 CNY（见 adapter 注释） */
  costUsd: number;
}

export type ProviderCaps = {
  cache: { kind: 'explicit' } | { kind: 'automatic'; minPrefixTokens: number } | { kind: 'none' };
  reasoning: 'none' | 'thinking-blocks' | 'content-field';
  parallelToolCalls: boolean;
  /** 默认 'client' */
  compaction: 'server' | 'client';
  maxContextTokens: number;
  /**
   * 该供应商吃 `reasoning_effort`（思考档位 low/high/max）。DeepSeek V4.1 吃；缺省 false——
   * 严格校验的 OpenAI 兼容端点收到未知字段可能 422，所以**不给没申报的供应商发**（BYOK 安全）。
   */
  thinkingEffort?: boolean;
  /** 单次输出物理上限（max_tokens 会被夹到这里）；缺省不限。
   *  实测教训：全局上限抬到 64k 后，qwen 端点直接 400（它的范围是 [1, 32768]）。 */
  maxOutputTokens?: number;
  /** 可选：语义记忆检索用；缺失则记忆降级为关键词 + BM25 */
  embedding?: { model: string; dims: number };
};

export type ModelRole = 'main' | 'fast' | 'compact' | 'subagent';

export interface ModelRef {
  role: ModelRole;
  thinking: boolean;
}

export interface ChatRequest {
  system: string;
  messages: ChatMessage[];
  tools: ToolDef[];
  model: ModelRef;
  maxOutputTokens?: number;
  signal?: AbortSignal;
  /** 采样温度（可选；缺省用 provider 配置默认值；compact 角色建议 0.3） */
  temperature?: number;
}

export interface LLMProvider {
  readonly name: string;
  readonly caps: ProviderCaps;
  chat(req: ChatRequest): AsyncIterable<ChatEvent>;
  /** 协议净化：发往服务商前的消息规范化（每适配器一组单测） */
  sanitizeForRequest(msgs: ChatMessage[]): ChatMessage[];
  /** 缓存标记（message-api 自动缓存下为 no-op） */
  injectCacheMarkers(system: string, tools: ToolDef[]): void;
  /** 可选：语义记忆向量化；未实现则记忆检索降级 */
  embed?(texts: string[]): Promise<number[][]>;
}
