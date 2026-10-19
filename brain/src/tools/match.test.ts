// 降级匹配四档（精确 → 忽略行尾空白 → 两端 trim → 标点/空格归一）单测。
// 档位顺序与归一表逐条对照 codex `seek_sequence.rs:39-112` / `:76-97`；
// "回报档位"由 edit 工具负责（这里只测匹配本身 + 下标映射）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findMatch } from './match.js';

test('精确档：唯一命中走第一档，不问后三档', () => {
  const r = findMatch('hello world', 'world');
  assert.equal(r.found, true);
  assert.equal(r.tier, 'exact');
  assert.deepEqual([r.start, r.end], [6, 11]);
  assert.deepEqual(r.triedTiers, ['exact']);
});

test('精确档多处命中 → 判失败，且不再往下降级（更宽松只会更不唯一）', () => {
  const r = findMatch('aaaa', 'aa');
  assert.equal(r.found, false);
  assert.equal(r.count, 2);
  assert.deepEqual(r.triedTiers, ['exact']);
});

test('第二档：忽略行尾空白（模型抄来的行尾没空格，原文有）', () => {
  const original = 'foo   \nbar\n';
  const r = findMatch(original, 'foo\nbar');
  assert.equal(r.found, true);
  assert.equal(r.tier, 'rstrip');
  // 替换区间落在**原串**上：把带空格的原文整段换掉，而不是只换归一化后的部分
  assert.equal(original.slice(r.start, r.end), 'foo   \nbar');
});

test('第三档：两端 trim（原文有缩进，模型给的是顶格）', () => {
  const original = '    第一行\n    第二行\n尾';
  const r = findMatch(original, '第一行\n第二行');
  assert.equal(r.found, true);
  assert.equal(r.tier, 'trim');
  assert.equal(original.slice(r.start, r.end), '第一行\n    第二行');
});

test('第四档：标点/空格归一（中文文档头号失败原因：全角引号、破折号、全角空格）', () => {
  const original = '他说：“今天先这样”——然后就走了。';
  const r = findMatch(original, '他说:"今天先这样"--然后就走了。');
  assert.equal(r.found, true);
  assert.equal(r.tier, 'punct');
  assert.equal(original.slice(r.start, r.end), '他说：“今天先这样”——然后就走了。');

  const sp = findMatch('A　B', 'A B'); // U+3000 全角空格
  assert.equal(sp.found, true);
  assert.equal(sp.tier, 'punct');
});

test('第四档也覆盖全角 ASCII 形式（全角冒号/逗号/字母，NFKC 这一段我们是 1:1 手动做的）', () => {
  const r = findMatch('他说：甲，乙', '他说:甲,乙');
  assert.equal(r.found, true);
  assert.equal(r.tier, 'punct');
  const letters = findMatch('型号 ＡＢＣ-１２３', '型号 ABC-123');
  assert.equal(letters.found, true);
  assert.equal(letters.tier, 'punct');
  // 1:1 的证明：命中区间长度与原串片段长度一致（NFKC 的 1:N 映射做不到这点）
  assert.equal(letters.end - letters.start, '型号 ＡＢＣ-１２３'.length);
});

test('归一化档里也要唯一：两处归一同形 → 报多处命中（不许静默改第一处）', () => {
  const r = findMatch('第一处“引号”，第二处“引号”。', '"引号"');
  assert.equal(r.found, false);
  assert.equal(r.count, 2);
  assert.equal(r.tier, 'punct');
});

test('四档都找不到 → 如实报找不到（triedTiers 让调用方能把"试过哪些档"告诉模型）', () => {
  const r = findMatch('abc', '完全不存在的一段');
  assert.equal(r.found, false);
  assert.equal(r.count, 0);
  assert.deepEqual(r.triedTiers, ['exact', 'rstrip', 'trim', 'punct']);
});

test('空 oldString 不匹配任何东西（防"空串 split 到处命中"的坑）', () => {
  const r = findMatch('abc', '');
  assert.equal(r.found, false);
  assert.equal(r.count, 0);
});
