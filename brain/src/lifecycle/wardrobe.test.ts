// 衣柜 v0 单测：初始资产/获得去重/自主穿搭评分（穿衣记忆优先）/穿着计数。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialWardrobe, acquire, chooseOutfit, wear, type WardrobeItem } from './wardrobe.js';

const NOW = 1_700_000_000_000;

test('出生基础款：两件且都有来历叙事', () => {
  const w = initialWardrobe(NOW);
  assert.equal(w.items.length, 2);
  assert.ok(w.items.every((i) => i.story.length > 0));
});

test('获得新衣服：带叙事入库；重复 id 忽略', () => {
  let w = initialWardrobe(NOW);
  const gift: Omit<WardrobeItem, 'acquiredAt' | 'wornCount'> = {
    id: 'gift-scarf', name: '围巾', category: 'accessory', origin: 'gift',
    story: '去年生日你送我的围巾',
  };
  const r1 = acquire(w, gift, NOW);
  assert.equal(r1.added, true);
  assert.equal(r1.state.items.length, 3);
  const r2 = acquire(r1.state, gift, NOW + 1);
  assert.equal(r2.added, false);
  assert.equal(r2.state.items.length, 3);
});

test('自主穿搭：有故事的衣服优先（穿衣记忆）；场合加成', () => {
  let w = initialWardrobe(NOW);
  const story: Omit<WardrobeItem, 'acquiredAt' | 'wornCount'> = {
    id: 'gift-dress', name: '礼服', category: 'dress', origin: 'gift', story: '生日礼物，第一次约会穿的',
  };
  w = acquire(w, story, NOW).state;
  // 约会场合：有故事的礼服胜出
  assert.equal(chooseOutfit(w, { occasion: 'date' })?.id, 'gift-dress');
  // 日常场合：常服（birth-casual，top 有加成）
  assert.equal(chooseOutfit(w, { occasion: 'daily' })?.id, 'birth-casual');
  // 开心情绪：裙子加分
  assert.equal(chooseOutfit(w, { occasion: 'daily', emotion: 'joy' })?.id, 'gift-dress');
});

test('穿着记录：wornCount 累积 → 常穿偏好逐渐生效', () => {
  let w = initialWardrobe(NOW);
  for (let i = 0; i < 5; i++) w = wear(w, 'birth-casual');
  const casual = w.items.find((i) => i.id === 'birth-casual')!;
  assert.equal(casual.wornCount, 5);
  // 常穿 5 次的常服在日常场合仍首选
  assert.equal(chooseOutfit(w, { occasion: 'daily' })?.id, 'birth-casual');
});
