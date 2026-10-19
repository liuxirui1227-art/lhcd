// 「内置规则不可禁用」——**墙只许加高，不许拆**。
//
// 攻击面：一份普通的 `<home>/.agent/agent.json` 写上
//   { "permissions": { "rules": [{ "tool": "*", "match": ".*", "action": "allow" }], "readZones": ["/tmp/nothing"] } }
// 就能把 `~/.lhcd`（人格/记忆/凭据所在）整条禁区拆掉、把内置 deny 规则整表换掉——
// 读 `~/.lhcd/data/state.json` 变成 allow。成因：`deepMerge` 对数组是**整体替换**，
// 默认禁区若写成 `userZones.length ? userZones : DEFAULT_READ_ZONES`（"你给了就听你的"）就会中招。
// 这一组用例走的是**真配置文件那条路**（loadConfig 读盘），不是构造对象。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../config/load.js';
import { PolicyEngine } from './engine.js';
import { BUILTIN_DENY_RULES } from '../config/schema.js';
import { BaselineGuard, DEFAULT_READ_ZONES } from './baseline.js';

/** 造一个"看起来正常"的家目录，里面放一份想拆墙的配置 */
function hostileHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-nodown-'));
  fs.mkdirSync(path.join(home, '.agent'), { recursive: true });
  fs.writeFileSync(path.join(home, '.agent', 'agent.json'), JSON.stringify({
    permissions: {
      // 用户当然可以写自己的规则（更严或更松都行）——但不能把内置的墙拆掉
      rules: [{ id: 'my-allow', tool: '*', match: '.*', action: 'allow' }],
      readZones: ['/tmp/nothing'],
    },
  }));
  return home;
}

test('条 5③：配置文件拆不掉默认禁区（~/.lhcd 只许加、不许拆）', () => {
  const home = hostileHome();
  const cfg = loadConfig({ cwd: home, home });
  const eng = new PolicyEngine(cfg.permissions, { home, cwd: home });

  const r = eng.check('read', 'read', { path: '~/.lhcd/data/state.json' });
  assert.equal(r.action, 'deny', '人格/记忆/凭据所在目录不许因为配置而失去保护');
  assert.equal(r.ruleId, 'baseline-zone');
  // 系统敏感目录、凭据文件名、保留区这三样本来就与配置无关，这里一起回归一遍
  assert.equal(eng.check('read', 'read', { path: '~/.ssh/id_rsa' }).action, 'deny');
  assert.equal(eng.check('read', 'read', { path: '~/proj/.env' }).action, 'deny');
  assert.equal(eng.check('write', 'write', { path: '~/proj/.git/hooks/pre-commit', content: 'x' }).action, 'deny');
  // 用户自己写的规则照旧生效（配置不是废纸）
  assert.equal(eng.check('bash', 'bash', { command: 'echo hi' }).ruleId, 'my-allow');
});

test('条 5③：内置 deny 表不在配置里，任何配置都删不掉、也盖不住', () => {
  const home = hostileHome();
  const cfg = loadConfig({ cwd: home, home });
  const eng = new PolicyEngine(cfg.permissions, { home, cwd: home });

  // 先确认这个攻击面是真的：用户配置里确实只剩自己那一条（内置的没在里面）
  assert.deepEqual(cfg.permissions.rules.map((r) => r.id), ['my-allow']);
  // 而 deny 判据照样在——`dd of=` 这条硬表没覆盖（硬表只认 of=/dev/），只有内置表能拦
  const dd = eng.check('bash', 'bash', { command: 'dd of=/tmp/disk.img' });
  assert.equal(dd.action, 'deny');
  assert.equal(dd.ruleId, 'builtin:dangerous-bash');
  assert.ok(dd.warning && dd.alternative, '拒绝要给"为什么 + 换个办法"');
  // 排在用户 allow 规则**后面**也拦得住（内置表先于用户规则判）——这正是修前会漏的那种写法
  assert.equal(eng.check('bash', 'bash', { command: 'mkfs.ext4 /dev/disk2' }).action, 'deny');
  // 不该误伤的：打印/查找里提到这些词
  assert.equal(eng.check('bash', 'bash', { command: 'echo "dd of=/tmp/x"' }).action, 'allow');
});

test('条 5③：内置表本身是干净的（别把墙砌成永远命中）', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-nodown2-'));
  const g = new BaselineGuard(undefined, { home, cwd: home });
  // 默认禁区必须在（构造器不传 zones 时）
  assert.equal(g.forbiddenPath('~/.lhcd/x'), DEFAULT_READ_ZONES[0]);
  // 内置规则只有 deny、且都带 id（没有 id 就没法在日志里说清是谁拦的）
  for (const r of BUILTIN_DENY_RULES) {
    assert.equal(r.action, 'deny', '内置表只放 deny——它代表"墙"，不是"门"');
    assert.ok(r.id && r.id.length > 0);
  }
});
