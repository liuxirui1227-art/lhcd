// 世界状态差分注入单测（三态 / 没变不发 / 消失要说明）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WorldStateTracker, mergePatchFrom, type SectionSpec } from './world-state.js';

const SPECS: SectionSpec[] = [
  { id: 'task', label: '账上还欠着的事', render: (s) => `- ${s.title}（${s.done}/${s.total} 步）` },
  { id: 'facet', label: '当前的说话侧面', render: (s) => String(s.overlay) },
];

test('首次注入 → 保守重播全量（宁可重播，不假设"没变过"）', () => {
  const t = new WorldStateTracker(SPECS);
  const r = t.render({ task: { title: '整理报表', done: 1, total: 3 }, facet: { overlay: '职场语气' } });
  assert.equal(r.changed, true);
  assert.match(r.text, /【账上还欠着的事】/);
  assert.match(r.text, /整理报表（1\/3 步）/);
  assert.match(r.text, /【当前的说话侧面】/);
});

test('第二轮完全没变 → **一个字都不发**（出处 codex "相等即不发"）', () => {
  const t = new WorldStateTracker(SPECS);
  t.render({ task: { title: '整理报表', done: 1, total: 3 }, facet: { overlay: '职场语气' } });
  const r2 = t.render({ task: { title: '整理报表', done: 1, total: 3 }, facet: { overlay: '职场语气' } });
  assert.equal(r2.text, '');
  assert.equal(r2.changed, false);
});

test('变了 → 只发变化的那一节（没变的节不再重发）', () => {
  const t = new WorldStateTracker(SPECS);
  t.render({ task: { title: '整理报表', done: 1, total: 3 }, facet: { overlay: '职场语气' } });
  const r = t.render({ task: { title: '整理报表', done: 2, total: 3 }, facet: { overlay: '职场语气' } });
  assert.match(r.text, /账上还欠着的事·有更新/);
  assert.match(r.text, /2\/3 步/);
  assert.ok(!r.text.includes('职场语气'), '没变的节不发');
});

test('某节从有到无 → 明说"不再适用"（出处 codex REMOVAL_NOTICE）', () => {
  const t = new WorldStateTracker(SPECS);
  t.render({ task: { title: '整理报表', done: 1, total: 3 }, facet: null });
  const r = t.render({ task: null, facet: null });
  assert.match(r.text, /不再适用/);
  assert.match(r.text, /账上还欠着的事/);
});

test('从来没有过的节：不出现也不提（静默，别没话找话）', () => {
  const t = new WorldStateTracker(SPECS);
  const r = t.render({ task: { title: 'x', done: 0, total: 1 }, facet: null });
  assert.ok(!r.text.includes('不再适用'));
  assert.ok(!r.text.includes('侧面'));
});

test('重启后恢复：带快照继续差分；快照丢了就重播（出处 codex "没有 full 基线的 patch 丢弃"）', () => {
  const t1 = new WorldStateTracker(SPECS);
  const first = t1.render({ task: { title: 'A', done: 0, total: 2 }, facet: null });
  // 重启：从落盘的快照恢复
  const t2 = new WorldStateTracker(SPECS, first.snapshot);
  const same = t2.render({ task: { title: 'A', done: 0, total: 2 }, facet: null });
  assert.equal(same.text, '', '恢复后没变 → 依然不发');
  // 没有快照（老会话）→ 保守重播
  const t3 = new WorldStateTracker(SPECS);
  const replay = t3.render({ task: { title: 'A', done: 0, total: 2 }, facet: null });
  assert.match(replay.text, /账上还欠着的事/);
});

test('mergePatchFrom（RFC 7386 语义）：改键/删键/没变', () => {
  assert.equal(mergePatchFrom({ a: 1 }, { a: 1 }), null);
  assert.deepEqual(mergePatchFrom({ a: 1 }, { a: 2, b: 3 }), { a: 2, b: 3 });
  assert.deepEqual(mergePatchFrom({ a: 1, b: 2 }, { a: 1 }), { b: null }, '删掉的键在 patch 里是 null');
  assert.equal(mergePatchFrom(null, null), null);
  assert.deepEqual(mergePatchFrom(null, { x: 1 }), { x: 1 });
});
