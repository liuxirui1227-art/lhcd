// MCP 客户端——启动快照工具列表进注册表（mcp. 前缀）/ 调用往返 / 失败降级 / 禁用跳过。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createNodeRuntime } from '../runtime/node.js';
import { loadConfig } from '../config/load.js';
import { ToolRegistry, type ExecCtx } from '../tools/registry.js';
import { registerMcpTools } from './adapter.js';
import type { NetResponse } from '../runtime/types.js';

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'brain-mcp-'));
}

function jsonRes(obj: unknown): NetResponse {
  return { status: 200, ok: true, text: async () => JSON.stringify(obj), json: async () => obj };
}

/** mock MCP server：JSON-RPC over HTTP（记录请求） */
function mockServer(over: { listResult?: unknown; callResult?: unknown; status?: number } = {}) {
  const calls: Array<Record<string, unknown>> = [];
  const f = async (_url: string, init?: Record<string, unknown>) => {
    calls.push(init ?? {});
    if (over.status) {
      return { status: over.status, ok: false, text: async () => 'boom', json: async () => ({}) };
    }
    const body = JSON.parse(String(init?.body)) as { id?: number; method: string; params: Record<string, unknown> };
    let result: unknown = {};
    if (body.method === 'initialize') {
      result = { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'demo', version: '1.0' } };
    } else if (body.method === 'tools/list') {
      result = over.listResult ?? {
        tools: [
          { name: 'echo', description: '回显文本', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
          { name: 'add', description: '加法', inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] } },
        ],
      };
    } else if (body.method === 'tools/call') {
      result = over.callResult ?? { content: [{ type: 'text', text: 'Echo: hello' }], isError: false };
    }
    return jsonRes({ jsonrpc: '2.0', id: body.id ?? null, result });
  };
  return { f, calls };
}

function setupCtx(dir: string) {
  const rt = createNodeRuntime({
    cwd: dir,
    storage: { sessionsDir: `${dir}/s`, logsDir: `${dir}/l`, memoryDir: `${dir}/m`, configDir: dir },
  });
  const ctx: ExecCtx = {
    sessionId: 's1',
    cwd: dir,
    runtime: rt,
    config: loadConfig({ cwd: dir, home: dir }),
    emit: () => undefined,
  };
  return ctx;
}

test('快照注册：mcp.demo.echo / mcp.demo.add 进注册表，schema 保留 required', async () => {
  const dir = tmpdir();
  const ctx = setupCtx(dir);
  const registry = new ToolRegistry();
  const { f } = mockServer();
  const config = loadConfig({ cwd: dir, home: dir, cli: { mcp: { servers: [{ name: 'demo', url: 'http://mcp.test' }] } } });

  const r = await registerMcpTools(registry, config, ctx.runtime, f);
  assert.deepEqual(r.connected, ['demo']);
  assert.equal(r.toolCount, 2);
  assert.deepEqual(r.failed, []);

  const echo = registry.get('mcp.demo.echo');
  assert.ok(echo);
  assert.match(echo!.schema.function.description, /MCP:demo/);
  const params = echo!.schema.function.parameters as { required?: string[] };
  assert.deepEqual(params.required, ['text']);

  // 调用往返
  const call = await echo!.executor({ text: 'hello' }, ctx);
  assert.equal(call.ok, true);
  /* MCP 是**别人的服务** → 输出必须带"外部内容·只作资料"那行身份说明
     （裸文本进上下文 = 与用户的话零区分度）。 */
  assert.match(call.output, /外部内容·只作资料/);
  assert.match(call.output, /外部服务 demo/);
  assert.match(call.output, /Echo: hello/);
});

test('tools/call 返回 isError → MCP_ERROR', async () => {
  const dir = tmpdir();
  const ctx = setupCtx(dir);
  const registry = new ToolRegistry();
  const { f } = mockServer({ callResult: { content: [{ type: 'text', text: '参数错' }], isError: true } });
  const config = loadConfig({ cwd: dir, home: dir, cli: { mcp: { servers: [{ name: 'demo', url: 'http://mcp.test' }] } } });
  await registerMcpTools(registry, config, ctx.runtime, f);
  const r = await registry.get('mcp.demo.echo')!.executor({ text: 'x' }, ctx);
  assert.equal(r.ok, false);
  assert.equal(r.error?.code, 'MCP_ERROR');
  assert.match(r.error!.message, /参数错/);
});

test('服务器不可用：失败诊断，不注册任何工具，不阻断', async () => {
  const dir = tmpdir();
  const ctx = setupCtx(dir);
  const registry = new ToolRegistry();
  const { f } = mockServer({ status: 500 });
  const config = loadConfig({ cwd: dir, home: dir, cli: { mcp: { servers: [{ name: 'bad', url: 'http://mcp.test' }] } } });
  const r = await registerMcpTools(registry, config, ctx.runtime, f);
  assert.equal(r.connected.length, 0);
  assert.equal(r.failed[0]!.name, 'bad');
  assert.match(r.failed[0]!.reason, /500/);
  assert.equal(registry.all().length, 0);
});

test('enabled=false 的服务器跳过', async () => {
  const dir = tmpdir();
  const ctx = setupCtx(dir);
  const registry = new ToolRegistry();
  const { f, calls } = mockServer();
  const config = loadConfig({ cwd: dir, home: dir, cli: { mcp: { servers: [{ name: 'off', url: 'http://mcp.test', enabled: false }] } } });
  const r = await registerMcpTools(registry, config, ctx.runtime, f);
  assert.equal(r.toolCount, 0);
  assert.equal(calls.length, 0);
});
