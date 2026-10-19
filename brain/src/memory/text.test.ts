// 中文召回（CJK 重叠双字 + 连续命中）：长中文句里带两字词能命中。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeQuery, entryText, isCjk, scoreText, scoreTerms, textSimilarity, tokenize } from './text.js';

test('isCjk：中日韩命中，拉丁/数字/标点不命中', () => {
  for (const ch of ['项', '目', 'ひ', 'カ', '가', '鿿']) assert.equal(isCjk(ch), true, ch);
  for (const ch of ['A', 'a', '1', '，', ' ', '_']) assert.equal(isCjk(ch), false, ch);
});

test('tokenize：两字词整词查询与旧行为一致（不回归）', () => {
  assert.deepEqual(tokenize('滑雪'), ['滑雪']);
  assert.deepEqual(tokenize('日本'), ['日本']);
  // 英文/空白段原样
  assert.deepEqual(tokenize('TypeScript API'), ['typescript', 'api']);
});

test('tokenize：长中文句切重叠双字（洞的正面）', () => {
  assert.deepEqual(tokenize('那个项目'), ['那个', '个项', '项目']);
  assert.deepEqual(tokenize('上次我们聊的那个项目'), ['上次', '次我', '我们', '们聊', '聊的', '的那', '那个', '个项', '项目']);
  // 标点/空白分段，各自切双字
  assert.deepEqual(tokenize('项目，日本'), ['项目', '日本']);
});

test('tokenize：混排（中文夹英文）两侧都保留', () => {
  assert.deepEqual(tokenize('修改youer服务端'), ['修改', 'youer', '服务', '务端']);
  assert.deepEqual(analyzeQuery('修改youer服务端').cjk, '修改服务端');
});

test('tokenize：单字 CJK 保留单字（不把 1 字查询变成 0 词）', () => {
  assert.deepEqual(tokenize('猫'), ['猫']);
});

test('scoreText：长中文句里的两字词能命中（验收核心）', () => {
  const text = entryText({ name: 'project.linghe', description: '用户在做的桌面数字人项目', tags: [], content: '灵核项目，一个能装在自己电脑上的数字人' });
  const hit = scoreText(text, '上次我们聊的那个项目后来怎么样了');
  assert.ok(hit.bestRun >= 2, `bestRun=${hit.bestRun}`);
  assert.ok(hit.score >= 0.45, `score=${hit.score}`); // 两字词命中即达 0.45 兜底
  assert.equal(scoreText(text, '今天天气不错适合出门散步').score, 0);
});

test('scoreText：连续命中越长分越高（2 字 < 3 字 < 4 字）', () => {
  const text = '用户喜欢滑雪场里的雪';
  const two = scoreText(text, '滑雪');         // 1 个双字命中 → run 2
  const three = scoreText(text, '滑雪场');      // 2 个相邻双字 → run 3
  const four = scoreText(text, '喜欢滑雪');     // 3 个相邻双字 → run 4
  assert.equal(two.bestRun, 2);
  assert.equal(three.bestRun, 3);
  assert.equal(four.bestRun, 4);
  assert.ok(three.score >= 0.72 && four.score >= 0.9, `${three.score}/${four.score}`);
  assert.ok(two.score <= three.score && three.score <= four.score);
});

test('scoreText：长句里 boost 是主力（否则 cover 被词数稀释）', () => {
  const text = '用户喜欢滑雪场里的雪';
  const longTwo = scoreText(text, '你还记得我上次说的那个滑雪的事情吗');
  const longFour = scoreText(text, '你还记得我上次说的喜欢滑雪的事情吗');
  assert.ok(longTwo.score >= 0.45, `longTwo=${longTwo.score}`);
  assert.ok(longFour.score >= 0.9, `longFour=${longFour.score}`);
  assert.ok(longFour.score > longTwo.score);
});

test('scoreText：命中多个独立词 > 只命中一个常见词（并列打破）', () => {
  const q = '你还记得我上次说的那个项目吗，现在做得怎么样了';
  const a = scoreText('用户在做灵核项目', q);
  const b = scoreText('用户现在每天很忙', q);
  assert.equal(a.hits, 2); // 项目 + 在做
  assert.equal(b.hits, 1); // 只有 现在
  assert.ok(a.score > b.score, `${a.score} > ${b.score}`);
});

test('scoreText：高词频不塌成平台（猫×6 > 猫×2，且都 ≤ 1）', () => {
  const many = scoreText('用户养了两只猫，猫，猫', '猫');
  const few = scoreText('用户曾经养过一只猫', '猫');
  assert.ok(many.score > few.score, `${many.score} > ${few.score}`);
  assert.ok(many.score <= 1 && few.score <= 1);
});

test('scoreText：非连续命中不虚高（双字散落 ≠ 连续短语）', () => {
  // "项目" 与 "日本" 都命中，但中间的双字（目日）不命中 → run 只有 2，不得按整段算
  const scattered = scoreText('项目要点：日本市场调研', '项目日本');
  assert.ok(scattered.bestRun === 2, `bestRun=${scattered.bestRun}`);
  assert.ok(scattered.score < 0.9, `score=${scattered.score}`);
});

test('scoreText：英文路径保持可用（词命中 + 词频）', () => {
  assert.ok(scoreText('user prefers blue', 'blue').score > 0);
  assert.ok(scoreText('blue blue blue', 'blue').score > scoreText('blue', 'blue').score);
  assert.equal(scoreText('user prefers blue', 'skiing').score, 0);
  assert.equal(scoreText('任何文本', '').score, 0);
});

test('scoreTerms：空词表（纯标点查询）返回 0', () => {
  const q = analyzeQuery('，。、');
  assert.deepEqual(q.terms, []);
  assert.equal(scoreTerms('用户喜欢猫', q).score, 0);
});

// ── 分段按 Unicode（五语一套口径）+ 简繁归一 ──

test('分段：标点/符号/emoji 一律不算检索词（五种语言同一套口径）', () => {
  assert.deepEqual(tokenize('项目进度怎么样？'), ['项目', '目进', '进度', '度怎', '怎么', '么样']);
  assert.deepEqual(tokenize('How is the project going?'), ['how', 'is', 'the', 'project', 'going']);
  assert.deepEqual(tokenize('my manager asked me for the report!'), ['my', 'manager', 'asked', 'me', 'for', 'the', 'report']);
  assert.deepEqual(tokenize('プロジェクトの進捗はどう？').slice(-1), ['どう']);
  assert.deepEqual(tokenize('프로젝트 진행 상황은?').slice(-1), ['황은']);
  assert.deepEqual(tokenize('进度🎉如何'), ['进度', '如何']); // emoji 与逗号一样是分隔符：不跨段拼双字
  // 逗号句号那套旧行为不许回归（词表里已有的断言）
  assert.deepEqual(tokenize('项目，日本'), ['项目', '日本']);
  assert.deepEqual(tokenize('TypeScript API'), ['typescript', 'api']);
});

test('简繁归一：繁体问句打简体记忆，与简体问句**同分**（14 号 §5.2 那一层）', () => {
  const hansMem = '项目进度：这周把登录流程收尾';
  const hantMem = '專案進度：這週把登入流程收尾';
  const hansQ = scoreText(hansMem, '项目进度');
  const hantQ = scoreText(hansMem, '專案進度');
  assert.equal(hantQ.score, hansQ.score, `简体问句 ${hansQ.score} / 繁体问句 ${hantQ.score}`);
  assert.ok(hansQ.score >= 0.9, `score=${hansQ.score}`);
  // 反方向：简体问句打繁体记忆（用户在繁体界面下存过的东西）
  assert.equal(scoreText(hantMem, '项目进度').score, hansQ.score);
  assert.equal(scoreText(hantMem, '專案進度').score, hansQ.score);
  // 长句里的繁体问法也认（不是只认整词）
  assert.ok(scoreText(hansMem, '你还记得專案進度吗').score >= 0.45);
});

test('简繁归一：一对多的候选都试（资料/数据、本机/本地都算命中）', () => {
  assert.ok(scoreText('用户的数据备份在移动硬盘', '使用者的資料備份').score >= 0.45);
  assert.ok(scoreText('用户把资料整理成了表格', '使用者的資料').score >= 0.45);
  // `本機` 的两条路都得留着：整词那条给"本地"，逐字那条给"本机"
  assert.ok(scoreText('用户把文件存在本地磁盘', '本機').score >= 0.45, '本地那条');
  assert.ok(scoreText('用户的本机环境是 macOS', '本機').score >= 0.45, '本机那条');
});

test('五语同判：同一件事用五种语言说，判断一致（有就命中、没有就给 0）', () => {
  const cases: Array<[string, string, string]> = [
    ['zh-CN', '用户最喜欢吃的食物是火锅', '火锅'],
    ['zh-Hant', '使用者最喜歡吃的食物是火鍋', '火鍋'],
    ['en', 'the user likes hot pot the most', 'hot pot'],
    ['ja', 'ユーザーが一番好きな食べ物は火鍋です', '火鍋'],
    ['ko', '사용자가 가장 좋아하는 음식은 훠궈입니다', '훠궈'],
  ];
  for (const [lang, mem, q] of cases) {
    assert.ok(scoreText(mem, q).score >= 0.45, `${lang}：记得却搜不到（${scoreText(mem, q).score}）`);
    assert.equal(scoreText(mem, '滑雪').score, 0, `${lang}：没提过却给分`);
  }
});

test('分词矩阵：日文（假名/汉字混排、片假名长音、送假名差异）都认得出', () => {
  const cases: Array<[string, string]> = [
    ['プロジェクトの進捗は順調です', 'プロジェクトの進捗はどうですか'],
    ['ユーザーは毎日頑張っている', 'がんばってる？'],            // 平假名口语形
    ['コーヒーを飲むのが好き', 'コーヒーは好き？'],
    ['新しいプロジェクトを始めた', '新しいプロジェクトの話'],
    ['申し込みの締め切りは金曜日', '申込の締切はいつ'],          // 送假名/缩略差异：认得出但只到 0.45 那档
    ['コンピューターを買い替えた', 'コンピュータの調子は'],        // 长音省略
  ];
  for (const [mem, q] of cases) {
    const r = scoreText(mem, q);
    assert.ok(r.score >= 0.45, `「${q}」应认得出（${r.score}）`);
  }
});

test('分词矩阵：韩文（助词变化、空格不一致、动词活用）都认得出', () => {
  const cases: Array<[string, string]> = [
    ['프로젝트 진행 상황은 순조롭다', '프로젝트 진행 상황은 어때'],
    ['사용자는 매일 운동을 한다', '운동을 좋아해'],              // 을/를 助词
    ['보고서를 다 썼다', '보고서는 끝났어'],                     // 를 → 는
    ['매일 아침 커피를 마신다', '커피 마셔'],
    ['어제 김치를 먹었다', '어제 뭐 먹었어'],                    // 动词活用：靠别的词兜住
    ['잘 지내고 있어', '잘지내?'],                              // 空格不一致
  ];
  for (const [mem, q] of cases) {
    const r = scoreText(mem, q);
    assert.ok(r.score >= 0.45, `「${q}」应认得出（${r.score}）`);
  }
});

test('分词矩阵：跨语言的"同一句话"不假装认得（那是 embedding 的活）', () => {
  // 日语问句搜中文记忆要靠向量通道（目前是空槽）——
  // 确定性分词**不该**在这里给分，给了就是假命中。
  assert.equal(scoreText('用户最喜欢吃的食物是火锅', 'What is my favorite food').score, 0);
  assert.equal(scoreText('사용자가 가장 좋아하는 음식은 훠궈입니다', '火锅').score, 0);
});

/* ── 跨体去重 ──────────────────────────────────────────────────────────────── */

test('跨体相似度：简繁说同一件事 = 1.00（这是去重能成立的前提）', () => {
  const same: Array<[string, string]> = [
    ['用户最喜欢吃的食物是火锅', '使用者最喜歡吃的食物是火鍋'],
    ['用户把项目进度记录在飞书文档里', '使用者把專案進度記錄在飛書文件裡'],
    ['我今天很累，撑不住了', '我今天很累，撐不住了'],
    ['猫的名字叫豆豆', '貓的名字叫豆豆'],
  ];
  for (const [a, b] of same) {
    const s = textSimilarity(a, b);
    assert.equal(s.contain, 1, `contain ${a} / ${b}`);
    assert.equal(s.jaccard, 1, `jaccard ${a} / ${b}`);
  }
});

test('跨体相似度：同主语换了值 ≠ 重复（火锅/拉面 不该被当成同一件事）', () => {
  assert.deepEqual(textSimilarity('用户最喜欢吃的食物是火锅', '用户最喜欢吃的食物是火锅'), { contain: 1, jaccard: 1 });
  const dup = textSimilarity('用户最喜欢吃的食物是火锅', '用户最喜欢吃的食物是拉面');
  assert.ok(dup.jaccard < 0.8, `jaccard=${dup.jaccard}`);
  assert.equal(textSimilarity('用户最喜欢吃的食物是火锅', '明天要去杭州出差').contain, 0);
});

test('跨体相似度：判定与写法无关（简体问、繁体存，两边一样）', () => {
  const a = textSimilarity('用户养了两只猫', '猫的名字叫豆豆');
  const b = textSimilarity('用戶養了兩隻貓', '貓的名字叫豆豆');
  assert.equal(a.jaccard, b.jaccard, `${a.jaccard} vs ${b.jaccard}`);
});
