// 任务账本单测：原子写 / 事件流重建 / 恢复语义 / 催办退避 / 状态词。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createNodeRuntime } from '../runtime/node.js';
import { TaskStore } from './store.js';
import { statusWord, progressOf } from './types.js';
import { nudgeDecision, classifyFailure, isUnrecoverable, nextNudgeAt } from './nudge.js';
import { stopVerdict, promiseSeen, stripPromise, continuationNudge } from './criteria.js';
import { decideResume, TOMBSTONE_FRESH_MS, TOMBSTONE_MAX_ATTEMPTS, resumePrompt, type Tombstone } from './tombstone.js';

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-task-'));
  const rt = createNodeRuntime({
    cwd: dir,
    storage: { sessionsDir: `${dir}/s`, logsDir: `${dir}/l`, memoryDir: `${dir}/m`, configDir: `${dir}/c` },
  });
  let NOW = new Date(2026, 8, 18, 10, 0, 0);
  const store = new TaskStore(rt, `${dir}/tasks`, () => NOW);
  return { store, dir, rt, now: () => NOW.getTime(), setNow: (ms: number) => { NOW = new Date(ms); }, advance: (ms: number) => { NOW = new Date(NOW.getTime() + ms); } };
}

test('建任务：落快照 + 索引 + run_created 事件；带上完成信号', async () => {
  const { store, dir } = setup();
  await store.load();
  const run = await store.create({
    title: '整理季度报表', explanation: '你要的', sessionId: 'main',
    steps: [{ title: '找数据' }, { title: '做表' }], completionPromise: 'DONE-ALL',
  });
  assert.equal(run.state, 'running');
  assert.equal(run.steps.length, 2);
  assert.deepEqual(run.steps[1]!.dependencies, ['s1']); // 默认顺序链
  assert.ok(fs.existsSync(path.join(dir, 'tasks', run.id, 'task.json')));
  const idx = JSON.parse(fs.readFileSync(path.join(dir, 'tasks', 'index.json'), 'utf8'));
  assert.equal(idx.runs.length, 1);
  const events = fs.readFileSync(path.join(dir, 'tasks', run.id, 'events.jsonl'), 'utf8').trim().split('\n');
  assert.equal(JSON.parse(events[0]!).type, 'run_created');
  assert.equal(JSON.parse(events[0]!).payload.promise, 'DONE-ALL');
});

test('步骤状态机：依赖没完成不许开工；终态不可回退；完成推进 run 状态', async () => {
  const { store } = setup();
  await store.load();
  const run = await store.create({ title: 'A', steps: [{ title: '一步' }, { title: '二步' }] });
  const fail = await store.updateStep(run.id, 's2', { state: 'completed' });
  assert.equal(fail.ok, false);
  assert.match(fail.error!, /还等着 s1/);

  assert.equal((await store.updateStep(run.id, 's1', { state: 'completed', resultSummary: '数据齐了' })).ok, true);
  assert.equal((await store.updateStep(run.id, 's1', { state: 'pending' })).ok, false, '终态不可回退');
  assert.equal((await store.updateStep(run.id, 's2', { state: 'completed' })).ok, true);
  const after = store.get(run.id)!;
  assert.equal(after.state, 'completed'); // 全部完成 → 终态推导
  assert.deepEqual(progressOf(after), { done: 2, total: 2 });
});

test('终态推导：有失败步 → blocked（带上人话原因），不是 completed', async () => {
  const { store } = setup();
  await store.load();
  const run = await store.create({ title: 'B', steps: [{ title: '一步' }] });
  await store.updateStep(run.id, 's1', { state: 'failed', detail: '数据源打不开' });
  const after = store.get(run.id)!;
  assert.equal(after.state, 'blocked');
  assert.match(after.stateDetail!, /s1/);
});

test('条 16：block 是一等状态（需要你决定）+ 回答问题后回到 running', async () => {
  const { store } = setup();
  await store.load();
  const run = await store.create({ title: 'C' });
  await store.askUser(run.id, '报表用哪个口径？');
  const blocked = store.get(run.id)!;
  assert.equal(blocked.state, 'blocked');
  assert.equal(blocked.blockReason, 'needs_input');
  const w = statusWord(blocked);
  assert.equal(w.key, 'needs_input');
  assert.match(w.label, /需要你决定/);
  assert.equal(w.stopped, true);
  assert.equal(blocked.blockedAt !== undefined, true);
  await store.answerUser(run.id, '用财年口径');
  assert.equal(store.get(run.id)!.state, 'running');
});

test('条 50/16：重启恢复——running 一律置 paused（绝不自动续跑），步回退 pending', async () => {
  const { store } = setup();
  await store.load();
  const run = await store.create({ title: 'D', steps: [{ title: '一步' }] });
  await store.updateStep(run.id, 's1', { state: 'running' });
  const rec = await store.recoverOnStart();
  assert.equal(rec.length, 1);
  assert.equal(rec[0]!.state, 'paused');
  assert.equal(rec[0]!.steps[0]!.state, 'pending');
  assert.match(rec[0]!.steps[0]!.detail!, /打断/);
  // 事件流里留下 recovered_requires_confirmation（重启的痕迹可审计）
  assert.equal(store.get(run.id)!.state, 'paused');
});

test('快照损坏 → 重放事件流重建（真相源）；事件流也没了 → 隔离，不带着坏状态继续', async () => {
  const { store, dir } = setup();
  await store.load();
  const run = await store.create({ title: 'E', steps: [{ title: '一步' }] });
  await store.updateStep(run.id, 's1', { state: 'completed' });
  // 快照写坏，事件流完好
  fs.writeFileSync(path.join(dir, 'tasks', run.id, 'task.json'), '{ 这不是 JSON');
  const s2 = new TaskStore(store['runtime'], `${dir}/tasks`);
  await s2.load();
  const rebuilt = s2.get(run.id)!;
  assert.equal(rebuilt.state, 'completed'); // 从事件流重建
  // 快照 + 事件流都坏
  const run2 = await store.create({ title: 'F' });
  fs.writeFileSync(path.join(dir, 'tasks', run2.id, 'task.json'), '坏的');
  fs.writeFileSync(path.join(dir, 'tasks', run2.id, 'events.jsonl'), '也坏的\n');
  const s3 = new TaskStore(store['runtime'], `${dir}/tasks`);
  await s3.load();
  assert.equal(s3.get(run2.id), null);
  assert.equal(s3.isQuarantined(run2.id), true);
  assert.ok(fs.existsSync(path.join(dir, 'tasks', run2.id, 'task.json.corrupt')));
});

test('迭代 17 节点 4 修 bug：产物经快照损坏 → 重放后仍在（此前会整段丢）', async () => {
  const { store, dir } = setup();
  await store.load();
  const run = await store.create({ title: '带产物的一步', steps: [{ title: '写文件' }] });
  await store.updateStep(run.id, 's1', { state: 'completed', artifacts: ['/a/月报.xlsx', '/a/图表.png'] });
  // 快照写坏，逼它从事件流重建
  fs.writeFileSync(path.join(dir, 'tasks', run.id, 'task.json'), '{ 坏快照');
  const s2 = new TaskStore(store['runtime'], `${dir}/tasks`);
  await s2.load();
  const rebuilt = s2.get(run.id)!;
  assert.equal(rebuilt.steps[0]!.state, 'completed');
  assert.deepEqual(rebuilt.steps[0]!.artifacts, ['/a/月报.xlsx', '/a/图表.png'], '产物必须能从事件流装回来');
});

test('条 15：催办退避曲线 30 分 → 1 小时 → 2 小时；每周期最多 3 次；用户回话重置', async () => {
  const { store, now, advance } = setup();
  await store.load();
  const run = await store.create({ title: 'G' });
  await store.askUser(run.id, '用哪个口径？');
  // 不到 30 分钟：不催
  assert.equal((await store.takeNudgeDue(now() + 10 * 60 * 1000, 0)).length, 0);
  // 第 1 次（30 分档）
  const n1 = await store.takeNudgeDue(now() + 31 * 60 * 1000, 0);
  assert.equal(n1.length, 1);
  assert.match(n1[0]!.message, /第 1 次问/);
  advance(31 * 60 * 1000);
  // 第 2 次要再等 1 小时
  assert.equal((await store.takeNudgeDue(now() + 30 * 60 * 1000, 0)).length, 0);
  assert.equal((await store.takeNudgeDue(now() + 61 * 60 * 1000, 0)).length, 1);
  advance(61 * 60 * 1000);
  assert.equal((await store.takeNudgeDue(now() + 121 * 60 * 1000, 0)).length, 1);
  advance(121 * 60 * 1000);
  // 第 4 次：本周期额度用尽
  assert.equal((await store.takeNudgeDue(now() + 5 * 60 * 60 * 1000, 0)).length, 0);
  // 用户说话了 → 再给 3 次
  const later = now() + 6 * 60 * 60 * 1000;
  const n2 = await store.takeNudgeDue(later, later - 1000);
  assert.equal(n2.length, 1);
  assert.match(n2[0]!.message, /第 1 次问/);
});

test('条 15③：不可恢复错误自动解除（凭证吊销/上下文爆掉），可自愈的不叫人', () => {
  assert.equal(classifyFailure('HTTP 401 invalid api key'), 'auth');
  assert.equal(isUnrecoverable('auth'), true);
  assert.equal(classifyFailure('余额不足，请充值'), 'budget_limited');
  // 余额耗尽**算不可恢复**（与吊销/上下文爆掉同类：用户不动作就好不了）
  assert.equal(isUnrecoverable('budget_limited'), true);
  assert.equal(classifyFailure('429 Too Many Requests'), 'usage_limited');
  assert.equal(classifyFailure('ECONNRESET socket hang up'), 'transient');
  assert.equal(classifyFailure('上下文超出上限'), 'context');
  assert.equal(isUnrecoverable('context'), true);
});

test('条 14：完成信号字面比较——没出现就续跑，出现才放行；交付文本剥掉机关', () => {
  const run = { title: '整理报表', completionPromise: 'DONE-ALL', maxIterations: 3, iterations: 0 };
  assert.equal(stopVerdict(run, '我做完了').action, 'continue');
  assert.equal(stopVerdict(run, '基本完成了，主要部分都做完').action, 'continue'); // "基本完成"不算
  assert.equal(stopVerdict(run, '全做完了\nDONE-ALL').action, 'allow');
  // **最后一行**原样等于信号才算，不是"正文里提到就算"
  assert.equal(promiseSeen('全做完了\nDONE-ALL', 'DONE-ALL'), true);
  assert.equal(promiseSeen('我还没做完，所以现在不能输出 DONE-ALL', 'DONE-ALL'), false); // ← 修的那个洞
  assert.equal(promiseSeen('DONE-ALLX', 'DONE'), false);   // 不是整行相等
  assert.equal(promiseSeen('done-all', 'DONE-ALL'), false); // 大小写敏感
  assert.equal(stripPromise('全做完了\nDONE-ALL', 'DONE-ALL').trim(), '全做完了');
  const nudge = continuationNudge('整理报表', 'DONE-ALL', 1, 3);
  assert.match(nudge, /没做到就别说完事了/);
  assert.match(nudge, /谎报/);
});

test('条 14：到硬上限 → 停下并诚实说明（不假装做完，也不无声耗一夜）', () => {
  const run = { title: '整理报表', completionPromise: 'DONE-ALL', maxIterations: 2, iterations: 1 };
  const v = stopVerdict(run, '还没好');
  assert.equal(v.action, 'continue');
  const cap = stopVerdict({ ...run, iterations: 2 }, '还没好');
  assert.equal(cap.action, 'cap');
  assert.match((cap as { text: string }).text, /还没做完/);
});

test('条 50：墓碑——新鲜的才续、超次数不续、提示词明写"先看现状再动手"', () => {
  const t: Tombstone = { sessionId: 'main', text: '帮我把项目整理完', startedAt: 1000, attempts: 0 };
  assert.equal(decideResume(t, 1000 + 60 * 1000).resume, true);
  assert.equal(decideResume(t, 1000 + TOMBSTONE_FRESH_MS + 1).resume, false); // 太旧
  assert.equal(decideResume(t, 1000 + TOMBSTONE_FRESH_MS + 1).reason, 'stale');
  assert.equal(decideResume({ ...t, attempts: TOMBSTONE_MAX_ATTEMPTS }, 2000).resume, false); // 崩循环
  assert.equal(decideResume(null, 2000).resume, false);
  assert.equal(decideResume({ ...t, text: '  ' }, 2000).reason, 'empty');
  assert.match(resumePrompt(t), /先看现状再动手/);
  assert.match(resumePrompt(t), /别把做过的重做一遍/);
});

test('条 60：状态词分开说——限流 / 额度 / 卡住 / 暂停 各有各的话', () => {
  assert.equal(statusWord({ state: 'usage_limited' }).key, 'usage_limited');
  assert.match(statusWord({ state: 'usage_limited' }).label, /限流/);
  assert.equal(statusWord({ state: 'budget_limited' }).key, 'budget_limited');
  assert.match(statusWord({ state: 'budget_limited' }).label, /额度用完/);
  assert.equal(statusWord({ state: 'blocked', blockReason: 'dependency' }).key, 'blocked');
  assert.equal(statusWord({ state: 'paused' }).key, 'paused');
  assert.equal(statusWord({ state: 'running' }).stopped, false);
});

test('条 60：markLimited 区分三态；终结的 run 不再被改', async () => {
  const { store } = setup();
  await store.load();
  const run = await store.create({ title: 'H' });
  await store.markLimited(run.id, 'usage_limited', '服务商 429');
  assert.equal(store.get(run.id)!.state, 'usage_limited');
  await store.markLimited(run.id, 'budget_limited', '余额不足');
  assert.equal(store.get(run.id)!.state, 'budget_limited');
  await store.complete(run.id, '你手动收尾');
  await store.markLimited(run.id, 'usage_limited', '再来一次');
  assert.equal(store.get(run.id)!.state, 'completed'); // 终态不被覆盖
});

test('nextNudgeAt：管理界面能显示"下次大概什么时候问你"', () => {
  const base = { state: 'blocked' as const, blockReason: 'needs_input' as const, nudgeCount: 0, blockedAt: 10_000, lastNudgeAt: 0 };
  assert.equal(nextNudgeAt(base), 10_000 + 30 * 60 * 1000);
  assert.equal(nextNudgeAt({ ...base, nudgeCount: 3 }), null);
  assert.equal(nextNudgeAt({ ...base, state: 'running', blockReason: undefined }), null);
});

test('nudgeDecision 的理由可解释（为什么不催）', () => {
  const run = { state: 'running' as const, blockReason: undefined, question: undefined, nudgeCount: 0, lastNudgeAt: 0, blockedAt: 0, lastUserAt: 0, title: 'X' };
  assert.match(nudgeDecision(run, 999_999_999, 0).reason, /不是在等你拍板/);
});
