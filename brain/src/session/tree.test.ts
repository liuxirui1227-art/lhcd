// 对话树——父指针、纯函数投影、回溯切点、分支 id。
// 要守住的三条：① 投影是纯函数（同日志同叶子 → 同结果）；② 宿主字段绝不进请求体；③ 老历史读完不动文件。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ensureIds, leafOf, parentOf, projectFrom, cutAt, branchSessionId, parentOfBranch, type TreeMessage } from './tree.js';
import type { ChatMessage } from '../llm/provider.js';

const H: ChatMessage[] = [
  { role: 'user', content: '第一句' },
  { role: 'assistant', content: '回一' },
  { role: 'user', content: '第二句' },
  { role: 'assistant', content: '回二' },
];

test('补 id/父指针：幂等；重复调用不会把指针改乱', () => {
  const a = ensureIds(H);
  assert.deepEqual(a.map((m) => m.id), ['m1', 'm2', 'm3', 'm4']);
  assert.deepEqual(a.map((m) => m.parentId), [null, 'm1', 'm2', 'm3']);
  const b = ensureIds(a);
  assert.deepEqual(b.map((m) => m.id), a.map((m) => m.id), '第二次调用 id 不变');
  assert.deepEqual(b.map((m) => m.parentId), a.map((m) => m.parentId));
  // 追加新消息：接着编号，父指针指向最后一条
  const c = ensureIds([...a, { role: 'user', content: '第三句' }]);
  assert.equal(c[4]!.id, 'm5');
  assert.equal(c[4]!.parentId, 'm4');
});

test('纯函数投影：从叶子沿 parentId 上溯；同输入两次结果一致；宿主字段被剥掉', () => {
  const entries = ensureIds(H);
  const p1 = projectFrom(entries, 'm4');
  const p2 = projectFrom(entries, 'm4');
  assert.deepEqual(p1, p2, '纯函数：同输入同输出');
  assert.equal(p1.length, 4);
  assert.equal(p1[0]!.content, '第一句');
  assert.ok(!('id' in p1[0]!) && !('parentId' in p1[0]!), '宿主字段不进请求体');
  // 从中间某条当叶子 → 只看到那一段（这就是"换条路走"）
  const mid = projectFrom(entries, 'm2');
  assert.deepEqual(mid.map((m) => m.content), ['第一句', '回一']);
  // 空叶子 / 不存在的叶子
  assert.deepEqual(projectFrom(entries, null), []);
  assert.deepEqual(projectFrom(entries, '不存在'), []);
});

test('坏数据不成死循环：成环时截断', () => {
  const cyc = [
    { role: 'user', content: 'a', id: 'x', parentId: 'y' },
    { role: 'assistant', content: 'b', id: 'y', parentId: 'x' },
  ] as TreeMessage[];
  const out = projectFrom(cyc, 'x');
  assert.equal(out.length, 2, '成环要停下（别转死）');
});

test('回到这句重说：选中用户消息 → 原话回填；选中助手 → 输入框留空', () => {
  const entries = ensureIds(H);
  const u = cutAt(entries, 'm3');
  assert.deepEqual(u.kept.map((m) => m.id), ['m1', 'm2']);
  assert.deepEqual(u.removed.map((m) => m.id), ['m3', 'm4']);
  assert.equal(u.text, '第二句', '用户消息：原话回填输入框');
  const a = cutAt(entries, 'm4');
  assert.equal(a.text, '', '助手条目：输入框留空（原方案语义）');
  assert.deepEqual(a.kept.map((m) => m.id), ['m1', 'm2', 'm3']);
  // 找不到的 id：原样返回、不炸
  const miss = cutAt(entries, 'nope');
  assert.equal(miss.kept.length, 4);
  assert.equal(miss.text, '');
});

test('会话与叶子：叶子 = 最后一条；分支 id 看得出从哪来', () => {
  const entries = ensureIds(H);
  assert.equal(leafOf(entries), 'm4');
  assert.equal(leafOf([]), null);
  assert.equal(parentOf(entries, 'm3'), 'm2');
  assert.equal(parentOf(entries, '不存在'), null);
  assert.equal(branchSessionId('main', 1), 'main~b1');
  assert.equal(parentOfBranch('main~b1'), 'main');
  assert.equal(parentOfBranch('main'), null);
});
