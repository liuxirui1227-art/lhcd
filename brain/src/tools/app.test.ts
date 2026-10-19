// app 工具——动作映射 / 参数校验 / 日历提醒扩展 / 错误回传；osascript 转义单测（hermetic，不真调 osascript）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createNodeRuntime, shq, osa, dq } from '../runtime/node.js';
import { loadConfig } from '../config/load.js';
import { appTool } from './app.js';
import type { ExecCtx } from './registry.js';
import type { Runtime } from '../runtime/types.js';

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'brain-app-'));
}

function setup() {
  const dir = tmpdir();
  const rt = createNodeRuntime({
    cwd: dir,
    storage: { sessionsDir: `${dir}/s`, logsDir: `${dir}/l`, memoryDir: `${dir}/m`, configDir: dir },
  });
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const spy: Runtime = {
    ...rt,
    app: {
      open: async (t) => { calls.push({ method: 'open', args: [t] }); return { ok: true, output: '' }; },
      activate: async (t) => { calls.push({ method: 'activate', args: [t] }); return { ok: true, output: '' }; },
      clipboard: async () => { calls.push({ method: 'clipboard', args: [] }); return { ok: true, content: '剪贴板内容' }; },
      notify: async (t, b) => { calls.push({ method: 'notify', args: [t, b] }); return { ok: true, output: '' }; },
      run: async (s) => { calls.push({ method: 'run', args: [s] }); return { ok: true, output: '' }; },
    },
  };
  const ctx: ExecCtx = {
    sessionId: 's1',
    cwd: dir,
    runtime: spy,
    config: loadConfig({ cwd: dir, home: dir }),
    emit: () => undefined,
  };
  return { ctx, calls };
}

test('open/activate/clipboard/notify 动作映射', async () => {
  const { ctx, calls } = setup();
  const tool = appTool();
  await tool.executor({ action: 'open', target: 'Calendar' }, ctx);
  await tool.executor({ action: 'activate', target: 'Safari' }, ctx);
  const clip = await tool.executor({ action: 'clipboard' }, ctx);
  assert.equal(clip.output, '剪贴板内容');
  await tool.executor({ action: 'notify', text: '标题|正文内容' }, ctx);

  assert.deepEqual(calls.map((c) => c.method), ['open', 'activate', 'clipboard', 'notify']);
  assert.deepEqual(calls[3]!.args, ['标题', '正文内容']);
});

test('run 动作：osascript 脚本透传', async () => {
  const { ctx, calls } = setup();
  const r = await appTool().executor({ action: 'run', script: 'beep 2' }, ctx);
  assert.equal(r.ok, true);
  assert.deepEqual(calls[0]!.args, ['beep 2']);
});

test('calendar/reminder：经 run 生成 osascript（标题转义）', async () => {
  const { ctx, calls } = setup();
  const tool = appTool();
  const r1 = await tool.executor({ action: 'calendar', title: '生日"派对"', date: '2026-08-22 14:00' }, ctx);
  assert.equal(r1.ok, true);
  assert.match(String(calls[0]!.args[0]), /Calendar/);
  assert.match(String(calls[0]!.args[0]), /生日\\"派对\\"/);
  assert.match(String(calls[0]!.args[0]), /2026-08-22 14:00/);

  const r2 = await tool.executor({ action: 'reminder', title: '买牛奶', date: '2026-08-22 09:00' }, ctx);
  assert.equal(r2.ok, true);
  assert.match(String(calls[1]!.args[0]), /Reminders/);
});

test('参数校验与未知动作', async () => {
  const { ctx } = setup();
  const tool = appTool();
  assert.equal((await tool.executor({ action: 'open' }, ctx)).error?.code, 'BAD_ARGS');
  assert.equal((await tool.executor({ action: 'notify' }, ctx)).error?.code, 'BAD_ARGS');
  assert.equal((await tool.executor({ action: 'calendar', title: 'x' }, ctx)).error?.code, 'BAD_ARGS');
  assert.equal((await tool.executor({ action: 'fly' }, ctx)).error?.code, 'BAD_ACTION');
});

test('app 方法失败 → APP_ERROR 回传', async () => {
  const dir = tmpdir();
  const rt = createNodeRuntime({
    cwd: dir,
    storage: { sessionsDir: `${dir}/s`, logsDir: `${dir}/l`, memoryDir: `${dir}/m`, configDir: dir },
  });
  const spy: Runtime = {
    ...rt,
    app: {
      ...rt.app,
      open: async () => ({ ok: false, output: '无权限' }),
    },
  };
  const ctx: ExecCtx = { sessionId: 's', cwd: dir, runtime: spy, config: loadConfig({ cwd: dir, home: dir }), emit: () => undefined };
  const r = await appTool().executor({ action: 'open', target: 'X' }, ctx);
  assert.equal(r.ok, false);
  assert.equal(r.error?.code, 'APP_ERROR');
});

test('shell/osascript 转义：shq/osa/dq', () => {
  assert.equal(shq("a'b"), `'a'\\''b'`);
  assert.equal(osa('beep 1'), `osascript -e 'beep 1'`);
  assert.equal(dq('a"b'), '"a\\"b"');
});
