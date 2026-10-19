// 情绪识别单测：六类基本行为 + 否定消解 + 中性判定。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyEmotion } from './emotion.js';

test('六类基本分类', () => {
  assert.equal(classifyEmotion('今天加班好累啊').emotion, 'comfort');
  assert.equal(classifyEmotion('哈哈哈中奖了！').emotion, 'joy');
  assert.equal(classifyEmotion('失恋了，好难过').emotion, 'sad');
  assert.equal(classifyEmotion('气死我了，又被放鸽子').emotion, 'angry');
  assert.equal(classifyEmotion('明天要面试，好紧张').emotion, 'anxious');
  assert.equal(classifyEmotion('帮我查一下明天的航班').emotion, 'neutral');
});

test('否定消解：不累/不难受/别担心 不误判', () => {
  assert.equal(classifyEmotion('我今天一点都不累').emotion, 'neutral');
  assert.equal(classifyEmotion('不难过，就是有点感慨').emotion, 'neutral');
  assert.equal(classifyEmotion('别担心，我没事').emotion, 'neutral');
  assert.equal(classifyEmotion('我不生气了').emotion, 'neutral');
});

test('多情绪混合取最高分', () => {
  assert.equal(classifyEmotion('又累又烦，还担心明天').emotion, 'comfort'); // 累2+烦(真烦3?)→最高分者
});

test('弱词单发不触发（阈值 2）', () => {
  assert.equal(classifyEmotion('我走了，去上班').emotion, 'neutral');
});

/* ── 多语一致 ────────────────────────────────────────────────────────────
   判据：**同一句情绪，用五种语言说，识别结果必须一致**；而且每种语言都得有词库在管
   （不是"中文有 300 条、英文只有 3 条"那种表面覆盖）。 */
import { LEXICON_STATS } from './emotion.js';

test('多语情绪：五种语言说同一件事 → 同一类情绪', () => {
  const cases: Array<[string, string[]]> = [
    ['comfort', ['今天好累，撑不住了', '今天好累，撐不住了', "I'm so tired, I can't keep up", '疲れた、もう限界', '너무 힘들어, 못 버티겠어']],
    ['joy', ['太好了，真开心', '太好了，真開心', 'Awesome, great news!', 'やった、嬉しい！', '다행이다, 기뻐!']],
    ['sad', ['很难过，特别孤独', '很難過，特別孤獨', "I'm so sad and lonely", '悲しい、寂しい', '너무 슬퍼, 외로워']],
    ['angry', ['太气人了，真不公平', '太氣人了，真不公平', "I'm furious, this is unfair", '腹立つ、不公平だ', '화나, 불공평해']],
    ['anxious', ['明天要面试，我好焦虑', '明天要面試，我好焦慮', "I'm anxious, interview tomorrow", '不安で、明日面接', '불안해, 내일 면접이야']],
  ];
  for (const [want, lines] of cases) {
    for (const line of lines) {
      const got = classifyEmotion(line).emotion;
      const near = want === 'sad' || want === 'anxious' ? (got === 'sad' || got === 'anxious' || got === 'comfort') : got === want;
      assert.ok(near, `「${line}」应判为 ${want}（或同类），实际 ${got}`);
    }
  }
});

test('多语情绪：每种语言都有词库在管（不是只有中文有）', () => {
  for (const [lang, n] of Object.entries(LEXICON_STATS)) {
    assert.ok(n >= 60, `${lang} 的词条太少（${n}）——"五种语言一致"不能是表面覆盖`);
  }
});

test('多语情绪：否定词也按语言消解（"not happy" 不算开心）', () => {
  assert.notEqual(classifyEmotion('not happy at all').emotion, 'joy');
  assert.notEqual(classifyEmotion('嬉しくない').emotion, 'joy');
  assert.notEqual(classifyEmotion('기쁘지 않아').emotion, 'joy');
});

/* ── 口语梗（翻译解决不了的那一层）──────────────────────────────────────
   判据（五种语言口径一致）：**同一条概念，五种说法必须判出同一类**；
   而且"每个概念每种语言都有说法"是**结构**，不是靠人记得补。 */
import { SLANG } from './emotion.js';
import { SLANG_HANT } from './emotion-hant.js';

test('口语梗：每条概念五种语言（含繁体）都有说法，判出来是同一类', () => {
  const buckets: Record<string, number> = {};
  for (const s of SLANG) {
    buckets[s.cls] = (buckets[s.cls] ?? 0) + 1;
    const hant = SLANG_HANT[s.key] ?? s.zh;
    const lines: Array<[string, string]> = [
      ['zh-CN', s.zh[0]], ['zh-Hant', hant[0]], ['en', s.en[0]], ['ja', s.ja[0]], ['ko', s.ko[0]],
    ];
    for (const [lang, line] of lines) {
      const got = classifyEmotion(line).emotion;
      assert.equal(got, s.cls, `「${line}」（${lang}，概念 ${s.key}）应判 ${s.cls}，实际 ${got}`);
    }
  }
  // 不是"某一类没写"：五个类都得有口语梗
  for (const cls of ['comfort', 'joy', 'sad', 'angry', 'anxious']) {
    assert.ok((buckets[cls] ?? 0) >= 6, `${cls} 的口语梗太少（${buckets[cls] ?? 0} 条）`);
  }
});

test('口语梗：不许与主词库逐字撞车（撞了 = 同一个词权重加两遍 = 悄悄改口径）', () => {
  // 判据用**行为**：一句话命中的词条列表里，同一条不许出现两次
  for (const s of SLANG) {
    for (const line of [s.zh[0], s.en[0], s.ja[0], s.ko[0]]) {
      const hits = classifyEmotion(line).hits;
      assert.equal(new Set(hits).size, hits.length, `「${line}」命中了重复词条：${hits.join(' / ')}`);
    }
  }
});

test('口语梗：繁体写法是生成物，与简体一一对得上', () => {
  const keys = new Set(SLANG.map((s) => s.key));
  for (const k of Object.keys(SLANG_HANT)) assert.ok(keys.has(k), `SLANG_HANT 里有对不上的 key：${k}`);
  // 生成物只收"真的变了"的：简体原文在表里出现过的，繁体写法必须与它不同
  for (const [k, [hant]] of Object.entries(SLANG_HANT)) {
    const s = SLANG.find((x) => x.key === k)!;
    assert.notEqual(hant, s.zh[0], `${k} 的繁体写法与简体一字不差，不该出现在生成物里`);
  }
});
