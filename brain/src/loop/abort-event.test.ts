// `user.prompt.abort` 这个事件类型曾经"有定义、零发射"——
// 于是日志里"她没做完"和"人叫停了"长得一模一样。这里锁住两条中止路径都要留痕。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAgent } from '../factory.js';
import { MockProvider, mockText } from '../llm/adapters/mock.js';
import { runTurn } from './turn.js';
import type { AgentEvent } from '../session/events.js';

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'brain-abort-'));
}

test('中止留痕：还没开口就被叫停 → 发 user.prompt.abort', async () => {
  const dir = tmpdir();
  const provider = new MockProvider({ script: [mockText('不该被用到')] });
  const agent = await createAgent({ cwd: dir, home: dir, provider });
  const session = agent.createSession();
  const seen: AgentEvent[] = [];
  session.emit = (ev) => seen.push(ev);

  const ctrl = new AbortController();
  ctrl.abort();
  const r = await runTurn(session, '你好', ctrl.signal);
  assert.equal(r.kind, 'error');
  const types = seen.map((e) => e.type);
  assert.ok(types.includes('user.prompt.abort'), `要有中止事件：${types.join(',')}`);
  assert.ok(types.indexOf('user.prompt.abort') > types.indexOf('turn.start'), '顺序：先开回合、再中止');
});
