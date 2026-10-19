// 「记忆不出本机」——两半都在这条测试里：
//   ① **出站**：她替你发出去的内容里出现私密材料 → 不发（而且是代码判据，档位关不掉）；
//   ② **导出**：落点会离开这台机器 → 一次都没点头就一个字节都不写，且每次导出进签名链。
// 用法：node --test egress.test.mjs（零成本：mock 大脑、不联网、不碰用户数据）
//
// 判据写得比功能多，因为这条是"底线"：
//   · 命中的是**原文片段**（记忆里的一行 / 私钥材料 / 日志签名），不是"提到记忆这个词"；
//   · 正常请求（普通中文、普通 URL）**不许误伤**——误伤的闸门会被用户关掉，那才是真的失守；
//   · 指纹有 60 秒缓存，但**判据每次重算**（缓存只影响性能，不影响"拦不拦"）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'lhcd-egress-'));
process.env.LHCD_DATA_DIR = DATA;
process.env.LHCD_LLM_MOCK = '1';

const lib = await import('./lib.mjs');
const { createNodeRuntime, createAgent, DEFAULT_CONFIG } = await import('../brain/dist/index.js');

const SECRET_LINE = '你妈妈生日是三月五号，你喜欢提前两周准备礼物';
fs.mkdirSync(path.join(DATA, 'memory', 'semantic'), { recursive: true });
fs.writeFileSync(path.join(DATA, 'memory', 'semantic', 'chat-1.md'), `---\nkey: 生日\n---\n${SECRET_LINE}\n`);

test('指纹收得到"绝不许出本机"的那几样', () => {
  const n = lib.egressNeedles();
  assert.ok(n.some((x) => x.includes('三月五号')), '记忆原文要在指纹里');
  assert.ok(n.some((x) => x.includes(DATA)), '禁区路径要在指纹里');
  assert.ok(n.every((x) => x.length >= 12), '太短的串会把闸门焊死（不许进指纹）');
});

test('★ 出站：body 里出现记忆原文 → 不发', () => {
  const v = lib.egressGuard({ url: 'https://example.com/api', body: JSON.stringify({ q: SECRET_LINE }) });
  assert.equal(v.ok, false);
  assert.match(v.reason, /不许发到本机之外/);
});

test('出站：URL 里出现禁区路径 → 不发', () => {
  const v = lib.egressGuard({ url: `https://example.com/?p=${encodeURIComponent(path.join(DATA, 'seed.enc'))}` });
  assert.equal(v.ok, false);
});

test('出站：正常请求不许误伤', () => {
  for (const req of [
    { url: 'https://api.example.com/v1/search', body: JSON.stringify({ q: '今天的天气' }) },
    { url: 'https://example.com/', body: '' },
    { url: 'https://example.com/x', body: '{"path":"/Users/someone/Documents/报表.md"}' },
  ]) {
    assert.equal(lib.egressGuard(req).ok, true, '不该拦：' + JSON.stringify(req).slice(0, 80));
  }
});

test('★ 内核真的会问这一句：net.fetch 命中指纹就不发（抛 EGRESS_BLOCKED）', async () => {
  const rt = createNodeRuntime({
    cwd: DATA,
    storage: { sessionsDir: path.join(DATA, 's'), logsDir: path.join(DATA, 'l'), memoryDir: path.join(DATA, 'm'), configDir: DATA },
    netGuard: lib.egressGuard,
  });
  await assert.rejects(
    () => rt.net.fetch('https://example.com/leak', { method: 'POST', body: JSON.stringify({ m: SECRET_LINE }) }),
    /EGRESS_BLOCKED/,
  );
});

test('不传 netGuard 的那些调用方行为不变（缺省不设闸）', async () => {
  const rt = createNodeRuntime({
    cwd: DATA,
    storage: { sessionsDir: path.join(DATA, 's2'), logsDir: path.join(DATA, 'l2'), memoryDir: path.join(DATA, 'm2'), configDir: DATA },
  });
  // 不联网：只要不是被守卫拦下的那种错，就算过（判据是"它真的去发了"）
  await rt.net.fetch('http://127.0.0.1:9/definitely-not-listening', {}).then(
    () => assert.ok(true),
    (e) => assert.ok(!/EGRESS_BLOCKED/.test(String(e?.message ?? e)), '不该被守卫拦：' + String(e?.message ?? e)),
  );
});

test('宿主把守卫接上了（静态判据：接线断了这条底线就是空的）', () => {
  const src = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), 'lib.mjs'), 'utf8');
  assert.match(src, /netGuard: egressGuard/, 'createAgent 必须把守卫交进去');
});

test('★ 导出落点：云盘 / 外接卷判得出来，本机位置不打扰', () => {
  const home = os.homedir();
  assert.equal(lib.exportDestinationVerdict(path.join(home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs')).outOfMachine, true);
  assert.equal(lib.exportDestinationVerdict('/Volumes/U盘').outOfMachine, true);
  assert.equal(lib.exportDestinationVerdict(path.join(home, 'Desktop')).outOfMachine, false);
  assert.equal(lib.exportDestinationVerdict(path.join(DATA, 'out')).outOfMachine, false);
});

test('导出这件事进签名链（"我什么时候把 TA 带出去过"要查得到）', async () => {
  lib.mockBirth({ name: '测试体' });
  const r = await lib.auditMemoryExport({ outOfMachine: true, kind: 'iCloud 云盘', ok: true, target: '/x/y/TA-backup.lhpack' });
  assert.equal(r.ok, true, r.error);
  const entries = fs.readFileSync(path.join(DATA, 'log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const row = entries.find((e) => e.type === 'memory_export');
  assert.ok(row, '链上要有 memory_export 这一条');
  assert.equal(row.payload.outOfMachine, true);
  assert.equal(row.payload.kind, 'iCloud 云盘');
  assert.equal(row.payload.target, 'TA-backup.lhpack', '只留文件名，不留完整路径');
});
