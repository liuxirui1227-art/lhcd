// 检索准确率测试（≥80% 过线）：50 条合成记忆 → BM25 top-1 命中率。本地零成本。
// 用法：node retrieval-test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createNodeRuntime, MemoryService } from '../brain/dist/index.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lhcd-retrieval-'));
const rt = createNodeRuntime({
  cwd: dir,
  storage: { sessionsDir: `${dir}/s`, logsDir: `${dir}/l`, memoryDir: `${dir}/memory`, configDir: dir },
});
const memory = new MemoryService(rt, `${dir}/memory/semantic`, `${dir}/memory/episodes`);

const FOODS = ['火锅', '寿司', '烤肉', '饺子', '拉面', '川菜', '粤菜', '日料', '西餐', '烧烤'];
const COLORS = ['蓝色', '绿色', '橙色', '紫色', '白色', '黑色', '红色', '黄色', '粉色', '灰色'];
const CITIES = ['杭州', '成都', '深圳', '西安', '南京', '武汉', '青岛', '厦门', '苏州', '重庆'];
const HOBBIES = ['摄影', '徒步', '游泳', '骑行', '绘画', '弹琴', '书法', '下棋', '养花', '钓鱼'];
const MOVIES = ['科幻片', '悬疑片', '喜剧片', '纪录片', '动画片', '爱情片', '战争片', '武侠片', '恐怖片', '文艺片'];

const facts = [
  ...FOODS.map((x, i) => ({ key: `fact.food.${i}`, content: `用户最喜欢吃的食物是${x}`, query: x })),
  ...COLORS.map((x, i) => ({ key: `fact.color.${i}`, content: `用户最喜欢的颜色是${x}`, query: x })),
  ...CITIES.map((x, i) => ({ key: `fact.city.${i}`, content: `用户最想去的城市是${x}`, query: x })),
  ...HOBBIES.map((x, i) => ({ key: `fact.hobby.${i}`, content: `用户的爱好是${x}`, query: x })),
  ...MOVIES.map((x, i) => ({ key: `fact.movie.${i}`, content: `用户爱看的电影类型是${x}`, query: x })),
];

// 难例：同查询词多条命中，词频占优者应胜出。
// alt=true = 对照组（只入库、不参与断言）——同一个 query 不可能让两条都拿 top-1，
// 两条都断言会自带 2 分必丢（52/54 是天花板，与引擎好坏无关）。
facts.push({ key: 'fact.cat.0', content: '用户养了两只猫，猫，猫', query: '猫' });
facts.push({ key: 'fact.cat.1', content: '用户曾经养过一只猫', query: '猫', alt: true });
facts.push({ key: 'fact.hard.0', content: '用户每周跑步三次，跑步，跑步', query: '跑步' });
facts.push({ key: 'fact.hard.1', content: '用户偶尔跑步', query: '跑步', alt: true });

// 36 条长句用例：两字词嵌在长中文句里（整句被当成 1 个 token 时全灭）。期望条目复用上面的 key。
const LONG_CASES = [
  { key: 'fact.food.0', query: '上次我们吃的那种火锅你还记得吗' },
  { key: 'fact.city.0', query: '你不是说想去杭州看看吗，后来去了没' },
  { key: 'fact.hobby.0', query: '你那个摄影的爱好还在坚持吗' },
  { key: 'fact.movie.0', query: '我们上次说要一起看科幻片来着' },
  { key: 'fact.color.0', query: '你之前问过我喜欢什么颜色，蓝色那种' },
];

async function main() {
  for (const f of facts) {
    await memory.remember({
      scope: 'project', key: f.key, content: f.content,
      description: f.content.slice(0, 40), confidence: 'medium', source: 'synthetic-qa',
    });
  }
  let hit = 0;
  const misses = [];
  const cases = [
    ...facts.filter((f) => !f.alt).map((f) => ({ query: f.query, expect: f.key, kind: 'short' })),
    ...LONG_CASES.map((c) => ({ query: c.query, expect: c.key, kind: 'long' })),
  ];
  const longHit = { n: 0, total: 0 };
  for (const c of cases) {
    const top = (await memory.search(c.query, 1))[0];
    const ok = top?.entry.name === c.expect;
    if (c.kind === 'long') longHit.total++;
    if (ok) {
      hit++;
      if (c.kind === 'long') longHit.n++;
    } else {
      misses.push({ query: c.query, expect: c.expect, got: top?.entry.name ?? null, kind: c.kind });
    }
  }
  const acc = hit / cases.length;
  console.log(`检索准确率：${hit}/${cases.length} = ${(acc * 100).toFixed(1)}%（长中文句 ${longHit.n}/${longHit.total}）`);
  if (misses.length > 0) console.log('未命中：', JSON.stringify(misses.slice(0, 10), null, 2));
  const pass = acc >= 0.8;
  console.log(`过线判定（≥80%）：${pass ? '✅ 过线' : '❌ 未过线'}`);
  process.exit(pass ? 0 : 1);
}

main().catch((e) => { console.error(e.message); process.exit(2); });
