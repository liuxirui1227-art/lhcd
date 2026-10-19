// 锚点索引——正则机械提取，零模型调用。成对用例：该抠出来的 / 不该混进来的。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAnchorIndex, renderAnchors, ANCHOR_BUDGET_CHARS } from './anchors.js';

const pick = (text: string, label: string) =>
  buildAnchorIndex(text).find((s) => s.label === label)?.values.map((v) => v.value) ?? [];

test('抠出精确标识符：文件/网址/编号/报错/日期/金额', () => {
  const text = [
    '看了 brain/src/memory/text.ts 和 ~/.lhcd/data/state.json',
    '参考 https://example.com/docs/recall 的说明',
    '见 PR #1234，报错是 ENOSPC 和 TypeError',
    '约定 2026-09-20 之前给答复，预算 300 元',
  ].join('\n');
  assert.ok(pick(text, '文件').includes('brain/src/memory/text.ts'));
  assert.ok(pick(text, '文件').includes('~/.lhcd/data/state.json'));
  assert.ok(pick(text, '网址').includes('https://example.com/docs/recall'));
  assert.ok(pick(text, '编号').includes('#1234'));
  assert.ok(pick(text, '报错').includes('ENOSPC'));
  assert.ok(pick(text, '报错').includes('TypeError'));
  assert.ok(pick(text, '日期').includes('2026-09-20'));
  assert.ok(pick(text, '金额').includes('300 元'));
});

test('按频次排序、同频按最近出现', () => {
  const text = 'a/one.ts b/two.ts a/one.ts';
  const files = pick(text, '文件');
  assert.equal(files[0], 'a/one.ts'); // 出现两次 → 排前
});

test('不该混进来：普通中文与常见词不进锚点', () => {
  const sections = buildAnchorIndex('今天我们聊了聊最近的事，天气不错。');
  assert.equal(sections.length, 0);
});

test('去尾标点：句末的路径不留句号', () => {
  assert.ok(pick('请看 src/main.ts.', '文件').includes('src/main.ts'));
});

test('预算封顶：超长文本也不会把摘要块撑回去', () => {
  const many = Array.from({ length: 300 }, (_, i) => `dir/sub/file-${i}.ts`).join(' ');
  const rendered = renderAnchors(buildAnchorIndex(many));
  assert.ok(rendered.length <= ANCHOR_BUDGET_CHARS + 400, `渲染后长度 ${rendered.length}`); // 预算 + 标题/说明行
  assert.ok(rendered.includes('精确锚点'));
});

test('渲染：带次数、带"别改写/可当查询锚点"的说明', () => {
  const rendered = renderAnchors(buildAnchorIndex('a/x.ts a/x.ts b/y.ts'));
  assert.ok(rendered.includes('×2'));
  assert.ok(rendered.includes('原样使用'));
  assert.ok(rendered.includes('session_search'));
});

test('空输入 → 空索引（不产出空标题）', () => {
  assert.deepEqual(buildAnchorIndex(''), []);
  assert.equal(renderAnchors([]), '');
});
