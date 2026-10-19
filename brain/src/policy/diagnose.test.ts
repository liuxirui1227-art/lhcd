// 规则可达性诊断——"写歪的规则比没有规则更危险"。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diagnoseRules, isRiskyRegex, isTooBroad, MAX_RULES, MAX_RULE_PATTERN } from './diagnose.js';
import { PolicyEngine } from './engine.js';
import { DEFAULT_CONFIG, type PermissionsCfg } from '../config/schema.js';

function perms(over: Partial<PermissionsCfg> = {}): PermissionsCfg {
  return { ...DEFAULT_CONFIG.permissions, ...over };
}

test('健康规则表 → 无告警（默认配置本身要干净）', () => {
  assert.deepEqual(diagnoseRules(perms()), []);
});

test('正则写错 → 指出来并给修法', () => {
  const issues = diagnoseRules(perms({ rules: [{ id: 'bad', tool: 'bash', match: '([', action: 'ask' }] }));
  assert.equal(issues.length, 1);
  assert.equal(issues[0]!.kind, 'invalid-regex');
  assert.ok(issues[0]!.fix.length > 0);
});

test('被更早的兜底规则挡死 → 指出来（这类最容易被忽略）', () => {
  const issues = diagnoseRules(perms({
    rules: [
      { id: 'catch-all', tool: 'bash', match: '.*', action: 'ask' },
      { id: 'later', tool: 'bash', match: '^git ', action: 'allow' },
    ],
  }));
  assert.equal(issues.length, 1);
  assert.equal(issues[0]!.ruleId, 'later');
  assert.equal(issues[0]!.kind, 'shadowed');
  assert.ok(issues[0]!.message.includes('catch-all'));
  assert.ok(issues[0]!.fix.includes('前面'));
});

test('工具名不存在 → 指出来并列出可用工具', () => {
  const issues = diagnoseRules(perms({ rules: [{ id: 'typo', tool: 'bas', match: '^ls', action: 'allow' }] }), { tools: ['bash', 'read'] });
  assert.equal(issues.length, 1);
  assert.equal(issues[0]!.kind, 'unknown-tool');
  assert.ok(issues[0]!.fix.includes('bash'));
});

test('重复的两条兜底：第二条会被指出是死条目', () => {
  const issues = diagnoseRules(perms({
    rules: [
      { id: 'c1', tool: 'bash', match: '.*', action: 'ask' },
      { id: 'c2', tool: 'bash', match: '^.*', action: 'allow' },
    ],
  }));
  assert.equal(issues.length, 1);
  assert.equal(issues[0]!.ruleId, 'c2');
});

test('条 19③：拒绝时带"换个办法"（模型据此换路子，不傻站）', () => {
  const p = new PolicyEngine(perms({ autonomy: 'auto' }));
  const d = p.check('bash', 'bash', { command: 'rm -rf build' });
  assert.equal(d.action, 'deny');
  assert.ok(d.alternative && d.alternative.length > 0, '硬拒必须给替代路子');
  const zone = new PolicyEngine(perms({ readZones: ['~/.lhcd'] }), { home: '/Users/me', cwd: '/Users/me' });
  const dz = zone.check('read', 'read', { path: '~/.lhcd/data/state.json' });
  assert.equal(dz.action, 'deny');
  assert.ok(dz.alternative && dz.alternative.length > 0, '禁区拒绝也要给替代路子');
});

// ---------- ReDoS 粗筛 + 三处上限 + 过宽 ----------

test('ReDoS：嵌套量词直接跳过，并在体检里说清"为什么它不会加载"', () => {
  assert.equal(isRiskyRegex('(a+)+'), true);
  assert.equal(isRiskyRegex('^(\\s*)*$'), true);
  assert.equal(isRiskyRegex('(.*)*'), true);
  // 不该误伤的：单个量词、字符类、交替
  assert.equal(isRiskyRegex('^git '), false);
  assert.equal(isRiskyRegex('(a|b)*'), false);
  assert.equal(isRiskyRegex('^[a-z]+\\s'), false);
  assert.equal(isRiskyRegex(DEFAULT_CONFIG.permissions.rules[1]!.match), false, '默认 r2 不能被误判');

  const p = perms({ rules: [{ id: 'bad', tool: 'bash', match: '(a+)+$', action: 'deny' }] });
  const issues = diagnoseRules(p);
  assert.equal(issues.some((i) => i.kind === 'redos' && i.ruleId === 'bad'), true);
  // 引擎侧同一判据：跳过它（不然一条正则能把回合挂死）
  const eng = new PolicyEngine(p, { home: '/Users/me', cwd: '/Users/me/proj' });
  assert.notEqual(eng.check('bash', 'bash', { command: 'aaaaaaaaaaaaaaaaaaaaaa!' }).ruleId, 'bad');
});

test('三处上限（条 5⑤）：条数 / 单条长度 / 总量，超了要说出来', () => {
  const many = perms({ rules: Array.from({ length: MAX_RULES + 1 }, (_, i) => ({ id: `r${i}`, tool: 'bash', match: `^cmd${i} `, action: 'ask' as const })) });
  assert.equal(diagnoseRules(many).some((i) => i.kind === 'too-many'), true);

  const longPat = perms({ rules: [{ id: 'long', tool: 'bash', match: `^${'x'.repeat(MAX_RULE_PATTERN + 1)}`, action: 'ask' }] });
  assert.equal(diagnoseRules(longPat).some((i) => i.kind === 'too-long'), true);

  const fat = perms({
    // 30 条 × 每条约 410 字符 ≈ 12KB > 8KB 总量上限（**每一条单独都不超长**，所以只有总量这条能报出来）
    rules: Array.from({ length: 30 }, (_, i) => ({ id: `f${i}`, tool: 'bash', match: `^cmd${i}${'y'.repeat(400)}`, action: 'ask' as const })),
  });
  assert.equal(diagnoseRules(fat).some((i) => i.kind === 'too-long'), true, '总量超 8KB 也要报');
});

test('过宽规则（条 19⑤）：没锚定 + 短 → 指出来（这正是"规则把正功能也拦了"的成因）', () => {
  assert.equal(isTooBroad('build'), true);
  assert.equal(isTooBroad('^npm run build'), false, '锚定的不算');
  assert.equal(isTooBroad('.*'), false, '兜底规则是故意的');
  const p = perms({ rules: [{ id: 'wide', tool: 'bash', match: 'build', action: 'deny' }] });
  const issues = diagnoseRules(p);
  assert.equal(issues.some((i) => i.kind === 'too-broad' && i.ruleId === 'wide'), true);
  // allow 类不报（它宽一点只是放行多，不构成"拦住正功能"）
  const allowWide = perms({ rules: [{ id: 'wide2', tool: 'bash', match: 'build', action: 'allow' }] });
  assert.equal(diagnoseRules(allowWide).some((i) => i.kind === 'too-broad'), false);
});
