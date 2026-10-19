// 「总是允许」安全阀。成对用例：该拒绝提议的 / 该正常提议的。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BANNED_PREFIXES, proposePrefixRule } from './suggest.js';
import { PolicyEngine } from './engine.js';
import { DEFAULT_CONFIG, type PermissionsCfg } from '../config/schema.js';

function perms(over: Partial<PermissionsCfg> = {}): PermissionsCfg {
  return { ...DEFAULT_CONFIG.permissions, ...over };
}

test('闸一：禁提前缀一律不给提议（允许它等于允许一切）', () => {
  for (const cmd of ['bash', "bash -c 'ls'", 'sh -lc "x"', 'sudo ls', 'env FOO=1 ls', 'python3 x.py', 'node -e 1', 'osascript -e 1', 'rm x.txt', 'npm test', 'git status']) {
    const r = proposePrefixRule(cmd, perms());
    assert.equal(r.ok, false, `不应提议: ${cmd}`);
    if (!r.ok) assert.ok(r.reason.length > 0);
  }
  // 清单本身抽查
  for (const p of ['bash', 'sudo', 'env', 'rm', 'python3', 'git', 'npm']) assert.ok(BANNED_PREFIXES.has(p), p);
});

test('闸二：普通只读命令 → 给出锚定在开头的精确规则', () => {
  const r = proposePrefixRule('cat notes.txt', perms({ autonomy: 'auto' }));
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.rule.action, 'allow');
    assert.ok(r.rule.match.startsWith('^cat'));
    assert.deepEqual(r.covers, ['cat notes.txt']);
  }
});

test('闸二：试装验证——规则须覆盖整条命令的每一段，否则不给提议', () => {
  // 第一段是 ls（可提议的头），但第二段 curl 不在 ls 的规则覆盖内
  const r = proposePrefixRule('ls && curl http://x', perms({ autonomy: 'auto' }));
  assert.equal(r.ok, false);
  if (!r.ok) assert.ok(r.reason.includes('curl'));
});

test('闸二：结构不可信（重定向/变量）→ 不给提议', () => {
  for (const cmd of ['echo x > /tmp/f', 'echo $HOME', 'ls $(ls)']) {
    const r = proposePrefixRule(cmd, perms({ autonomy: 'auto' }));
    assert.equal(r.ok, false, `不应提议: ${cmd}`);
  }
});

test('闸二：命令里含危险成分（强制删除）→ 不给提议', () => {
  const r = proposePrefixRule('ls && rm -rf x', perms({ autonomy: 'auto' }));
  assert.equal(r.ok, false);
});

test('提议出来的规则确实精确：装进引擎后只放行这一条，不越权到同头不同参', () => {
  const cfg = perms({ autonomy: 'auto' });
  const r = proposePrefixRule('cat notes.txt', cfg);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.rules[0]!.id, r.rule.id); // 新规则在最前（否则会被 r4 挡在前面永不生效）
  const engine = new PolicyEngine({ ...cfg, rules: r.rules });
  assert.equal(engine.check('bash', 'bash', { command: 'cat notes.txt' }).ruleId, r.rule.id);
  // 同头不同参：不归这条规则管（走回默认判定），说明规则是精确的而不是"放行 cat 一切"
  assert.notEqual(engine.check('bash', 'bash', { command: 'cat /etc/hosts' }).ruleId, r.rule.id);
});

test('新规则插到最前也压不过硬底线（禁区/危险命令先于一切规则）', () => {
  const cfg = perms({ autonomy: 'auto', readZones: ['~/.lhcd'] });
  const engine = new PolicyEngine(
    { ...cfg, rules: [{ id: 'evil-allow', tool: '*', match: '.*', action: 'allow' }, ...cfg.rules] },
    { home: '/Users/me', cwd: '/Users/me/proj' },
  );
  assert.equal(engine.check('read', 'read', { path: '~/.lhcd/data/state.json' }).action, 'deny');
  assert.equal(engine.check('bash', 'bash', { command: 'rm -rf /' }).action, 'deny');
});
