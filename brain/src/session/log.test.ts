// 只追加的会话日志 + 纯函数投影。
// 三条要守住的：① 正常保存只**追加**（不重写）；② 上下文对不上时立 compact 基准（不装作无事）；
// ③ 投影是纯函数（同一份日志两次结果逐字相同），压缩之后原文仍在日志里（不是快照那种"一压就没"）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionLog, projectLog, planLogAppend, type LogEntry } from './log.js';
import { SessionStore } from './store.js';
import { createNodeRuntime } from '../runtime/node.js';
import type { ChatMessage } from '../llm/provider.js';

function mk() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-log-'));
  const rt = createNodeRuntime({
    cwd: dir,
    storage: { sessionsDir: `${dir}/s`, logsDir: `${dir}/l`, memoryDir: `${dir}/m`, configDir: `${dir}/c` },
  });
  return { dir, rt, store: new SessionStore(rt) };
}

const msg = (role: 'user' | 'assistant' | 'tool', content: string): ChatMessage => ({ role, content });

test('纯函数投影：同一份日志两次投影逐字相同；最后一条 compact 是"从这里往后读"的起点', () => {
  const entries: LogEntry[] = [
    { seq: 1, type: 'message', at: 't1', id: 'm1', parentId: null, payload: msg('user', '第一句') },
    { seq: 2, type: 'message', at: 't2', id: 'm2', parentId: 'm1', payload: msg('assistant', '回一') },
    { seq: 3, type: 'message', at: 't3', id: 'm3', parentId: 'm2', payload: msg('tool', '一大坨工具输出') },
    { seq: 4, type: 'compact', at: 't4', payload: [msg('user', '【摘要块】'), msg('assistant', '最后一轮')] },
    { seq: 5, type: 'message', at: 't5', id: 'm9', parentId: null, payload: msg('user', '压缩之后新说的') },
  ];
  const a = projectLog(entries);
  const b = projectLog(entries);
  assert.deepEqual(a, b);
  assert.equal(a.length, 3, '基准 2 条 + 其后 1 条');
  assert.equal(a[0]!.content, '【摘要块】');
  assert.equal(a[2]!.content, '压缩之后新说的');
  // 关键：被压缩掉的**原文还在日志里**（投影不带它，但日志条目一条没删）
  assert.ok(entries.some((e) => e.type === 'message' && String(e.payload && (e.payload as ChatMessage).content).includes('一大坨')));
});

test('追加计划：正常尾部增长 → 只追加新条目；历史被换过 → 立 compact 基准', () => {
  const h1 = [msg('user', 'a'), msg('assistant', 'b')];
  /* 空日志 → 逐条落 message（比立一条 compact 基准更细，重建时原文天然都在）；
     只有"历史被换过、前缀对不上"才立 compact 基准。 */
  const plan1 = planLogAppend([], h1, 't1');
  assert.equal(plan1.rebuiltBecause, null);
  assert.equal(plan1.entries.length, 2);
  assert.ok(plan1.entries.every((e) => e.type === 'message'));

  const base: LogEntry[] = plan1.entries;
  const h2 = [...h1, msg('user', 'c')];
  const plan2 = planLogAppend(base, h2, 't2');
  assert.equal(plan2.rebuiltBecause, null, '正常追加不该重建');
  assert.equal(plan2.entries.length, 1);
  assert.equal(plan2.entries[0]!.type, 'message');
  assert.equal(plan2.entries[0]!.seq, 3, '序号接着上一条往下排');
  assert.equal((plan2.entries[0]!.payload as ChatMessage).content, 'c');

  // 压缩发生了：历史被换成一份更短的（前缀对不上）→ 立新基准
  const h3 = [msg('user', '【会话压缩摘要】'), msg('assistant', 'c')];
  const plan3 = planLogAppend([...base, ...plan2.entries], h3, 't3');
  assert.equal(plan3.entries.length, 1);
  assert.equal(plan3.entries[0]!.type, 'compact');
  assert.match(String(plan3.rebuiltBecause), /对不上|立新基准/);
});

test('落盘：save 只追加（文件行数只增不减）；load 优先从日志投影；压缩后原文仍在日志里', async () => {
  const { dir, rt, store } = mk();
  const session = {
    id: 'main', cwd: dir, provider: { name: 'mock' }, config: { a: 1 }, stats: {},
    history: [msg('user', '第一句'), msg('assistant', '回一')],
  } as never;
  await store.save(session as never, '2026-09-26T00:00:00.000Z');
  const logFile = path.join(dir, 's', 'main', 'log.jsonl');
  const n1 = fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).length;
  assert.equal(n1, 2, '第一次把两条消息逐条落进日志');

  (session as { history: ChatMessage[] }).history = [...(session as { history: ChatMessage[] }).history, msg('user', '第二句')];
  await store.save(session as never, '2026-09-26T00:00:01.000Z');
  const rows = fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as LogEntry);
  const msgRows = rows.filter((r) => r.type === 'message').length;
  assert.equal(msgRows, 3, '三条消息各占一行（第二条是**追加**进去的，不是重写整份）');
  assert.equal(rows.length, n1 + 1, '文件只多了一行');

  // 读回来：走日志投影
  const loaded = await store.load('main', { a: 1 });
  assert.equal(loaded!.history.length, 3);
  assert.equal(loaded!.history[2]!.content, '第二句');

  // 模拟压缩：历史被换成"摘要块 + 最后一条"
  (session as { history: ChatMessage[] }).history = [msg('user', '【会话压缩摘要】'), msg('user', '第二句')];
  await store.save(session as never, '2026-09-26T00:00:02.000Z');
  const log = new SessionLog(rt, 'main');
  const after = await log.list();
  assert.ok(after.some((e) => e.type === 'compact'), '压缩后立了新基准');
  // 原文（第一句）仍在日志里 —— 这正是"压缩不再让原文从日志消失"
  assert.ok(JSON.stringify(after).includes('第一句'), '被压掉的原文还在日志里');
  const projected = await log.project();
  assert.equal(projected.length, 2, '投影 = 新基准（2 条）');
  assert.equal(projected[0]!.content, '【会话压缩摘要】');
});

test('老会话没有 log.jsonl → 回落 messages.jsonl（行为与从前一致）', async () => {
  const { dir, rt, store } = mk();
  fs.mkdirSync(path.join(dir, 's', 'old'), { recursive: true });
  fs.writeFileSync(path.join(dir, 's', 'old', 'session.json'), JSON.stringify({ id: 'old', cwd: dir, startedAt: 't', provider: 'mock', model: 'main', configHash: '', stats: {} }));
  fs.writeFileSync(path.join(dir, 's', 'old', 'messages.jsonl'), JSON.stringify(msg('user', '老会话的一句话')) + '\n');
  const loaded = await store.load('old', {});
  assert.equal(loaded!.history.length, 1);
  assert.equal(loaded!.history[0]!.content, '老会话的一句话');
  assert.equal(fs.existsSync(path.join(dir, 's', 'old', 'log.jsonl')), false, '读老会话不该顺手造一个日志文件');
  void rt;
});

/* ── 标签：落在只追加日志的 custom 条目上 ──────────────────────────────────── */

test('标签：追加事实、最后一条赢、空串 = 摘掉；不改历史条目', async () => {
  const { rt } = mk();
  const log = new SessionLog(rt, 'main');
  // 先有一条消息（标签要打给它）
  await log.sync([{ role: 'user', content: '第一句' }, { role: 'assistant', content: '回一' }], '2026-09-26T00:00:00.000Z');
  const msgs = await log.messages();
  const target = msgs[0]!.id;

  assert.deepEqual(await log.labels(), {}, '一开始没有标签');
  await log.appendCustom({ kind: 'label', target, text: '那个决定' }, '2026-09-26T00:01:00.000Z');
  assert.deepEqual(await log.labels(), { [target]: '那个决定' });

  // 再打一次 → 覆盖（最后一条赢）
  await log.appendCustom({ kind: 'label', target, text: '纪念日' }, '2026-09-26T00:02:00.000Z');
  assert.deepEqual(await log.labels(), { [target]: '纪念日' });

  // 空串 → 摘掉
  await log.appendCustom({ kind: 'label', target, text: '' }, '2026-09-26T00:03:00.000Z');
  assert.deepEqual(await log.labels(), {}, '空串要能把标签摘掉');

  // 只追加：消息条目还在，日志行数只增不减
  assert.equal((await log.messages()).length, 2, '打标签不许动历史条目');
  const rows = (await log.list()).filter((e) => e.type === 'custom');
  assert.equal(rows.length, 3, '三次标签操作 = 三条追加事实（历史留着，可回溯）');
});
