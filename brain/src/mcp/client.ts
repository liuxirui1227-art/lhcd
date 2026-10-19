// MCP 客户端（可选）：JSON-RPC 2.0 over HTTP（Streamable HTTP 形态）。
// v0 范围：initialize / tools/list / tools/call 三个方法；启动时快照一次，此后不刷新。
// TODO(spec)：stdio 传输与 SSE 流式响应（需 Runtime 增 spawn-persistent，留待需要时扩展）。
import type { NetFetch } from '../runtime/types.js';

export interface McpServerConfig {
  name: string;
  url: string;
  enabled?: boolean;
}

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: {
    type?: string;
    properties?: Record<string, unknown>;
    required?: string[];
  };
}

interface JsonRpcResponse {
  result?: unknown;
  error?: { code: number; message: string };
}

export class McpClient {
  private nextId = 1;
  constructor(
    private readonly serverName: string,
    private readonly url: string,
    private readonly http: NetFetch,
  ) {}

  async initialize(): Promise<void> {
    const res = await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'lhcd-brain', version: '0.2' },
    });
    if (res.error) throw new Error(`MCP initialize 失败: ${res.error.message}`);
    // 握手后发送 initialized 通知（无 id，服务端不回复）
    await this.request('notifications/initialized', {}, false);
  }

  async listTools(): Promise<McpTool[]> {
    const res = await this.request('tools/list', {});
    if (res.error) throw new Error(`MCP tools/list 失败: ${res.error.message}`);
    const tools = (res.result as { tools?: McpTool[] } | undefined)?.tools;
    return tools ?? [];
  }

  async callTool(name: string, args: unknown): Promise<{ text: string; isError: boolean }> {
    const res = await this.request('tools/call', { name, arguments: args });
    if (res.error) return { text: `MCP 调用失败: ${res.error.message}`, isError: true };
    const r = res.result as { content?: Array<{ type: string; text?: string }>; isError?: boolean } | undefined;
    const text = (r?.content ?? [])
      .filter((c) => c.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text!)
      .join('\n');
    return { text, isError: r?.isError ?? false };
  }

  get name(): string {
    return this.serverName;
  }

  private async request(method: string, params: unknown, expectReply = true): Promise<JsonRpcResponse> {
    const body: Record<string, unknown> = { jsonrpc: '2.0', method, params };
    if (expectReply) body.id = this.nextId++;
    const res = await this.http(this.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`MCP HTTP ${res.status}`);
    const text = await res.text();
    if (!expectReply) return {}; // 通知无响应
    // SSE 包裹（data: {...}）与非流式 JSON 均兼容
    const dataLine = text.split('\n').find((l) => l.startsWith('data:'));
    const payload = dataLine ? dataLine.slice(5).trim() : text;
    try {
      return JSON.parse(payload) as JsonRpcResponse;
    } catch {
      return { error: { code: -32700, message: `MCP 响应解析失败: ${text.slice(0, 200)}` } };
    }
  }
}
