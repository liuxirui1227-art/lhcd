// 单测：facet 注册表/权限矩阵（Companion 全读写，侧面最小权限）/记忆分区过滤/切换不改人格。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_FACETS, domainAccess, filterDomains, facetById, DOMAINS } from './facets.js';

test('出厂侧面：三个（职场/情感/学习），overlay 不含人格修改', () => {
  assert.deepEqual(DEFAULT_FACETS.map((f) => f.key), ['career', 'emotion', 'study']);
  for (const f of DEFAULT_FACETS) {
    assert.ok(f.overlay.includes('不改变人格'));
    assert.ok(f.overlay.includes('仍是同一个 TA'));
  }
});

test('权限矩阵：Companion 全读写；侧面本域读写、日程只读、其余禁', () => {
  assert.equal(domainAccess('schedule', 'companion'), 'rw');
  assert.equal(domainAccess('private_diary', 'companion'), 'rw');
  assert.equal(domainAccess('work_log', 'career'), 'rw');
  assert.equal(domainAccess('schedule', 'career'), 'rw');
  assert.equal(domainAccess('emotion_log', 'career'), 'none');
  assert.equal(domainAccess('schedule', 'emotion'), 'r');    // 日程对情感侧面只读
  assert.equal(domainAccess('work_log', 'emotion'), 'none');
  assert.equal(domainAccess('private_diary', 'study'), 'none');
  assert.equal(domainAccess('schedule', 'unknown'), 'none');
});

test('记忆分区过滤：侧面只看得到有权限的域', () => {
  const entries = [
    { domain: 'schedule', text: 'a' },
    { domain: 'work_log', text: 'b' },
    { domain: 'private_diary', text: 'c' },
  ] as Array<{ domain: (typeof DOMAINS)[number]; text: string }>;
  const career = filterDomains(entries, 'career');
  assert.deepEqual(career.map((e) => e.domain), ['schedule', 'work_log']);
  const emotion = filterDomains(entries, 'emotion');
  assert.deepEqual(emotion.map((e) => e.domain), ['schedule', 'private_diary']); // 日程只读 + 情感本域
  const companion = filterDomains(entries, 'companion');
  assert.equal(companion.length, 3);
});

test('facetById：未知 key 返回 undefined（不静默回退）', () => {
  assert.equal(facetById('career')?.label, '职场侧面');
  assert.equal(facetById('nope'), undefined);
});
