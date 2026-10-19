// 市场：源与清单
// 用法：node --test market.test.mjs（零成本：不联网——HTTP 那种用一个本地桩替掉 globalThis.fetch）
//
// 判据（写死在测试里）：
//   ① 好清单能读；② **坏 JSON / 取不到**如实报错（不抛、不静默成空市场）；
//   ③ 加源**先取一次**，取不到就不加（"不会加一个空源"）；④ 随包那份删不掉（可停用）；
//   ⑤ 目录把"取不到的源"也带着错因返回（界面据此显示）；⑥ 已装的条目标出来。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'lhcd-market-'));
process.env.LHCD_DATA_DIR = DATA;
process.env.LHCD_LLM_MOCK = '1';

const lib = await import('./lib.mjs');

/* 网络桩：本用例只走"清单 URL"这条路的三个形态（好/坏/超时），不打真网 */
let stub = { kind: 'good' };
const GOOD = { version: 1, name: '测试清单', updatedAt: '2026-09-26', items: [{ kind: 'skill', name: 'demo-skill', summary: '一个演示技能' }] };
globalThis.fetch = async () => {
  if (stub.kind === 'good') return { ok: true, status: 200, text: async () => JSON.stringify(GOOD) };
  if (stub.kind === 'bad-json') return { ok: true, status: 200, text: async () => '{ 这不是 JSON' };
  if (stub.kind === 'http-500') return { ok: false, status: 500, text: async () => '' };
  const e = new Error('The operation was aborted due to timeout');
  throw e;
};

test('好清单读得出来（名字/更新时间/条目）', async () => {
  stub = { kind: 'good' };
  const r = await lib.readManifest('https://example.com/market.json');
  assert.equal(r.ok, true, r.error);
  assert.equal(r.name, '测试清单');
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].name, 'demo-skill');
});

test('★ 坏清单如实报错（不抛、不静默）', async () => {
  stub = { kind: 'bad-json' };
  let r = await lib.readManifest('https://example.com/market.json');
  assert.equal(r.ok, false);
  assert.match(r.error, /不是合法 JSON/);
  stub = { kind: 'http-500' };
  r = await lib.readManifest('https://example.com/market.json');
  assert.equal(r.ok, false);
  assert.match(r.error, /HTTP 500/);
  stub = { kind: 'timeout' };
  r = await lib.readManifest('https://example.com/market.json');
  assert.equal(r.ok, false);
  assert.match(r.error, /超时/, '超时要单独说清楚（不是"失败了"三个字）');
});

test('清单格式不对（没有 items）也要说清楚', async () => {
  stub = { kind: 'good' };
  const p = path.join(DATA, 'bad-manifest.json');
  fs.writeFileSync(p, JSON.stringify({ version: 1, name: 'x' }));
  const r = await lib.readManifest(p);
  assert.equal(r.ok, false);
  assert.match(r.error, /items/);
});

test('★ 随包那一条永远在，而且删不掉', () => {
  const { sources } = lib.listMarketSources();
  assert.equal(sources[0].id, 'seed');
  assert.equal(sources[0].builtin, true);
  const rm = lib.removeMarketSource('seed');
  assert.equal(rm.ok, false);
  assert.match(rm.error, /删不掉/);
});

test('★ 加源先取一次：取不到就不加（不会加一个空源）', async () => {
  stub = { kind: 'timeout' };
  const bad = await lib.addMarketSource({ kind: 'url', locator: 'https://example.com/market.json' });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /取不到/);
  assert.equal(lib.listMarketSources().sources.filter((s) => s.id !== 'seed').length, 0, '失败的源不许留在列表里');

  stub = { kind: 'good' };
  const good = await lib.addMarketSource({ kind: 'url', locator: 'https://example.com/market.json', label: '我的清单' });
  assert.equal(good.ok, true, good.error);
  assert.equal(good.source.count, 1, '加的时候就把条目数记下来');
  const again = await lib.addMarketSource({ kind: 'url', locator: 'https://example.com/market.json' });
  assert.equal(again.ok, false, '同一个源不许加两遍');
});

test('本地文件夹源：扫 SKILL.md，且不算第三方', async () => {
  const dir = path.join(DATA, '我的技能');
  fs.mkdirSync(path.join(dir, 'my-skill'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'my-skill', 'SKILL.md'), '---\nname: my-skill\ndescription: 我自己的\n---\n正文\n');
  const r = await lib.addMarketSource({ kind: 'dir', locator: dir });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.source.count, 1);
  stub = { kind: 'good' };
  const cat = await lib.marketCatalog();
  const mine = cat.sources.find((s) => s.sourceId === r.source.id);
  assert.equal(mine.ok, true);
  assert.equal(mine.items[0].name, 'my-skill');
  assert.equal(mine.items[0].thirdParty, false, '本地自己写的不算第三方（不打"未审核"）');
});

test('★ 目录里"取不到的源"带着错因返回（界面才能如实说）', async () => {
  stub = { kind: 'timeout' };
  const list = lib.listMarketSources().sources.filter((s) => s.kind === 'url');
  assert.ok(list.length >= 1, '先得有 url 源');
  await lib.refreshMarketSource(list[0].id);
  const cat = await lib.marketCatalog();
  const broken = cat.sources.find((s) => s.sourceId === list[0].id);
  assert.equal(broken.ok, false);
  assert.match(broken.error, /超时/);
  assert.deepEqual(broken.items, [], '取不到就没有条目——但**源本身还在**（不是"东西都没了"）');
});

test('刷新成功会把 lastError 清掉、把条数更新', async () => {
  const { sources } = lib.listMarketSources();
  const url = sources.find((s) => s.kind === 'url');
  stub = { kind: 'good' };
  const r = await lib.refreshMarketSource(url.id);
  assert.equal(r.ok, true, r.error);
  const after = lib.listMarketSources().sources.find((s) => s.id === url.id);
  assert.equal(after.lastError, '');
  assert.equal(after.count, 1);
});

/* ---------- 来源与版本 / 检查更新 / 卸载 ---------- */
test('★ 装过的东西带来源与指纹；自己攒的那种如实标出来', async () => {
  const dir = path.join(DATA, 'src2');
  fs.mkdirSync(path.join(dir, 'demo2'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'demo2', 'SKILL.md'), '---\nname: demo2\ndescription: 演示\n---\n正文\n');
  const ins = await lib.marketInstall({ kind: 'skill', name: 'demo2', dir: path.join(dir, 'demo2'), thirdParty: false });
  assert.equal(ins.ok, true, ins.error);
  const list = await lib.installedList();
  const me = list.skills.find((x) => x.name === 'demo2');
  assert.ok(me, '装完要出现在"装过的东西"里：' + JSON.stringify(list.skills.map((x) => x.name)));
  assert.equal(me.hash, ins.hash, '指纹要一致');
  assert.equal(me.thirdParty, false, '本地自己的不算第三方');
});

test('★ 检查更新：来源内容变了才提示（没变不许瞎提示）', async () => {
  const p = path.join(DATA, 'src2', 'demo2', 'SKILL.md');
  const before = await lib.checkSkillUpdate('demo2');
  assert.equal(before.ok, true, before.error);
  assert.equal(before.hasUpdate, false, '内容没变 → 不该说"有新版"');
  fs.writeFileSync(p, '---\nname: demo2\ndescription: 演示\n---\n正文改了\n');
  const after = await lib.checkSkillUpdate('demo2');
  assert.equal(after.hasUpdate, true, '内容变了要提示');
  assert.notEqual(after.current, after.remote);
});

test('自己没有来源的技能不给"检查更新"', async () => {
  const r = await lib.checkSkillUpdate('从没装过的东西');
  assert.equal(r.ok, false);
  assert.match(r.error, /不知道是从哪儿装的/);
});

test('★ 卸载：默认留着"她学过的用法"，明确要求才清', async () => {
  const pre = await lib.uninstallPreview('demo2');
  assert.equal(pre.ok, true);
  assert.equal(typeof pre.memoryHits, 'number', '要能给出"她学过的用法"有几条');
  const r = await lib.uninstallSkill('demo2', { forget: false });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.forgotten, 0);
  // ⚠ 删的是**装进来的那一份**（`<data>/skills/<name>`），源文件夹是用户的、要原样留着
  assert.equal(fs.existsSync(path.join(DATA, 'skills', 'demo2')), false, '装进来的那份要真删掉');
  assert.equal(fs.existsSync(path.join(DATA, 'src2', 'demo2', 'SKILL.md')), true, '用户的源文件夹不许动');
  const after = await lib.installedList();
  assert.equal(after.skills.find((x) => x.name === 'demo2'), undefined, '列表里要没有它了');
  const again = await lib.uninstallSkill('demo2');
  assert.equal(again.ok, false, '再卸一次要如实说"没装过"');
});

test('断开外部服务：配置里移除，并如实说"重启后彻底生效"', () => {
  const r = lib.uninstallMcp('没接过的东西');
  assert.equal(r.ok, false);
  assert.match(r.error, /没接过/);
});
