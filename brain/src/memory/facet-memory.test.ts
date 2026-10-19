// 语义记忆域标签（frontmatter domain 往返）+ recall 按侧面权限域过滤。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createNodeRuntime } from '../runtime/node.js';
import { MemoryService } from './service.js';
import { recallTool, rememberTool, forgetTool } from '../tools/memory.js';
import { filterDomains, DOMAINS, classifyDomain } from '../lifecycle/facets.js';

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'brain-facet-'));
}

function setup() {
  const dir = tmpdir();
  const rt = createNodeRuntime({
    cwd: dir,
    storage: { sessionsDir: `${dir}/s`, logsDir: `${dir}/l`, memoryDir: `${dir}/memory`, configDir: dir },
  });
  const memory = new MemoryService(rt, `${dir}/memory/semantic`, `${dir}/memory/episodes`);
  return { dir, rt, memory, store: memory.semantic };
}

const base = {
  scope: 'global' as const,
  description: '',
  confidence: 'medium' as const,
  source: 'sess-1',
  tags: ['auto'],
  updatedAt: '2026-08-22T20:00:00+08:00',
};

test('frontmatter 往返：domain 标签写入与读出（无标签旧文件兼容）', async () => {
  const { store } = setup();
  await store.write({ ...base, name: 'w.1', domain: 'work_log', content: '周报要点：Q3 数据已对齐。' });
  await store.write({ ...base, name: 'p.1', domain: 'private_diary', content: '最近有点孤独。' });
  await store.write({ ...base, name: 's.1', content: '未打标条目。' }); // 旧格式无 domain
  const w = await store.read('w.1');
  assert.equal(w?.domain, 'work_log');
  const p = await store.read('p.1');
  assert.equal(p?.domain, 'private_diary');
  const s = await store.read('s.1');
  assert.equal(s?.domain, undefined); // 兼容旧文件
  const raw = await store.serialize({ ...base, name: 'x', domain: 'emotion_log', content: 'c' });
  assert.ok(raw.includes('domain: emotion_log'));
});

test('未打标条目默认按 schedule 域：所有侧面可见（读）', () => {
  const entries = [
    { domain: 'work_log' as const, name: 'a' },
    { domain: 'private_diary' as const, name: 'b' },
    { domain: 'schedule' as const, name: 'c' },
    { name: 'd' }, // 无标签
  ];
  const career = filterDomains(entries as Array<{ domain: (typeof DOMAINS)[number]; [k: string]: unknown }>, 'career');
  assert.deepEqual(career.map((e) => e.name), ['a', 'c', 'd']);
  const emotion = filterDomains(entries as Array<{ domain: (typeof DOMAINS)[number]; [k: string]: unknown }>, 'emotion');
  assert.deepEqual(emotion.map((e) => e.name), ['b', 'c', 'd']);
});

test('recall 工具按侧面过滤：职场侧面看不到私人倾诉域', async () => {
  const { memory, rt } = setup();
  await memory.remember({ ...base, key: 'user.work', content: '用户在做数据平台 Q3 复盘。', domain: 'work_log', source: 't' });
  await memory.remember({ ...base, key: 'user.diary', content: '用户最近睡眠很差很焦虑。', domain: 'private_diary', source: 't' });
  const tool = recallTool();
  const ctxBase = {
    sessionId: 's1', cwd: '.', runtime: rt, config: {} as unknown as import('../config/schema.js').Config,
    memory, emit: () => undefined,
  };
  const r = await tool.executor({ query: '用户', max: 8 }, { ...ctxBase, facet: 'career' });
  assert.ok(r.ok);
  assert.ok(r.output.includes('user.work'));
  assert.ok(!r.output.includes('user.diary'), '职场侧面不应看到私人倾诉');
  // companion 全读写：两个都可见
  const r2 = await tool.executor({ query: '用户', max: 8 }, { ...ctxBase, facet: 'companion' });
  assert.ok(r2.output.includes('user.work') && r2.output.includes('user.diary'));
  // 未注入 facet：默认 companion 全量
  const r3 = await tool.executor({ query: '用户', max: 8 }, ctxBase);
  assert.ok(r3.output.includes('user.diary'));
});

test('classifyDomain：情绪优先/工作/日程分类 + 默认通用域', () => {
  assert.equal(classifyDomain('今天开会讨论了 Q3 方案'), 'work_log');
  assert.equal(classifyDomain('最近压力好大，有点想哭'), 'emotion_log');
  assert.equal(classifyDomain('我下周的学习计划'), 'schedule');
  assert.equal(classifyDomain('今天天气不错'), 'schedule');
  // 情绪优先：含工作词+情绪词 → emotion_log（敏感域优先）
  assert.equal(classifyDomain('加班到很晚，感觉压力很大'), 'emotion_log');
});

test('remember 工具写权限：侧面只写本域（rw），越权域拒绝；companion 全读写', async () => {
  const { memory, rt } = setup();
  const tool = rememberTool();
  const ctxBase = {
    sessionId: 's1', cwd: '.', runtime: rt, config: {} as unknown as import('../config/schema.js').Config,
    memory, emit: () => undefined,
  };
  // 职场侧面：写 work_log ✓，写 private_diary ✗
  const r1 = await tool.executor({ scope: 'project', key: 'k1', content: '今天周会结论已定', domain: 'work_log' }, { ...ctxBase, facet: 'career' });
  assert.ok(r1.ok, 'career 应可写 work_log');
  const r2 = await tool.executor({ scope: 'project', key: 'k2', content: '用户倾诉的秘密', domain: 'private_diary' }, { ...ctxBase, facet: 'career' });
  assert.equal(r2.ok, false);
  assert.equal(r2.error?.code, 'FACET_DENIED');
  // 情感侧面：写 emotion_log ✓（无 domain 参数时按内容自动分类）
  const r3 = await tool.executor({ scope: 'project', key: 'k3', content: '最近心情很低落' }, { ...ctxBase, facet: 'emotion' });
  assert.ok(r3.ok, 'emotion 侧面应可写自动分类的 emotion_log');
  const e3 = await memory.semantic.read('k3');
  assert.equal(e3?.domain, 'emotion_log');
  // companion：全读写
  const r4 = await tool.executor({ scope: 'project', key: 'k4', content: '秘密', domain: 'private_diary' }, { ...ctxBase, facet: 'companion' });
  assert.ok(r4.ok);
});

test('forget 工具删除权限与 remember 对齐：侧面无权删除他域记忆，companion 全读写', async () => {
  const { memory, rt } = setup();
  await memory.remember({ ...base, key: 'u.diary', content: '私人秘密', domain: 'private_diary', source: 't' });
  await memory.remember({ ...base, key: 'u.work', content: '周报结论', domain: 'work_log', source: 't' });
  const tool = forgetTool();
  const ctxBase = {
    sessionId: 's1', cwd: '.', runtime: rt, config: {} as unknown as import('../config/schema.js').Config,
    memory, emit: () => undefined,
  };
  // 职场侧面：删 work_log ✓，删 private_diary ✗（且条目仍在）
  const r1 = await tool.executor({ scope: 'project', key: 'u.work' }, { ...ctxBase, facet: 'career' });
  assert.ok(r1.ok, 'career 应可删本域 work_log');
  const r2 = await tool.executor({ scope: 'project', key: 'u.diary' }, { ...ctxBase, facet: 'career' });
  assert.equal(r2.ok, false);
  assert.equal(r2.error?.code, 'FACET_DENIED');
  assert.ok(await memory.semantic.read('u.diary'), '被拒后条目必须还在');
  // companion：可删任意域
  const r3 = await tool.executor({ scope: 'project', key: 'u.diary' }, { ...ctxBase, facet: 'companion' });
  assert.ok(r3.ok);
  assert.equal(await memory.semantic.read('u.diary'), null);
});
