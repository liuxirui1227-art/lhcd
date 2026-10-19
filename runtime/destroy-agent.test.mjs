// **记忆包导出之后，本机的可以销毁**（销毁完就是一个全新的她，从头开始）。
// 用法：node --test destroy-agent.test.mjs（或 npm test）；零成本。
//
// 这组用例盯的是**安全性质**——销毁是不可撤销的，所以"该删的删干净"和"不该删的别碰"同等重要：
//   ① 她的东西：出生包 / 钥匙种子 / 签名日志 / 记忆 / 会话 / 花销 / 技能 / 待办 —— 全没
//   ② **你的东西**：API Key、自定义端点、语言、授权目录、放行的应用 —— 一个都不能少
//   ③ **随包资源**：形象库、内置分身 —— 一个都不能少（开发态它们就和她的东西同住一个目录）
//   ④ 没确认就不许动一个字；已销毁再销毁要如实说"这儿还没有她"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'lhcd-destroy-'));
process.env.LHCD_DATA_DIR = DATA;
process.env.LHCD_LLM_MOCK = '1';

const lib = await import('./lib.mjs');

if (!fs.existsSync('/tmp/birth-3.json')) throw new Error('缺少 /tmp/birth-3.json（先跑 make-birth-fixture.mjs）');
assert.equal(lib.importPackageFromPath('/tmp/birth-3.json').ok, true);
assert.equal(lib.bind().ok, true);

// 造出"她用过一阵子"的现场 + "你的东西" + "随包资源"
fs.mkdirSync(path.join(DATA, 'memory', 'semantic'), { recursive: true });
fs.writeFileSync(path.join(DATA, 'memory', 'semantic', 'chat-x.md'), '---\nkey: 生日\n---\n三月五号\n');
fs.mkdirSync(path.join(DATA, 'memory', 'episodes'), { recursive: true });
fs.writeFileSync(path.join(DATA, 'memory', 'identity.md'), '- 别催我\n');
fs.mkdirSync(path.join(DATA, 'sessions', 'main'), { recursive: true });
fs.writeFileSync(path.join(DATA, 'sessions', 'main', 'messages.jsonl'), '{}\n');
fs.mkdirSync(path.join(DATA, 'skills', 'excel-report'), { recursive: true });
fs.mkdirSync(path.join(DATA, 'agents', 'my-own-helper'), { recursive: true });   // 用户装的分身
fs.mkdirSync(path.join(DATA, 'agents', 'verifier'), { recursive: true });        // 随包分身（开发态同住）
fs.mkdirSync(path.join(DATA, 'live2d'), { recursive: true });                    // 随包形象库
fs.writeFileSync(path.join(DATA, 'live2d', 'models.json'), '{"models":[]}');
fs.writeFileSync(path.join(DATA, 'credentials.json'), JSON.stringify({ deepseek: 'sk-user-key' }));
fs.writeFileSync(path.join(DATA, 'todos.json'), JSON.stringify({ items: [{ text: '买牛奶' }] }));
// 机器级设置与她的状态混在同一个 state.json 里（这正是绑定时的写法）
const st = JSON.parse(fs.readFileSync(path.join(DATA, 'state.json'), 'utf8'));
fs.writeFileSync(path.join(DATA, 'state.json'), JSON.stringify({
  ...st,
  llm: { provider: 'deepseek', modelOverride: { deepseek: 'deepseek-v4-flash' } },
  prefs: { language: 'zh-CN', globalVisible: true },
  workspaceDirs: ['/Users/demo/文稿'],
  appWhitelist: ['Calendar'],
  intimacy: 0.42, stage: 'close', wardrobe: { items: [1, 2, 3] },          // 她的
}));

// 销毁是不可逆的，用例之间会互相影响 —— 所以**每个用例自己造前提**，不靠上一个用例剩下的现场
function reseed() {
  assert.equal(lib.importPackageFromPath('/tmp/birth-3.json').ok, true, '出生包夹具导入失败');
  assert.equal(lib.bind().ok, true, '重新绑定失败');
}

test('销毁前的账单：说得出她是谁、每一组里有多少东西', () => {
  const f = lib.agentFootprint();
  assert.equal(f.ok, true);
  assert.equal(f.bound, true);
  assert.equal(typeof f.days, 'number', '在一起多少天要算得出来');
  // 明细按组给（界面一行一项：勾选框 + 名字 + 一句说明 + 右边"有多少"）
  const ident = f.groups.find((g) => g.id === 'identity');
  assert.ok(ident, '要有"出生信息与身份"这一组');
  assert.match(String(ident.size), /条日志/, '这一组右边要写得出签名日志条数：' + ident.size);
  assert.equal(ident.reborn, true, '勾了它 = 重新出生，界面据此换警告');
  const mem = f.groups.find((g) => g.id === 'memory');
  assert.ok(mem && typeof mem.desc === 'string' && mem.desc.length > 0, '每组都要有一句人话说明');
});

test('没确认就不许动一个字', () => {
  const r = lib.destroyAgent({});
  assert.equal(r.ok, false);
  assert.ok(fs.existsSync(path.join(DATA, 'birth-package.json')), '出生包还在');
  assert.equal(fs.existsSync(path.join(DATA, 'memory')), true, '记忆还在');
});

test('销毁：她的全没，你的全在，随包的一个不少', () => {
  const r = lib.destroyAgent({ confirm: 'destroy' });
  assert.equal(r.ok, true, r.error);

  // ① 她的东西：没了
  for (const p of ['birth-package.json', 'seed.enc', 'log.jsonl', 'todos.json', 'memory', 'sessions', 'skills', 'cost', 'logs', 'turns', 'cron', 'tasks']) {
    assert.equal(fs.existsSync(path.join(DATA, p)), false, `${p} 应当被销毁`);
  }
  // ② 你的东西：一个都不能少
  assert.equal(JSON.parse(fs.readFileSync(path.join(DATA, 'credentials.json'), 'utf8')).deepseek, 'sk-user-key', '钥匙是你的，不许删');
  const after = JSON.parse(fs.readFileSync(path.join(DATA, 'state.json'), 'utf8'));
  assert.equal(after.llm?.modelOverride?.deepseek, 'deepseek-v4-flash', '选的模型要留着');
  assert.equal(after.prefs?.language, 'zh-CN', '语言要留着');
  assert.deepEqual(after.workspaceDirs, ['/Users/demo/文稿'], '授权目录要留着');
  assert.deepEqual(after.appWhitelist, ['Calendar'], '放行的应用要留着');
  assert.equal(after.bound, undefined, '绑定状态必须清掉（下次打开就是从头开始）');
  assert.equal(after.intimacy, undefined, '亲密度是她的，不许留');
  assert.equal(after.wardrobe, undefined, '衣柜是她的，不许留');
  // ③ 随包资源：一个都不能少
  assert.equal(fs.existsSync(path.join(DATA, 'agents', 'verifier')), true, '随包分身必须留着');
  assert.equal(fs.existsSync(path.join(DATA, 'agents', 'my-own-helper')), false, '用户装的分身算"她装过的"，要删');
  assert.equal(fs.existsSync(path.join(DATA, 'live2d', 'models.json')), true, '随包形象库必须留着');
});

// ---------- 销毁按组选择：「能勾选的就不要输入」「可以选择可以全选」----------
// 销毁因此变成**按组**：既能全选，也能只清一部分（比如"只忘掉记忆，她还是她"）。

test('分组：默认（不给 groups）= 全清，行为与以前一致', () => {
  const fp = lib.agentFootprint();
  assert.ok(Array.isArray(fp.groups) && fp.groups.length >= 6, '账单要按组给出，界面才能一行一项地列');
  for (const g of fp.groups) {
    assert.ok(g.id && g.label && g.desc, '每组都要有 id/名字/一句说明：' + JSON.stringify(g));
  }
  assert.ok(fp.groups.some((g) => g.id === 'identity' && g.reborn === true), '身份那组要标"勾了=重新出生"');
});

test('只清一部分：只勾"记忆" → 记忆没了，她本人还在（仍然绑定）', () => {
  reseed();   // 上一个用例已经全清过一次
  fs.mkdirSync(path.join(DATA, 'memory', 'semantic'), { recursive: true });
  fs.writeFileSync(path.join(DATA, 'memory', 'semantic', 'chat-y.md'), '---\nkey: k\n---\nv\n');
  const r = lib.destroyAgent({ confirm: 'destroy', groups: ['memory'] });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.reborn, false, '没勾身份 → 不算重新出生');
  assert.equal(fs.existsSync(path.join(DATA, 'memory')), false, '记忆要没');
  assert.equal(fs.existsSync(path.join(DATA, 'birth-package.json')), true, '出生包要留（她还是她）');
  assert.equal(fs.existsSync(path.join(DATA, 'log.jsonl')), true, '签名日志要留（你俩的历史还在）');
  assert.equal(lib.status().bound, true, '仍然绑定 → 打开还是她');
});

test('细到小项：只删"这些天的片段" → 片段没了，记住的事与规矩都还在', () => {
  reseed();
  fs.mkdirSync(path.join(DATA, 'memory', 'semantic'), { recursive: true });
  fs.mkdirSync(path.join(DATA, 'memory', 'episodes'), { recursive: true });
  fs.writeFileSync(path.join(DATA, 'memory', 'semantic', 'a.md'), '---\nk: a\n---\nv\n');
  fs.writeFileSync(path.join(DATA, 'memory', 'episodes', 'day1.md'), '片段\n');
  fs.writeFileSync(path.join(DATA, 'memory', 'identity.md'), '- 别催我\n');
  const r = lib.destroyAgent({ confirm: 'destroy', groups: { memory: ['episodes'] } });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.groups, ['memory:episodes'], '回执要能说出删的是哪一小项');
  assert.equal(fs.existsSync(path.join(DATA, 'memory', 'episodes')), false, '片段要没');
  assert.equal(fs.existsSync(path.join(DATA, 'memory', 'semantic', 'a.md')), true, '记住的事要留');
  assert.equal(fs.existsSync(path.join(DATA, 'memory', 'identity.md')), true, '定下的规矩要留');
  assert.equal(lib.status().bound, true, '没动身份 → 她还是她');
});

test('细到小项：只删"签名日志" → 历史没了，但她还在（不算重新出生）', () => {
  reseed();   // 上一个用例删过片段；这里要的是"她还在"的现场
  const r = lib.destroyAgent({ confirm: 'destroy', groups: { identity: ['log'] } });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.reborn, false, '只删日志不该算重新出生');
  assert.equal(fs.existsSync(path.join(DATA, 'log.jsonl')), false);
  assert.equal(fs.existsSync(path.join(DATA, 'birth-package.json')), true, '出生包要留');
  assert.equal(lib.status().bound, true);
});

test('连带规则：删"身份钥匙"（没勾出生信息）也算重新出生——不能让她半死不活', () => {
  reseed();
  const r = lib.destroyAgent({ confirm: 'destroy', groups: { identity: ['seed'] } });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.reborn, true, '钥匙没了就是"没有她"');
  assert.equal(fs.existsSync(path.join(DATA, 'seed.enc')), false);
  assert.equal(lib.status().bound, false, '要回到出生向导，而不是带着坏状态运行');
});

test('只勾"身份" → 重新出生（下次打开从头开始）', () => {
  reseed();   // 上一个用例把钥匙删了，这里先让她回来
  const r = lib.destroyAgent({ confirm: 'destroy', groups: ['identity'] });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.reborn, true);
  assert.equal(fs.existsSync(path.join(DATA, 'birth-package.json')), false);
  assert.equal(lib.status().bound, false, '没有出生包 → 未绑定 → 出生向导');
});

test('一项都没选 / 空数组 → 什么都不做', () => {
  const r = lib.destroyAgent({ confirm: 'destroy', groups: [] });
  assert.equal(r.ok, false);
  assert.match(String(r.error), /一项都没选|还没有她/);
});

test('销毁之后：状态回到"还没有她"，再销毁要如实说', () => {
  const s = lib.status();
  assert.equal(s.bound, false, 'status 要如实说"这台机器上还没有她"');
  const again = lib.destroyAgent({ confirm: 'destroy' });
  assert.equal(again.ok, false);
  assert.match(String(again.error), /还没有她/);
});
