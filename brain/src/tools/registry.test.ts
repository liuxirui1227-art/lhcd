// 注册表——name 排序 / enabled 白名单 / 能力门控 / 重复注册拒绝。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ToolRegistry, type ToolEntry } from './registry.js';
import type { RuntimeCaps } from '../runtime/types.js';
import type { Config } from '../config/schema.js';
import { DEFAULT_CONFIG } from '../config/schema.js';

const caps: RuntimeCaps = { exec: true, net: true, app: false, browser: false, background: true };

function entry(name: string, extra: Partial<ToolEntry> = {}): ToolEntry {
  return {
    name,
    schema: { type: 'function', function: { name, description: name, parameters: {} } },
    executor: async () => ({ ok: true, output: 'ok' }),
    permissionClass: 'read',
    ...extra,
  };
}

function configWith(enabled: string[]): Config {
  return { ...DEFAULT_CONFIG, tools: { enabled } };
}

test('all() 按 name 排序', () => {
  const r = new ToolRegistry();
  r.register(entry('bash'));
  r.register(entry('app'));
  r.register(entry('read'));
  assert.deepEqual(r.all().map((e) => e.name), ['app', 'bash', 'read']);
});

test('listEnabled：白名单过滤 + 能力门控', () => {
  const r = new ToolRegistry();
  r.register(entry('bash', { permissionClass: 'bash', capabilityRequirement: 'exec' }));
  r.register(entry('web_search', { permissionClass: 'net', capabilityRequirement: 'net' }));
  r.register(entry('app', { permissionClass: 'app', capabilityRequirement: 'app' }));   // caps.app=false → 不注册
  r.register(entry('browser', { permissionClass: 'app', capabilityRequirement: 'browser' })); // 不注册
  r.register(entry('hidden')); // 不在白名单 → 过滤
  const list = r.listEnabled(configWith(['bash', 'web_search', 'app', 'browser']), caps);
  assert.deepEqual(list.map((e) => e.name), ['bash', 'web_search']);
});

test('schemasFor 输出 ToolDef 且顺序稳定', () => {
  const r = new ToolRegistry();
  r.register(entry('read'));
  r.register(entry('bash', { permissionClass: 'bash', capabilityRequirement: 'exec' }));
  const schemas = r.schemasFor(configWith(['read', 'bash']), caps);
  assert.deepEqual(schemas.map((s) => s.function.name), ['bash', 'read']);
});

test('重复注册抛错', () => {
  const r = new ToolRegistry();
  r.register(entry('read'));
  assert.throws(() => r.register(entry('read')), /重复注册/);
});
