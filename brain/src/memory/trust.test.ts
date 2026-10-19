// 信任分：用户说"这条有用/没用"要真的影响排序。
// 口径：缺省 0.5（= ×1.0，老行为不变）；有用 +0.05 / 没用 −0.10（**罚是奖的两倍**），乘在相关性上。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createNodeRuntime } from '../runtime/node.js';
import { MemoryService } from '../memory/service.js';
import { trustFactor } from '../memory/recall.js';

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-trust-'));
  const rt = createNodeRuntime({
    cwd: dir,
    storage: { sessionsDir: `${dir}/s`, logsDir: `${dir}/l`, memoryDir: `${dir}/memory`, configDir: dir },
  });
  const memory = new MemoryService(rt, `${dir}/memory/semantic`, `${dir}/memory/episodes`);
  return { dir, memory };
}

test('信任分：缺省 0.5 = 系数 1.0（老条目行为一字不变）', async () => {
  const { dir, memory } = setup();
  await memory.remember({ scope: 'project', key: 'k.a', content: '构建脚本在 tools/ 目录', source: 'chat-digest' });
  const e = await memory.semantic.read('k.a');
  assert.equal(e?.trust, 0.5, '老条目没这一行 → 读出来按中性 0.5');
  assert.equal(trustFactor(e!), 1.0, '中性条目的系数必须是 1.0（不偷偷给所有人加分）');
  // 没打过分就不落盘：文件里不该凭空多出 trust 行（老文件字节面一个都不动）
  const file = path.join(dir, 'memory', 'semantic', 'k.a.md');
  assert.ok(!fs.readFileSync(file, 'utf8').includes('trust:'), '没人打过分，文件里就不该有 trust 行');
  await memory.rateTrust('k.a', 'useful');
  assert.ok(fs.readFileSync(file, 'utf8').includes('trust: 0.55'), '打过分才写进文件');
});

test('信任分：有用 +0.05 / 没用 −0.10，罚是奖的两倍', async () => {
  const { memory } = setup();
  await memory.remember({ scope: 'project', key: 'k.b', content: '发布流程先跑一遍测试', source: 'chat-digest' });
  assert.equal(await memory.rateTrust('k.b', 'useful'), 0.55);
  assert.equal(await memory.rateTrust('k.b', 'useless'), 0.45); // 一奖一罚 → 净 −0.05
  const e = await memory.semantic.read('k.b');
  assert.equal(e?.trust, 0.45);
  assert.ok(trustFactor(e!) < 1, '被说过"没用"的条目系数要低于 1');
  // 罚是奖的两倍：奖一次 +0.05，罚一次 −0.10（0.45 → 0.35，一次掉 0.10）；
  // 顺带钉住"两位小数"（浮点会把 0.45-0.10 算成 0.35000000000000003）
  assert.equal(await memory.rateTrust('k.b', 'useless'), 0.35);
  assert.equal(await memory.rateTrust('不存在的条目', 'useful'), null);
});

test('信任分：钳在 0~1，打不穿', async () => {
  const { memory } = setup();
  await memory.remember({ scope: 'project', key: 'k.c', content: '用户偏好用中文回复', source: 'user' });
  for (let i = 0; i < 12; i++) await memory.rateTrust('k.c', 'useless');
  assert.equal((await memory.semantic.read('k.c'))?.trust, 0, '连罚到底就是 0，不能变负数');
  for (let i = 0; i < 25; i++) await memory.rateTrust('k.c', 'useful');
  assert.equal((await memory.semantic.read('k.c'))?.trust, 1, '连奖到顶就是 1，不能超过 1');
});

test('信任分：同样的内容，打过分的那条真的排前面/后面（走混合召回）', async () => {
  const { memory } = setup();
  const body = '月度报表的口径是「签约金额」，不含退款';
  await memory.remember({ scope: 'project', key: 'k.good', content: body, source: 'user' });
  await memory.remember({ scope: 'project', key: 'k.bad', content: body, source: 'user' });
  await memory.rateTrust('k.good', 'useful');
  await memory.rateTrust('k.bad', 'useless');

  const hits = await memory.searchHybrid('月度报表 口径 签约金额', 5);
  const names = hits.map((h) => h.entry.name);
  assert.ok(names.indexOf('k.good') < names.indexOf('k.bad'),
    `"有用"那条要排在"没用"前面：${JSON.stringify(names)}`);
  // 乘在相关性上：分数差 = 系数差 × 相关性（不是简单加减一个常数）
  const good = hits.find((h) => h.entry.name === 'k.good')!;
  const bad = hits.find((h) => h.entry.name === 'k.bad')!;
  assert.ok(good.score > bad.score, `${good.score} 应 > ${bad.score}`);
});

test('矛盾检测：同主语改说法 → 高分；无关 → 0；重复 → 低分（条 41）', async () => {
  const { memory } = setup();
  await memory.remember({ scope: 'project', key: 'c.old', content: '月度报表的口径是「签约金额」，不含退款', source: 'user' });
  await memory.remember({ scope: 'project', key: 'c.new', content: '月度报表的口径改用「回款金额」，不含退款', source: 'user' });
  await memory.remember({ scope: 'project', key: 'c.dup', content: '月度报表的口径是「签约金额」，不含退款', source: 'user' });
  await memory.remember({ scope: 'project', key: 'c.other', content: '今天下午三点和老王开会对需求', source: 'user' });

  const pairs = await memory.findContradictions(0.3);
  const has = (a: string, b: string) => pairs.some((p) => (p.a === a && p.b === b) || (p.a === b && p.b === a));
  assert.ok(has('c.old', 'c.new'), `改了口径的那条要被抓出来：${JSON.stringify(pairs)}`);
  assert.ok(!has('c.old', 'c.other'), '无关两条不该被当成矛盾');
  assert.ok(!has('c.old', 'c.dup'), '一字不差的重复是"重复"，不是"矛盾"');
  // 分数关系（钉住口径：真矛盾 > 0.3，重复更低）
  const conflict = pairs.find((p) => (p.a === 'c.old' && p.b === 'c.new') || (p.a === 'c.new' && p.b === 'c.old'))!;
  assert.ok(conflict.score >= 0.3, JSON.stringify(conflict));
});

test('矛盾检测：已忽略的条目不参与（用户处理过的别再端上来）', async () => {
  const { memory } = setup();
  await memory.remember({ scope: 'project', key: 'd.old', content: '月度报表的口径是「签约金额」', source: 'user' });
  await memory.remember({ scope: 'project', key: 'd.new', content: '月度报表的口径改用「回款金额」', source: 'user' });
  await memory.semantic.setStatus('d.old', 'deprecated');
  const pairs = await memory.findContradictions(0.3);
  assert.ok(!pairs.some((p) => p.a === 'd.old' || p.b === 'd.old'), JSON.stringify(pairs));
});

/* ── 跨体去重：简繁两条同一件事要认得出来 ── */
test('跨体去重：同一件事一条简体一条繁体 → findDuplicates 抓得到，且不算矛盾', async () => {
  const { memory } = setup();
  await memory.remember({ scope: 'project', key: 'z.hans', content: '用户最喜欢吃的食物是火锅', source: 'user' });
  await memory.remember({ scope: 'project', key: 'z.hant', content: '使用者最喜歡吃的食物是火鍋', source: 'user' });
  await memory.remember({ scope: 'project', key: 'z.other', content: '下周三要去上海出差', source: 'user' });

  const dups = await memory.findDuplicates(0.85);
  const has = (a: string, b: string) => dups.some((p) => (p.a === a && p.b === b) || (p.a === b && p.b === a));
  assert.ok(has('z.hans', 'z.hant'), `简繁同一件事要被抓出来：${JSON.stringify(dups)}`);
  assert.ok(!has('z.hans', 'z.other'), '无关两条不该被当成重复');
  const pair = dups.find((p) => has(p.a, p.b))!;
  assert.ok(pair.score >= 0.99, `同一件事的重复分应当接近 1：${JSON.stringify(pair)}`);

  const cfs = await memory.findContradictions(0.3);
  assert.ok(!cfs.some((p) => (p.a === 'z.hans' && p.b === 'z.hant') || (p.a === 'z.hant' && p.b === 'z.hans')),
    `简繁同一件事不该提示"说法对不上"：${JSON.stringify(cfs)}`);
});

test('跨体去重：值不一样的两条**不是**重复（火锅 / 拉面）', async () => {
  const { memory } = setup();
  await memory.remember({ scope: 'project', key: 'y.a', content: '用户最喜欢吃的食物是火锅', source: 'user' });
  await memory.remember({ scope: 'project', key: 'y.b', content: '用户最喜欢吃的食物是拉面', source: 'user' });
  const dups = await memory.findDuplicates(0.85);
  assert.equal(dups.length, 0, `值不同不该算重复：${JSON.stringify(dups)}`);
});
