// 思考回放的**开关**（`reasoningField` 此前是 null → reasoning.delta 永远不会发）。
// 这里钉住三件事：
//   ① 默认配置真的开着（回归守卫：谁把它改回 null，这条立刻红）；
//   ② caps.reasoning 决定要不要回放（不再是一句没人读的声明）；
//   ③ 'none' / 未实现的 'thinking-blocks' 一律不发（不许假装支持）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, type ProviderCfg } from '../config/schema.js';
import { reasoningFieldOf } from './hub.js';

const caps = (reasoning: ProviderCfg['caps']['reasoning']): ProviderCfg['caps'] => ({
  ...DEFAULT_CONFIG.providers.deepseek!.caps, reasoning, parallelToolCalls: false,
});

const base = (): ProviderCfg => ({ ...DEFAULT_CONFIG.providers.deepseek!, caps: caps('content-field') });

test('默认配置：在售供应商开着思考回放（reasoningField 不为 null）', () => {
  const cfg = DEFAULT_CONFIG.providers.deepseek!;
  assert.equal(cfg.reasoningField, 'reasoning_content');
  assert.equal(reasoningFieldOf(cfg), 'reasoning_content');
});

test('caps.reasoning 决定回放：content-field 才发，none / thinking-blocks 一律不发', () => {
  const b = base();
  assert.equal(reasoningFieldOf({ ...b, reasoningField: 'reasoning_content' }), 'reasoning_content');
  // 字段名没写但声明了 content-field → 取行业通名，不是"什么都不发"
  assert.equal(reasoningFieldOf({ ...b, reasoningField: undefined }), 'reasoning_content');
  assert.equal(reasoningFieldOf({ ...b, reasoningField: null }), 'reasoning_content');
  // 声明不支持思考 / 声明了还没实现的 blocks 形态 → 不发（不许假装支持）
  assert.equal(reasoningFieldOf({ ...b, caps: caps('none'), reasoningField: 'reasoning_content' }), null);
  assert.equal(reasoningFieldOf({ ...b, caps: caps('thinking-blocks'), reasoningField: 'reasoning_content' }), null);
});
