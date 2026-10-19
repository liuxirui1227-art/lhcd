// 标签供给：没人传 tags 时，服务自己把这一维算出来。
// 背景：入口早就有，但一直**没人真的传** —— 服务兜底写死 ['auto']，
// 于是图谱共现（Jaccard）对谁都一样、情绪加成永不触发，召回这两个维度等于死的。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createNodeRuntime } from '../runtime/node.js';
import { MemoryService } from '../memory/service.js';
import { graphScore, importanceWeight } from '../memory/recall.js';

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-tags-'));
  const rt = createNodeRuntime({
    cwd: dir,
    storage: { sessionsDir: `${dir}/s`, logsDir: `${dir}/l`, memoryDir: `${dir}/memory`, configDir: dir },
  });
  return { dir, rt, memory: new MemoryService(rt, `${dir}/memory/semantic`, `${dir}/memory/episodes`) };
}

test('标签供给：没传 tags 时按 domain 现算，不再是清一色 auto', async () => {
  const { memory } = setup();
  await memory.remember({ scope: 'project', key: 'k.work', content: '这个项目的构建脚本在 tools/', source: 'chat-digest', domain: 'work_log' });
  const w = await memory.semantic.read('k.work');
  assert.deepEqual(w?.tags, ['work_log']);
});

test('标签供给：内容带情绪 → 打「情绪」+ 具体档词，情绪加成因此真的生效', async () => {
  const { memory } = setup();
  await memory.remember({ scope: 'project', key: 'k.emo', content: '今天被骂了一顿，特别委屈，想哭', source: 'chat-digest' });
  const e = await memory.semantic.read('k.emo');
  assert.ok(e?.tags.includes('情绪'), `应含「情绪」：${JSON.stringify(e?.tags)}`);
  // 具体档词按**内核分类器**的结果给（别在测试里写死某一档：这句在词库里 comfort 得分最高，
  // 所以是「疲惫」而不是「难过」）——这里只钉契约：第二个词必须来自那张档词表。
  const WORDS = ['开心', '难过', '生气', '焦虑', '疲惫'];
  assert.equal(e?.tags.length, 2, `标签应是「情绪」+ 一个档词：${JSON.stringify(e?.tags)}`);
  assert.ok(WORDS.includes(e!.tags[1]!), `档词必须来自档词表：${JSON.stringify(e?.tags)}`);

  // 同样 confidence/source/status 的两条，只有标签不同 → 情绪那条必须更重（1.25×）
  await memory.remember({ scope: 'project', key: 'k.plain', content: '构建脚本放在 tools/ 目录', source: 'chat-digest' });
  const p = await memory.semantic.read('k.plain');
  assert.deepEqual(p?.tags, ['auto'], '非情绪又没 domain → 仍是老兜底 auto');
  assert.ok(importanceWeight(e!) > importanceWeight(p!), '情绪记忆的权重必须高于中性记忆');
});

test('标签供给：图谱共现这一维开始有区分度（同域有分、异域为 0）', async () => {
  const { memory } = setup();
  await memory.remember({ scope: 'project', key: 'a1', content: '周报模板在 docs/weekly.md', source: 'chat-digest', domain: 'work_log' });
  await memory.remember({ scope: 'project', key: 'a2', content: '发布流程先跑一遍测试', source: 'chat-digest', domain: 'work_log' });
  await memory.remember({ scope: 'project', key: 'b1', content: '下周三去体检', source: 'chat-digest', domain: 'schedule' });
  const [a1, a2, b1] = await Promise.all(['a1', 'a2', 'b1'].map((k) => memory.semantic.read(k)));
  const seeds = new Set<string>();
  a1!.tags.forEach((t) => seeds.add(t));
  assert.ok(graphScore(a2!, seeds) > 0, '同域条目应吃到图谱分');
  assert.equal(graphScore(b1!, seeds), 0, '异域条目图谱分必须是 0（旧实现里人人 share「auto」→ 恒为 1，这一维等于死的）');
});

test('标签供给：显式传了 tags 的调用方优先，不被兜底覆盖', async () => {
  const { memory } = setup();
  await memory.remember({ scope: 'project', key: 'k.explicit', content: '今天好累', source: 'user', domain: 'emotion_log', tags: ['自定义', '别动我'] });
  const e = await memory.semantic.read('k.explicit');
  assert.deepEqual(e?.tags, ['自定义', '别动我']);
});
