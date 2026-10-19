// state 字段级合并单测——关系只升不降 / facet 保本机 / 里程碑并集 / 锚点取早。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeStates } from './lib.mjs';

test('关系只升不降：intimacy/stage 取高（本机更新不被旧快照回退）', () => {
  const m = mergeStates(
    { bound: true, application_id: '9', intimacy: 0.6, stage: 'close', facet: 'career' },
    { bound: true, application_id: '9', intimacy: 0.1, stage: 'stranger', facet: 'emotion' },
  );
  assert.equal(m.intimacy, 0.6);
  assert.equal(m.stage, 'close');
  assert.equal(m.facet, 'career'); // 本机现场优先
});

test('本机较弱时取包内更高值', () => {
  const m = mergeStates(
    { bound: true, application_id: '9', intimacy: 0.1, stage: 'stranger', facet: undefined },
    { bound: true, application_id: '9', intimacy: 0.8, stage: 'intimate', facet: 'study' },
  );
  assert.equal(m.intimacy, 0.8);
  assert.equal(m.stage, 'intimate');
  assert.equal(m.facet, 'study');
});

test('里程碑并集 + 出生锚点取早 + bound_at 取早', () => {
  const m = mergeStates(
    { bound: true, application_id: '9', birth_anchor: 1755000000000, bound_at: '2026-08-20T10:00:00Z', milestonesDone: { full_moon: 1 } },
    { bound: true, application_id: '9', birth_anchor: 1755100000000, bound_at: '2026-08-19T10:00:00Z', milestonesDone: { hundred_days: 1 } },
  );
  assert.equal(m.birth_anchor, 1755000000000);
  assert.equal(m.bound_at, '2026-08-19T10:00:00Z');
  assert.deepEqual(m.milestonesDone, { full_moon: 1, hundred_days: 1 });
});

test('空/缺省字段兼容', () => {
  const m = mergeStates({ bound: true, application_id: '9' }, {});
  assert.equal(m.intimacy, 0);
  assert.equal(m.stage, 'stranger');
  assert.equal(m.bound, true);
});

test('本机字段优先：infoDigest 保本机现场（远端只补齐缺省）', () => {
  const m = mergeStates(
    { bound: true, infoDigest: '本机新摘要', lastProactiveAt: 200 },
    { bound: true, infoDigest: '旧快照摘要', lastProactiveAt: 100 },
  );
  assert.equal(m.infoDigest, '本机新摘要');
  assert.equal(m.lastProactiveAt, 200); // 取大：避免双端口径不一致重复打扰
  const m2 = mergeStates({ bound: true }, { bound: true, infoDigest: '远端摘要', lastProactiveAt: 50 });
  assert.equal(m2.infoDigest, '远端摘要'); // 本机缺失时补齐
  assert.equal(m2.lastProactiveAt, 50);
});

test('appWhitelist 并集 + spec_version 取大 + 里程碑同 id 取新', () => {
  const m = mergeStates(
    { bound: true, appWhitelist: ['日历', '提醒'], spec_version: 1, milestonesDone: { full_moon: 200 } },
    { bound: true, appWhitelist: ['提醒', '备忘录'], spec_version: 3, milestonesDone: { full_moon: 100, hundred_days: 1 } },
  );
  assert.deepEqual(m.appWhitelist, ['日历', '提醒', '备忘录']);
  assert.equal(m.spec_version, 3);
  assert.equal(m.milestonesDone.full_moon, 200); // 同 id 取更晚时间戳，不被旧快照回退
  assert.equal(m.milestonesDone.hundred_days, 1);
});
