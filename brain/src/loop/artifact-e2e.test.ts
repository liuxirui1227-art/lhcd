// 端到端——她真的做出一个文件之后，产物台账里要有、事件里也要有。
// 这条测的是"接线"，不是 `artifacts.ts` 的函数（那些在 session/artifacts.test.ts 里）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAgent } from '../factory.js';
import { MockProvider, mockText, mockToolCalls } from '../llm/adapters/mock.js';
import { runTurn } from './turn.js';
import { ArtifactLog } from '../session/artifacts.js';
import type { AgentEvent } from '../session/events.js';

test('她写了一个文件 → 台账里有一条 + 发出 artifact.created；只读不算产物', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-artifact-e2e-'));
  const provider = new MockProvider({
    script: [
      mockToolCalls([{ id: 'c1', name: 'write', args: { path: `${dir}/月报.md`, content: '# 月报' } }]),
      mockText('写好了'),
      mockToolCalls([{ id: 'c2', name: 'read', args: { path: `${dir}/月报.md` } }]),
      mockText('读了一下'),
    ],
  });
  const agent = await createAgent({ cwd: dir, home: dir, provider });
  const session = agent.createSession();
  const seen: AgentEvent[] = [];
  session.emit = (ev) => seen.push(ev);

  await runTurn(session, '写个月报');
  const created = seen.filter((e) => e.type === 'artifact.created') as Array<{ id: string; path?: string; createdBy: string }>;
  assert.equal(created.length, 1, '写文件要发一条 artifact.created');
  assert.equal(created[0]!.path, `${dir}/月报.md`);
  assert.equal(created[0]!.createdBy, 'write');

  const list = await new ArtifactLog(session.runtime, session.id).list();
  assert.equal(list.length, 1, '台账里要有一条');
  assert.equal(list[0]!.type, 'text');
  assert.equal(list[0]!.path, `${dir}/月报.md`);

  // 第二轮只读 → 不该再增产
  await runTurn(session, '念一遍');
  const list2 = await new ArtifactLog(session.runtime, session.id).list();
  assert.equal(list2.length, 1, '读文件不算产物（那是文件页的活）');
});
