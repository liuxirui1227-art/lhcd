// 压缩存档 + 历史检索（"压缩 = 延迟检索"而不是"压缩 = 丢失"）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createNodeRuntime } from '../runtime/node.js';
import { SessionArchive } from './archive.js';

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-archive-'));
  const rt = createNodeRuntime({
    cwd: dir,
    storage: { sessionsDir: `${dir}/s`, logsDir: `${dir}/l`, memoryDir: `${dir}/m`, configDir: `${dir}/c` },
  });
  return { dir, rt, archive: new SessionArchive(rt, 'sess-1') };
}

test('归档：只追加、跳过空消息与摘要块', async () => {
  const { rt, archive } = setup();
  const n = await archive.append(
    [
      { role: 'user', content: '今天聊到灵核项目的排期' },
      { role: 'assistant', content: '' },
      { role: 'user', content: '【会话压缩摘要（结构化）】{"goal":"x"}' },
      { role: 'tool', content: '命令输出：全部通过', toolCallId: 't1' },
    ],
    '2026-09-17T10:00:00.000Z',
  );
  assert.equal(n, 2); // 空内容与摘要块不入档
  const all = await archive.list();
  assert.equal(all.length, 2);
  assert.equal(all[0]!.role, 'user');
  assert.equal(all[1]!.toolCallId, 't1');
  // 追加而非重写：再归档一次，旧的还在
  await archive.append([{ role: 'user', content: '第二轮的事' }], '2026-09-17T11:00:00.000Z');
  assert.equal((await archive.list()).length, 3);
  const raw = fs.readFileSync(`${rt.storage.sessionsDir()}/sess-1/archive.jsonl`, 'utf8');
  assert.ok(raw.trim().split('\n').length === 3);
});

test('检索：中文长句能命中（复用 36 条的打分）；无档/无命中都给得体的空', async () => {
  const { archive } = setup();
  assert.deepEqual(await archive.search('随便什么'), []); // 还没归档过
  await archive.append(
    [
      { role: 'user', content: '用户提到生日是三月五号，想吃火锅' },
      { role: 'assistant', content: '好，记下了' },
      { role: 'user', content: '另外灵核项目下周要出个验收包' },
    ],
    '2026-09-17T10:00:00.000Z',
  );
  const hits = await archive.search('上次我们说的那个项目什么时候要验收包');
  assert.equal(hits.length, 1);
  assert.ok(hits[0]!.msg.content.includes('灵核项目'));
  assert.ok(hits[0]!.score > 0);
  // 无关查询 → 空（不硬凑）
  assert.deepEqual(await archive.search('量子力学'), []);
});

test('检索：长文截取命中附近片段，带省略号', async () => {
  const { archive } = setup();
  const long = `${'前'.repeat(2000)}关键约定在第五章${'后'.repeat(2000)}`;
  await archive.append([{ role: 'user', content: long }], '2026-09-17T10:00:00.000Z');
  const hits = await archive.search('第五章');
  assert.equal(hits.length, 1);
  assert.ok(hits[0]!.excerpt.includes('第五章'));
  assert.ok(hits[0]!.excerpt.length < 600);
  assert.ok(hits[0]!.excerpt.startsWith('…'));
});
