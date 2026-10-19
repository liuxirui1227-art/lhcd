// 「以后这类都允许」——写回 → 立即生效 → 跨重启还在 → 删得掉
// 用法：node --test rule-writeback.test.mjs（零成本，不调 LLM，不碰用户数据）
//
// 这条测的是**最重的一次授权**（跨重启、跨对话、她以后自己用），所以判据写得比功能多：
//   ① 能写出一条**窄**规矩（`echo hi` → `^echo\s+hi\b`，不是 `.*`）；
//   ② 写进去之后**内核真认**（同一条命令不再问、别的命令照旧问）；
//   ③ **墙压得住门**：自己写一条 `.* → allow`，`rm -rf /` 仍然被内置底线拒；
//   ④ 一次对话最多一条（连点"都允许"不该把规则表写满）；
//   ⑤ 「我的规矩」列得出来、删得掉；删完内核立刻不认它。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'lhcd-rule-'));
process.env.LHCD_DATA_DIR = DATA;
process.env.LHCD_LLM_MOCK = '1';

const lib = await import('./lib.mjs');
const { PolicyEngine, loadConfig } = await import('../brain/dist/index.js');

const cfgFile = () => path.join(DATA, 'agent.json');
const readCfg = () => JSON.parse(fs.readFileSync(cfgFile(), 'utf8'));
const engineNow = () => new PolicyEngine(loadConfig({ cwd: DATA, home: DATA }).permissions);

test('★ 路径类工具也能给规矩了（节点 19 余补上节点 2 推迟的那半）', () => {
  const r = lib.proposeRuleForApproval({ tool: 'write', args: { path: '/tmp/工作/报表.md', content: 'x' } });
  assert.equal(r.ok, true, r.reason);
  assert.match(r.rule.match, /^write\(path: \/tmp\/工作\/\*\*\)$/, '范围 = 那个文件所在文件夹（含子文件夹）：' + r.rule.match);
  assert.match(r.preview, /工作/);
});

test('范围太大 / 落在我自己的数据目录 → 不给这颗按钮', () => {
  const home = os.homedir();
  const tooBig = lib.proposeRuleForApproval({ tool: 'write', args: { path: path.join(home, 'a.md'), content: 'x' } });
  assert.equal(tooBig.ok, false, '家目录根 = 什么文件都能改，不给');
  assert.match(tooBig.reason, /太大|说得清范围/);
  const mine = lib.proposeRuleForApproval({ tool: 'write', args: { path: path.join(DATA, 'x.md'), content: 'x' } });
  assert.equal(mine.ok, false, '我自己的数据目录有硬底线管着，写规矩没意义');
});

test('还没有窄写法的工具照样不给（比如 app）', () => {
  const r = lib.proposeRuleForApproval({ tool: 'app', args: { action: 'run', script: 'return 1' } });
  assert.equal(r.ok, false);
  assert.match(r.reason, /规矩写法/);
});

test('禁提前缀不提议（`sudo ls` 这类不能变成规矩）', () => {
  for (const cmd of ['sudo ls', 'bash -c "ls"', 'npm test', 'rm -rf build']) {
    const r = lib.proposeRuleForApproval({ tool: 'bash', args: { command: cmd } });
    assert.equal(r.ok, false, `${cmd} 不该被提成规矩`);
  }
});

test('窄规矩写得出来、而且真的是窄的', () => {
  const r = lib.proposeRuleForApproval({ tool: 'bash', args: { command: 'echo hi' } });
  assert.equal(r.ok, true, r.reason);
  assert.ok(!/\.\*/.test(r.rule.match), '不许是 catch-all：' + r.rule.match);
  assert.match(r.rule.match, /echo/);
  assert.match(r.preview, /echo hi 开头的命令/, r.preview);
});

test('写回用户配置 → 内核立刻认（同一条不问、别的照旧问）', async () => {
  const r = lib.proposeRuleForApproval({ tool: 'bash', args: { command: 'echo hi' } });
  const w = await lib.writeApprovedRule(r.rule);
  assert.equal(w.ok, true, w.error);
  // ① 落盘（跨重启还在）
  const onDisk = readCfg();
  assert.ok(Array.isArray(onDisk.permissions.rules) && onDisk.permissions.rules.some((x) => x.id === r.rule.id),
    'agent.json 里要有这条规矩');
  // ② 内核真认（用**落盘后重新加载**的配置建引擎——这条正是"重启后还在"的判据）
  const e = engineNow();
  assert.equal(e.check('bash', 'bash', { command: 'echo hi' }).action, 'allow', '这条命令不该再问了');
  assert.notEqual(e.check('bash', 'bash', { command: 'echo 别的' }).action, 'allow', '别的命令照旧走原档');
});

test('★ 墙压得住门：自己写一条 `.* → allow`，内置底线照样拒', async () => {
  const w = await lib.writeApprovedRule({ id: 'user-allow-all', tool: 'bash', match: '.*', action: 'allow' });
  assert.equal(w.ok, true, w.error);
  const e = engineNow();
  assert.equal(e.check('bash', 'bash', { command: 'echo hi' }).action, 'allow');
  assert.equal(e.check('bash', 'bash', { command: 'rm -rf /' }).action, 'deny', '内置底线不该被自己的规矩拆掉');
  // 清掉，别影响后面的用例
  await lib.removeMyRule('user-allow-all');
});

test('一次对话最多写一条（连点"都允许"写不满规则表）', async () => {
  const first = lib.proposeRuleForApproval({ tool: 'bash', args: { command: 'date' } });
  if (first.ok) await lib.writeApprovedRule(first.rule);   // 前面用例已经写过一条 → 这里必然被配额挡住
  const again = lib.proposeRuleForApproval({ tool: 'bash', args: { command: 'whoami' } });
  assert.equal(again.ok, false, '配额用完之后不该再给按钮');
  assert.match(again.reason, /已经记过一条规矩/);
  const mine = lib.myRules();
  assert.equal(mine.canWriteMore, false, '设置页也要知道"这一轮不能再记了"');
});

test('「我的规矩」列得出来、删得掉；删完内核立刻不认', async () => {
  const mine = lib.myRules();
  assert.ok(mine.rules.length >= 1, '至少有一条（前面写的）');
  const target = mine.rules.find((r) => /echo/.test(r.match));
  assert.ok(target, '要能看到刚写的那条：' + JSON.stringify(mine.rules));
  assert.ok(target.preview && target.tool === 'bash', '每条要有人话预览');
  const rm = await lib.removeMyRule(target.id);
  assert.equal(rm.ok, true, rm.error);
  const e = engineNow();
  assert.notEqual(e.check('bash', 'bash', { command: 'echo hi' }).action, 'allow', '删掉之后内核不该再认它');
});

test('规矩写不进用户层时如实说（坏 JSON 不许被覆盖）', async () => {
  fs.writeFileSync(cfgFile(), '{ 这不是 JSON');
  const w = await lib.writeApprovedRule({ id: 'x1', tool: 'bash', match: '^echo\\s+x\\b', action: 'allow' });
  assert.equal(w.ok, false, '坏 JSON 必须拒绝写，而不是覆盖用户的文件');
  assert.equal(fs.readFileSync(cfgFile(), 'utf8'), '{ 这不是 JSON', '文件一个字节都不许动');
});
