// session_search 工具单测——参数校验 / 命中渲染 / 空档得体话术。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createNodeRuntime } from '../runtime/node.js';
import { SessionArchive } from '../session/archive.js';
import { sessionSearchTool } from './session-search.js';
import type { ExecCtx } from './registry.js';

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-ssearch-'));
  const rt = createNodeRuntime({
    cwd: dir,
    storage: { sessionsDir: `${dir}/s`, logsDir: `${dir}/l`, memoryDir: `${dir}/m`, configDir: dir },
  });
  const ctx: ExecCtx = {
    sessionId: 'sess-A',
    cwd: dir,
    runtime: rt,
    config: undefined as never,
    emit: () => {},
  };
  return { rt, ctx };
}

test('会话还没压缩过 → 得体地说明"没有档"，不装作查过', async () => {
  const { ctx } = setup();
  const r = await sessionSearchTool().executor({ query: '任何事' }, ctx);
  assert.equal(r.ok, true);
  assert.ok(r.output.includes('没有找到'));
});

test('压缩后：能搜回被压掉的原文（中文长句也行）', async () => {
  const { rt, ctx } = setup();
  await new SessionArchive(rt, 'sess-A').append(
    [
      { role: 'user', content: '我们约定验收包在下周三给，文件名 lh.dmg' },
      { role: 'tool', content: '命令输出：全部测试通过（1234 个用例）', toolCallId: 't9' },
    ],
    '2026-09-17T10:00:00.000Z',
  );
  const r = await sessionSearchTool().executor({ query: '上次说的那个验收包什么时候给' }, ctx);
  assert.equal(r.ok, true);
  assert.ok(r.output.includes('lh.dmg'));
  assert.ok(r.output.includes('2026-09-17')); // 带时间戳，便于判断新旧
  // 工具结果也能搜到
  const r2 = await sessionSearchTool().executor({ query: '1234 个用例' }, ctx);
  assert.ok(r2.output.includes('t9'));
});

test('参数校验：空 query 报 BAD_ARGS；max 封顶 20', async () => {
  const { rt, ctx } = setup();
  const bad = await sessionSearchTool().executor({ query: '   ' }, ctx);
  assert.equal(bad.ok, false);
  assert.equal(bad.error?.code, 'BAD_ARGS');
  await new SessionArchive(rt, 'sess-A').append(
    Array.from({ length: 30 }, (_, i) => ({ role: 'user' as const, content: `第 ${i} 条关于预算的记录` })),
    '2026-09-17T10:00:00.000Z',
  );
  const capped = await sessionSearchTool().executor({ query: '预算', max: 999 }, ctx);
  assert.equal(capped.ok, true);
  assert.equal(capped.output.split('\n').length, 20);
});
