// **回合来源**单测：`origin` 说明"谁给的输入"，`background` 才决定"要不要打扰"。
// 用法：node --test turn-origin.test.mjs（或 npm test）；零成本（mock 大脑，不调 LLM、不联网）。
//
// 为什么要拆这两件事（以前是一个标志）：
//   ① 三条旁路回合（截图/拖文件/屏幕观察）**不带 origin** → 记录层写成 `user` = 冒充用户发言，
//      还会被 `digestMemory` 当作用户发言提炼进长期记忆（屏幕里的外部内容有机会沉淀成关于你的事实）；
//   ② 反过来"带 origin 就不弹审批卡"太粗：你刚按的截图分析、刚拖进来的文件，本来是该能问的。
//
// ⚠ mock 剧本是**按位置消耗**的，所以整份测试只写一个剧本文件（交替的"调工具 → 收尾"对），
// 不按用例换文件——换文件不生效，会让后面的用例悄悄跑在错位的剧本上。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'lhcd-turn-origin-'));
process.env.LHCD_DATA_DIR = DATA;
process.env.LHCD_LLM_MOCK = '1';
const done = { type: 'done' };
const say = (t) => [{ type: 'text.delta', text: t }, done];
// `app run` = R5（任意脚本，任何档位都必须问）——用它观察闸门有没有真的问。
// 脚本本身用 `return 1`（合法 AppleScript、无副作用），万一真被执行也不动用户的机器。
const appRun = () => [{ type: 'tool_calls', calls: [{ id: 'a1', name: 'app', args: { action: 'run', script: 'return 1' } }] }, done];
// 每一轮固定消耗一对（工具调用 → 收尾），于是每轮都从 appRun 开始
const pairs = Array.from({ length: 10 }, () => [appRun(), say('好')]).flat();
fs.writeFileSync(path.join(DATA, 'mock-script.json'), JSON.stringify(pairs));
process.env.LHCD_LLM_MOCK_SCRIPT = path.join(DATA, 'mock-script.json');

const lib = await import('./lib.mjs');

if (!fs.existsSync('/tmp/birth-3.json')) throw new Error('缺少 /tmp/birth-3.json（先跑 make-birth-fixture.mjs）');
assert.equal(lib.importPackageFromPath('/tmp/birth-3.json').ok, true);
assert.equal(lib.bind().ok, true);

const chain = () => fs.readFileSync(path.join(DATA, 'log.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
/** 这一轮真的发生了"高风险动作"吗——用它确认用例不是空跑 */
const deviceRuns = () => chain().filter((r) => r.type === 'device_action').length;

test('无人值守的来源（定时/心跳/续跑/屏幕观察）不弹审批卡：R5 问不成 = 拒绝', async () => {
  for (const origin of ['cron', 'heartbeat', 'resume', 'screen']) {
    const asked = [];
    const before = deviceRuns();
    lib.setApprovalBridge((req) => { asked.push(req); return Promise.resolve('allow'); });
    const r = await lib.chat('跑一下', undefined, { origin });
    lib.setApprovalBridge(null);
    assert.equal(r.ok, true);
    assert.ok(deviceRuns() > before, `${origin}：这一轮确实摸到了高风险动作（否则这条用例是空跑）`);
    assert.equal(asked.length, 0, `${origin}：不该弹卡（用户不在，弹了只会 60s 超时）`);
  }
});

test('有人在场的来源（你刚按的截图 / 刚拖的文件）可以问：桥被调到', async () => {
  for (const origin of ['screenshot', 'drop']) {
    const asked = [];
    lib.setApprovalBridge((req) => { asked.push(req); return Promise.resolve('deny'); });
    const r = await lib.chat('看看这个', undefined, { origin });
    lib.setApprovalBridge(null);
    assert.equal(r.ok, true);
    assert.ok(asked.length >= 1, `${origin}：应当弹卡（用户刚动作过，就在屏幕前）`);
    assert.equal(asked[0].risk, 'R5');
  }
});

test('来源如实进记录：非用户输入不许记成 user', async () => {
  lib.setApprovalBridge(null);
  await lib.chat('[屏幕观察模式] 这是用户当前屏幕的截图。', undefined, { origin: 'screen' });
  await lib.chat('这是我自己说的话');

  const rows = chain();
  // 作者那一格是 `author`（user/companion/system），来源在 payload.origin ——
  // **不许再把 origin 塞进 type**（那是 spec 枚举，塞进去就是"枚举外的类型"，见 log-spec.test.mjs）
  const screenRows = rows.filter((r) => r.payload?.origin === 'screen');
  assert.ok(screenRows.length >= 1, '屏幕观察回合应当带着 origin=screen 进链');
  assert.ok(screenRows.every((r) => r.author === 'system'), '屏幕观察的输入是 system 给的，不是用户说的');
  assert.ok(screenRows.every((r) => r.type === 'memory_append'), 'type 必须在 spec 枚举内');
  const userTexts = rows.filter((r) => r.author === 'user').map((r) => String(r.payload?.text ?? ''));
  assert.equal(userTexts.some((t) => t.includes('屏幕观察模式')), false, '屏幕内容不许冒充用户说的话');
  assert.ok(userTexts.some((t) => t.includes('这是我自己说的话')), '用户自己说的照旧记成 user');
});

/* ---------- 把"这一轮是谁说的"翻成人话给界面 ---------- */
test('★ 最近几轮的来源说得出来：你自己说的 / 定时 / 心跳（人话，不出现内部码）', async () => {
  const r = lib.recentTurnOrigins(8);
  assert.equal(r.ok, true, r.error);
  assert.ok(r.total >= 1, '至少有前面那些用例跑出来的轮次：' + JSON.stringify(r));
  // 每一条都要有 人话 + 是不是我说的
  for (const t of r.turns) {
    assert.ok(typeof t.word === 'string' && t.word.length > 0, '要有词：' + JSON.stringify(t));
    assert.ok(typeof t.mine === 'boolean');
    assert.ok(!/^(cron|heartbeat|screen|resume|drop)$/.test(t.word), '不许把内部码甩给用户：' + t.word);
  }
  assert.equal(r.mine, r.turns.filter((t) => t.mine).length, '统计口径要自洽');
});

test('无人值守那一轮不会被算成"你说的"', async () => {
  const before = lib.recentTurnOrigins(20);
  await lib.chat('（心跳）', undefined, { origin: 'heartbeat' }).catch(() => null);
  const after = lib.recentTurnOrigins(20);
  assert.ok(after.total >= before.total, '轮次要能数出来');
  if (after.total > before.total) {
    assert.equal(after.turns[0].mine, false, '心跳那一轮不该算成我说的：' + JSON.stringify(after.turns[0]));
    assert.match(after.turns[0].word, /心跳|主动/);
  }
});
