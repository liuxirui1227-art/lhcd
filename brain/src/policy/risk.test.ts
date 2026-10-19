// 动作风险分级（内核唯一出处）+ 审批作用域判定单测。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { riskLevelOf, shouldAskForRisk, isMandatoryAsk, RISK_RANK } from './risk.js';

test('风险档：逐类动作落档（判据是"做错了用户能不能自己收拾"）', () => {
  assert.equal(riskLevelOf('read', 'read', { path: 'a.txt' }), 'R0');
  assert.equal(riskLevelOf('web_fetch', 'net', { url: 'https://x' }), 'R0');
  assert.equal(riskLevelOf('remember', 'write', {}), 'R1');
  assert.equal(riskLevelOf('write', 'write', { path: '新文件.txt', content: 'x' }), 'R1');
  assert.equal(riskLevelOf('media', 'write', {}), 'R2');
  assert.equal(riskLevelOf('office', 'write', {}), 'R2');
  assert.equal(riskLevelOf('bash', 'bash', { command: 'ls -la' }), 'R2');
  assert.equal(riskLevelOf('delete', 'write', { path: 'x' }), 'R3');
  assert.equal(riskLevelOf('schedule', 'write', {}), 'R4');
  assert.equal(riskLevelOf('install_mcp', 'net', {}), 'R4');
});

test('风险档：bash 按"这条命令到底动没动盘/联没联网"细分', () => {
  assert.equal(riskLevelOf('bash', 'bash', { command: 'grep -r foo .' }), 'R2');
  assert.equal(riskLevelOf('bash', 'bash', { command: 'rm -rf ./build' }), 'R3');   // 动盘
  assert.equal(riskLevelOf('bash', 'bash', { command: 'echo x > out.txt' }), 'R3'); // 覆写
  assert.equal(riskLevelOf('bash', 'bash', { command: 'git push origin main' }), 'R3');
  assert.equal(riskLevelOf('bash', 'bash', { command: 'curl https://x/y' }), 'R4'); // 对外
  assert.equal(riskLevelOf('bash', 'bash', { command: 'npm install lodash' }), 'R3');
});

test('风险档：app 工具按动作分（任意脚本 = R5）', () => {
  assert.equal(riskLevelOf('app', 'app', { action: 'run', script: 'x' }), 'R5');
  assert.equal(riskLevelOf('app', 'app', { action: 'notify', text: 'hi' }), 'R2');
  assert.equal(riskLevelOf('app', 'app', { action: 'open', target: 'Safari' }), 'R1');
});

test('风险档：未知工具（含外部装进来的）按权限类兜底，宁可保守', () => {
  assert.equal(riskLevelOf('some_mcp_tool', 'read', {}), 'R0');
  assert.equal(riskLevelOf('some_mcp_tool', 'net', {}), 'R4');
  assert.equal(riskLevelOf('some_mcp_tool', 'bash', {}), 'R3');
  assert.equal(riskLevelOf('some_mcp_tool', 'write', {}), 'R3');
});

test('审批作用域：闲聊一律不问（P8），工作只问 R3 及以上', () => {
  // R5 例外，见下一条（强制逐次确认）；这里只验"作用域矩阵"这一半
  for (const r of ['R0', 'R1', 'R2', 'R3', 'R4'] as const) {
    assert.equal(shouldAskForRisk('silent', r), false, `闲聊不该问 ${r}`);
  }
  assert.equal(shouldAskForRisk('askR3', 'R0'), false);
  assert.equal(shouldAskForRisk('askR3', 'R2'), false);
  assert.equal(shouldAskForRisk('askR3', 'R3'), true);
  assert.equal(shouldAskForRisk('askR3', 'R5'), true);
  // 第三档「请求批准」——可逆执行（R2）也问
  assert.equal(shouldAskForRisk('askR2', 'R1'), false);
  assert.equal(shouldAskForRisk('askR2', 'R2'), true);
  assert.equal(shouldAskForRisk('askR2', 'R4'), true);
  assert.ok(RISK_RANK.R5 > RISK_RANK.R3 && RISK_RANK.R3 > RISK_RANK.R2);
});

test('强制逐次确认（2026-09-23 · D 项）：R5 与作用域无关——任何档位都要问', () => {
  assert.equal(isMandatoryAsk('R5'), true);
  for (const r of ['R0', 'R1', 'R2', 'R3', 'R4'] as const) assert.equal(isMandatoryAsk(r), false, `${r} 不该是强制档`);
  // 三档全问：**完全访问（silent）也问** —— 这条是强制档的回归守卫
  for (const scope of ['silent', 'askR3', 'askR2'] as const) {
    assert.equal(shouldAskForRisk(scope, 'R5'), true, `${scope} 档也必须问 R5`);
  }
  // 判据来源：app.run（任意 osascript）= R5 —— 端到端串一遍，防止两边脱节
  assert.equal(riskLevelOf('app', 'app', { action: 'run', script: 'x' }), 'R5');
});
