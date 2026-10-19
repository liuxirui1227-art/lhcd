// 策略引擎单测：硬性 deny / 规则首条命中 / 默认值 / auto 模式 / app 白名单与信任模式。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PolicyEngine } from './engine.js';
import { isHardDenied } from './deny.js';
import { DEFAULT_CONFIG, type PermissionsCfg, type PolicyRule } from '../config/schema.js';

function perms(over: Partial<PermissionsCfg> = {}): PermissionsCfg {
  return { ...DEFAULT_CONFIG.permissions, ...over };
}

test('硬性 deny 表：危险命令一律拒绝（不可覆盖）', () => {
  for (const cmd of [
    'rm -rf /',
    'rm -rf /*',
    'sudo rm -rf /',
    'mkfs.ext4 /dev/sda1',
    'dd if=/dev/zero of=/dev/sda',
    'shutdown now',
    'reboot',
    'poweroff',
    'halt',
    ':(){ :|:& };:',
    'echo x > /dev/sda',
    'chmod 777 /',
  ]) {
    assert.equal(isHardDenied(cmd).denied, true, `应拦截: ${cmd}`);
  }
  assert.equal(isHardDenied('rm -rf build/').denied, false); // 非根目录不硬拦（走 ask/规则）
});

test('硬性 deny 先于一切（即使 auto 模式 + 放行规则）', () => {
  const auto = new PolicyEngine(perms({ autonomy: 'auto', rules: [{ id: 'allow-all', tool: 'bash', match: '.*', action: 'allow' }] }));
  const d = auto.check('bash', 'bash', { command: 'rm -rf /' });
  assert.equal(d.action, 'deny');
  assert.equal(d.ruleId, 'hard-deny');
});

test('用户规则首条命中生效', () => {
  const p = new PolicyEngine(perms({
    rules: [
      { id: 'r-git', tool: 'bash', match: '^git ', action: 'allow' },
      { id: 'r-rest', tool: 'bash', match: '.*', action: 'ask' },
    ],
  }));
  assert.equal(p.check('bash', 'bash', { command: 'git status' }).action, 'allow');
  assert.equal(p.check('bash', 'bash', { command: 'npm install x' }).action, 'ask');
});

test('默认值：bash=ask，read=allow；无规则命中且 defaults=deny → deny', () => {
  const p = new PolicyEngine(perms());
  assert.equal(p.check('read', 'read', { path: 'a' }).action, 'allow');
  assert.equal(p.check('bash', 'bash', { command: 'npm install x' }).action, 'ask'); // 默认规则 r3 兜底 ask
  const noDefault = new PolicyEngine(perms({ rules: [], defaults: { ...perms().defaults, bash: 'deny' } }));
  assert.equal(noDefault.check('bash', 'bash', { command: 'npm install x' }).action, 'deny');
});

test('auto 模式：安全 bash 放行；破坏性写仍 ask；read/write/net/internal 放行', () => {
  const p = new PolicyEngine(perms({ autonomy: 'auto' }));
  assert.equal(p.check('bash', 'bash', { command: 'git status' }).action, 'allow');
  assert.equal(p.check('bash', 'bash', { command: 'npm test' }).action, 'allow');
  // 带 force 的 rm 一律硬拒（强制删除没有安全用法）
  assert.equal(p.check('bash', 'bash', { command: 'rm -rf build' }).action, 'deny');
  // 删除类命令**一律改道**到 delete 工具（进回收站，可撤回）——
  // 这不是"询问"，是"换条路"：用户能接受 TA 改错，不能接受删掉。
  assert.equal(p.check('bash', 'bash', { command: 'rm -r build' }).action, 'deny');
  assert.equal(p.check('bash', 'bash', { command: 'rm build/x.o' }).action, 'deny');
  const rmSoft = p.check('bash', 'bash', { command: 'rm build/x.o' });
  assert.match(String(rmSoft.warning ?? '') + String(rmSoft.alternative ?? ''), /回收站|delete/);
  assert.equal(p.check('bash', 'bash', { command: 'curl http://x' }).action, 'ask');   // 非安全 bash
  assert.equal(p.check('read', 'read', { path: 'a' }).action, 'allow');
  assert.equal(p.check('write', 'write', { path: 'a', content: 'x' }).action, 'allow');
});

test('条 27：安全前缀不再罩住后续命令（分段取最严）；套壳仍能识别', () => {
  const auto = new PolicyEngine(perms({ autonomy: 'auto' }));
  // 洞的正面：以前 `git status && …` 因 startsWith 命中安全前缀被整条放行
  assert.equal(auto.check('bash', 'bash', { command: 'git status' }).action, 'allow');
  assert.equal(auto.check('bash', 'bash', { command: 'git status && rm -rf xxx' }).action, 'deny');
  assert.equal(auto.check('bash', 'bash', { command: 'git status && curl http://x' }).action, 'ask');
  assert.equal(auto.check('bash', 'bash', { command: 'git status && git log' }).action, 'allow'); // 多段全安全 → 仍放行
  // 套壳：剥开后再判（`bash -c 'rm -rf /'` 以前因引号躲过正则锚点）
  assert.equal(auto.check('bash', 'bash', { command: "bash -c 'rm -rf /'" }).action, 'deny');
  assert.equal(auto.check('bash', 'bash', { command: 'sudo rm -rf xxx' }).action, 'deny');
  assert.equal(auto.check('bash', 'bash', { command: 'env X=1 rm -rf xxx' }).action, 'deny');
  assert.equal(auto.check('bash', 'bash', { command: 'nohup rm -rf xxx &' }).action, 'deny');
  // 解释器内联代码内容不可见 → 不进快速放行（python3 前缀在清单里也不放）
  assert.equal(auto.check('bash', 'bash', { command: "python3 -c 'print(1)'" }).action, 'ask');
  // 重定向/变量 = 说不清 → 退回原文匹配，绝不放行
  assert.equal(auto.check('bash', 'bash', { command: 'echo x > /tmp/f' }).action, 'ask');
  assert.equal(auto.check('bash', 'bash', { command: 'echo $HOME' }).action, 'ask');
});

test('app 白名单模式：白名单内放行，名单外 ask', () => {
  const p = new PolicyEngine(perms({ app: { mode: 'whitelist', whitelist: ['Calendar', 'Notes'] } }));
  assert.equal(p.check('app', 'app', { action: 'open', target: 'Calendar' }).action, 'allow');
  assert.equal(p.check('app', 'app', { action: 'open', target: 'Terminal' }).action, 'ask');
  assert.equal(p.check('app', 'app', { action: 'run', script: 'x' }).action, 'ask'); // 无 target
});

test('app 信任模式：放行并带警告', () => {
  const p = new PolicyEngine(perms({ app: { mode: 'trusted', whitelist: [] } }));
  const d = p.check('app', 'app', { action: 'open', target: 'Terminal' });
  assert.equal(d.action, 'allow');
  assert.ok(d.warning?.includes('信任模式'));
});

test('低风险只读命令免审（011-A1 r4）：ls/cat/grep 等放行；元字符拼接/重定向仍 ask', () => {
  const p = new PolicyEngine(perms()); // 默认规则：r1 git allow / r2 deny / r4 只读 allow / r3 ask
  for (const cmd of ['ls -la', 'cat package.json', 'head -5 a.txt', 'tail -f log', 'grep -r foo src', 'wc -l a.txt', 'pwd', 'date', 'echo hello', 'cat a.txt b.txt']) {
    assert.equal(p.check('bash', 'bash', { command: cmd }).action, 'allow', `应免审放行: ${cmd}`);
  }
  // 命令注入/绕过防御：分隔符、命令替换、重定向、find 一律绝不 allow（回审批通道或被硬拒绝）
  for (const cmd of [
    'cat a.txt | sudo tee x',    // 管道
    'echo x > /tmp/f',           // 重定向写
    'ls $(rm -rf x)',            // $() 命令替换
    'ls `rm -rf x`',             // 反引号替换
    'cat a.txt & rm -rf x',      // 后台拼接
    'find . -name x',            // find 不进白名单（-exec/-delete 攻击面）
    'cat a.txt\nrm -rf x',       // 换行拼接
  ]) {
    assert.notEqual(p.check('bash', 'bash', { command: cmd }).action, 'allow', `应拦截绕过: ${cmd}`);
  }
  assert.equal(p.check('bash', 'bash', { command: 'cat a.txt; rm -rf x' }).action, 'deny'); // 分号拼接 rm -rf → 硬拒绝先拦
  // 危险命令仍被 deny 先拦
  assert.equal(p.check('bash', 'bash', { command: 'rm -rf /' }).action, 'deny');
  // 其余 bash 仍 ask
  assert.equal(p.check('bash', 'bash', { command: 'npm install x' }).action, 'ask');
});

test('app 分级模型（蓝图 9.5）：高风险必须逐次确认，信任模式也不例外', () => {
  const trusted = new PolicyEngine(perms({ app: { mode: 'trusted', whitelist: [] } }));
  const d = trusted.check('app', 'app', { action: 'run', script: 'x' });
  assert.equal(d.action, 'ask');
  assert.equal(d.ruleId, 'app-high-risk');
  assert.ok(d.warning?.includes('高风险'));

  // 白名单内的高风险动作同样拦截（白名单只放行执行级）
  const wl = new PolicyEngine(perms({ app: { mode: 'whitelist', whitelist: ['Terminal'] } }));
  assert.equal(wl.check('app', 'app', { action: 'run', script: 'x', target: 'Terminal' }).action, 'ask');
  assert.equal(wl.check('app', 'app', { action: 'open', target: 'Terminal' }).action, 'allow');
});

test('app 分级模型：观察级/执行级在信任模式下照常放行（仅高风险例外）', () => {
  const p = new PolicyEngine(perms({ app: { mode: 'trusted', whitelist: [] } }));
  assert.equal(p.check('app', 'app', { action: 'clipboard' }).action, 'allow'); // 观察级
  assert.equal(p.check('app', 'app', { action: 'calendar', title: 't', date: '2026-08-23 10:00' }).action, 'allow'); // 执行级
  assert.equal(p.check('app', 'app', { action: 'notify', text: 'a|b' }).action, 'allow');
});

// ---------- **每一个拒绝出口**都要说得出"为什么 + 换个办法" ----------
// 主路径（策略 deny）有 alternative，其余出口也要有——
// 模型只收到"policy 拒绝了（u1）"这种内部码时，它只能瞎猜或卡住。

test('条 19③：四个拒绝出口都带 warning + alternative', () => {
  const p = new PolicyEngine(perms());

  // ① 原文模式类硬拒（deny.ts 的 HARD_DENY：这几条走的是"整条原文匹配"，不是分段逐层）
  const raw = p.check('bash', 'bash', { command: 'shutdown now' });
  assert.equal(raw.action, 'deny');
  assert.ok(raw.warning, '硬拒要说为什么');
  assert.ok(raw.alternative, '硬拒要给路子');

  // ② 嵌套过深
  const deep = p.check('bash', 'bash', { command: `${'sudo '.repeat(9)}rm -rf x` });
  assert.equal(deep.action, 'deny');
  assert.ok(deep.alternative, '嵌套过深也要给路子');

  // ③ 用户规则 deny（以前只回一个规则 id）
  const ruled = new PolicyEngine(perms({
    defaults: { ...DEFAULT_CONFIG.permissions.defaults, bash: 'allow' },
    rules: [{ id: 'u1', tool: 'bash', match: '^curl ', action: 'deny' }],
  }));
  const byRule = ruled.check('bash', 'bash', { command: 'curl http://x' });
  assert.equal(byRule.action, 'deny');
  assert.equal(byRule.ruleId, 'u1');
  assert.match(String(byRule.warning), /u1/, '要说清是被哪条规则拦的');
  assert.ok(byRule.alternative, '规则拒也要给路子');
});

// ---------- auto 档的两处真漏 ----------

test('auto 档不再跳过"收紧类"规则：用户写的 deny 在哪个档位都算数', () => {
  const rules: PolicyRule[] = [{ id: 'u-deny', tool: 'bash', match: '^curl ', action: 'deny' }, ...DEFAULT_CONFIG.permissions.rules];
  const auto = new PolicyEngine(perms({ autonomy: 'auto', rules }));
  const inter = new PolicyEngine(perms({ rules }));
  assert.equal(auto.check('bash', 'bash', { command: 'curl http://x' }).ruleId, 'u-deny', 'auto 档也要拒');
  assert.equal(inter.check('bash', 'bash', { command: 'curl http://x' }).ruleId, 'u-deny');
  // 但 `ask` 类规则在 auto 档仍然让路（否则 auto 就没意义了：默认那条 `.* → ask` 会罩住一切）
  assert.equal(auto.check('bash', 'bash', { command: 'curl http://x' }).ruleId !== 'r3', true);
});

test('auto 安全前缀收窄：跑"刚写下的那个文件"不再自动放行', () => {
  const auto = new PolicyEngine(perms({ autonomy: 'auto' }));
  for (const cmd of ['python3 evil.py', 'node evil.js', 'make install', 'find . -delete']) {
    assert.notEqual(auto.check('bash', 'bash', { command: cmd }).ruleId, 'auto-safe-bash', `${cmd} 不该进快速放行`);
  }
  // 该留的还留着：只读 + 跑这个项目既有的测试
  for (const cmd of ['git status', 'ls -la', 'cat notes.txt', 'npm test', 'npx vitest run']) {
    assert.equal(auto.check('bash', 'bash', { command: cmd }).action, 'allow', `${cmd} 应照常放行`);
  }
});

test('默认 deny 规则锚在命令位置：提到 rm -rf 的只读命令不误伤', () => {
  // 这条在 auto 档放行 deny 类规则之后才暴露出来：裸子串会把"打印/查找"一起拒掉
  for (const cmd of ['echo "rm -rf x"', 'grep "rm -rf" log.txt']) {
    assert.equal(autoOf().check('bash', 'bash', { command: cmd }).action, 'allow', `${cmd} 不该被拒`);
  }
  // 真危险的位置照样拒
  assert.equal(autoOf().check('bash', 'bash', { command: 'rm -rf build' }).action, 'deny');
  assert.equal(autoOf().check('bash', 'bash', { command: 'cd x && rm -rf y' }).action, 'deny');
});

function autoOf() {
  return new PolicyEngine(perms({ autonomy: 'auto' }));
}

// ---------- auto 档与用户规则的关系 ----------

test('auto 档：内置 ask 兜底让路，用户自己写的规则一律照办（deny 与 ask 都是）', () => {
  const builtinAuto = new PolicyEngine(perms({ autonomy: 'auto' }));
  // 内置那条 `.* → ask`（r3）让路 → 落到 auto 分支（安全前缀放行 / 其余 ask，但不带 r3 的名字）
  assert.notEqual(builtinAuto.check('bash', 'bash', { command: 'curl http://x' }).ruleId, 'r3');
  assert.equal(builtinAuto.check('bash', 'bash', { command: 'git status' }).action, 'allow');

  const userRules: PolicyRule[] = [
    { id: 'u-deny', tool: 'bash', match: '^curl ', action: 'deny' },
    { id: 'u-ask', tool: 'bash', match: '^npm publish', action: 'ask' },
    ...DEFAULT_CONFIG.permissions.rules,
  ];
  const auto = new PolicyEngine(perms({ autonomy: 'auto', rules: userRules }));
  assert.equal(auto.check('bash', 'bash', { command: 'curl http://x' }).ruleId, 'u-deny', 'deny 任何档位都算数');
  assert.equal(auto.check('bash', 'bash', { command: 'npm publish' }).ruleId, 'u-ask', '用户写的 ask 也不许被 auto 吞掉');
  // 而"用户没写过"的普通命令，auto 照旧自己拿主意（不然 auto 就没意义了）
  assert.equal(auto.check('bash', 'bash', { command: 'git status' }).ruleId, 'r1');
});

/* ---------- 看屏幕（screen 权限类） ---------- */
// 口径（写死在测试里，改之前先想清楚）：
//   ① 用户在场按的按钮 → 走规则/默认档（默认 ask = 弹一次卡说明"画面会离开本机"）；
//   ② 无人值守（定时观察/心跳）且**没开开关** → 代码级底线直接拒，**写 allow 规则也压不住**；
//   ③ 无人值守但用户开了开关 → 开关即授权，放行（每次截取仍进链）；
//   ④ 用户写 `screen → deny` → 一律不看（按钮也不行）—— 规则只能更严。
test('看屏幕①：用户在场上按的 → 默认问一次（不是默默看）', () => {
  const p = new PolicyEngine(perms());
  const d = p.check('screen', 'screen', { source: 'button' });
  assert.equal(d.action, 'ask');
  assert.equal(d.ruleId, 'default:screen');
});

test('看屏幕②：无人值守 + 没开开关 → 底线拒（allow 规则也压不住）', () => {
  const p = new PolicyEngine(perms({ rules: [{ id: 'allow-screen', tool: 'screen', match: '.*', action: 'allow' }] }));
  const d = p.check('screen', 'screen', { source: 'watch', unattended: true, preApproved: false });
  assert.equal(d.action, 'deny');
  assert.equal(d.ruleId, 'screen-unattended');
  assert.ok(d.alternative, '拒绝要给替代路子（条 19③）');
});

test('看屏幕③：无人值守 + 开了开关 → 开关即授权，放行', () => {
  const p = new PolicyEngine(perms());
  const d = p.check('screen', 'screen', { source: 'watch', unattended: true, preApproved: true });
  assert.equal(d.action, 'allow');
  assert.equal(d.ruleId, 'screen-preapproved');
});

test('看屏幕④：用户写 screen → deny → 一律不看（按钮也不例外）', () => {
  const p = new PolicyEngine(perms({ rules: [{ id: 'no-screen', tool: 'screen', match: '.*', action: 'deny' }] }));
  assert.equal(p.check('screen', 'screen', { source: 'button' }).action, 'deny');
  assert.equal(p.check('screen', 'screen', { source: 'watch', unattended: true, preApproved: true }).action, 'deny');
});

/* ---------- 读"从外面拿来的东西"先问一句 ---------- */
// 口径：只对**外部来源目录**（默认 ~/Downloads）开口；授权按**文件**给（换个新文件再问一次）。
test('读下载目录里的文件 → 问一次，且授权按文件给', () => {
  const p = new PolicyEngine(perms(), { home: '/Users/demo' });
  const d = p.check('read', 'read', { path: '/Users/demo/Downloads/供应商合同.docx' });
  assert.equal(d.action, 'ask');
  assert.equal(d.ruleId, 'outside-source-read');
  assert.equal(d.grantKey, 'read:/Users/demo/Downloads/供应商合同.docx', '授权键 = 这一份文件');
  assert.ok(d.alternative, '要给出路（条 19③）');
});

test('读自己的文件不打扰（这条最容易做成烦人）', () => {
  const p = new PolicyEngine(perms(), { home: '/Users/demo' });
  assert.equal(p.check('read', 'read', { path: '/Users/demo/Documents/周报.md' }).action, 'allow');
  assert.equal(p.check('read', 'read', { path: '/Users/demo/Desktop/笔记.md' }).action, 'allow');
  // 写自己的文件也不受影响（这条只读）
  assert.equal(p.check('write', 'write', { path: '/Users/demo/Documents/新.md', content: 'x' }).action, 'allow');
});

test('用户写 read → deny：下载目录里的东西一律不读', () => {
  const p = new PolicyEngine(perms({ rules: [{ id: 'no-dl', tool: 'read', match: '.*', action: 'deny' }] }), { home: '/Users/demo' });
  assert.equal(p.check('read', 'read', { path: '/Users/demo/Downloads/x.pdf' }).action, 'deny');
});

test('可以换成别的外部来源目录（配置说了算）', () => {
  const p = new PolicyEngine(perms({ externalSourceDirs: ['~/邮件附件'] }), { home: '/Users/demo' });
  assert.equal(p.check('read', 'read', { path: '/Users/demo/邮件附件/a.docx' }).action, 'ask');
  assert.equal(p.check('read', 'read', { path: '/Users/demo/Downloads/b.docx' }).action, 'allow', '换了名单就不该再问下载目录');
});
