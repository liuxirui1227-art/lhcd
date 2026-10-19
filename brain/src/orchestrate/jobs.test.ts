// 任务表（触发前推进 / 分档错过 / 一次性作废 / 零花费重试 / 记事本）单测。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createNodeRuntime } from '../runtime/node.js';
import { CronJobs, graceMs, NOTE_VALUE_MAX } from './jobs.js';

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-jobs-'));
  const rt = createNodeRuntime({
    cwd: dir,
    storage: { sessionsDir: `${dir}/s`, logsDir: `${dir}/l`, memoryDir: `${dir}/m`, configDir: `${dir}/c` },
  });
  let NOW = new Date(2026, 8, 18, 10, 0, 0); // 2026-09-18 10:00 本地
  const clock = () => NOW;
  const file = path.join(dir, 'cron', 'jobs.json');
  const jobs = new CronJobs(rt, file, clock);
  return {
    jobs, file, rt,
    now: () => NOW,
    setNow: (d: Date) => { NOW = d; },
    advance: (ms: number) => { NOW = new Date(NOW.getTime() + ms); },
  };
}

test('建任务：cron 推到下一个未来时刻；非法表达式/过去时间给人话错误', async () => {
  const { jobs } = setup();
  await jobs.load();
  const r = await jobs.create({ spec: '0 8 * * *', task: '跟我说早' }); // 每天 08:00
  assert.equal(r.ok, true);
  assert.equal(new Date(r.job!.nextRunAt!).getHours(), 8);

  const bad = await jobs.create({ spec: '99 99 * *', task: 'x' });
  assert.equal(bad.ok, false);
  const past = await jobs.create({ spec: '2026-09-18T09:00:00', task: 'x', kind: 'once' });
  assert.equal(past.ok, false);
  assert.match(past.error!, /已经过去/);
});

test('不变量①：触发前推进——claim 之后同一格不会再触发（不补课 N 次）', async () => {
  const { jobs, now, setNow, advance } = setup();
  await jobs.load();
  const { job } = await jobs.create({ spec: '0 8 * * *', task: '跟我说早' });
  setNow(new Date(job!.nextRunAt!)); // 到点
  let due = await jobs.due(now());
  assert.equal(due.length, 1);
  assert.equal(due[0]!.disposition, 'due');
  const c = await jobs.claim(job!.id);
  assert.equal(c.ok, true);
  // 仍在同一分钟内 → 不再 due（nextRunAt 已推到明天 08:00，且 firingAt 在跑）
  due = await jobs.due(now());
  assert.equal(due.length, 0);
  await jobs.complete(job!.id, 'ok', '说了早', 0.001, '早上好呀');
  advance(60 * 1000);
  due = await jobs.due(now());
  assert.equal(due.length, 0); // 明天 08:00 前一直安静
});

test('条 47③：错过分档——≤5 分钟准时；≤宽限补跑一次；超宽限跳过累积只在现在跑一次', async () => {
  const { jobs, now, advance } = setup();
  await jobs.load();
  const { job } = await jobs.create({ spec: '*/5 * * * *', task: '每五分钟的活' }); // 周期 5 分钟 → 宽限 max(120s, 150s)=150s
  assert.equal(graceMs(5 * 60 * 1000), 150 * 1000);

  // 准时（10:05 到点即跑）
  advance(5 * 60 * 1000);
  let due = await jobs.due(now());
  assert.equal(due[0]!.disposition, 'due');
  await jobs.claim(job!.id);
  await jobs.complete(job!.id, 'ok');

  // 宽限内（10:12，比 10:10 的格晚了 120s ≤ 150s）→ 照跑一次
  advance(7 * 60 * 1000);
  due = await jobs.due(now());
  assert.equal(due[0]!.disposition, 'due');
  await jobs.claim(job!.id);
  await jobs.complete(job!.id, 'ok');

  // 超宽限（10:40，比 10:35 的格晚 5 分钟 > 150s）→ 跳过累积，只在现在跑一次
  advance(28 * 60 * 1000);
  due = await jobs.due(now());
  assert.equal(due[0]!.disposition, 'missed');
  const nextRun = due[0]!.job.nextRunAt!;
  assert.ok(nextRun > now().getTime(), '错过之后 nextRunAt 应指回未来（不补课）');
  const ledger = jobs.ledger();
  assert.ok(ledger.some((e) => e.status === 'missed'));
});

test('条 47④：一次性提醒过期直接作废（不会半夜弹出三周前的会）', async () => {
  const { jobs, now, advance } = setup();
  await jobs.load();
  const t = new Date(2026, 8, 18, 14, 0, 0);
  const { job } = await jobs.create({ spec: t.toISOString(), task: '三点开会', kind: 'once' });
  advance(4 * 60 * 60 * 1000 + 5 * 60 * 1000); // 14:05 才开机（错过 5 分钟 > 宽限 120s）
  const due = await jobs.due(now());
  assert.equal(due.length, 0);
  const after = jobs.list().find((j) => j.id === job!.id)!;
  assert.equal(after.enabled, false);
  assert.equal(after.lastStatus, 'expired');
  assert.ok(jobs.ledger().some((e) => e.status === 'expired'));
});

test('条 47②：崩溃恢复——被取走但没跑完 → 只补跑一次（firingAt 戳）', async () => {
  const { jobs, file, rt, now, setNow, advance } = setup();
  await jobs.load();
  const { job } = await jobs.create({ spec: '0 8 * * *', task: '跟我说早' });
  setNow(new Date(job!.nextRunAt!));
  await jobs.claim(job!.id); // 取走 → 进程"崩了"（没有 complete）
  advance(30 * 1000);        // 停机 30 秒后重启
  const revived = new CronJobs(rt, file, () => now());
  await revived.load();
  const due = await revived.due(now());
  assert.equal(due.length, 1);
  assert.equal(due[0]!.disposition, 'recover');
  await revived.claim(job!.id);
  const due2 = await revived.due(now());
  assert.equal(due2.filter((d) => d.disposition === 'recover').length, 0); // 只补一次
});

test('条 47⑤：零花费才重试——5/15/30 阶梯；花了钱就不重试', async () => {
  const { jobs, now, advance } = setup();
  await jobs.load();
  const a = await jobs.create({ spec: '0 8 * * *', task: 'A' });
  await jobs.claim(a.job!.id);
  const r1 = await jobs.fail(a.job!.id, { zeroCost: true, transient: true, detail: 'ENOTFOUND' });
  assert.equal(r1.retryInMs, 5 * 60 * 1000);

  advance(5 * 60 * 1000);
  let due = await jobs.due(now());
  assert.equal(due.find((d) => d.job.id === a.job!.id)!.disposition, 'retry');
  await jobs.claim(a.job!.id);
  const r2 = await jobs.fail(a.job!.id, { zeroCost: true, transient: true });
  assert.equal(r2.retryInMs, 15 * 60 * 1000);
  advance(15 * 60 * 1000);
  await jobs.claim(a.job!.id);
  const r3 = await jobs.fail(a.job!.id, { zeroCost: true, transient: true });
  assert.equal(r3.retryInMs, 30 * 60 * 1000);
  advance(30 * 60 * 1000);
  await jobs.claim(a.job!.id);
  const r4 = await jobs.fail(a.job!.id, { zeroCost: true, transient: true });
  assert.equal(r4.retryInMs, undefined); // 三梯用尽

  const b = await jobs.create({ spec: '0 8 * * *', task: 'B' });
  await jobs.claim(b.job!.id);
  const rb = await jobs.fail(b.job!.id, { zeroCost: false, transient: true }); // 花过钱
  assert.equal(rb.retryInMs, undefined);
  assert.equal(jobs.list().find((j) => j.id === b.job!.id)!.retryAt ?? null, null);
});

test('条 68：记事本——超限报错不静默截断；空的时候渲染空字符串（缓存友好）', async () => {
  const { jobs } = setup();
  await jobs.load();
  const { job } = await jobs.create({ spec: '0 8 * * *', task: '盯着某件事' });
  assert.equal(jobs.renderSection(jobs.list()[0]!), ''); // 没用记事本 → 逐字节不变

  assert.equal((await jobs.setNote(job!.id, 'cursor', '上次看到第 3 页')).ok, true);
  assert.equal((await jobs.setNote(job!.id, 'big', 'x'.repeat(NOTE_VALUE_MAX + 1))).ok, false); // 单值超 16KB
  assert.equal((await jobs.setNote(job!.id, 'n1', 'y'.repeat(NOTE_VALUE_MAX))).ok, true);   // 单值刚好 16KB
  assert.equal((await jobs.setNote(job!.id, 'n2', 'y'.repeat(NOTE_VALUE_MAX))).ok, true);
  assert.equal((await jobs.setNote(job!.id, 'n3', 'y'.repeat(NOTE_VALUE_MAX))).ok, true);
  assert.equal((await jobs.setNote(job!.id, 'n4', 'y'.repeat(NOTE_VALUE_MAX))).ok, false); // 总超 64KB（4×16KB）

  await jobs.complete(job!.id, 'ok', '一趟', 0.01, '看到第 5 页了');
  const section = jobs.renderSection(jobs.list()[0]!);
  assert.match(section, /任务记事本/);
  assert.match(section, /cursor: 上次看到第 3 页/);
  assert.match(section, /上次的输出[\s\S]*看到第 5 页了/);

  // 静默/空输出不覆盖 continuity
  await jobs.complete(job!.id, 'ok', '空跑', 0.01, '   ');
  assert.match(jobs.renderSection(jobs.list()[0]!), /看到第 5 页了/);
});

test('原子写：落盘后无 .tmp 残留；文件是完整 JSON', async () => {
  const { jobs, file } = setup();
  await jobs.load();
  await jobs.create({ spec: '0 8 * * *', task: 'x' });
  const dir = path.dirname(file);
  assert.equal(fs.readdirSync(dir).some((f) => f.includes('.tmp-')), false);
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(parsed.version, 1);
  assert.equal(parsed.jobs.length, 1);
});
