// 时间锚点（跨天那一行 + 距上次几天）
// 用法：node --test time-anchor.test.mjs（零成本：mock 大脑，时间靠注入 now——**不改系统时钟**）
//
// 判据：① 一天里只给一次；② 第一次对话不给"上次说话是几天前"；③ 跨天要说人话（凌晨/上午/晚上）；
//       ④ 主脑侧：给了才加、加在**冻结前缀最末尾**（缓存作废最短）；不给就一个字都不加。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'lhcd-anchor-'));
process.env.LHCD_DATA_DIR = DATA;
process.env.LHCD_LLM_MOCK = '1';
const script = path.join(DATA, 's.json');
fs.writeFileSync(script, JSON.stringify([[{ type: 'text.delta', text: '嗯。' }, { type: 'done' }]]));
process.env.LHCD_LLM_MOCK_SCRIPT = script;

const lib = await import('./lib.mjs');
lib.mockBirth({ name: '测试体' });

const at = (y, mo, d, h) => new Date(y, mo - 1, d, h, 30, 0).getTime();

test('第一次：给"现在是什么时候"，但**不给**"上次说话是几天前"', () => {
  const r = lib.timeAnchorLine(at(2026, 9, 27, 1));
  assert.equal(r.ok, true);
  assert.match(r.line, /【现在是什么时候】/);
  assert.match(r.line, /9 月 27 日/);
  assert.match(r.line, /凌晨/, '半夜要说"凌晨"：' + r.line);
  assert.ok(!/上次说话/.test(r.line), '第一次没有"上次"：' + r.line);
});

test('★ 一天里只给一次（同一天再问就是空的）', () => {
  lib.markAnchorDay('2026-9-27');
  const again = lib.timeAnchorLine(at(2026, 9, 27, 9));
  assert.equal(again.isNewDay, false);
  assert.equal(again.line, '');
});

test('★ 跨天：给新的一天 + "上次说话是几天前"', async () => {
  // "上次说话"的依据是**签名链里作者是用户的条目**（不是另存一个字段）——
  // 所以先真说一句（真实入链），时间由系统时钟给
  lib.setMoodSink(() => {});
  await lib.chat('三天前那句', undefined, { origin: 'user' });
  const st = JSON.parse(fs.readFileSync(path.join(DATA, 'state.json'), 'utf8'));
  st.lastAnchorDay = '2026-9-26';            // 上一次给锚点是"昨天"
  fs.writeFileSync(path.join(DATA, 'state.json'), JSON.stringify(st));
  // 注入的 now = 链里那一条之后三天
  const chain = fs.readFileSync(path.join(DATA, 'log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const lastUser = chain.filter((e) => e.author === 'user').map((e) => e.hlc.t).sort((a, b) => b - a)[0];
  const r = lib.timeAnchorLine(lastUser + 3 * 86400000 + 3600e3);
  assert.equal(r.isNewDay, true);
  assert.match(r.line, /上次说话是 3 天前/, r.line);
  assert.equal(r.isNewDay, true);
});

test('当天早些时候说过话 → 不给"几天前"（不足一天不算）', () => {
  const st = JSON.parse(fs.readFileSync(path.join(DATA, 'state.json'), 'utf8'));
  st.lastAnchorDay = '2026-9-26';
  delete st.lastUserAt;   // 这玩意儿根本不该存在（多余字段）
  fs.writeFileSync(path.join(DATA, 'state.json'), JSON.stringify(st));
  const r = lib.timeAnchorLine(at(2026, 9, 27, 9));
  assert.ok(!/上次说话/.test(r.line), '不足一天不该说"几天前"：' + r.line);
});

test('"上次说话"的依据来自签名链（同一件事不存两处）', async () => {
  const st = JSON.parse(fs.readFileSync(path.join(DATA, 'state.json'), 'utf8'));
  assert.equal(st.lastUserAt, undefined, '不该再存一个 state.lastUserAt（两处迟早不一致）');
  const chain = fs.readFileSync(path.join(DATA, 'log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(chain.some((e) => e.author === 'user'), '用户说过的话要在链上（锚点据此算"几天前"）');
});
