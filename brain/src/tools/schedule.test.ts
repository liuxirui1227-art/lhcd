// schedule 工具 ↔ 任务表接线单测（建/查/取消/记事本 + 未挂载时拒绝）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createNodeRuntime } from '../runtime/node.js';
import { CronJobs } from '../orchestrate/jobs.js';
import { scheduleTool } from './schedule.js';
import type { ExecCtx } from './registry.js';

async function makeCtx(withJobs = true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-sched-'));
  const rt = createNodeRuntime({
    cwd: dir,
    storage: { sessionsDir: `${dir}/s`, logsDir: `${dir}/l`, memoryDir: `${dir}/m`, configDir: `${dir}/c` },
  });
  const cronJobs = new CronJobs(rt, `${dir}/cron/jobs.json`);
  await cronJobs.load();
  const ctx = { sessionId: 's', cwd: dir, runtime: rt, emit: () => undefined, ...(withJobs ? { cronJobs } : {}) } as unknown as ExecCtx;
  return { ctx, cronJobs };
}

test('schedule：create → list → cancel 全链路（人话回执）', async () => {
  const { ctx } = await makeCtx();
  const tool = scheduleTool((ctx as unknown as { cronJobs: CronJobs }).cronJobs);
  const c = await tool.executor({ action: 'create', spec: '0 8 * * *', task: '跟我说早' }, ctx);
  assert.equal(c.ok, true);
  assert.match(c.output, /已记下：跟我说早/);
  assert.match(c.output, /下次 \d{4}-\d{2}-\d{2} 08:00/);

  const l = await tool.executor({ action: 'list' }, ctx);
  assert.equal(l.ok, true);
  assert.match(l.output, /跟我说早/);

  const id = /id=([^\s）)]+)/.exec(c.output)![1]!;
  const x = await tool.executor({ action: 'cancel', id }, ctx);
  assert.equal(x.ok, true);
  assert.match((await tool.executor({ action: 'list' }, ctx)).output, /没有定时任务/);
});

test('schedule：坏 cron / 过去时间给人话错误；once 走 ISO 时间', async () => {
  const { ctx } = await makeCtx();
  const tool = scheduleTool((ctx as unknown as { cronJobs: CronJobs }).cronJobs);
  const bad = await tool.executor({ action: 'create', spec: '99 99 * *', task: 'x' }, ctx);
  assert.equal(bad.ok, false);
  assert.match(bad.error!.message, /cron 表达式无效/);

  const once = await tool.executor({ action: 'create', spec: '2030-01-01T08:00:00', task: '元旦说早', kind: 'once' }, ctx);
  assert.equal(once.ok, true);
  assert.match(once.output, /2030-01-01 08:00/);
});

test('schedule：task 记事本（note）——超限被拒；未挂载任务表时明确拒绝', async () => {
  const { ctx, cronJobs } = await makeCtx();
  const tool = scheduleTool(cronJobs);
  const c = await tool.executor({ action: 'create', spec: '0 8 * * *', task: '盯着某件事' }, ctx);
  const id = /id=([^\s）)]+)/.exec(c.output)![1]!;
  assert.equal((await tool.executor({ action: 'note', id, key: 'cursor', value: '第 3 页' }, ctx)).ok, true);
  assert.equal((await tool.executor({ action: 'note', id, value: '没有 key' }, ctx)).ok, false); // 缺 key
  assert.equal((await tool.executor({ action: 'note', id, key: 'big', value: 'x'.repeat(20000) }, ctx)).ok, false); // 超 16KB

  const { ctx: bare } = await makeCtx(false);
  const bareTool = scheduleTool(cronJobs);
  const r = await bareTool.executor({ action: 'list' }, bare);
  assert.equal(r.ok, false);
  assert.equal(r.error!.code, 'NO_CRON');
});
