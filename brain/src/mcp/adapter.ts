// MCP 适配器：MCP 工具映射进注册表，名称加 `mcp.` 前缀。
// 工具列表会话启动时快照一次，此后不刷新。权限类 v0 默认 net（外部服务调用），
// TODO(spec)：按工具语义细分权限类/能力要求。
import type { Runtime } from '../runtime/types.js';
import type { Config } from '../config/schema.js';
import type { ToolRegistry } from '../tools/registry.js';
import { markUntrusted } from '../tools/untrusted.js';
import { McpClient, type McpTool } from './client.js';

export interface McpRegistryResult {
  connected: string[];
  failed: Array<{ name: string; reason: string }>;
  toolCount: number;
}

/** 启动时调用一次：连接各 MCP server → tools/list 快照 → 注册 mcp.* 工具 */
export async function registerMcpTools(
  registry: ToolRegistry,
  config: Config,
  runtime: Runtime,
  http?: Runtime['net']['fetch'],
): Promise<McpRegistryResult> {
  const out: McpRegistryResult = { connected: [], failed: [], toolCount: 0 };
  const servers = config.mcp?.servers ?? [];
  for (const s of servers) {
    if (s.enabled === false) continue;
    const client = new McpClient(s.name, s.url, http ?? runtime.net.fetch);
    try {
      await client.initialize();
      const tools = await client.listTools();
      for (const t of tools) {
        if (!t.name) continue;
        const fullName = `mcp.${s.name}.${t.name}`;
        registry.register({
          name: fullName,
          permissionClass: 'net',
          capabilityRequirement: 'net',
          schema: {
            type: 'function',
            function: {
              name: fullName,
              description: `[MCP:${s.name}] ${t.description ?? t.name}`,
              parameters: normalizeSchema(t.inputSchema),
            },
          },
          executor: async (args) => {
            const r = await client.callTool(t.name, args);
            /* MCP 是**别人的服务**，它返回的字是外部内容 —— 与网页/文档同理，
               必须打同一行身份说明（web_fetch/web_search/office 都打了，MCP 别漏）。
               错误分支也标：错误正文同样可能夹带"请执行…"这种话。 */
            return r.isError
              ? { ok: false, output: '', error: { code: 'MCP_ERROR', message: markUntrusted(r.text, `外部服务 ${s.name}`) } }
              : { ok: true, output: markUntrusted(r.text, `外部服务 ${s.name}`) };
          },
        });
        out.toolCount++;
      }
      out.connected.push(s.name);
    } catch (err) {
      out.failed.push({ name: s.name, reason: (err as Error).message });
    }
  }
  return out;
}

/** MCP inputSchema → 工具参数 schema（零依赖降级：非 object 形态按 {} 放行） */
function normalizeSchema(input: McpTool['inputSchema']): object {
  if (!input || input.type !== 'object') return { type: 'object', properties: {} };
  return {
    type: 'object',
    properties: input.properties ?? {},
    ...(Array.isArray(input.required) && input.required.length > 0 ? { required: input.required } : {}),
  };
}
