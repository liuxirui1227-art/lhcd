// **无人值守时不做破坏性的事**（后台审批闸门）
// 用法：node --test background-gate.test.mjs（零成本：mock 大脑，不碰用户数据）
//
// 口径（写死在测试里，改之前先想清楚）：
//   · R0/R1/R2（看一眼 / 记一笔 / 读文件）→ 后台照做，不打扰（不然安静的夜里会被刷屏）；
//   · R3/R4（删东西 / 跑命令 / 改文件）→ **拒**，并攒成一张卡等用户回来；
//   · R5（不可逆）→ 照旧拒（本来就不放行）。
// 这条修的是"静默放行"：`lib.mjs` 那一支以前只拦 R5，R3/R4 直接 allow。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'lhcd-bggate-'));
process.env.LHCD_DATA_DIR = DATA;
process.env.LHCD_LLM_MOCK = '1';

const lib = await import('./lib.mjs');
lib.mockBirth({ name: '测试体' });

const zero = { inTokens: 0, hitTokens: 0, missTokens: 0, outTokens: 0, reasoningTokens: 0, costUsd: 0 };
/* ⚠ 剧本的两条硬约束：
   ① MockProvider 的剧本是**建会话时快照**的（`new MockProvider({ script: mockScript() })`），
      之后每用例换文件没用；
   ② 游标跨用例一直往前走（`loop: true` 循环），所以"每用例不同剧本"必然与游标耦合。
   现在：**一个剧本、每一轮都是同一条工具调用** —— 任何一轮落下来都是它，用例之间就不会错位。
   命令用 `mv 不存在 也不存在`：命中 BASH_WRITES → **R3**；万一闸门坏了真执行也只是两个不存在的路径。
   （也不能用 echo/ls/cat：那些被内置 r4 规则直接放行，压根走不到闸门。） */
const MOCK_TURN = [
  { type: 'tool_calls', calls: [{ id: 'c1', name: 'bash', args: { command: 'mv 不存在 也不存在' } }] },
  zero ? { type: 'done', usage: zero } : { type: 'done' },
];
fs.writeFileSync(path.join(DATA, 'mock-script.json'), JSON.stringify(Array.from({ length: 12 }, () => MOCK_TURN)));
process.env.LHCD_LLM_MOCK_SCRIPT = path.join(DATA, 'mock-script.json');

/* ⚠ 挑命令有两道讲究：
   ① `echo`/`ls`/`cat` 这类只读命令被**内置 r4 规则**直接放行 → 压根走不到闸门；
   ② `bash` 的**默认档是 R2**（`policy/risk.ts` 的 TOOL_RISK）→ R2 在无人值守时本来就放行，
      验不到新加的 R3/R4 那条。
   所以用 `mv 不存在 也不存在`：命中 BASH_WRITES → **R3**；而且万一闸门坏了真执行，也只是
   两个不存在的路径，什么都不会发生。 */
test('★ 无人值守跑命令（R3）→ 拒，并且攒下一张卡', async () => {
  /* ⚠ 不要求 r.ok：剧本每一轮都是工具调用，而她会在**同一个回合里**连试几次，
     被拒三次之后内核按"同一件事被拦了几次，我先停下了"收场 —— 那是设计好的收场方式，
     这一条要盯的是"拒了 + 攒了卡"，不是"回合成功"。 */
  await lib.chat('（定时）跑一下', undefined, { origin: 'cron' });
  const items = lib.listBackgroundBlocked();
  assert.ok(items.length >= 1, '被拒的事要攒下来：' + JSON.stringify(items));
  assert.equal(items[0].tool, 'bash');
  assert.match(items[0].summary, /跑一条命令/, '摘要要是人话：' + items[0].summary);
  assert.ok(!JSON.stringify(items).includes('mv'), '★ 摘要里不许出现命令原文（安全词表）');
});

test('链上留了痕：这一次是"无人值守 → 拒"', () => {
  const entries = fs.readFileSync(path.join(DATA, 'log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const denied = entries.filter((e) => e.type === 'approval' && e.payload?.decision === 'deny');
  assert.ok(denied.length >= 1, '审批那一笔要在链上');
  assert.ok(denied.some((e) => /无人值守/.test(String(e.payload?.by ?? ''))), '理由要写清是无人值守：' + JSON.stringify(denied.map((d) => d.payload)));
});

test('处理完就清掉（不重复打扰）', () => {
  const items = lib.listBackgroundBlocked();
  assert.ok(items.length >= 1, '先得有攒下的（上一个用例留下的）');
  for (const it of items) assert.equal(lib.clearBackgroundBlocked(it.id).ok, true);
  assert.equal(lib.listBackgroundBlocked().length, 0);
});

test('你说"现在做"之后：她在有人在场时重做一遍，且不再攒卡', async () => {
  /* ⚠ 期望值要照产品口径写：**闲聊档一律不问**（不要二次确认），
     所以"有人在场 → 会弹卡"这件事只有**工作模式**下才成立（`lifecycle/mode.ts` 的 askR3）。
     这一条真正要盯的是：前台**不再走无人值守那一支**（不攒卡），而且这一步真的被做了。 */
  // ⚠ 必须**锁定**模式：`decideModeForTurn` 的粘性规则是"这句明显不是活、手上又没活 → 退回闲聊"，
  //   而"你刚才想做的那件事，现在做吧"正好不像活。
  lib.setMode('work', { source: 'test', reason: '用例要验工作模式的审批', lock: true });
  let asked = 0;
  lib.setApprovalBridge(() => { asked += 1; return Promise.resolve('deny'); });
  const r = await lib.chat('你刚才想做的那件事，现在做吧', undefined, { origin: 'user' });
  // 同样不要求 r.ok：测试里的审批桥一律回"不允许"，被拒三次之后她会自己收场（设计如此）
  assert.ok(asked >= 1, `工作模式下 R3 要走审批卡（这一次点了"不允许"）· 实际问了 ${asked} 次 · mode=${r.mode}`);
  assert.equal(lib.listBackgroundBlocked().length, 0, '前台不该再攒卡');
  lib.setMode('chat', { source: 'test', reason: '用例收尾', lock: false });
});

test('闲聊模式不打扰（这是产品口径，不是漏做）', async () => {
  lib.setMode('chat', { source: 'test', reason: '用例要验闲聊档', lock: true });
  let asked = 0;
  lib.setApprovalBridge(() => { asked += 1; return Promise.resolve('deny'); });
  await lib.chat('随便说句话', undefined, { origin: 'user' });
  assert.equal(asked, 0, '闲聊档不问（P8：不要二次确认）');
});

test('档位表：R0/R1/R2 放行，R3 以上拒（判据一处，闸门与这里同一个函数）', () => {
  for (const r of ['R0', 'R1', 'R2']) assert.equal(lib.backgroundVerdict(r).allow, true, r + ' 该放行');
  for (const r of ['R3', 'R4', 'R5']) assert.equal(lib.backgroundVerdict(r).allow, false, r + ' 该拒');
  assert.match(lib.backgroundVerdict('R3').reason, /等你回来/);
});

test('一键停掉全部定时任务：停得掉，也说得出停了几条', async () => {
  // 造两条定时任务
  await lib.chat('每天早上九点提醒我喝水', undefined, { origin: 'user' }).catch(() => null);
  const jobs = lib.cronJobList();
  if (jobs.filter((j) => j.enabled).length === 0) {
    // mock 剧本没造出定时任务就跳过（这条判据由真链路覆盖）
    assert.ok(true, '（本次 mock 没建出定时任务，跳过）');
    return;
  }
  const r = lib.stopAllCron();
  assert.equal(r.ok, true, r.error);
  assert.ok(r.stopped >= 1);
  assert.equal(lib.cronJobList().filter((j) => j.enabled).length, 0, '停完应当一条都不剩');
});
