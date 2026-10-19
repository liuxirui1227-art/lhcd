// 语义记忆——写入/覆盖/删除/frontmatter 往返/脱敏拒写/索引/BM25 检索/TTL 过期。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createNodeRuntime } from '../runtime/node.js';
import { SemanticStore, hasSecret } from './semantic.js';

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'brain-mem-'));
}

function setup() {
  const dir = tmpdir();
  const rt = createNodeRuntime({
    cwd: dir,
    storage: { sessionsDir: `${dir}/s`, logsDir: `${dir}/l`, memoryDir: `${dir}/memory`, configDir: dir },
  });
  const store = new SemanticStore(rt, `${dir}/memory/semantic`);
  return { dir, rt, store };
}

const base = {
  scope: 'global' as const,
  description: '用户偏好中文',
  confidence: 'medium' as const,
  source: 'sess-1',
  tags: ['preference'],
  updatedAt: '2026-08-21T09:00:00+08:00',
};

test('写入 → 读取往返（frontmatter + 正文）', async () => {
  const { store } = setup();
  const r = await store.write({ ...base, name: 'user.lang', content: '用户要求中文回复。' });
  assert.equal(r.action, 'write');
  const e = await store.read('user.lang');
  assert.equal(e?.name, 'user.lang');
  assert.equal(e?.scope, 'global');
  assert.equal(e?.confidence, 'medium');
  assert.equal(e?.content, '用户要求中文回复。');
  assert.deepEqual(e?.tags, ['preference']);
});

test('同名 key 覆盖：updatedAt 新者覆盖旧者', async () => {
  const { store } = setup();
  await store.write({ ...base, name: 'user.lang', content: 'v1' });
  const r = await store.write({ ...base, name: 'user.lang', content: 'v2', updatedAt: '2026-08-21T10:00:00+08:00' });
  assert.equal(r.action, 'overwrite');
  const e = await store.read('user.lang');
  assert.equal(e?.content, 'v2');
});

test('脱敏：密钥/密码/token 模式拒写（redacted，不落盘）', async () => {
  const { store } = setup();
  const r = await store.write({ ...base, name: 'user.key', content: 'API key = sk-abcdef1234567890' });
  assert.equal(r.action, 'redacted');
  assert.equal(await store.read('user.key'), null);
  assert.equal(hasSecret('我的密码 password = hunter2'), true);
  assert.equal(hasSecret('普通事实：用户住在杭州'), false);
});

test('删除：墓碑后读不到；索引同步移除', async () => {
  const { dir, store } = setup();
  await store.write({ ...base, name: 'user.lang', content: 'x' });
  assert.equal(await store.delete('user.lang'), true);
  assert.equal(await store.read('user.lang'), null);
  assert.equal(await store.delete('user.lang'), false); // 二次删除 → false
  const idx = fs.readFileSync(path.join(dir, 'memory', 'MEMORY.md'), 'utf8');
  assert.ok(!idx.includes('user.lang'));
});

test('索引 MEMORY.md 维护（排序、覆盖不重复）', async () => {
  const { dir, store } = setup();
  await store.write({ ...base, name: 'b.key', content: 'b' });
  await store.write({ ...base, name: 'a.key', content: 'a' });
  await store.write({ ...base, name: 'b.key', content: 'b2' }); // 覆盖不重复
  const idx = fs.readFileSync(path.join(dir, 'memory', 'MEMORY.md'), 'utf8');
  const lines = idx.split('\n').filter(Boolean);
  assert.equal(lines.length, 2);
  assert.ok(lines[0]!.includes('[a.key]'));
  assert.ok(lines[1]!.includes('[b.key]'));
  assert.ok(idx.includes('用户偏好中文'));
});

test('BM25 检索：关键词命中排序 + 无命中返回空', async () => {
  const { store } = setup();
  await store.write({ ...base, name: 'u1', content: '用户喜欢猫 猫 猫', updatedAt: '2026-08-21T09:00:00+08:00' });
  await store.write({ ...base, name: 'u2', content: '用户喜欢猫，但更喜欢狗', updatedAt: '2026-08-21T10:00:00+08:00' });
  const hits = await store.search('猫');
  assert.equal(hits.length, 2);
  assert.equal(hits[0]!.entry.name, 'u1');
  assert.ok(hits[0]!.score > hits[1]!.score); // 词频加权
  assert.equal((await store.search('不存在的词')).length, 0);
});

test('TTL 过期：非 high 置信且超过 ttlDays → 清理；high 保留', async () => {
  const { store } = setup();
  await store.write({ ...base, name: 'old.low', content: '旧', confidence: 'low', updatedAt: '2026-01-01T00:00:00+08:00' });
  await store.write({ ...base, name: 'old.high', content: '旧', confidence: 'high', updatedAt: '2026-01-01T00:00:00+08:00' });
  await store.write({ ...base, name: 'fresh', content: '新', updatedAt: '2026-08-21T09:00:00+08:00' });
  const deleted = await store.purgeExpired(30, '2026-08-21T09:00:00+08:00');
  assert.equal(deleted, 1);
  assert.equal(await store.read('old.low'), null);
  assert.ok(await store.read('old.high'));
  assert.ok(await store.read('fresh'));
});

// ── 生命周期字段 + TTL 真生效 ────────────────────────────────────────────────

test('新字段往返：importance/createdAt/lastUsedAt/expiresAt/status 写进去读出来一致', async () => {
  const { store } = setup();
  await store.write({
    ...base, name: 'u.f', content: '正文',
    importance: 0.8, createdAt: '2026-08-01T00:00:00+08:00',
    lastUsedAt: '2026-08-20T00:00:00+08:00', expiresAt: '2027-01-01T00:00:00+08:00', status: 'candidate',
  });
  const e = await store.read('u.f');
  assert.equal(e?.importance, 0.8);
  assert.equal(e?.createdAt, '2026-08-01T00:00:00+08:00');
  assert.equal(e?.lastUsedAt, '2026-08-20T00:00:00+08:00');
  assert.equal(e?.expiresAt, '2027-01-01T00:00:00+08:00');
  assert.equal(e?.status, 'candidate');
});

test('向后兼容：老条目（无新字段）读出来 undefined，写回不凭空多行；active 不写行', async () => {
  const { dir, store } = setup();
  const raw = ['---', 'name: u.old', 'scope: global', 'description: 旧条目', 'confidence: medium',
    'source: sess-1', 'tags: preference', 'updatedAt: 2026-08-21T09:00:00+08:00', '---', '正文'].join('\n');
  fs.mkdirSync(`${dir}/memory/semantic`, { recursive: true }); // 全新目录：语义目录平时由第一次写入创建
  fs.writeFileSync(`${dir}/memory/semantic/u.old.md`, raw);
  const e = await store.read('u.old');
  assert.equal(e?.importance, undefined);
  assert.equal(e?.status, undefined);
  assert.equal(e?.createdAt, base.updatedAt, '没有 createdAt 的老条目：按 updatedAt 兜底（内存补齐）');
  // ① **只读不改盘**：老文件的字节面一个都不许动
  assert.equal(fs.readFileSync(`${dir}/memory/semantic/u.old.md`, 'utf8'), raw, '读一遍不该改写老文件');
  // ② 真被写时才落盘，且落的是**兜底值**（不拿"现在"冒充创建时间）；其余生命周期行仍不出现
  await store.write({ ...e!, status: 'active' });
  const back = fs.readFileSync(`${dir}/memory/semantic/u.old.md`, 'utf8');
  assert.match(back, /createdAt: 2026-08-21T09:00:00\+08:00/, '兜底值 = 原 updatedAt，不是 now');
  assert.ok(!/importance:|lastUsedAt:|expiresAt:|status:/.test(back), '不该凭空多出其它字段行：' + back);
});

test('覆盖 = 换内容不重置生命周期：createdAt/status/lastUsedAt/importance 留住，expiresAt 重新计时', async () => {
  const { store } = setup();
  await store.write({
    ...base, name: 'u.k', content: 'v1', importance: 0.9, createdAt: '2026-08-01T00:00:00+08:00',
    lastUsedAt: '2026-08-20T00:00:00+08:00', expiresAt: '2027-01-01T00:00:00+08:00', status: 'active',
  });
  await store.write({ ...base, name: 'u.k', content: 'v2', updatedAt: '2026-08-22T00:00:00+08:00', status: 'candidate' });
  const e = await store.read('u.k');
  assert.equal(e?.content, 'v2');
  assert.equal(e?.createdAt, '2026-08-01T00:00:00+08:00', '创建时间不该被覆盖吃掉');
  assert.equal(e?.importance, 0.9, 'importance 不该被冲掉');
  assert.equal(e?.lastUsedAt, '2026-08-20T00:00:00+08:00', 'lastUsedAt 是运行数据，不该丢');
  assert.equal(e?.status, 'candidate', '显式给了 status 就用新的');
  assert.equal(e?.expiresAt, undefined, 'expiresAt 例外：内容更新 → 重新计时');
});

test('用户批准过的状态不许被下一次自动提炼打回候选', async () => {
  const { store } = setup();
  await store.write({ ...base, name: 'u.a', content: 'v1', status: 'candidate' });
  await store.setStatus('u.a', 'active');
  // 自动提炼又写了一遍同一条（不带 status）
  await store.write({ ...base, name: 'u.a', content: 'v1 补充', updatedAt: '2026-08-22T00:00:00+08:00' });
  // 注：active 是缺省语义，**不写进 frontmatter**（老文件不该凭空多行）——所以按语义断言
  assert.notEqual((await store.read('u.a'))?.status, 'candidate', '批准过的记忆不该被打回候选');
});

test('召回回流 touch：lastUsedAt 更新、updatedAt 不动', async () => {
  const { store } = setup();
  await store.write({ ...base, name: 'u.t', content: 'x' });
  assert.equal(await store.touch('u.t', '2026-09-01T00:00:00+08:00'), true);
  const e = await store.read('u.t');
  assert.equal(e?.lastUsedAt, '2026-09-01T00:00:00+08:00');
  assert.equal(e?.updatedAt, base.updatedAt, 'updatedAt 是内容新鲜度，被召回不算内容变化');
  assert.equal(await store.touch('不存在'), false);
});

test('TTL：显式 expiresAt 优先于 updatedAt+ttlDays；high 置信有 expiresAt 也不清', async () => {
  const { store } = setup();
  const now = '2026-08-21T09:00:00+08:00';
  // updatedAt 很新、但 expiresAt 已过 → 该清（说明 expiresAt 真的优先）
  await store.write({ ...base, name: 'e.due', content: 'x', updatedAt: now, expiresAt: '2026-08-20T00:00:00+08:00' });
  // updatedAt 很旧、但 expiresAt 未到 → 不清（老逻辑会误杀）
  await store.write({ ...base, name: 'e.future', content: 'x', confidence: 'low', updatedAt: '2020-01-01T00:00:00+08:00', expiresAt: '2027-01-01T00:00:00+08:00' });
  // top 置信 + 已过期 → 仍不清（长期记忆不蒸发）
  await store.write({ ...base, name: 'e.high', content: 'x', confidence: 'high', expiresAt: '2020-01-01T00:00:00+08:00' });
  const deleted = await store.purgeExpired(30, now);
  assert.equal(deleted, 1);
  assert.equal(await store.read('e.due'), null);
  assert.ok(await store.read('e.future'));
  assert.ok(await store.read('e.high'));
});

test('空查询（冻结前缀的稳定核心）：importance 优先、同分按新近 —— 且确定性', async () => {
  const { store } = setup();
  await store.write({ ...base, name: 'low', content: 'a', confidence: 'low', updatedAt: '2026-08-21T10:00:00+08:00' });
  await store.write({ ...base, name: 'high', content: 'b', confidence: 'high', updatedAt: '2026-08-21T09:00:00+08:00' });
  await store.write({ ...base, name: 'mid.new', content: 'c', confidence: 'medium', updatedAt: '2026-08-21T11:00:00+08:00' });
  await store.write({ ...base, name: 'mid.old', content: 'd', confidence: 'medium', updatedAt: '2026-08-21T08:00:00+08:00' });
  const order = (await store.search('', 10)).map((h) => h.entry.name);
  assert.deepEqual(order, ['high', 'mid.new', 'mid.old', 'low']);
  // 确定性：再查一次，顺序逐字相同（冻结前缀字节稳定的前提）
  assert.deepEqual((await store.search('', 10)).map((h) => h.entry.name), order);
});

// ── 候选态 ──────────────────────────────────────────────────────────────────

test('候选态默认值：自动提炼的落候选，用户说的直接生效 —— 且**只在首次写入**生效', async () => {
  const { store } = setup();
  // 她自己提炼的 → 候选
  await store.write({ ...base, name: 'auto.1', content: '她好像喜欢猫', source: 'chat-digest' });
  assert.equal((await store.read('auto.1'))?.status, 'candidate');
  // 用户当面纠正的 → 直接生效（不写行 = active）
  await store.write({ ...base, name: 'said.1', content: '我不住杭州', source: 'user-correction' });
  assert.notEqual((await store.read('said.1'))?.status, 'candidate');
  // 会话摘要滚出来的 → 候选
  await store.write({ ...base, name: 'ses.1', content: '上次聊到滑雪', source: 'session.main.fact.x' });
  assert.equal((await store.read('ses.1'))?.status, 'candidate');
});

test('候选态：用户批准后，下一次自动提炼打不回候选', async () => {
  const { store } = setup();
  await store.write({ ...base, name: 'c.1', content: 'v1', source: 'chat-digest' });
  assert.equal((await store.read('c.1'))?.status, 'candidate');
  await store.setStatus('c.1', 'active');           // 用户点「批准」
  await store.write({ ...base, name: 'c.1', content: 'v2', source: 'chat-digest', updatedAt: '2026-08-22T00:00:00+08:00' });
  assert.notEqual((await store.read('c.1'))?.status, 'candidate', '批准过的记忆不该被打回候选');
});

test('候选态：忽略（deprecated）后不再被检索到，文件仍在（便于反悔）', async () => {
  const { dir, store } = setup();
  await store.write({ ...base, name: 'd.1', content: '崇礼滑雪很好玩', source: 'chat-digest' });
  assert.equal((await store.search('滑雪')).length, 1);
  await store.setStatus('d.1', 'deprecated');
  assert.equal((await store.search('滑雪')).length, 0, '忽略过的记忆不该再被想起来');
  assert.equal((await store.searchHybrid('滑雪')).length, 0);
  assert.ok(fs.existsSync(`${dir}/memory/semantic/d.1.md`), '文件要留着（用户随时能反悔）');
  assert.equal(await store.setStatus('不存在', 'active'), false);
});

test('查重看得见已忽略条目：忽略过的内容不许以新 key 复活（条 40）', async () => {
  const { store } = setup();
  await store.write({ ...base, name: 'user.coffee', content: '用户每天都要喝一杯咖啡。' });
  await store.setStatus('user.coffee', 'deprecated'); // 用户在界面上点了"忽略"

  // 召回路径：看不见它（这是对的，别再端上来）
  const visible = await store.search('咖啡', 5);
  assert.equal(visible.length, 0);

  // 查重路径：必须看得见 —— 否则自动提炼再抽到同样内容会换个 key 写一条新的。
  // 查询串按**真实链路**给：提炼器再抽一次得到的是内容原文，不是改写过的问句。
  const forDedup = await store.search('用户每天都要喝一杯咖啡', 1, { includeDeprecated: true });
  assert.equal(forDedup.length, 1);
  assert.equal(forDedup[0]!.entry.name, 'user.coffee');
  assert.ok(forDedup[0]!.score > 0.8, `相似度要够高才谈得上"同一条"：${forDedup[0]!.score}`);

  // ⚠ 残余风险（如实记）：查重靠 0.8 阈值，**换个说法**（"用户习惯早上喝咖啡"）分数会掉到
  // 0.75 上下 → 仍会以新 key 写一条。要根治得让"已忽略的内容"参与一次语义相似判断，
  // 那是另一笔（要动阈值/加向量），先记在案、不假装已经堵死。

  // 覆盖写（自动提炼路径）→ 内容更新，但**状态保持 ignored**
  await store.write({ ...base, name: 'user.coffee', content: '用户每天都要喝一杯咖啡，早上喝。' });
  const after = await store.read('user.coffee');
  assert.equal(after?.status, 'deprecated', '覆盖不许把 ignored 打回 active/candidate');
  const visibleAgain = await store.search('每天 咖啡', 5);
  assert.equal(visibleAgain.length, 0, '忽略过的记忆不许因为被再提炼一次就复活');
});
