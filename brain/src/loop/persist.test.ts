// 大工具输出落盘单测（阈值 / 预览截断 / 落盘块话术 / read 钉住不落盘）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createNodeRuntime } from '../runtime/node.js';
import { maybePersistOutput, previewOf, buildPersistedMessage, PERSIST_THRESHOLD_CHARS } from './persist.js';

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-persist-'));
  const rt = createNodeRuntime({
    cwd: dir,
    storage: { sessionsDir: `${dir}/s`, logsDir: `${dir}/l`, memoryDir: `${dir}/m`, configDir: `${dir}/c` },
  });
  return { dir, rt };
}

test('previewOf：短内容原样；长内容优先切在换行边界（且只在换行落在后半段时）', () => {
  assert.deepEqual(previewOf('短短一行', 100), { preview: '短短一行', hasMore: false });

  // 换行落在后半段 → 切在换行处（保留换行）
  const late = 'a'.repeat(1400) + '\n' + 'b'.repeat(600);
  const p1 = previewOf(late, 1500);
  assert.equal(p1.hasMore, true);
  assert.equal(p1.preview.length, 1401);
  assert.equal(p1.preview.endsWith('\n'), true);

  // 换行落在前半段 → 硬切（不为了凑换行把预览砍掉一半）
  const early = 'a'.repeat(100) + '\n' + 'b'.repeat(2000);
  const p2 = previewOf(early, 1500);
  assert.equal(p2.preview.length, 1500);
});

test('落盘块话术：带大小、绝对路径、翻页指引、以及"别再重调一遍"', () => {
  const msg = buildPersistedMessage('预览内容', true, 123456, '/tmp/x/out.txt');
  assert.match(msg, /<persisted-output>/);
  assert.match(msg, /120\.6 KB/);
  assert.match(msg, /\/tmp\/x\/out\.txt/);
  assert.match(msg, /offset\/limit/);
  assert.match(msg, /别为了同一份数据把工具再调一遍/);
  assert.match(msg, /\.\.\./); // 截断标记
  assert.match(msg, /<\/persisted-output>/);
});

test('超阈值才落盘：文件真写出来，块里给的路径能读到原文', async () => {
  const { rt } = setup();
  const small = await maybePersistOutput(rt, { id: 'c1', tool: 'grep', output: '短输出' });
  assert.equal(small, null);

  const big = '行内容\n'.repeat(Math.ceil(PERSIST_THRESHOLD_CHARS / 4) + 10);
  const out = await maybePersistOutput(rt, { id: 'c2', tool: 'grep', output: big });
  assert.ok(out && out.includes('<persisted-output>'));
  const p = /完整内容在：(.+)/.exec(out!)?.[1]!.trim();
  assert.ok(p && fs.existsSync(p!), '落盘文件应该真的在');
  assert.equal(fs.readFileSync(p!, 'utf8').length, big.length); // 一个字不丢
});

test('read 钉住不落盘（hermes 同款：防"落盘→读→再落盘"死循环）', async () => {
  const { rt } = setup();
  const big = '行\n'.repeat(PERSIST_THRESHOLD_CHARS);
  assert.equal(await maybePersistOutput(rt, { id: 'c3', tool: 'read', output: big }), null);
});
