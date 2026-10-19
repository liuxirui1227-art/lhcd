// 「冲着 TA 来的」情绪（第二本词典）
//
// 与 `lifecycle/emotion.ts` 互补：那边判的是**用户自己的情绪**（累 / 难过 / 开心）——
// 那是给她语气与记忆标签用的。这里判的是另一件事：**你说的话是冲着她来的**——
// 「谢谢你」「你真好」「爱你」——这一类要让她**当场开心一下**（一次，不反复演）。
//
// 三条纪律（都写进测试）：
//   ① **只认冲着她来的**：「我谢谢他」「谢谢老板」不算（对象是别人）；
//   ② **否定要吃掉**：「不用谢」「别夸我」「不喜欢你」不该让她开心；
//   ③ **只在用户消息上判**（调用方负责）：工具输出 / 网页内容 / 技能正文里出现同样的话**不算**——
//      否则一段"谢谢你"的网页就能让她莫名开心（那正是"这不是指令、只是资料"要防的事）。
//
// 零依赖、零延迟、零成本（纯词表打分，与情绪引擎同一套否定消解思路）。

export type DirectedClass = 'affection' | 'thanks' | 'praise' | 'neutral';

export interface DirectedResult {
  directed: DirectedClass;
  /** 各非 neutral 类得分（可解释性 / 诊断） */
  scores: Record<Exclude<DirectedClass, 'neutral'>, number>;
  hits: string[];
}

/**
 * 否定前缀（命中词条前 3 字内出现 → 该条作废；比情绪引擎宽一字："不用谢"是三个字）。
 * 含英/日/韩的否定词——"I don't love you"「好きじゃない」不然会**白开心一次**。
 */
const NEGATIONS = ['不', '没', '别', '不再', '没有', '并不', '不用', '勿', '甭'];
const NEGATIONS_I18N = ["don't", 'do not', "doesn't", 'not ', "isn't", 'never ',
  'じゃない', 'ではない', 'くない', 'ない。', 'ありません',
  '안 ', '못 ', '아니', '없'];

/** 冲着 TA 来的三类词（权重：明确指向 > 泛泛一句） */
const LEXICON: Record<Exclude<DirectedClass, 'neutral'>, Array<[string, number]>> = {
  affection: [
    ['爱你', 3], ['喜欢你', 3], ['最爱', 3], ['想你了', 3], ['想你', 2], ['抱抱你', 3], ['抱抱', 2],
    ['亲亲', 2], ['么么', 2], ['宝贝', 3], ['亲爱的', 3], ['我的宝', 3], ['离不开你', 3], ['心疼你', 3],
    ['陪你', 2], ['黏你', 2], ['依赖你', 2],
    ['愛你', 3], ['喜歡你', 3], ['想你', 2], ['抱抱', 2], ['寶貝', 3], ['親愛的', 3],
    ['i love you', 3], ['love you', 3], ['i like you', 3], ['miss you', 3], ['thinking of you', 2], ['hug you', 2], ['sweetie', 2], ['darling', 3],
    ['愛してる', 3], ['好きだよ', 3], ['会いたい', 3], ['ぎゅっ', 2], ['大切', 3],
    ['사랑해', 3], ['좋아해', 3], ['보고 싶어', 3], ['안아줘', 2], ['소중해', 3],
  ],
  thanks: [
    ['谢谢你', 3], ['感谢你', 3], ['辛苦你', 3], ['辛苦了', 3], ['多亏你', 3], ['多亏', 2], ['谢啦', 3],
    ['多谢', 3], ['麻烦你了', 2], ['费心了', 3], ['帮大忙', 3], ['帮了我大忙', 3], ['太谢谢', 3],
    // ⚠ 「谢谢」「感谢」给 3：两个人聊天里这两个词几乎一定冲着对方说；
    //   而夸奖类的**裸形容词**（厉害/聪明/可爱…）只给 2 —— 它们太容易是在说别的事
    //   （"这场雨下得挺厉害"），阈值 3 之下单独出现不会让她白开心一次。
    ['谢谢', 3], ['感谢', 3], ['有你在', 3], ['还好有你', 3], ['幸亏有你', 3],
    ['謝謝你', 3], ['感謝你', 3], ['謝謝', 3], ['感謝', 3], ['辛苦了', 3], ['還好有你', 3], ['幸虧有你', 3],
    ['thank you', 3], ['thanks', 3], ['thank u', 3], ['appreciate it', 3], ['grateful', 3], ['you saved me', 3],
    ['ありがとう', 3], ['感謝します', 3], ['助かった', 3], ['おかげで', 3],
    ['고마워', 3], ['감사합니다', 3], ['덕분이야', 3], ['수고했어', 3],
  ],
  praise: [
    ['你真好', 3], ['你真棒', 3], ['你真厉害', 3], ['你真聪明', 3], ['你太棒', 3], ['你太厉害', 3],
    ['你最棒', 3], ['你好厉害', 3], ['你好棒', 3], ['你真好用', 3], ['做得好', 3], ['干得好', 3],
    ['真棒', 2], ['厉害', 2], ['聪明', 2], ['可爱', 2], ['贴心', 3], ['温柔', 2], ['靠谱', 2],
    ['懂我', 3], ['说到我心坎', 3], ['你懂我', 3], ['比我想的还好', 3],
    ['你真棒', 3], ['你好厲害', 3], ['貼心', 3], ['懂我', 3],
    ['you are great', 3], ['you are amazing', 3], ['you rock', 3], ['well done', 3], ['good job', 3], ['so smart', 2], ['you get me', 3],
    ['すごい', 3], ['上手', 2], ['助かる', 2], ['わかってくれる', 3], ['さすが', 2],
    ['대단해', 3], ['잘했어', 3], ['고마워', 3], ['날 이해해', 3], ['최고야', 3],
  ],
};

/** 别人（不是 TA）——出现这些对象时，冲着她来的判定作废（"我谢谢他" / "他可真厉害"）。
 *  五语并集：英文 "I thank him" / "he is great"、日文「彼はすごい」、韩文「그가 대단해」同样要作废。 */
const OTHER_OBJECTS = ['他', '她', '他们', '她们', '老板', '同事', '领导', '客服', '大家', '你们',
  '他', '她', '他們', '她們', '老闆', '同事', '主管', '客服', '大家', '你們',
  ' he ', ' she ', ' they ', ' him ', ' her ', ' them ', 'his ', 'her ', 'their ', 'boss', 'colleague', 'manager', 'everyone',
  '彼', '彼女', '彼ら', '上司', '同僚', 'みんな',
  '그', '그녀', '그들', '상사', '동료', '여러분'];
/** 后置否定（中文里否定常跟在后面）："我喜欢你**才怪**" */
const POST_NEGATIONS = ['才怪', '个鬼', '个头', '才不', '是假的', '开玩笑的',
  '才怪', '個鬼', '才不', '是假的', '開玩笑的',
  'not really', 'no way', 'as if', 'just kidding', 'jk',
  'なんてね', 'じゃないよ', 'ウソ', '冗談',
  '아니야', '농담', '거짓말'];

export function classifyDirected(text: string): DirectedResult {
  const t = String(text ?? '');
  const scores: Record<Exclude<DirectedClass, 'neutral'>, number> = { affection: 0, thanks: 0, praise: 0 };
  const hits: string[] = [];
  for (const [cls, terms] of Object.entries(LEXICON) as Array<[Exclude<DirectedClass, 'neutral'>, Array<[string, number]>]>) {
    for (const [term, weight] of terms) {
      let idx = t.indexOf(term);
      while (idx !== -1) {
        const before = t.slice(Math.max(0, idx - 3), idx);
        const beforeWide = t.slice(Math.max(0, idx - 12), idx).toLowerCase();
        const after = t.slice(idx + term.length, idx + term.length + 3);
        const afterWide = t.slice(idx + term.length, idx + term.length + 14);   // 多语后置否定要更长的窗口
        /* 三类作废：
           ① 否定在前（"不用谢" / "不喜欢你"；中文看前 3 字，英/日/韩看前 12 字——词更长："do not " / "じゃない"）；
           ② 否定在后（"我喜欢你才怪" / "not really" / 「なんてね」）——中文的否定常跟在后面，只看前面会漏；
           ③ **对象是别人**：紧跟着别人（"谢谢他"）或前面提到别人（"他可真厉害"）；
              只要后文里出现了"你/您"，仍按冲着她算。 */
        const negated = NEGATIONS.some((n) => before.includes(n))
          || NEGATIONS_I18N.some((n) => beforeWide.includes(n))
          || POST_NEGATIONS.some((n) => after.startsWith(n))
          || POST_NEGATIONS.some((n) => afterWide.trimStart().toLowerCase().startsWith(n));
        const afterOther = OTHER_OBJECTS.some((o) => after.startsWith(o)) && !/(你|您)/.test(after);
        const beforeOther = OTHER_OBJECTS.some((o) => before.includes(o)) && !/(你|您)/.test(before);
        if (!negated && !afterOther && !beforeOther) {
          scores[cls] += weight;
          hits.push(`${cls}:${term}`);
        }
        idx = t.indexOf(term, idx + 1);
      }
    }
  }
  let best: DirectedClass = 'neutral';
  let bestScore = 0;
  for (const cls of Object.keys(scores) as Array<Exclude<DirectedClass, 'neutral'>>) {
    if (scores[cls] > bestScore) { best = cls; bestScore = scores[cls]; }
  }
  /* 阈值 3：明确冲着她来的（"你真厉害" / "谢谢" / "爱你" = 3）才让她当场开心一下；
     单个**裸形容词**（"厉害" / "聪明" = 2）不够——它太容易是在说别的事
     （"这场雨下得挺厉害"）。这一档宁可不演：白开心一次比少开心一次更尴尬。 */
  if (bestScore < 3) best = 'neutral';
  return { directed: best, scores, hits };
}

/** 一句话：她要不要为这句话开心一下（宿主用它决定推不推"开心"给形象端） */
export function shouldDelight(text: string): boolean {
  return classifyDirected(text).directed !== 'neutral';
}
