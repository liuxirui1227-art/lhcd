// Identity 层单测：用户定过的长期规矩（克制、可改、可审）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createNodeRuntime } from '../runtime/node.js';
import { IdentityStore, IDENTITY_MAX } from './identity.js';

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-id-'));
  const rt = createNodeRuntime({
    cwd: dir,
    storage: { sessionsDir: `${dir}/s`, logsDir: `${dir}/l`, memoryDir: `${dir}/memory`, configDir: dir },
  });
  return { dir, store: new IdentityStore(rt, `${dir}/memory/identity.md`) };
}

test('记一条规矩 → 落盘可读（一条一行 + 出处注释），list 往返一致', async () => {
  const { dir, store } = setup();
  const r = await store.add('回复用中文，别夹英文', 'user-request', '2026-09-23T10:00:00+08:00');
  assert.equal(r.action, 'add');
  assert.equal(r.count, 1);
  const raw = fs.readFileSync(`${dir}/memory/identity.md`, 'utf8');
  assert.match(raw, /^- 回复用中文，别夹英文 {2}<!-- user-request · 2026-09-23T10:00:00\+08:00 -->$/m);
  assert.deepEqual(await store.list(), [{ text: '回复用中文，别夹英文', source: 'user-request', at: '2026-09-23T10:00:00+08:00' }]);
});

test('重申同一条：刷新措辞，**保留最早的时间**（它一直算数）', async () => {
  const { store } = setup();
  await store.add('回复用中文', 'user-request', '2026-01-01T00:00:00+08:00');
  const r = await store.add('回复请用中文，不要夹英文', 'user-request', '2026-09-23T00:00:00+08:00');
  assert.equal(r.action, 'update');
  assert.equal(r.count, 1, '不该多出一条');
  const [it] = await store.list();
  assert.equal(it!.text, '回复请用中文，不要夹英文', '措辞按新的');
  assert.equal(it!.at, '2026-01-01T00:00:00+08:00', '时间保留最早的');
});

test('上限 30 条：满了**拒收**（不静默丢老的）', async () => {
  const { dir, store } = setup();
  // 直接铺满文件（避免"造的规矩彼此太像 → 被相似去重判成重申"这种测试数据问题）
  fs.mkdirSync(`${dir}/memory`, { recursive: true });
  const lines = Array.from({ length: IDENTITY_MAX }, (_, i) => `- 规矩${i}号  <!-- user-request · 2026-09-01T00:00:00+08:00 -->`);
  fs.writeFileSync(`${dir}/memory/identity.md`, ['# 规矩', ...lines, ''].join('\n'));
  assert.equal((await store.list()).length, IDENTITY_MAX);
  const r = await store.add('再来一条全新的规矩', 'user-request');
  assert.equal(r.action, 'full');
  assert.equal(r.count, IDENTITY_MAX);
  assert.equal((await store.list()).length, IDENTITY_MAX, '老的规则一条都不许被挤掉');
});

test('疑似密钥拒写；空串拒收', async () => {
  const { store } = setup();
  assert.equal((await store.add('我的密码 password = hunter2')).action, 'redacted');
  assert.equal((await store.add('   ')).action, 'empty');
  assert.equal((await store.list()).length, 0);
});

test('删规矩：按下标 / 按原文都对；删不到返回 false', async () => {
  const { store } = setup();
  await store.add('回复用中文', 'user-request');
  await store.add('别反复确认小事', 'user-request');
  assert.equal(await store.remove(5), false);
  assert.equal(await store.remove(0), true);
  assert.deepEqual((await store.list()).map((i) => i.text), ['别反复确认小事']);
  assert.equal(await store.removeByText('别反复确认小事'), true);
  assert.equal((await store.list()).length, 0);
  assert.equal(await store.removeByText('没这条'), false);
});

test('用户手改文件：没带注释的条目按 user-edit 记，注释里没时间也不炸', async () => {
  const { dir, store } = setup();
  fs.mkdirSync(`${dir}/memory`, { recursive: true });
  fs.writeFileSync(`${dir}/memory/identity.md`, [
    '# 你给 TA 定过的长期规矩（Identity 层）',
    '- 手写的一条规矩',
    '- 带出处的一条  <!-- user-request -->',
    '- 我  <!-- user-request · 2026-09-01T00:00:00+08:00 -->',
    '',
  ].join('\n'));
  const items = await store.list();
  assert.deepEqual(items[0], { text: '手写的一条规矩', source: 'user-edit', at: '' });
  assert.deepEqual(items[1], { text: '带出处的一条', source: 'user-request', at: '' });
  assert.equal(items[2]!.text, '我', '正文里带别的字也不该被注释吃掉');
});

test('render：按文件顺序、确定性（同一份文件 → 同一段字节）；空 → 空串', async () => {
  const { store } = setup();
  assert.equal(await store.render(), '');
  await store.add('回复用中文，别夹英文', 'user-request');
  await store.add('别反复确认小事', 'user-request');
  const first = await store.render();
  assert.equal(first, '- 回复用中文，别夹英文\n- 别反复确认小事');
  assert.equal(await store.render(), first, '两次渲染必须逐字相同（冻结前缀的前提）');
});
