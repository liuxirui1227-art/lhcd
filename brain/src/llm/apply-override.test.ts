// 模型覆盖 + 开发侧全 Flash（forceCheapTier）单测。
// 背景：面板手选模型只覆盖 main（拆压平）；开发/测试开关要把**所有档位**压到便宜档，
// 且不能留下任何能打到 Pro 的缝（reasoner 条目 / Pro 定价 / 注册表 deep 条目）——默认关，产品面不受影响。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyModelOverride, forceCheapTier, type ProviderLike } from './apply-override.js';

const deepseek = (): ProviderLike => ({
  models: {
    main: { id: 'deepseek-flash', thinking: false },
    fast: { id: 'deepseek-flash', thinking: false },
    compact: { id: 'deepseek-flash', thinking: false },
    subagent: { id: 'deepseek-flash', thinking: false },
    reasoner: { id: 'deepseek-v4-pro' },
  },
  pricingReasoner: { hit: 0.15, miss: 4.5, out: 13.5 },
});

test('applyModelOverride：只覆盖 main，四档不压平', () => {
  const p = { deepseek: deepseek(), qwen: { models: { main: { id: 'qwen-plus' }, fast: { id: 'qwen-turbo' } } } };
  applyModelOverride(p, { deepseek: 'deepseek-v4-pro', qwen: 'qwen-max' });
  assert.deepEqual(p.deepseek.models?.main, { id: 'deepseek-v4-pro', thinking: true });
  assert.equal((p.deepseek.models?.fast as { id: string }).id, 'deepseek-flash');
  assert.deepEqual(p.qwen.models?.main, { id: 'qwen-max', thinking: false });
});

test('forceCheapTier：所有档位压到便宜档，thinking 全关', () => {
  const p = { deepseek: deepseek() };
  forceCheapTier(p);
  for (const role of ['main', 'fast', 'compact', 'subagent']) {
    assert.deepEqual(p.deepseek.models?.[role], { id: 'deepseek-flash', thinking: false }, role);
  }
});

test('forceCheapTier：reasoner 条目与 Pro 定价一并摘掉（不可能再打到 Pro / 不可能按 Pro 记账）', () => {
  const p = { deepseek: deepseek() };
  forceCheapTier(p);
  assert.equal(p.deepseek.models?.reasoner, undefined);
  assert.equal(p.deepseek.pricingReasoner, undefined);
});

test('forceCheapTier：面板把 main 选成 Pro 时，仍压回便宜档（不是压到 main）', () => {
  const p = { deepseek: deepseek() };
  applyModelOverride(p, { deepseek: 'deepseek-v4-pro' }); // 用户手选 = Pro
  forceCheapTier(p); // 测试期开关覆盖它
  assert.deepEqual(p.deepseek.models?.main, { id: 'deepseek-flash', thinking: false });
  assert.equal(p.deepseek.models?.reasoner, undefined);
});

test('forceCheapTier：没有分档（无 fast）的供应商回落到自己的 main', () => {
  const p: Record<string, ProviderLike> = { mini: { models: { main: { id: 'mini-1' }, reasoner: { id: 'mini-pro' } } } };
  forceCheapTier(p);
  assert.deepEqual(p.mini.models?.main, { id: 'mini-1', thinking: false });
  assert.deepEqual(p.mini.models?.compact, { id: 'mini-1', thinking: false });
});

test('forceCheapTier：多供应商逐个体内压平（含自定义大脑）', () => {
  const p = {
    deepseek: deepseek(),
    qwen: { models: { main: { id: 'qwen-plus' }, fast: { id: 'qwen-turbo' }, reasoner: { id: 'qwq' } }, pricingReasoner: { out: 9 } },
  };
  forceCheapTier(p);
  assert.deepEqual(p.qwen.models?.main, { id: 'qwen-turbo', thinking: false });
  assert.equal(p.qwen.models?.reasoner, undefined);
  assert.equal(p.qwen.pricingReasoner, undefined);
});

test('forceCheapTier：空配置 / 缺 models 的供应商安全跳过', () => {
  assert.deepEqual(forceCheapTier({}), {});
  const p: Record<string, ProviderLike> = { broken: {} };
  forceCheapTier(p);
  assert.deepEqual(p, { broken: {} });
});

test('forceCheapTier：opts.effort → 便宜档条目带思考档位（"flash max 版"）；不传则一个字段都不加', () => {
  const p = { deepseek: deepseek() };
  forceCheapTier(p, { effort: 'max' });
  assert.deepEqual(p.deepseek.models?.main, { id: 'deepseek-flash', thinking: false, effort: 'max' });
  assert.deepEqual(p.deepseek.models?.compact, { id: 'deepseek-flash', thinking: false, effort: 'max' });

  const q = { deepseek: deepseek() };
  forceCheapTier(q); // 不传档位 = 不发 reasoning_effort（服务端默认 thinking 开 + high，旧行为逐字一致）
  assert.deepEqual(q.deepseek.models?.main, { id: 'deepseek-flash', thinking: false });
});

test('forceCheapTier：多供应商各自带档位，条目互不共享引用（改一个不影响另一个）', () => {
  const p = {
    deepseek: deepseek(),
    qwen: { models: { main: { id: 'qwen-plus' }, fast: { id: 'qwen-turbo' } } },
  };
  forceCheapTier(p, { effort: 'low' });
  assert.equal((p.deepseek.models?.main as { effort?: string }).effort, 'low');
  assert.equal((p.qwen.models?.main as { effort?: string }).effort, 'low');
  (p.deepseek.models!.main as { id: string }).id = 'mutated';
  assert.equal((p.qwen.models?.main as { id: string }).id, 'qwen-turbo'); // 不是同一个对象
});
