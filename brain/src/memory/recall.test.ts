// 混合召回单测：关键词 / 图谱共现 / 向量 / 时间衰减 / 重要性加权。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  hybridRecall, keywordScore, graphScore, timeDecay, importanceWeight, cosine, tokenize,
  sourceAuthority, sourceLabel, statusWeight,
} from './recall.js';
import type { SemanticEntry } from './semantic.js';

function entry(partial: Partial<SemanticEntry> & { name: string }): SemanticEntry {
  return {
    scope: 'global', description: '', confidence: 'medium', source: 'test', tags: [],
    updatedAt: '2026-08-23T00:00:00.000Z', content: '',
    ...partial,
  };
}

test('tokenize：中英文分词', () => {
  assert.deepEqual(tokenize('我的 生日，喜欢 蓝色。'), ['我的', '生日', '喜欢', '蓝色']);
  assert.deepEqual(tokenize(''), []);
});

test('keywordScore：命中与词频（0~1）', () => {
  const e = entry({ name: 'user.color', description: '最喜欢的颜色', content: '蓝色蓝色蓝色', tags: ['偏好'] });
  const hit = keywordScore(e, '蓝色');
  assert.ok(hit > 0);
  const miss = keywordScore(e, '滑雪');
  assert.equal(miss, 0);
  const max = keywordScore(e, '蓝色');
  assert.ok(max <= 1);
});

test('graphScore：标签共现 Jaccard', () => {
  const e = entry({ name: 'a', tags: ['滑雪', '冬天'] });
  assert.equal(graphScore(e, new Set(['滑雪', '冬天', '旅行'])), 2 / 3);
  assert.equal(graphScore(e, new Set(['编程'])), 0);
  assert.equal(graphScore(entry({ name: 'b', tags: [] }), new Set(['x'])), 0);
});

test('timeDecay：越旧越低；半衰期=1；未来/非法时间=1', () => {
  const now = '2026-08-23T00:00:00.000Z';
  assert.equal(timeDecay(now, now, 30), 1);
  assert.ok(Math.abs(timeDecay('2026-08-22T00:00:00.000Z', now, 1) - 0.5) < 1e-9); // 1 天 = 恰好半衰
  assert.equal(timeDecay('2026-08-24T00:00:00.000Z', now, 30), 1); // 未来时间
  assert.equal(timeDecay('garbage', now, 30), 1); // 非法时间
});

test('importanceWeight：confidence 档 + 情绪峰值加成', () => {
  assert.equal(importanceWeight(entry({ name: 'a', confidence: 'high' })), 1.5);
  assert.equal(importanceWeight(entry({ name: 'b', confidence: 'medium' })), 1);
  assert.equal(importanceWeight(entry({ name: 'c', confidence: 'low' })), 0.6);
  const emotional = importanceWeight(entry({ name: 'd', confidence: 'medium', tags: ['情绪', '感动'] }));
  assert.equal(emotional, 1.25);
});

test('cosine：同向 1 / 正交 0 / 负向截 0 / 空向量 0', () => {
  assert.equal(cosine([1, 0], [1, 0]), 1);
  assert.equal(cosine([1, 0], [0, 1]), 0);
  assert.equal(cosine([1], [-1]), 0);
  assert.equal(cosine([], [1]), 0);
});

test('hybridRecall：无 embedder → 关键词+时间+重要性（向量权重让渡）', async () => {
  const now = '2026-08-23T00:00:00.000Z';
  const entries = [
    entry({ name: 'a', description: '滑雪旅行', content: '去年冬天去了滑雪', confidence: 'high', tags: ['滑雪'], updatedAt: now }),
    entry({ name: 'b', description: '编程', content: '写代码', tags: ['工作'], updatedAt: now }),
    entry({ name: 'c', description: '滑雪装备', content: '滑雪板保养', confidence: 'low', updatedAt: '2025-01-01T00:00:00.000Z' }),
  ];
  const r = await hybridRecall('滑雪', entries, { now });
  assert.equal(r.length, 3);
  assert.equal(r[0]!.entry.name, 'a'); // 关键词命中 + high confidence + 新鲜
  assert.equal(r[2]!.entry.name, 'b'); // 完全不相关垫底
  assert.ok(r[0]!.score > r[2]!.score);
});

test('hybridRecall：长中文句 → 两字词条目能召回（36 条验收）', async () => {
  const now = '2026-08-23T00:00:00.000Z';
  const entries = [
    entry({ name: 'project.linghe', description: '灵核项目：桌面数字人', content: '用户在做灵核项目，装在自己电脑上', confidence: 'high', updatedAt: now }),
    entry({ name: 'fact.busy', description: '用户最近很忙', content: '用户现在每天很忙', confidence: 'high', updatedAt: now }),
    entry({ name: 'fact.food', description: '用户喜欢吃火锅', content: '用户最喜欢吃的食物是火锅', updatedAt: now }),
  ];
  const r = await hybridRecall('你还记得我上次说的那个项目吗，现在做得怎么样了', entries, { now });
  assert.equal(r[0]!.entry.name, 'project.linghe'); // 两个关键词命中 > 单个常见词
  assert.ok(r[0]!.components.keyword >= 0.45, `keyword=${r[0]!.components.keyword}`);
  assert.equal(r.find((x) => x.entry.name === 'fact.food')!.components.keyword, 0);
});

test('hybridRecall：embedder 参与 → 向量分量生效且语义相近者靠前', async () => {
  const now = '2026-08-23T00:00:00.000Z';
  const entries = [
    entry({ name: 'x', description: '旅行', content: '想去海边度假', updatedAt: now }),
    entry({ name: 'y', description: '工作', content: '项目排期紧张', updatedAt: now }),
  ];
  // 词面无关但语义相近的向量：query「旅游」与 x 的语义向量夹角小
  const embed = async (texts: string[]) =>
    texts.map((t) => (t.startsWith('旅游') || t.includes('海边') ? [1, 0] : [0, 1]));
  const r = await hybridRecall('旅游', entries, { now, embed });
  assert.equal(r[0]!.entry.name, 'x');
  assert.ok(r[0]!.components.vector > 0);
});

test('hybridRecall：embedder 抛错 → 降级纯关键词路径不抛错', async () => {
  const entries = [entry({ name: 'a', description: '滑雪', content: '滑雪好玩', updatedAt: '2026-08-23T00:00:00.000Z' })];
  const r = await hybridRecall('滑雪', entries, { embed: async () => { throw new Error('embed down'); } });
  assert.equal(r.length, 1);
  assert.equal(r[0]!.components.vector, 0);
});

test('hybridRecall：components 齐全（诊断/审计用）', async () => {
  const r = await hybridRecall('滑雪', [entry({ name: 'a', content: '滑雪' })], { now: '2026-08-23T00:00:00.000Z' });
  assert.deepEqual(Object.keys(r[0]!.components).sort(), ['graph', 'importance', 'keyword', 'time', 'vector']);
});

// ── 来源权威性 ───────────────────────────────────────────────────────────────

test('sourceAuthority：用户纠正 > 用户明说 > 日程同步 > 聊天提炼 > 约会记录 > 会话摘要', () => {
  const w = (s: string) => sourceAuthority(s);
  assert.ok(w('user-correction') > w('user-request'));
  assert.ok(w('user-request') > w('info-sync'));
  assert.ok(w('info-sync') > w('chat-digest'));
  assert.ok(w('chat-digest') > w('scene-report'));
  assert.ok(w('scene-report') > w('session.main.fact.x'));
  assert.equal(w('随便什么来源'), 1, '未知来源不影响老行为');
  assert.equal(sourceLabel('user-correction'), '用户纠正');
  assert.equal(sourceLabel('nope'), '');
});

test('importanceWeight：来源权威性真的进了权重（同内容同置信，不同来路不同分量）', () => {
  const mk = (source: string) => entry({ name: 'x', content: '崇礼滑雪', confidence: 'medium', source });
  assert.ok(importanceWeight(mk('user-correction')) > importanceWeight(mk('chat-digest')));
  assert.ok(importanceWeight(mk('chat-digest')) > importanceWeight(mk('session.s1.fact.y')));
});

test('importanceWeight：显式 importance（0~1）优先于 confidence 档，折算到同量纲', () => {
  assert.equal(importanceWeight(entry({ name: 'a', confidence: 'high', importance: 0 })), 0.4);
  assert.ok(Math.abs(importanceWeight(entry({ name: 'b', confidence: 'low', importance: 1 })) - 1.6) < 1e-9);
  // 显式 0.5 落在 high(1.5) 与 low(0.6) 之间
  const w = importanceWeight(entry({ name: 'c', confidence: 'high', importance: 0.5 }));
  assert.ok(w > 0.6 && w < 1.5);
});

test('hybridRecall：同为"滑雪"的两条，用户纠正过的那条排前面（来路压过新鲜度）', () => {
  const now = '2026-08-23T00:00:00.000Z';
  const entries = [
    entry({ name: 'digest', content: '崇礼滑雪', source: 'chat-digest', updatedAt: '2026-08-23T00:00:00.000Z' }),
    entry({ name: 'correction', content: '崇礼滑雪', source: 'user-correction', updatedAt: '2026-08-01T00:00:00.000Z' }),
  ];
  return hybridRecall('崇礼滑雪', entries, { now }).then((r) => {
    assert.equal(r[0]!.entry.name, 'correction');
  });
});

test('候选态降权（条目 2）：同样的内容与来路，候选比已确认的低一档，忽略过的为 0', () => {
  const mk = (status?: 'active' | 'candidate' | 'deprecated') => entry({ name: 'x', content: '崇礼滑雪', source: 'chat-digest', ...(status ? { status } : {}) });
  assert.equal(statusWeight(mk()), 1, '老条目（无 status）= active');
  assert.equal(statusWeight(mk('candidate')), 0.8);
  assert.equal(statusWeight(mk('deprecated')), 0);
  assert.ok(importanceWeight(mk('candidate')) < importanceWeight(mk('active')));
  assert.ok(importanceWeight(mk('candidate')) > importanceWeight(mk('deprecated')));
});

/* ── 跨体去重：同一件事的简繁两条要认得出 ── */
import { duplicateScore, contradictionScore as cs } from './recall.js';

test('跨体去重：简繁两条同一件事 → 重复分 1.0（且**不**被判成矛盾）', () => {
  const mk = (content: string, name = 'm'): SemanticEntry => ({
    name, scope: 'project', description: content.slice(0, 40), confidence: 'medium',
    source: 'test', tags: [], updatedAt: '2026-09-26T00:00:00.000Z', content,
  } as SemanticEntry);
  const pairs: Array<[string, string]> = [
    ['用户最喜欢吃的食物是火锅', '使用者最喜歡吃的食物是火鍋'],
    ['用户把项目进度记录在飞书文档里', '使用者把專案進度記錄在飛書文件裡'],
    ['猫的名字叫豆豆', '貓的名字叫豆豆'],
  ];
  for (const [a, b] of pairs) {
    assert.equal(duplicateScore(mk(a), mk(b)), 1, `${a} / ${b}`);
    assert.ok(cs(mk(a), mk(b)) < 0.3, `简繁同一件事不该提示矛盾：${cs(mk(a), mk(b))}`);
  }
  // 真正的矛盾（同主语换了值）仍要被认出来，且**不算重复**
  const c = mk('用户最喜欢吃的食物是火锅', 'a');
  const d = mk('用户最喜欢吃的食物是拉面', 'b');
  assert.ok(duplicateScore(c, d) < 0.85, '值不同 → 不是重复');
});
