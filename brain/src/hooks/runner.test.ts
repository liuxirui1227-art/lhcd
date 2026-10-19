// hooks——matcher 规则 / 事件 stdin 透传 / exit 2 阻断（PreToolUse）/ 后置触发。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createNodeRuntime } from '../runtime/node.js';
import { loadConfig } from '../config/load.js';
import type { Config } from '../config/schema.js';
import { matchesHook, runHooks } from './runner.js';
import type { Runtime } from '../runtime/types.js';
import type { AgentEvent } from '../session/events.js';

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'brain-hooks-'));
}

test('matchesHook：* / tool:<name>:<class> / 不命中', () => {
  const call: AgentEvent = { type: 'tool.call', seq: 1, id: 'c1', name: 'bash', args: {} };
  assert.equal(matchesHook('*', call), true);
  assert.equal(matchesHook('tool:*:*', call), true);
  assert.equal(matchesHook('tool:bash:bash', call, { tool: 'bash', permissionClass: 'bash' }), true);
  assert.equal(matchesHook('tool:read:*', call, { tool: 'bash' }), false);
  assert.equal(matchesHook('tool:bash:app', call, { tool: 'bash', permissionClass: 'bash' }), false);
  assert.equal(matchesHook('*', { type: 'turn.start', seq: 1 }), true);
});

function setupWith(exitCodes: number[]) {
  const dir = tmpdir();
  const rt = createNodeRuntime({
    cwd: dir,
    storage: { sessionsDir: `${dir}/s`, logsDir: `${dir}/l`, memoryDir: `${dir}/m`, configDir: dir },
  });
  const executions: Array<{ cmd: string; stdin?: string }> = [];
  let i = 0;
  const spy: Runtime = {
    ...rt,
    exec: async (cmd, opts) => {
      executions.push({ cmd, stdin: opts.stdin });
      return { ok: true, code: exitCodes[i++] ?? 0, output: 'hook-out' };
    },
  };
  return { dir, spy, executions };
}

test('runHooks：匹配执行 + 事件 JSON 走 stdin', async () => {
  const { dir, spy, executions } = setupWith([0]);
  const config = loadConfig({
    cwd: dir,
    home: dir,
    cli: { hooks: { PreToolUse: [{ matcher: 'tool:bash:*', command: 'node guard.mjs' }] } },
  }) as Config;
  const event: AgentEvent = { type: 'tool.call', seq: 1, id: 'c1', name: 'bash', args: { command: 'ls' } };
  const results = await runHooks(config, 'PreToolUse', {
    runtime: spy,
    sessionId: 's1',
    event,
    tool: 'bash',
    permissionClass: 'bash',
  });
  assert.equal(results.length, 1);
  assert.equal(results[0]!.exit, 0);
  assert.equal(executions[0]!.cmd, 'node guard.mjs');
  assert.deepEqual(JSON.parse(executions[0]!.stdin ?? '{}'), event);
});

test('PreToolUse exit 2 → blocked', async () => {
  const { dir, spy } = setupWith([2]);
  const config = loadConfig({
    cwd: dir,
    home: dir,
    cli: { hooks: { PreToolUse: [{ matcher: '*', command: 'node block.mjs' }] } },
  }) as Config;
  const results = await runHooks(config, 'PreToolUse', {
    runtime: spy,
    sessionId: 's1',
    event: { type: 'tool.call', seq: 1, id: 'c1', name: 'read', args: {} },
  });
  assert.equal(results[0]!.blocked, true);
});

test('PostToolUse exit 2 不阻断（仅 PreToolUse 可阻断）', async () => {
  const { dir, spy } = setupWith([2]);
  const config = loadConfig({
    cwd: dir,
    home: dir,
    cli: { hooks: { PostToolUse: [{ matcher: '*', command: 'node lint.mjs' }] } },
  }) as Config;
  const results = await runHooks(config, 'PostToolUse', {
    runtime: spy,
    sessionId: 's1',
    event: { type: 'tool.result', seq: 1, id: 'c1', ok: true, output: 'x', truncated: false },
  });
  assert.equal(results[0]!.blocked, false);
});
