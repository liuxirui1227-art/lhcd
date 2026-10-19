// SSRF 防护单测：拦的是"模型被骗着去抓内网"，不是"抓网页"。
// 三条路都要钉住：① 字面量内网地址；② 公网域名**解析到**内网；③ 302 跳到内网（只查第一跳是拦不住的）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { assertPublicUrl, blockedHostname, safeFetchText, MAX_REDIRECTS } from './url-guard.js';

test('字面量：环回 / 私网 / 链路本地（含云元数据）/ 内网域名 一律拦', async () => {
  const bad = [
    'http://127.0.0.1:43129/?x=1',
    'http://localhost/admin',
    'http://localhost.:8080/',
    'http://0.0.0.0/',
    'http://10.1.2.3/',
    'http://172.16.0.1/',
    'http://172.31.255.254/',
    'http://192.168.1.1/',
    'http://169.254.169.254/latest/meta-data/',   // 云元数据：这条是这一层的头号目标
    'http://[::1]:8080/',
    'http://[fe80::1]/',
    'http://[fd00::1]/',
    'http://[::ffff:127.0.0.1]/',
    'http://nas.local/',
    'http://router/',
    'file:///etc/passwd',
    'ftp://example.com/x',
  ];
  for (const u of bad) {
    const r = await assertPublicUrl(u);
    assert.equal(r.ok, false, `${u} 应当被拦（拿到了 ok=true）`);
    assert.ok(r.reason && r.reason.length > 2, `${u} 没给理由`);
  }
});

test('正常公网地址放行（别把墙砌到正功能上）', async () => {
  for (const u of ['https://example.com/a', 'http://example.com:8080/x?y=1', 'https://8.8.8.8/', 'https://[2606:4700::1111]/']) {
    const r = await assertPublicUrl(u);
    assert.equal(r.ok, true, `${u} 不该被拦（${r.reason ?? ''}）`);
  }
});

test('域名解析到内网也要拦（只查字面量拦不住这条）', async () => {
  const resolve = async (h: string) => (h === 'evil.example' ? ['93.184.216.34', '127.0.0.1'] : ['93.184.216.34']);
  const bad = await assertPublicUrl('https://evil.example/x', resolve);
  assert.equal(bad.ok, false);
  assert.match(bad.reason ?? '', /内网地址/);
  const good = await assertPublicUrl('https://ok.example/x', resolve);
  assert.equal(good.ok, true, good.reason ?? '');
  // 解析失败：也拦（拿不准就别抓）
  const dead = await assertPublicUrl('https://nx.example/x', async () => { throw new Error('ENOTFOUND'); });
  assert.equal(dead.ok, false);
});

test('★302 跳到内网要拦（每一跳都重查）', async () => {
  const seen: string[] = [];
  const fetchLike = async (u: string) => {
    seen.push(u);
    if (u === 'https://pub.example/a') {
      return { status: 302, ok: false, text: async () => '', headers: { location: 'http://169.254.169.254/latest/meta-data/' } };
    }
    return { status: 200, ok: true, text: async () => '不该走到这里' };
  };
  const r = await safeFetchText('https://pub.example/a', { fetch: fetchLike });
  assert.equal(r.ok, false, '跳到云元数据必须被拦');
  assert.match(r.reason ?? '', /不抓这类地址/);
  assert.deepEqual(seen, ['https://pub.example/a'], '不该真的去请求被拦的那一跳');
});

test('重定向上限：跟不完就如实说，不无限跟', async () => {
  let n = 0;
  const r = await safeFetchText('https://pub.example/a', {
    fetch: async (u: string) => { n++; return { status: 302, ok: false, text: async () => '', headers: { location: `https://pub.example/${n}` } }; },
  });
  assert.equal(r.ok, false);
  assert.match(r.reason ?? '', new RegExp(`超过 ${MAX_REDIRECTS} 跳`));
  assert.equal(n, MAX_REDIRECTS + 1, '每一跳都查过一次，且没有多跟');
});

test('响应体积按流截断（不把大响应整包拉进内存）', async () => {
  const chunk = 'x'.repeat(1024);
  async function* stream() { for (let i = 0; i < 5000; i++) yield chunk; }   // 5MB
  const r = await safeFetchText('https://big.example/f', {
    fetch: async () => ({ status: 200, ok: true, text: async () => chunk.repeat(5000), streamText: stream, headers: {} }),
    maxBytes: 10 * 1024,
  });
  assert.equal(r.ok, true);
  assert.equal(r.truncated, true);
  assert.ok((r.text ?? '').length <= 10 * 1024, `截断没生效：${(r.text ?? '').length}`);
});

test('blockedHostname 逐类判据（给宿主/文档引用的一张表）', () => {
  assert.equal(blockedHostname('127.0.0.1'), '内网/保留 IP');
  assert.equal(blockedHostname('169.254.169.254'), '内网/保留 IP');
  assert.equal(blockedHostname('localhost'), '本机地址');
  assert.equal(blockedHostname('a.b.local'), '内网域名');
  assert.equal(blockedHostname('intranet'), '内网主机名（没有域名后缀）');
  assert.equal(blockedHostname('example.com'), null);
  assert.equal(blockedHostname('8.8.8.8'), null);
});
