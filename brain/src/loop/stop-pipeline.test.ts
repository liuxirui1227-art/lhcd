// 完成判据（回合级集成）：真的能把回合拦住（不是只测纯函数）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAgent } from '../factory.js';
import { MockProvider, mockText } from '../llm/adapters/mock.js';
import { runTurn } from './turn.js';

function setup(script: string[]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-stop-'));
  const provider = new MockProvider({ script: script.map((t) => mockText(t)), loop: true });
  return createAgent({ cwd: dir, home: dir, provider, cli: { sessions: { dir: `${dir}/sessions` } } });
}

test('条 14：模型想收尾但没输出完成信号 → 被拦回来继续；信号到了才放行（并从交付文本剥掉）', async () => {
  const agent = await setup(['我做完了', '这回真做完了\nDONE-ALL']);
  const session = agent.createSession();
  const run = await agent.taskStore.create({ title: '整理报表', sessionId: session.id, completionPromise: 'DONE-ALL', maxIterations: 3 });

  const r = await runTurn(session, '把报表整理完，没弄完别停');
  assert.equal(r.kind, 'final');
  assert.equal((r as { text: string }).text, '这回真做完了'); // 信号被剥掉，用户看不到机关
  assert.equal(agent.taskStore.get(run.id)!.state, 'completed'); // 信号到了 = 这件事真结束
  assert.equal(agent.taskStore.get(run.id)!.iterations, 1); // 被拦过 1 次
});

test('条 14：到硬上限 → 停下并如实说"还没做完"（不假装、不无声耗）', async () => {
  // 剧本永远说"还没好"：模型一直不输出信号
  const agent = await setup(['还没好']);
  const session = agent.createSession();
  const run = await agent.taskStore.create({ title: '整理报表', sessionId: session.id, completionPromise: 'DONE-ALL', maxIterations: 2 });

  const r = await runTurn(session, '做到底');
  assert.equal(r.kind, 'limit');
  assert.match((r as { text: string }).text, /还没做完/);
  const after = agent.taskStore.get(run.id)!;
  assert.equal(after.state, 'paused');           // 停下但可继续（不是"完成"）
  assert.match(after.stateDetail!, /上限/);
  assert.equal(after.iterations, 2);
});

test('条 14：没有完成信号的任务不受影响（普通聊天照旧）', async () => {
  const agent = await setup(['好呀']);
  const session = agent.createSession();
  await agent.taskStore.create({ title: '随口聊的事', sessionId: session.id }); // 无 promise
  const r = await runTurn(session, '在吗');
  assert.equal(r.kind, 'final');
  assert.equal((r as { text: string }).text, '好呀');
});

test('条 20：改过的文件对不上 → 回插一条补充意见；**一轮只回插一次**（护栏①：不会自触发到收不了尾）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-workcheck-turn-'));
  let session: ReturnType<Awaited<ReturnType<typeof createAgent>>['createSession']> | undefined;
  let calls = 0;
  // 自定义 provider：第 1 次回答前偷偷塞一条"对不上"的改动记录（模拟文件被别的东西改掉）
  const provider = {
    name: 'probe', caps: { cache: { kind: 'none' as const }, reasoning: 'none' as const, parallelToolCalls: true, compaction: 'client' as const, maxContextTokens: 128000 },
    async *chat() {
      calls++;
      yield { type: 'text.delta' as const, text: calls === 1 ? '都改好了' : '刚才那句不算——有个文件其实没改成，我重说' };
      yield { type: 'done' as const, usage: { inTokens: 0, hitTokens: 0, missTokens: 0, outTokens: 0, reasoningTokens: 0, costUsd: 0 } };
    },
    sanitizeForRequest: (m: unknown[]) => m,
    injectCacheMarkers: () => undefined,
  };
  const agent = await createAgent({ cwd: dir, home: dir, provider: provider as never, cli: { sessions: { dir: `${dir}/sessions` } } });
  session = agent.createSession();
  const bogus = { tool: 'write', path: path.join(dir, '不存在.txt'), at: Date.now(), expect: { content: 'x' } };
  const origEmit = session.emit;
  session.emit = (ev) => {
    if (ev.type === 'turn.start') session!.mutations.push(bogus); // 回合一开始就登记一条对不上的改动
    origEmit(ev);
  };
  const r = await runTurn(session, '把文件改一下');
  assert.equal(r.kind, 'final');
  assert.equal((r as { text: string }).text, '刚才那句不算——有个文件其实没改成，我重说');
  assert.equal(calls, 2, '应该恰好回插一次（护栏①：不多不少）');
  assert.equal(session.workChecked, true);
});

test('条 14：别的会话的长活不会拦这个会话的回合（完成判据按会话认领）', async () => {
  const agent = await setup(['我说完了']);
  const s1 = agent.createSession({ id: 'sess-other' });
  await agent.taskStore.create({ title: '另一个会话的活', sessionId: s1.id, completionPromise: 'DONE-ALL' });
  const s2 = agent.createSession({ id: 'sess-me' });
  const r = await runTurn(s2, '你好');
  assert.equal(r.kind, 'final');
  assert.equal((r as { text: string }).text, '我说完了');
});

test('审计（2026-09-19）：会话历史是忠实记录——用户的话与 TA 的最终回复都在里面', async () => {
  const agent = await setup(['第一句回复', '第二句回复']);
  const s = agent.createSession();
  await runTurn(s, '用户说的第一句话');
  await runTurn(s, '用户说的第二句话');
  const roles = s.history.map((m) => m.role);
  assert.deepEqual(roles, ['user', 'assistant', 'user', 'assistant'], JSON.stringify(s.history.map((m) => [m.role, String(m.content).slice(0, 10)])));
  // 第二次请求真的带上了第一轮的对话（模型要能看到用户说过什么）
  const provider = agent.provider as unknown as { requests: Array<{ messages: Array<{ role: string; content: unknown }> }> };
  const second = provider.requests[1]!;
  const texts = second.messages.map((m) => `${m.role}:${String(m.content)}`);
  assert.ok(texts.some((t) => t.includes('用户说的第一句话')), '第二次请求里要带上第一句用户消息：' + JSON.stringify(texts));
  assert.ok(texts.some((t) => t.includes('第一句回复')), '也要带上 TA 自己的上一句回复');
});

test('审计：空续跑不产生空用户消息（工具续跑时不会插一条空话）', async () => {
  const agent = await setup(['用一下工具\n', '好，做完了']);
  const s = agent.createSession();
  const r = await runTurn(s, '帮我看看');
  assert.equal(r.kind, 'final');
  assert.ok(!s.history.some((m) => m.role === 'user' && !String(m.content).trim()), '历史里不该有空用户消息');
});
