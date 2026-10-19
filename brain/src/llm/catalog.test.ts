// 模型清单数据化（四层合成 / 缺省值 / 刷新窗口 / etag 状态码分治）单测。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createNodeRuntime } from '../runtime/node.js';
import {
  CatalogStore, parseCatalog, mergeCatalog, normalizeCatalogModel, isValidCatalogModel, refreshCatalog,
  CATALOG_DEFAULTS, REMOTE_CATALOG_REFRESH_INTERVAL_MS, REMOTE_CATALOG_ATTEMPT_TIMEOUT_MS,
} from './catalog.js';

test('缺省值照 pi：cost 全 0 / contextWindow 128000 / maxTokens 16384', () => {
  const m = normalizeCatalogModel({ id: 'deepseek.chat' });
  assert.deepEqual(m.cost, CATALOG_DEFAULTS.cost);
  assert.equal(m.contextWindow, 128000);
  assert.equal(m.maxTokens, 16384);
  assert.equal(m.name, 'deepseek.chat'); // name 缺省 = id
  assert.equal(m.reasoning, false);
});

test('逐字段校验：一个字段不对就整条不收（照 pi 网关字段校验的严度）', () => {
  assert.equal(isValidCatalogModel({ id: 'a' }), true);
  assert.equal(isValidCatalogModel({ id: '' }), false);
  assert.equal(isValidCatalogModel({ id: 'a', contextWindow: -1 }), false);
  assert.equal(isValidCatalogModel({ id: 'a', cost: { input: 'x' } }), false);
  assert.equal(isValidCatalogModel({ id: 'a', reasoning: 'yes' }), false);
  assert.equal(isValidCatalogModel(null), false);
  // 坏条目被过滤，好条目留下
  const f = parseCatalog({ models: [{ id: 'ok' }, { id: '' }, { nope: 1 }] });
  assert.equal(f.models.length, 1);
  assert.equal(f.models[0]!.id, 'ok');
});

test('合并：同 id 覆盖、新 id 追加（pi provider-composer 的语义）', () => {
  const base = [{ id: 'a', name: '旧' }, { id: 'b' }];
  const merged = mergeCatalog(base, [{ id: 'a', name: '新' }, { id: 'c' }]);
  assert.equal(merged.length, 3);
  assert.equal(merged.find((m) => m.id === 'a')!.name, '新');
  assert.ok(merged.some((m) => m.id === 'c'));
});

test('清单仓：读同步绝不抛（缺文件/坏 JSON 都当没有）；随包基线 + 用户覆盖合起来', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-catalog-'));
  const rt = createNodeRuntime({ cwd: dir, storage: { sessionsDir: `${dir}/s`, logsDir: `${dir}/l`, memoryDir: `${dir}/m`, configDir: `${dir}/c` } });
  const builtin = path.join(dir, 'builtin.json');
  const user = path.join(dir, 'user.json');
  fs.writeFileSync(builtin, JSON.stringify({ models: [{ id: 'deepseek.chat', name: 'V3', contextWindow: 64000 }] }));
  fs.writeFileSync(user, '{ 这不是 JSON');
  const store = new CatalogStore(rt, user, builtin);
  await store.load();
  assert.equal(store.models().length, 1, '坏的用户文件不该让它抛，也不该吞掉基线');
  assert.equal(store.models()[0]!.name, 'V3');
  // 用户覆盖生效
  fs.writeFileSync(user, JSON.stringify({ models: [{ id: 'deepseek.chat', name: 'V4' }, { id: 'deepseek.reasoner' }] }));
  const store2 = new CatalogStore(rt, user, builtin);
  await store2.load();
  assert.equal(store2.models().length, 2);
  assert.equal(store2.models().find((m) => m.id === 'deepseek.chat')!.name, 'V4');
});

test('刷新：没开联网开关 → 一个字都不发（离线可用）', async () => {
  let called = 0;
  const r = await refreshCatalog({
    baseUrl: 'https://example.com', providerId: 'deepseek', stored: { models: [] }, allowNetwork: false,
    fetchFn: async () => { called++; return { status: 200, ok: true, json: async () => ({}) }; },
  });
  assert.equal(r.outcome, 'offline-disabled');
  assert.equal(called, 0, '不开开关绝不联网');
});

test('刷新：4 小时窗口内不重复问（但要能把 checkedAt 推上去）', async () => {
  const now = 1_000_000_000;
  let called = 0;
  const r = await refreshCatalog({
    baseUrl: 'https://example.com', providerId: 'deepseek',
    stored: { models: [{ id: 'x' }], checkedAt: now - 60_000 }, allowNetwork: true, now,
    fetchFn: async () => { called++; return { status: 200, ok: true, json: async () => ({}) }; },
  });
  assert.equal(r.outcome, 'too-soon');
  assert.equal(called, 0);
  // 超过窗口 → 真去问
  const r2 = await refreshCatalog({
    baseUrl: 'https://example.com', providerId: 'deepseek',
    stored: { models: [{ id: 'x' }], checkedAt: now - REMOTE_CATALOG_REFRESH_INTERVAL_MS - 1 }, allowNetwork: true, now,
    fetchFn: async () => { called++; return { status: 200, ok: true, json: async () => ({ models: [{ id: 'new-model', name: '新模型' }] }) }; },
  });
  assert.equal(r2.outcome, 'ok');
  assert.equal(called, 1);
  assert.equal(r2.catalog.models[0]!.name, '新模型');
  assert.equal(r2.catalog.checkedAt, now);
});

test('刷新：304 只推 checkedAt（清单不被清空）；404/501 清验证器；瞬时失败保留 etag', async () => {
  const now = 5_000_000;
  const stored = { models: [{ id: 'deepseek.chat' }], etag: '"abc"', checkedAt: 0 };
  // 304：清单还在，只更新时间
  const r304 = await refreshCatalog({ baseUrl: 'https://e.com', providerId: 'deepseek', stored, allowNetwork: true, now,
    fetchFn: async () => ({ status: 304, ok: false, json: async () => ({}), headers: { get: () => null } }) });
  assert.equal(r304.outcome, 'not-modified');
  assert.equal(r304.catalog.models.length, 1);
  assert.equal(r304.catalog.checkedAt, now);
  // 404：清验证器（下次别再拿旧 etag 问）
  const r404 = await refreshCatalog({ baseUrl: 'https://e.com', providerId: 'deepseek', stored, allowNetwork: true, now,
    fetchFn: async () => ({ status: 404, ok: false, json: async () => ({}) }) });
  assert.equal(r404.outcome, 'gone');
  assert.equal(r404.catalog.etag, undefined);
  // 瞬时失败：etag 原样保留（下轮还能 304）
  const rErr = await refreshCatalog({ baseUrl: 'https://e.com', providerId: 'deepseek', stored, allowNetwork: true, now,
    fetchFn: async () => { throw new Error('ECONNRESET'); } });
  assert.equal(rErr.outcome, 'error');
  assert.equal(rErr.catalog.etag, '"abc"');
  assert.equal(rErr.catalog.models.length, 1);
});

test('刷新：带验证器和 New-Match、URL 里只有供应商 id（只发元数据）', async () => {
  let seen: { url: string; init: Record<string, any> } | null = null;
  await refreshCatalog({
    baseUrl: 'https://gw.example.com/', providerId: 'deepseek', stored: { models: [{ id: 'x' }], etag: '"v1"' },
    allowNetwork: true, now: 9e12, userAgent: 'lhcd/0.9',
    fetchFn: async (url, init) => { seen = { url, init: init ?? {} }; return { status: 304, ok: false, json: async () => ({}) }; },
  });
  assert.equal(seen!.url, 'https://gw.example.com/api/models/providers/deepseek');
  assert.equal(seen!.init.headers['If-None-Match'], '"v1"');
  assert.equal(seen!.init.headers['User-Agent'], 'lhcd/0.9');
  assert.ok(!JSON.stringify(seen).includes('sk-'), '请求里不该出现任何密钥');
  assert.equal(REMOTE_CATALOG_ATTEMPT_TIMEOUT_MS, 4000);
});

test('清单仓：forProvider 按命名空间过滤（内置条目对所有供应商可见）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-catalog2-'));
  const rt = createNodeRuntime({ cwd: dir, storage: { sessionsDir: `${dir}/s`, logsDir: `${dir}/l`, memoryDir: `${dir}/m`, configDir: `${dir}/c` } });
  const store = new CatalogStore(rt, path.join(dir, 'c.json'));
  await store.load();
  await store.save({ models: [
    { id: 'generic-small', name: '通用小模型' },
    { id: 'deepseek.chat', name: 'V3' },
    { id: 'qwen.vl', name: 'VL' },
  ] });
  const ds = store.forProvider('deepseek').map((m) => m.id);
  assert.ok(ds.includes('generic-small'), '无前缀条目对所有供应商可见');
  assert.ok(ds.includes('deepseek.chat'));
  assert.ok(!ds.includes('qwen.vl'));
});
