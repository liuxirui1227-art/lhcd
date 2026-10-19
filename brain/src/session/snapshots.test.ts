// 回合级快照与回滚计划。
//
// 盯住四条容易做错的：
//   ① **第一次赢**：一轮里改同一个文件三次，快照里留的必须是"这一轮开始前"那一份（`.bak` 做不到）；
//   ② **新建的文件**要有 `existed:false` 且**没留内容**（还原 = 删掉）；
//   ③ `plan` 是**只算不动**（不许偷偷写盘/删文件）——它是"要做什么"的清单；
//   ④ 保留策略只留最近 N 个回合，且**没能力删就不假装清理过**。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createNodeRuntime } from '../runtime/node.js';
import { SnapshotStore, TurnSnapshots } from './snapshots.js';

function setup(keep = 20) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-snap-'));
  const rt = createNodeRuntime({
    cwd: dir,
    storage: { sessionsDir: `${dir}/s`, logsDir: `${dir}/l`, memoryDir: `${dir}/m`, configDir: `${dir}/c` },
  });
  return { dir, rt, store: new SnapshotStore(rt, `${dir}/snapshots`, keep) };
}

test('快照：同一轮同一文件只记第一次（第一次赢 = 这一轮开始前的那一份）', async () => {
  const { store } = setup();
  const snap = new TurnSnapshots(store, 'turn-1');
  assert.equal(await snap.record('/tmp/a.md', '第一版'), true);
  assert.equal(await snap.record('/tmp/a.md', '第二版'), false, '第二次不该覆盖');
  const entries = await store.entriesOf('turn-1');
  assert.equal(entries.length, 1);
  const written = fs.readFileSync(path.join(store.dir, entries[0]!.file!), 'utf8');
  assert.equal(written, '第一版');
});

test('快照：新建的文件记 existed:false 且不落内容（还原 = 删掉）', async () => {
  const { store } = setup();
  await store.record('turn-2', '/tmp/brand-new.md', null);
  const [e] = await store.entriesOf('turn-2');
  assert.equal(e!.existed, false);
  assert.equal(e!.file, null);
  assert.equal(e!.bytes, 0);
});

test('plan：只算不动——写回清单与删除清单分开，盘上什么都不变', async () => {
  const { dir, rt, store } = setup();
  await rt.fs.write(`${dir}/keep.txt`, '改前');
  await store.record('turn-3', `${dir}/keep.txt`, '改前');
  await store.record('turn-3', `${dir}/made.txt`, null);
  await rt.fs.write(`${dir}/keep.txt`, '改后');
  await rt.fs.write(`${dir}/made.txt`, '新建的');

  const plan = await store.plan('turn-3');
  assert.deepEqual(plan.restore.map((r) => r.path), [`${dir}/keep.txt`]);
  assert.equal(plan.restore[0]!.content, '改前');
  assert.deepEqual(plan.remove, [`${dir}/made.txt`]);
  assert.equal(plan.total, 2);
  // 只算不动：盘上还是"改后"的样子
  assert.equal(fs.readFileSync(`${dir}/keep.txt`, 'utf8'), '改后');
  assert.equal(fs.existsSync(`${dir}/made.txt`), true);
});

test('保留策略：只留最近 N 个回合，且**没有删的能力时不假装清理过**', async () => {
  const { rt, store } = setup(2);
  for (const t of ['t1', 't2', 't3']) await store.record(t, `/tmp/${t}.md`, `内容-${t}`);
  await store.prune();
  const turns = [...new Set((await store.list()).map((e) => e.turnId))];
  assert.deepEqual(turns, ['t2', 't3'], `只该留最近两个，实际 ${turns.join(',')}`);

  // 没有 fs.remove 的运行时（某些注入环境）：目录留着、索引不动，**不报告"已清理"**
  const bare = { ...rt, fs: { ...rt.fs, remove: undefined } } as unknown as typeof rt;
  const s2 = new SnapshotStore(bare, `${store.dir}-bare`, 1);   // 另起一个根：别把上一段的回合算进来
  await s2.record('x1', '/tmp/x1.md', 'a');
  await s2.record('x2', '/tmp/x2.md', 'b');
  const r = await s2.prune();
  assert.deepEqual(r.droppedTurns, [], '没有删的能力时**整件事都不做**（只删索引不删目录最坏：目录还在却再也退不回去）');
  const still = await s2.list();
  assert.deepEqual([...new Set(still.map((e) => e.turnId))], ['x1', 'x2'], '索引一点没动（下一轮再试）');
});

test('坏行不拖垮索引：中间一行坏了，其余照读', async () => {
  const { rt, store } = setup();
  await store.record('t', '/tmp/ok.md', 'x');
  await rt.fs.append(`${store.dir}/index.jsonl`, '{坏行\n');
  await store.record('t', '/tmp/ok2.md', 'y');
  const all = await store.list();
  assert.deepEqual(all.map((e) => e.path), ['/tmp/ok.md', '/tmp/ok2.md']);
});
