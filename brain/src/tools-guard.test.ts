// 守卫测试：「注册表里有、白名单里没有」= 死功能。
//
// schedule 工具与自然语言入口曾因 config.tools.enabled 白名单漏了 'schedule'，
// registry.listEnabled 一过滤，模型**根本看不到这个工具**，整条链路是空话（同批漏掉的还有 'session_search'）。
// 这类 bug 不报错、不崩溃、单测全绿，只有真跑起来问模型"你能看到哪些工具"才会现形——所以必须有守卫。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAgent } from './factory.js';
import { DEFAULT_CONFIG } from './config/schema.js';

/** 只在特定环境注册的工具（CLI 无此注册项 → 白名单里有也不会出现；反之不注册也必须白名单里有） */
const HOST_REGISTERED = ['plan_task', 'install_skill', 'save_skill', 'install_mcp', 'run_agent'];

test('守卫：工厂注册的每个工具都必须进 tools.enabled 白名单（否则模型看不见 = 死功能）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-guard-'));
  const agent = await createAgent({ cwd: dir, home: dir, cli: { sessions: { dir: `${dir}/sessions` } } });
  const registered = agent.registry.all().map((t) => t.name);
  const enabled = new Set(agent.config.tools.enabled);
  const missing = registered.filter((n) => !enabled.has(n));
  assert.deepEqual(
    missing,
    [],
    `这些工具注册了但没进白名单（模型看不到）：${missing.join(', ')}——请加进 config/schema.ts 的 tools.enabled`,
  );
  // 反向：宿主侧注册的工具（runtime/lib.mjs 里 register 的）也必须先在白名单里备着
  for (const n of HOST_REGISTERED) {
    assert.ok(enabled.has(n), `${n} 是宿主注册的工具，白名单里必须有它（否则等于没做）`);
  }
});

test('守卫：模型实际可见的工具集非空，且包含本轮新增的 task / schedule', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-guard2-'));
  const agent = await createAgent({ cwd: dir, home: dir, cli: { sessions: { dir: `${dir}/sessions` } } });
  const visible = agent.registry.schemasFor(agent.config, agent.runtime.capabilities).map((t) => t.function.name);
  assert.ok(visible.includes('task'), 'task 工具必须对模型可见（迭代 05 的自然语言入口）');
  assert.ok(visible.includes('schedule'), 'schedule 工具必须对模型可见（迭代 04 的入口，此前是死功能）');
  assert.ok(visible.includes('session_search'), 'session_search 必须对模型可见（条 37 找回的落点）');
});

test('默认配置白名单不含重复项（防止手滑写出两条一样的）', () => {
  const list = DEFAULT_CONFIG.tools.enabled;
  assert.equal(new Set(list).size, list.length);
});
