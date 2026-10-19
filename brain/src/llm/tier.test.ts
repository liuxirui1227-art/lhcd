// 能力档位单测：检测规则 / 用户覆盖 / 生效档位。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectCapabilityTier, effectiveTier, validTier, TIER_INFO } from './tier.js';

test('detectCapabilityTier：强设备（≥16GB + NPU）→ all-local', () => {
  const d = detectCapabilityTier({ ramGB: 32, npu: true, localModelSupport: true });
  assert.equal(d.tier, 'all-local');
  assert.ok(d.reasons.length > 0);
});

test('detectCapabilityTier：中档设备（≥8GB + 本地运行时）→ hybrid', () => {
  const d = detectCapabilityTier({ ramGB: 16, npu: false, localModelSupport: true });
  assert.equal(d.tier, 'hybrid');
});

test('detectCapabilityTier：弱设备（无 NPU 无本地运行时）→ cloud-only', () => {
  const d = detectCapabilityTier({ ramGB: 16, npu: false, localModelSupport: false });
  assert.equal(d.tier, 'cloud-only');
  assert.ok(d.reasons.join('').includes('存续态'));
});

test('validTier：非法值返回 null', () => {
  assert.equal(validTier('hybrid'), 'hybrid');
  assert.equal(validTier('quantum'), null);
  assert.equal(validTier(undefined), null);
});

test('effectiveTier：用户覆盖优先，非法回落检测值', () => {
  assert.equal(effectiveTier('cloud-only', 'all-local'), 'all-local');
  assert.equal(effectiveTier('cloud-only', 'bogus'), 'cloud-only');
  assert.equal(effectiveTier('hybrid', undefined), 'hybrid');
});

test('TIER_INFO：三档画像齐全（管理 UI 透出）', () => {
  for (const t of ['all-local', 'hybrid', 'cloud-only'] as const) {
    assert.ok(TIER_INFO[t].label);
    assert.ok(TIER_INFO[t].offline);
  }
});
