// 听到"冲着她来的"话 → 宿主推一次"开心"给形象端
// 用法：node --test pet-mood.test.mjs（零成本：mock 大脑）
//
// 这条盯的是**接线**（词表本身由 brain 的 directed.test.ts 盯）：
//   ① 说一句"谢谢你" → moodSink 收到一次 joy；
//   ② 平常的话 → 不收；
//   ③ **后台回合**（定时/心跳）里的话**不算**——那不是"你对我说的"；
//   ④ 一次回合只推一次（不许一句话推好几遍）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'lhcd-mood-'));
process.env.LHCD_DATA_DIR = DATA;
process.env.LHCD_LLM_MOCK = '1';
const script = path.join(DATA, 's.json');
fs.writeFileSync(script, JSON.stringify([[{ type: 'text.delta', text: '嗯。' }, { type: 'done' }]]));
process.env.LHCD_LLM_MOCK_SCRIPT = script;

const lib = await import('./lib.mjs');
lib.mockBirth({ name: '测试体' });

const moods = [];
lib.setMoodSink((m) => moods.push(m));

test('★ 用户说"谢谢你，今天多亏你" → 推一次开心', async () => {
  moods.length = 0;
  await lib.chat('谢谢你，今天多亏你', undefined, { origin: 'user' });
  assert.equal(moods.length, 1, '该推一次：' + JSON.stringify(moods));
  assert.equal(moods[0].kind, 'joy');
});

test('平常的话不推（不许看见什么都开心）', async () => {
  moods.length = 0;
  await lib.chat('帮我看看这份报表', undefined, { origin: 'user' });
  assert.equal(moods.length, 0, JSON.stringify(moods));
});

test('★ 后台回合不算：定时/心跳里出现"谢谢"不该让她开心', async () => {
  moods.length = 0;
  await lib.chat('（定时）谢谢', undefined, { origin: 'cron' });
  assert.equal(moods.length, 0, '后台回合里的话不是"你对我说的"：' + JSON.stringify(moods));
});

test('道谢+夸奖一起来也只推一次（一句话一次）', async () => {
  moods.length = 0;
  await lib.chat('谢谢你，你真棒', undefined, { origin: 'user' });
  assert.equal(moods.length, 1, JSON.stringify(moods));
});
