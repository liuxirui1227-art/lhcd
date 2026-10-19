// 情绪识别引擎（发布门槛：标注语料 F1 ≥ 0.8）。
// 方案：词库加权打分 + 否定消解 + 强度加成；零依赖、零延迟、零成本（本地即时分类）。
// 分类：comfort（求安慰/疲惫）| joy（开心）| sad（难过）| angry（生气）| anxious（焦虑/害怕）| neutral。
// 测评脚本：eval/emotion-eval.mjs（标注语料 eval/emotion-corpus.jsonl）。

export type EmotionClass = 'comfort' | 'joy' | 'sad' | 'angry' | 'anxious' | 'neutral';

/** 词库：每类若干词条 [词, 权重1~3] */
import { LEXICON_HANT, SLANG_HANT } from './emotion-hant.js';

const LEXICON: Record<Exclude<EmotionClass, 'neutral'>, Array<[string, number]>> = {
  comfort: [
    ['累', 2], ['累了', 2], ['好累', 3], ['疲惫', 3], ['心累', 3], ['加班', 2], ['通宵', 2], ['熬夜', 2],
    ['撑不住', 3], ['撑不下去了', 3], ['扛不住', 3], ['崩溃', 3], ['崩溃了', 3], ['崩了', 2], ['想哭', 3], ['哭', 2], ['大哭', 3],
    ['难受', 2], ['心里堵', 3], ['委屈', 3], ['压力好大', 3], ['压力大', 2], ['喘不过气', 3],
    ['不想说话', 3], ['什么都不想说', 3], ['安慰', 2], ['抱抱', 2], ['陪陪我', 3], ['求安慰', 3], ['陪陪我', 2],
    ['失眠', 2], ['睡不着', 2], ['emo', 2], ['Emo', 2], ['低落', 2], ['没动力', 2], ['好难', 2], ['太难了', 2], ['这么难', 2],
    ['想家', 3], ['想他们', 2], ['靠一靠', 3], ['糟透了', 3], ['被掏空', 3], ['头昏脑涨', 2], ['怀疑人生', 2],
    ['状态很差', 2], ['需要安慰', 2], ['被骂', 2], ['甩锅', 2], ['一个人待着', 2], ['安静待着', 2], ['提不起劲', 2],
    ['心塞', 2], ['好辛苦', 2], ['不容易', 1], ['憋得慌', 2], ['喘口气', 2], ['放空', 1], ['硬撑', 2], ['撑着', 2],
  ],
  joy: [
    ['开心', 3], ['高兴', 3], ['太棒', 3], ['太好了', 3], ['哈哈', 3], ['哈哈哈', 3], ['嘻嘻', 2], ['嘿嘿', 2],
    ['开心死', 3], ['激动', 2], ['兴奋', 2], ['幸福', 3], ['惊喜', 2], ['真香', 2], ['顺利', 2], ['通过', 1],
    ['上岸', 2], ['上岸了', 3], ['升职', 2], ['加薪', 2], ['中奖', 3], ['脱单', 2], ['表白成功', 3], ['拿下了', 2], ['成了', 1],
    ['好吃', 1], ['好玩', 1], ['超开心', 3], ['开心到', 3], ['庆祝', 2], ['耶', 2], ['🎉', 3],
    ['美滋滋', 3], ['骄傲', 2], ['放心了', 3], ['一身轻', 3], ['心情也好', 2], ['被夸', 2], ['夸好吃', 2],
    ['运气爆棚', 3], ['夺冠', 3], ['拿到offer', 3], ['拿到 offer', 3], ['offer', 2], ['全对', 2], ['满分', 2], ['涨了', 1],
  ],
  sad: [
    ['难过', 3], ['伤心', 3], ['失落', 3], ['沮丧', 3], ['绝望', 3], ['心碎', 3], ['分手', 2], ['失恋', 3],
    ['去世', 3], ['失去了', 2], ['失去', 1], ['遗憾', 2], ['后悔', 2], ['孤独', 3],
    ['孤单', 3], ['寂寞', 3], ['被抛弃', 3], ['抛弃', 2], ['没人理解', 3], ['好难过', 3], ['心疼', 2], ['眼泪', 2],
    ['流泪', 2], ['呜呜', 3], ['唉', 1], ['不开心', 2], ['不快乐', 2], ['没意思', 2],
    ['都走了', 2], ['只剩我一个', 3], ['只剩我一个人', 3], ['失业', 2], ['天塌了', 3], ['回不去', 2], ['走散了', 3], ['走散', 2],
    ['空荡荡', 3], ['空空的', 2], ['落空了', 3], ['落空', 2], ['想放弃了', 3], ['想放弃', 2], ['闹掰', 3],
    ['这段感情', 2], ['心很痛', 3], ['心好痛', 3], ['哭了一整天', 3], ['哭了一天', 3], ['眼泪止不住', 3],
    ['降级了', 2], ['想她', 3], ['想他', 3], ['舍不得', 2], ['再也见不到', 3], ['永远的', 1], ['心空了', 3], ['空落落', 3],
  ],
  angry: [
    ['生气', 3], ['气死', 3], ['气死我了', 3], ['愤怒', 3], ['火大', 3], ['恼火', 3], ['可恶', 2], ['过分', 2],
    ['烦死', 3], ['烦死了', 3], ['真烦', 3], ['烦人', 2], ['讨厌', 2], ['凭什么', 2], ['不公平', 2],
    ['太气人', 3], ['想骂人', 3], ['混蛋', 3], ['妈的', 3], ['滚', 2], ['受不了了', 2], ['忍不了', 2],
    ['气不过', 3], ['火了', 2], ['不想干了', 2], ['被坑', 2], ['欺负', 2], ['怼', 2], ['骂', 2], ['气炸', 3],
    ['受够了', 3], ['受够', 2], ['被宰', 2], ['变卦', 2], ['指手画脚', 2], ['抢了', 1], ['否决', 2],
    ['忍无可忍', 3], ['活该', 2], ['翻脸', 2], ['恶心', 2], ['离谱', 2], ['踢皮球', 2], ['画饼', 2],
  ],
  anxious: [
    ['焦虑', 3], ['紧张', 2], ['害怕', 3], ['担心', 2], ['不安', 3], ['恐慌', 3], ['慌', 2], ['怕', 1],
    ['恐惧', 3], ['睡不着觉', 2], ['怎么办', 2], ['不知道怎么办', 3], ['迷茫', 2], ['没底', 2], ['忐忑', 3],
    ['心慌', 3], ['冒冷汗', 3], ['手心冒汗', 3], ['不确定', 1], ['万一', 2], ['明天就', 1], ['要面试', 2], ['要考试', 2],
    ['deadline', 2], ['ddl', 2], ['来不及', 2], ['做不完', 2], ['完蛋', 2], ['担忧', 2], ['纠结', 1],
    ['复查', 2], ['吓死', 3], ['吓坏了', 3], ['着急', 2], ['赶不上', 2], ['怕搞砸', 3], ['怕失望', 2],
    ['盗刷', 2], ['答辩', 2], ['体检', 1], ['手术', 2], ['被拒', 2], ['挂科', 2], ['挂科了', 2], ['没复习完', 2],
  ],
};

/**
 * 其他语言的词库（与中文表同一口径：五种语言一起参与匹配）。
 *
 * 为什么是**并集匹配**而不是"按界面语言选一套"：用户可能界面是中文却在说英语，
 * 也可能界面是英文却在说中文——语言识别不该由设置决定。所以**所有语言的词库一起参与匹配**，
 * 谁的权重高算谁。这样"英文用户不会被当成没有情绪"，中文用户也不会因为切成英文就丢掉情绪识别。
 *
 * 词条口径与中文表一致：**只收"说出来就是在表达这种情绪"的话**（不收中性词、不收纯符号）。
 */
const LEXICON_I18N: Record<Exclude<EmotionClass, 'neutral'>, Record<'en' | 'ja' | 'ko', Array<[string, number]>>> = {
  comfort: {
    en: [['tired', 3], ['exhausted', 3], ['burned out', 3], ['burnt out', 3], ['so tired', 3], ['stressed', 2], ['overwhelmed', 3], ['can\'t keep up', 3], ['want to cry', 3], ['crying', 2], ['feel awful', 3], ['rough day', 3], ['need a break', 2], ['give me a hug', 2], ['stay with me', 2], ['lonely night', 2]],
    ja: [['疲れた', 3], ['つかれた', 3], ['疲れました', 3], ['しんどい', 3], ['へとへと', 3], ['泣きたい', 3], ['つらい', 3], ['辛い', 3], ['きつい', 2], ['落ち込んで', 3], ['眠れない', 2], ['不安で', 2], ['そばにいて', 3], ['慰めて', 3], ['頑張りすぎ', 2], ['限界', 3]],
    ko: [['힘들어', 3], ['피곤해', 3], ['지쳤어', 3], ['너무 힘들어', 3], ['번아웃', 3], ['울고 싶어', 3], ['속상해', 3], ['위로해줘', 3], ['같이 있어줘', 3], ['잠이 안 와', 2], ['스트레스', 2], ['버티기 힘들어', 3], ['지쳐서', 3], ['서운해', 2], ['외로워', 3], ['한계', 3]],
  },
  joy: {
    en: [['happy', 3], ['so happy', 3], ['great news', 3], ['awesome', 3], ['amazing', 3], ['excited', 3], ['yay', 2], ['hooray', 3], ['celebrate', 2], ['got the job', 3], ['promotion', 2], ['passed', 2], ['finally', 2], ['love it', 3], ['delighted', 3], ['best day', 3]],
    ja: [['嬉しい', 3], ['うれしい', 3], ['楽しい', 3], ['やった', 3], ['最高', 3], ['よかった', 3], ['成功した', 2], ['受かった', 3], ['昇進', 2], ['お祝い', 2], ['幸せ', 3], ['テンション上がる', 2], ['うれしすぎ', 3], ['ラッキー', 2], ['やり遂げた', 3], ['気分いい', 2]],
    ko: [['기뻐', 3], ['행복해', 3], ['좋아', 2], ['신나', 3], ['최고', 3], ['다행이다', 3], ['합격했어', 3], ['승진', 2], ['축하', 2], ['성공했어', 3], ['너무 좋아', 3], ['기분 좋아', 3], ['해냈어', 3], ['운 좋아', 2], ['즐거워', 3], ['웃겨', 2]],
  },
  sad: {
    en: [['sad', 3], ['so sad', 3], ['depressed', 3], ['heartbroken', 3], ['broke up', 3], ['lost him', 3], ['lost her', 3], ['miss you', 2], ['miss them', 2], ['lonely', 3], ['alone', 2], ['disappointed', 3], ['regret', 2], ['cried', 3], ['grief', 3], ['passed away', 3]],
    ja: [['悲しい', 3], ['かなしい', 3], ['寂しい', 3], ['さみしい', 3], ['つまらない', 2], ['失恋', 3], ['別れた', 2], ['亡くなった', 3], ['会いたい', 2], ['後悔', 2], ['落ち込む', 3], ['涙が出た', 3], ['がっかり', 3], ['孤独', 3], ['悲しすぎる', 3], ['喪失', 2]],
    ko: [['슬퍼', 3], ['너무 슬퍼', 3], ['우울해', 3], ['외로워', 3], ['쓸쓸해', 3], ['헤어졌어', 3], ['이별', 3], ['보고 싶어', 2], ['후회돼', 2], ['실망했어', 3], ['눈물 났어', 3], ['돌아가셨어', 3], ['상실감', 2], ['서글퍼', 3], ['낙담', 2], ['마음 아파', 3]],
  },
  angry: {
    en: [['angry', 3], ['so angry', 3], ['furious', 3], ['annoyed', 2], ['frustrated', 3], ['unfair', 3], ['ridiculous', 3], ['unacceptable', 3], ['fed up', 3], ['sick of', 3], ['hate this', 3], ['drives me nuts', 3], ['pissed', 3], ['mad at', 3], ['nonsense', 2], ['blame', 2]],
    ja: [['腹立つ', 3], ['むかつく', 3], ['イライラ', 3], ['許せない', 3], ['ふざけるな', 3], ['ありえない', 3], ['ひどい', 2], ['不公平', 2], ['うんざり', 3], ['最悪', 3], ['頭にきた', 3], ['怒り', 3], ['意味不明', 2], ['冗談でしょ', 2], ['嫌になる', 2], ['我慢できない', 3]],
    ko: [['화나', 3], ['화났어', 3], ['짜증나', 3], ['열받아', 3], ['빡쳐', 3], ['억울해', 3], ['말도 안 돼', 3], ['어이없어', 3], ['불공평', 2], ['지겨워', 3], ['최악', 3], ['못 참겠어', 3], ['미치겠어', 3], ['싫어', 2], ['답답해', 3], ['화가 나', 3]],
  },
  anxious: {
    en: [['anxious', 3], ['nervous', 3], ['worried', 3], ['scared', 3], ['afraid', 3], ['panic', 3], ['deadline', 2], ['what if', 2], ['not sure', 1], ['overthinking', 3], ['can\'t sleep', 2], ['interview tomorrow', 2], ['exam tomorrow', 2], ['running out of time', 3], ['stressed out', 3], ['freaking out', 3]],
    ja: [['不安', 3], ['心配', 3], ['緊張', 3], ['怖い', 3], ['こわい', 3], ['焦って', 3], ['間に合わない', 3], ['どうしよう', 3], ['締め切り', 2], ['プレッシャー', 3], ['迷って', 2], ['パニック', 3], ['眠れない', 2], ['面接', 2], ['試験', 2], ['失敗しそう', 3]],
    ko: [['불안해', 3], ['걱정돼', 3], ['긴장돼', 3], ['무서워', 3], ['두려워', 3], ['초조해', 3], ['어떡하지', 3], ['시간 없어', 3], ['마감', 2], ['압박감', 3], ['망설여', 2], ['공황', 3], ['잠이 안 와', 2], ['면접', 2], ['시험', 2], ['실수할까 봐', 3]],
  },
};

/**
 * 口语梗——**翻译解决不了的那一层**。
 *
 * 情绪词库能翻，**俚语不能**——"破防了"没有英文对应词，
 * "I'm running on empty" 也不是"我很累"的字面翻译。中文用户说「破防了」能被认出来，
 * 英文用户说 "that hit me hard"、日文用户说「立ち直れない」、韩文用户说「멘탈 나갔어」
 * 却是同一个情绪——**这四句话必须得到同一个判断**。
 *
 * 做法：不写"翻译表"，写**同一件事的四种说法**，一条概念一行——于是"五种语言一致"变成**可断言的结构**：
 *   · 每个概念四种语言都得有说法（少一种，单测就红）；
 *   · 每条说法判出来的情绪类必须与这个概念一致（单测逐条跑）；
 *   · 繁体是**生成**的（`SLANG_HANT`，同 `LEXICON_HANT` 一份映射）。
 *
 * ⚠ **未过母语者校对**：这些是按各语言真实口语写的，
 *   但"够不够地道 / 现在还在不在用"得请母语者看一眼。清单就是这张表，逐行可核对。
 */
export interface SlangConcept {
  /** 概念名（英文小写连字符；只用于测试报错时指出是哪一条） */
  key: string;
  /** 归属情绪类 */
  cls: Exclude<EmotionClass, 'neutral'>;
  zh: [string, number];
  en: [string, number];
  ja: [string, number];
  ko: [string, number];
}

export const SLANG: SlangConcept[] = [
  // ── 求安慰 / 疲惫 ──
  { key: 'drained-dry', cls: 'comfort', zh: ['被榨干了', 3], en: ['running on empty', 3], ja: ['心がすり減った', 3], ko: ['진이 빠졌어', 3] },
  { key: 'cant-move', cls: 'comfort', zh: ['一点都不想动', 3], en: ['can\'t move a muscle', 3], ja: ['動けない', 3], ko: ['몸이 안 움직여', 3] },
  { key: 'heart-tired', cls: 'comfort', zh: ['心好累', 3], en: ['my heart is tired', 3], ja: ['心が疲れた', 3], ko: ['마음이 지쳤어', 3] },
  { key: 'hide-away', cls: 'comfort', zh: ['想躲起来', 3], en: ['want to hide away', 3], ja: ['消えたい', 3], ko: ['숨고 싶어', 3] },
  { key: 'need-hug', cls: 'comfort', zh: ['想要一个拥抱', 3], en: ['could use a hug', 3], ja: ['抱きしめてほしい', 3], ko: ['안아줬으면 좋겠어', 3] },
  { key: 'no-breath', cls: 'comfort', zh: ['忙到没空喘气', 2], en: ['no time to breathe', 2], ja: ['息つく暇もない', 3], ko: ['숨 쉴 틈도 없어', 3] },
  // ── 开心 ──
  { key: 'light-body', cls: 'joy', zh: ['整个人都轻了', 2], en: ['walking on air', 3], ja: ['体が軽い', 3], ko: ['몸이 가벼워', 3] },
  { key: 'worth-it', cls: 'joy', zh: ['值了', 2], en: ['worth it', 2], ja: ['やってよかった', 3], ko: ['할 만했어', 2] },
  { key: 'lucky-burst', cls: 'joy', zh: ['运气好到爆', 3], en: ['hit the jackpot', 3], ja: ['運が良すぎる', 3], ko: ['운이 미쳤어', 2] },
  { key: 'finally-day', cls: 'joy', zh: ['终于等到这一天', 3], en: ['finally the day came', 3], ja: ['やっとこの日が来た', 3], ko: ['드디어 이 날이 왔어', 3] },
  { key: 'praised-float', cls: 'joy', zh: ['被夸得飘了', 2], en: ['so flattered', 3], ja: ['褒められて舞い上がってる', 3], ko: ['칭찬받아서 신나', 3] },
  { key: 'cant-stop-laugh', cls: 'joy', zh: ['笑到停不下来', 3], en: ['can\'t stop laughing', 3], ja: ['笑いが止まらない', 3], ko: ['웃음이 멈추지 않아', 3] },
  // ── 难过 ──
  { key: 'breakdown-hit', cls: 'sad', zh: ['破防了', 3], en: ['that hit me hard', 3], ja: ['立ち直れない', 3], ko: ['멘탈 나갔어', 3] },
  { key: 'low-all-night', cls: 'sad', zh: ['整晚都很难受', 3], en: ['in my feels all night', 3], ja: ['夜中ずっと沈んでた', 3], ko: ['밤새 우울했어', 3] },
  { key: 'tears-wont-stop', cls: 'sad', zh: ['眼泪控制不住', 3], en: ['tears won\'t stop', 3], ja: ['涙が止まらない', 3], ko: ['눈물이 멈추지 않아', 3] },
  { key: 'empty-inside', cls: 'sad', zh: ['心里空落落的', 3], en: ['feeling empty inside', 3], ja: ['ぽっかり穴が空いたみたい', 3], ko: ['마음이 텅 빈 것 같아', 3] },
  { key: 'no-more-chance', cls: 'sad', zh: ['再也没有机会了', 3], en: ['never get the chance again', 2], ja: ['もう二度と会えない', 3], ko: ['다시는 못 만나', 3] },
  { key: 'back-to-then', cls: 'sad', zh: ['好想回到从前', 3], en: ['wish I could go back', 3], ja: ['あの頃に戻りたい', 3], ko: ['그때로 돌아가고 싶어', 3] },
  // ── 生气 ──
  { key: 'blood-boil', cls: 'angry', zh: ['火一下就上来了', 3], en: ['my blood is boiling', 3], ja: ['血が上った', 3], ko: ['피가 거꾸로 솟아', 3] },
  { key: 'treated-like-idiot', cls: 'angry', zh: ['把人当傻子', 3], en: ['treating me like an idiot', 3], ja: ['バカにしてる', 3], ko: ['사람을 무시해', 3] },
  { key: 'speechless-anger', cls: 'angry', zh: ['气到说不出话', 3], en: ['too angry for words', 3], ja: ['怒りで言葉が出ない', 3], ko: ['화가 나서 말이 안 나와', 3] },
  { key: 'cant-let-slide', cls: 'angry', zh: ['这口气咽不下', 3], en: ['I can\'t let this slide', 3], ja: ['このままじゃ納得できない', 3], ko: ['이건 그냥 넘어갈 수 없어', 3] },
  { key: 'stood-up', cls: 'angry', zh: ['又被放鸽子', 3], en: ['stood up again', 3], ja: ['またドタキャンされた', 3], ko: ['또 바람 맞았어', 3] },
  { key: 'plan-changed', cls: 'angry', zh: ['说好的事又变了', 3], en: ['changed the plan again', 2], ja: ['また話が変わった', 3], ko: ['또 말이 바뀌었어', 3] },
  // ── 焦虑 ──
  { key: 'heart-throat', cls: 'anxious', zh: ['心提到嗓子眼', 3], en: ['heart in my throat', 3], ja: ['心臓が飛び出そう', 3], ko: ['심장이 터질 것 같아', 3] },
  { key: 'no-sleep-tonight', cls: 'anxious', zh: ['今晚别想睡了', 3], en: ['won\'t sleep tonight', 3], ja: ['今夜は眠れそうにない', 3], ko: ['오늘 밤은 못 잘 것 같아', 3] },
  { key: 'what-if-fail', cls: 'anxious', zh: ['万一搞砸了怎么办', 3], en: ['what if I screw it up', 3], ja: ['もし失敗したらどうしよう', 3], ko: ['망치면 어쩌지', 3] },
  { key: 'no-time-left', cls: 'anxious', zh: ['时间不够用了', 3], en: ['no time left', 3], ja: ['時間が足りない', 3], ko: ['시간이 부족해', 3] },
  { key: 'brain-wont-stop', cls: 'anxious', zh: ['脑子停不下来', 3], en: ['can\'t switch my brain off', 3], ja: ['頭が回りっぱなし', 3], ko: ['머리가 멈추지 않아', 3] },
  { key: 'cant-sit-still', cls: 'anxious', zh: ['坐立不安', 3], en: ['can\'t sit still', 3], ja: ['落ち着かない', 3], ko: ['가만히 있을 수가 없어', 3] },
];

/** 否定前缀（按语言）：命中词条前 2 字内出现 → 该词条作废 */
const NEGATIONS = ['不', '没', '别', '不再', '没有', '并不', '别太', '不用'];
const NEGATIONS_I18N = [
  'not ', "n't ", 'no ', 'never ', 'hardly ',
  'じゃない', 'ではない', 'ない', 'なくない',
  '안 ', '못 ', '없', '아니',
];

export interface EmotionResult {
  emotion: EmotionClass;
  /** 各非 neutral 类得分（诊断用） */
  scores: Record<Exclude<EmotionClass, 'neutral'>, number>;
  /** 命中词条（可解释性） */
  hits: string[];
}

export function classifyEmotion(text: string): EmotionResult {
  const scores: Record<Exclude<EmotionClass, 'neutral'>, number> = {
    comfort: 0, joy: 0, sad: 0, angry: 0, anxious: 0,
  };
  const hits: string[] = [];
  /* 五种语言**并集匹配**：
     中文词库 + en/ja/ko 三套一起参与，谁的权重高算谁——用户用什么语言说话都能识别到情绪。 */
  const merged: Array<[Exclude<EmotionClass, 'neutral'>, Array<[string, number]>]> = Object.entries(LEXICON).map(([cls, terms]) => {
    const key = cls as Exclude<EmotionClass, 'neutral'>;
    const extra = Object.values(LEXICON_I18N[key]).flat();
    /* 繁体写法（`emotion-hant.ts` 是**生成物**）：繁体用户说「很難過」也要认得出——
       这是"五种语言一致"里最容易漏的一块（词库本身是简体写的）。 */
    const hant = LEXICON_HANT[key] ?? [];
    /* 口语梗：一条概念四种说法 + 它的繁体写法，一起进并集——
       于是"破防了 / that hit me hard / 立ち直れない / 멘탈 나갔어 / 破防了（繁）"判出同一类。 */
    const slang = SLANG.filter((s) => s.cls === key).flatMap((s) => {
      const h = SLANG_HANT[s.key];
      return h ? [s.zh, s.en, s.ja, s.ko, h] : [s.zh, s.en, s.ja, s.ko];
    });
    /* **同一个词只算一次，取最高权重**：中文表与日文表里都可能有「不安」、`SLANG` 的繁体写法
       也可能与中文表里的词同形——按并集直接相加 = 同一个词权重加两遍 = 悄悄改口径
       （这条是加"口语梗不许撞车"断言时逮到的：`坐立不安` 里的「不安」被算了两次）。 */
    const byWord = new Map<string, number>();
    for (const [t, w] of [...terms, ...hant, ...extra, ...slang]) byWord.set(t, Math.max(byWord.get(t) ?? 0, w));
    return [key, [...byWord.entries()]];
  });
  const lower = text.toLowerCase();
  for (const [cls, terms] of merged) {
    for (const [term, weight] of terms) {
      const needle = /[a-z]/i.test(term) ? term.toLowerCase() : term;
      const hay = /[a-z]/i.test(term) ? lower : text;
      let idx = hay.indexOf(needle);
      while (idx !== -1) {
        // 否定消解：前 2 字内的否定词 → 该命中作废（中文与 en/ja/ko 的否定词一起看）
        const before = hay.slice(Math.max(0, idx - 12), idx);
        const negated = NEGATIONS.some((n) => before.slice(-2).includes(n))
          || NEGATIONS_I18N.some((n) => before.toLowerCase().includes(n));
        if (!negated) {
          scores[cls] += weight;
          hits.push(`${cls}:${term}`);
        }
        idx = hay.indexOf(needle, idx + 1);
      }
    }
  }
  // 最高分者胜（平局保持词库类序优先：comfort 优先，陪伴场景更稳妥）；得分 <2 判 neutral（单弱词不够）
  let best: EmotionClass = 'neutral';
  let bestScore = -1;
  for (const cls of Object.keys(scores) as Array<Exclude<EmotionClass, 'neutral'>>) {
    if (scores[cls] > bestScore) {
      best = cls;
      bestScore = scores[cls];
    }
  }
  if (bestScore < 2) best = 'neutral';
  return { emotion: best, scores, hits };
}

/** 词库规模（按语言）——给"五种语言一致"这条要求留一个**可断言**的口子（单测会查） */
export const LEXICON_STATS: Record<string, number> = (() => {
  const zh = Object.values(LEXICON).reduce((n, t) => n + t.length, 0);
  const hant = Object.values(LEXICON_HANT).reduce((n, t) => n + t.length, 0);
  // 口语梗：每种语言各 SLANG.length 条；繁体那边"同形的用中文那条、不同形的用生成的" → 也算全覆盖
  const slangZh = SLANG.length;
  const slangHant = SLANG.length;
  const out: Record<string, number> = { 'zh-CN': zh + slangZh, 'zh-Hant': hant + slangHant };
  for (const lang of ['en', 'ja', 'ko'] as const) {
    out[lang] = Object.values(LEXICON_I18N).reduce((n, byLang) => n + byLang[lang].length, 0) + SLANG.length;
  }
  return out;
})();
