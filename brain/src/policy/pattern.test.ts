// 参数级 / glob 规则语言
// 判据（都写死在测试里，改之前先想清楚）：
//   ① `*` **不跨** `/`、`**` 跨、`?` 一个字符、`~/` 按家目录展开、大小写敏感；
//   ② **零迁移**：不含参数级写法的 `match` 仍按老语义（正则跑在 `工具 + JSON.stringify(参数)` 上）；
//   ③ **值要全匹配**：数组参数里只要有一个不在范围内，这条规则就不算命中；
//   ④ 写歪的参数级写法（`write(path ~/x)`）要被**认出来是坏的**，不能当成永不命中的正则悄悄死掉。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PolicyEngine } from './engine.js';
import { expandHome, globToRegExp, isParamRule, paramRuleHits, parseRuleMatch, toolMatches, validateParamRule } from './pattern.js';
import { DEFAULT_CONFIG, type PermissionsCfg, type PolicyRule } from '../config/schema.js';

const OPTS = { home: '/Users/demo', cwd: '/Users/demo' };
const perms = (rules: PolicyRule[], over: Partial<PermissionsCfg> = {}): PermissionsCfg =>
  ({ ...DEFAULT_CONFIG.permissions, rules, ...over });
const engine = (rules: PolicyRule[]) => new PolicyEngine(perms(rules), OPTS);

/* ---------- glob 语义 ---------- */
test('glob：`*` 不跨目录，`**` 跨目录', () => {
  const one = globToRegExp('/Users/demo/Documents/*');
  assert.equal(one.test('/Users/demo/Documents/报表.md'), true);
  assert.equal(one.test('/Users/demo/Documents/工作/报表.md'), false, '`*` 不许跨目录');
  const two = globToRegExp('/Users/demo/Documents/**');
  assert.equal(two.test('/Users/demo/Documents/工作/报表.md'), true);
  assert.equal(two.test('/Users/demo/Documents/'), true);
  assert.equal(two.test('/Users/demo/Downloads/x.md'), false, '不许越出范围');
});

test('glob：`?` 一个字符；大小写敏感；正则元字符按字面', () => {
  assert.equal(globToRegExp('/a/b?.md').test('/a/b1.md'), true);
  assert.equal(globToRegExp('/a/b?.md').test('/a/b12.md'), false);
  assert.equal(globToRegExp('/Users/demo/documents/**').test('/Users/demo/Documents/x'), false, '大小写敏感（写错由体检指出）');
  assert.equal(globToRegExp('/a/b.md').test('/a/bXmd'), false, '`.` 是字面点，不是通配');
});

test('`~/` 按家目录展开（换台机器也对）', () => {
  assert.equal(expandHome('~/Documents/**', '/Users/demo'), '/Users/demo/Documents/**');
  assert.equal(expandHome('~', '/Users/demo'), '/Users/demo');
  assert.equal(expandHome('/abs/path', '/Users/demo'), '/abs/path');
  const p = parseRuleMatch('write(path: ~/Documents/**)', { home: '/Users/demo', tool: 'write' });
  assert.equal(p.kind, 'param');
  assert.equal((p as { pattern: string }).pattern, '/Users/demo/Documents/**');
});

test('工具字段支持 `*` 模式（`mcp.*` 罩住所有外部服务）', () => {
  assert.equal(toolMatches('mcp.*', 'mcp.github.echo'), true);
  assert.equal(toolMatches('mcp.*', 'mcp'), false);
  assert.equal(toolMatches('*', 'anything'), true);
  assert.equal(toolMatches('write', 'writer'), false, '精确名不做前缀匹配');
});

/* ---------- 值要全匹配（数组参数） ---------- */
test('★ 数组参数要每一个都落在模式里（"一部分在范围内"不算数）', () => {
  const p = parseRuleMatch('delete(paths: ~/Documents/**)', { home: '/Users/demo', tool: 'delete' });
  assert.equal(p.kind, 'param');
  const rule = p as never as Parameters<typeof paramRuleHits>[0];
  assert.equal(paramRuleHits(rule, 'delete', { paths: ['/Users/demo/Documents/a', '/Users/demo/Documents/b'] }, { home: '/Users/demo' }), true);
  assert.equal(paramRuleHits(rule, 'delete', { paths: ['/Users/demo/Documents/a', '/etc/passwd'] }, { home: '/Users/demo' }), false,
    '有一个越界就不算命中——这正是"只许改 Documents"会被绕过的地方');
  assert.equal(paramRuleHits(rule, 'delete', { paths: [] }, { home: '/Users/demo' }), false);
});

/* ---------- 零迁移 ---------- */
test('★ 零迁移：老正则规则行为一字不变（含 `(` 的正则也必须照旧）', () => {
  const old = [
    { id: 'r4-like', tool: 'bash', match: '^(ls|cat|echo)(\\s|$)', action: 'allow' as const },
    { id: 'git', tool: 'bash', match: '^git ', action: 'allow' as const },
  ];
  const e = engine(old);
  assert.equal(e.check('bash', 'bash', { command: 'ls -la' }).action, 'allow');
  assert.equal(e.check('bash', 'bash', { command: 'echo hi' }).action, 'allow');
  assert.equal(e.check('bash', 'bash', { command: 'git status' }).action, 'allow');
  assert.notEqual(e.check('bash', 'bash', { command: 'rm -rf build' }).action, 'allow', '老语义下别的照旧问/拒');
});

test('写歪的参数级写法被认出来是坏的（不是"永不命中的正则"）', () => {
  const bad = parseRuleMatch('write(path ~/Documents/**)', { home: '/Users/demo', tool: 'write' });
  assert.equal(bad.kind, 'bad');
  assert.match((bad as { fix: string }).fix, /write\(path: ~\/Documents\/\*\*\)/);
  assert.equal(isParamRule('write(path ~/x)'), true, '看起来像参数级写法 = 以 名字( 开头');
  assert.equal(isParamRule('^(ls|cat)(\\s|$)'), false, '老正则不以 名字( 开头，不该被误判');
});

/* ---------- 装进引擎：真的能管住 ---------- */
test('★ 参数级规则：放行范围内的写，范围外照旧问', () => {
  /* ⚠ 要把 write 的**默认档设成 ask**：默认 defaults.write = allow（"不设边界"那个产品前提），
     不然"范围外"会落到默认档直接放行，验不到规则的边界。 */
  const e = new PolicyEngine(perms(
    [{ id: 'doc', tool: 'write', match: 'write(path: ~/Documents/**)', action: 'allow' }],
    { defaults: { ...DEFAULT_CONFIG.permissions.defaults, write: 'ask' } },
  ), OPTS);
  assert.equal(e.check('write', 'write', { path: '/Users/demo/Documents/工作/报表.md', content: 'x' }).action, 'allow');
  assert.equal(e.check('write', 'write', { path: '/Users/demo/Downloads/x.md', content: 'x' }).action, 'ask', '范围外要照旧问');
  assert.equal(e.check('edit', 'write', { path: '/Users/demo/Documents/a.md' }).action, 'ask', '工具对不上不命中');
});

test('参数级规则也能收紧（deny 范围外的落点）', () => {
  const e = engine([{ id: 'no-etc', tool: 'write', match: 'write(path: /etc/**)', action: 'deny' }]);
  assert.equal(e.check('write', 'write', { path: '/etc/hosts', content: 'x' }).action, 'deny');
  assert.notEqual(e.check('write', 'write', { path: '/Users/demo/a.md', content: 'x' }).action, 'deny');
});

test('★ 参数级规则压不过内置底线（墙只许加高）', () => {
  const e = engine([
    { id: 'allow-all-writes', tool: 'write', match: 'write(path: /**)', action: 'allow' },
    { id: 'allow-bash', tool: 'bash', match: 'bash(cmd: **)', action: 'allow' },
  ]);
  assert.equal(e.check('bash', 'bash', { command: 'rm -rf /' }).action, 'deny', '危险命令是代码级底线');
  assert.equal(e.check('read', 'read', { path: '/Users/demo/.lhcd/data/state.json' }).action, 'deny', '禁区是代码级底线');
});

test('validateParamRule：不给"什么都能干"的写法（设置页那颗按钮的判据）', () => {
  assert.equal(validateParamRule({ id: 'a', tool: 'write', match: 'write(path: ~/Documents/**)', action: 'allow' }).ok, true);
  const bare = validateParamRule({ id: 'b', tool: 'write', match: 'write(path: /**)', action: 'allow' });
  assert.equal(bare.ok, false);
  assert.match((bare as { reason: string }).reason, /什么都能干/);
  const mismatch = validateParamRule({ id: 'c', tool: 'write', match: 'bash(cmd: git *)', action: 'allow' });
  assert.equal(mismatch.ok, false, 'tool 字段与括号里写的对不上要报出来');
});
