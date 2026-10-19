// 关系状态机——只升不降 / 阶段跃迁 / 冲突暂停增量 / 修复恢复。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  REL_STAGES, stageFor, initialRelationship, bumpIntimacy, markConflict, resolveConflict,
} from './relationship.js';

test('阶段阈值：stranger → acquaintance → friend → close → intimate', () => {
  assert.equal(stageFor(0), 'stranger');
  assert.equal(stageFor(0.09), 'stranger');
  assert.equal(stageFor(0.1), 'acquaintance');
  assert.equal(stageFor(0.3), 'friend');
  assert.equal(stageFor(0.6), 'close');
  assert.equal(stageFor(0.85), 'intimate');
  assert.equal(stageFor(1), 'intimate');
});

test('增量默认 0.01 且封顶 1；只升不降', () => {
  let s = initialRelationship();
  const r1 = bumpIntimacy(s);
  assert.equal(r1.state.intimacy, 0.01);
  assert.equal(r1.changed, true);
  const r2 = bumpIntimacy(s, -0.5);
  assert.equal(r2.changed, false); // 负增量拒绝
  s = { intimacy: 0.999, stage: 'intimate', conflict: false };
  assert.equal(bumpIntimacy(s).state.intimacy, 1);
});

test('阶段跃迁检测（10 次后进入 acquaintance）', () => {
  let s = initialRelationship();
  let changed = false;
  for (let i = 0; i < 10; i++) {
    const r = bumpIntimacy(s, 0.01);
    s = r.state;
    if (r.stageChanged) changed = true;
  }
  assert.equal(s.stage, 'acquaintance');
  assert.equal(s.intimacy, 0.1);
  assert.equal(changed, true);
});

test('冲突暂停增量；修复后恢复（亲密不因冲突下降）', () => {
  let s = { intimacy: 0.2, stage: 'acquaintance', conflict: false };
  s = markConflict(s);
  const before = s.intimacy;
  const r = bumpIntimacy(s, 0.05);
  assert.equal(r.changed, false);
  assert.equal(r.state.intimacy, before); // 冲突中不增量也不降
  s = resolveConflict(s);
  const r2 = bumpIntimacy(s, 0.05);
  assert.equal(r2.state.intimacy, 0.25);
  assert.equal(REL_STAGES.length, 5); // 阶段表不变
});
