// 「冲着 TA 来的」情绪（第二本词典）
// 判据：只认冲着她来的 · 否定吃掉 · 别人的对象不算 · 弱词不够 · 阈值可解释
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyDirected, shouldDelight } from './directed.js';

test('感谢类：谢谢你 / 辛苦了 / 多亏你 → 她该开心', () => {
  for (const t of ['今天多亏你，谢谢你', '辛苦啦，辛苦了', '谢啦', '还好有你']) {
    assert.equal(classifyDirected(t).directed, 'thanks', t);
    assert.equal(shouldDelight(t), true, t);
  }
});

test('夸奖类：你真好 / 你真棒 / 懂我 → 她该开心', () => {
  for (const t of ['你真好', '你真棒！', '还是你懂我', '这个做得挺好，干得好']) {
    assert.equal(classifyDirected(t).directed, 'praise', t);
  }
});

test('亲密类：爱你 / 想你了 / 抱抱你 → 她该开心', () => {
  for (const t of ['爱你', '想你了', '抱抱你']) {
    assert.equal(classifyDirected(t).directed, 'affection', t);
  }
});

test('★ 否定要吃掉：不用谢 / 别夸我 / 不喜欢你 → 不该开心', () => {
  for (const t of ['不用谢', '别夸我', '我喜欢你才怪', '不爱你']) {
    assert.equal(shouldDelight(t), false, t + ' → ' + JSON.stringify(classifyDirected(t)));
  }
});

test('★ 只认冲着她来的：谢谢他 / 谢谢老板 → 不算', () => {
  for (const t of ['我谢谢他', '谢谢老板', '感谢同事们', '他可真厉害']) {
    assert.equal(shouldDelight(t), false, t + ' → ' + JSON.stringify(classifyDirected(t)));
  }
});

test('弱词不够（阈值 3）：只夸一句"厉害"不演开心', () => {
  assert.equal(classifyDirected('厉害').directed, 'neutral');
  assert.equal(classifyDirected('这场雨下得挺厉害').directed, 'neutral');
  // 但"你真厉害"是明确冲着她来的 → 算
  assert.equal(classifyDirected('你真厉害').directed, 'praise');
});

test('平常的话不许误伤（闲聊聊到别人/别的事都不算）', () => {
  for (const t of ['今天加班好累', '帮我看看这份报表', '明天要下雨', '这个表格有三列']) {
    assert.equal(shouldDelight(t), false, t);
  }
});

test('可解释：命中词条带出来（诊断用）', () => {
  const r = classifyDirected('谢谢你，今天多亏你');
  assert.ok(r.hits.length >= 1);
  assert.ok(r.hits.some((h) => h.startsWith('thanks:')));
  assert.ok(r.scores.thanks >= 4);
});

/* ── 多语覆盖 ──────────────────────────────────────────────────────────────
   "冲着我来的"这套判定不能只有中文——英文说 "thank you"、日文说「ありがとう」、
   韩文说「고마워」也要认；反过来 "I thank him" / 「彼が好き」也该作废。 */

test('多语指向：五种语言说谢谢/爱你/夸你 → 判类一致', () => {
  const cases: Array<[string, string[]]> = [
    ['thanks', ['谢谢你', '謝謝你', 'thank you', 'ありがとう', '고마워']],
    ['affection', ['爱你', '愛你', 'i love you', '愛してる', '사랑해']],
    ['praise', ['你真棒', '你好厲害', 'you are great', 'すごい', '대단해']],
  ];
  for (const [want, lines] of cases) {
    for (const line of lines) {
      assert.equal(classifyDirected(line).directed, want, `「${line}」应判为 ${want}`);
    }
  }
});

test('多语指向：说别人不算（我爱他 / i love him / 彼が好き / 그를 사랑해）', () => {
  for (const line of ['我爱他', 'i love him', '彼が好き', '그를 사랑해']) {
    assert.notEqual(classifyDirected(line).directed, 'affection', `「${line}」不该算冲着她`);
  }
});

test('多语否定：I love you not really / 好きじゃない / 사랑하지 않아 都不算', () => {
  for (const line of ['我爱你才怪', 'i love you not really', '好きじゃない', '사랑하지 않아']) {
    assert.equal(classifyDirected(line).directed, 'neutral', `「${line}」不该算正向`);
  }
});
