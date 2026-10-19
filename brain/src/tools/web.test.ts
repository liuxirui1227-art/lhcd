// 网络工具单测——web_fetch 清洗/截断/错误；web_search 解析（mock fetch，零网络）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createNodeRuntime } from '../runtime/node.js';
import { loadConfig } from '../config/load.js';
import { htmlToText, webFetchTool } from './web-fetch.js';
import { webSearchTool, parseSearchResults, parseLiteResults, parseMojeekResults, SEARCH_EMPTY_TEXT } from './web-search.js';
import type { ExecCtx } from './registry.js';
import type { NetResponse } from '../runtime/types.js';

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'brain-web-'));
}

function okRes(html: string): NetResponse {
  return { status: 200, ok: true, text: async () => html, json: async () => ({}) };
}
function errRes(status: number): NetResponse {
  return { status, ok: false, text: async () => 'err', json: async () => ({}) };
}

function setup(responses: NetResponse[]) {
  const dir = tmpdir();
  let calls = 0;
  const rt = createNodeRuntime({
    cwd: dir,
    storage: { sessionsDir: `${dir}/s`, logsDir: `${dir}/l`, memoryDir: `${dir}/m`, configDir: dir },
  });
  const netFetch = async () => {
    const r = responses[Math.min(calls, responses.length - 1)]!;
    calls++;
    return r;
  };
  // 覆盖 runtime.net.fetch（Runtime 对象不可变 → 用 Object.assign 替换该键）
  const runtime = { ...rt, net: { fetch: netFetch } };
  const ctx: ExecCtx = {
    sessionId: 's1',
    cwd: dir,
    runtime,
    config: loadConfig({ cwd: dir, home: dir }),
    emit: () => undefined,
  };
  return ctx;
}

test('htmlToText：剥 script/style/标签 + 实体解码 + 空白归一', () => {
  const html = '<html><head><style>.a{}</style><script>var x=1;</script></head><body><h1>标题</h1><p>A &amp; B&nbsp;C</p></body></html>';
  const text = htmlToText(html);
  assert.ok(text.includes('标题'));
  assert.ok(text.includes('A & B C'));
  assert.ok(!text.includes('<h1>'));
  assert.ok(!text.includes('var x'));
});

test('web_fetch：抓取清洗成功；HTTP 错误；非法 URL', async () => {
  const ok = setup([okRes('<html><body><p>正文内容</p></body></html>')]);
  const r = await webFetchTool().executor({ url: 'https://example.com/a' }, ok);
  assert.equal(r.ok, true);
  assert.ok(r.output.includes('正文内容'));

  const bad = setup([errRes(404)]);
  const r2 = await webFetchTool().executor({ url: 'https://example.com/a' }, bad);
  assert.equal(r2.ok, false);
  assert.equal(r2.error?.code, 'HTTP_404');

  const badUrl = setup([]);
  const r3 = await webFetchTool().executor({ url: 'ftp://x' }, badUrl);
  assert.equal(r3.error?.code, 'BAD_ARGS');
});

test('web_fetch：超 30KB 截断', async () => {
  const big = setup([okRes(`<html><body>${'长'.repeat(35 * 1024)}</body></html>`)]);
  const r = await webFetchTool().executor({ url: 'https://example.com/a' }, big);
  assert.equal(r.ok, true);
  assert.equal(r.truncated, true);
  assert.ok(r.output.includes('已截断'));
});

test('parseSearchResults：DDG HTML → 标题/摘要/URL（uddg 重定向剥离）+ max 上限', () => {
  const html = `
    <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa">结果一标题</a>
    <div>广告</div><a class="result__snippet">摘要一内容</a>
    <a class="result__a" href="https://example.com/b">结果二标题</a><a class="result__snippet">摘要二内容</a>`;
  const hits = parseSearchResults(html, 1);
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.title, '结果一标题');
  assert.equal(hits[0]!.url, 'https://example.com/a');
  assert.equal(hits[0]!.snippet, '摘要一内容');
});

test('web_search：主后端命中；零命中/全失败 → 诚实话术「没搜到，不代表不存在」', async () => {
  const html = `
    <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fa.com%2Fx">标题A</a><a class="result__snippet">摘要A</a>
    <a class="result__a" href="https://b.com/y">标题B</a><a class="result__snippet">摘要B</a>`;
  const ok = setup([okRes(html)]);
  const r = await webSearchTool().executor({ query: '测试' }, ok);
  assert.equal(r.ok, true);
  assert.ok(r.output.includes('标题A'));
  assert.ok(r.output.includes('https://a.com/x'));
  assert.ok(r.output.includes('标题B'));

  // 三个后端全部解析 0 条（stub 复用最后一个响应）→ 明确话术，而不是暗示「确实没有」
  const none = setup([okRes('<html>改版了没有 result__a</html>')]);
  const r2 = await webSearchTool().executor({ query: 'x' }, none);
  assert.equal(r2.ok, true);
  assert.equal(r2.output, SEARCH_EMPTY_TEXT);
  assert.match(r2.output, /不代表不存在/);

  // 三个后端全部 HTTP 失败 → 同样话术（不再裸抛 HTTP_500）
  const bad = setup([errRes(500)]);
  const r3 = await webSearchTool().executor({ query: 'x' }, bad);
  assert.equal(r3.ok, true);
  assert.match(r3.output, /不代表不存在/);
});

test('web_search：后端链降级（主源失败 → lite 命中）', async () => {
  const liteHtml = `<a rel="nofollow" href="https://c.com/z" class='result-link'>备胎标题</a><td class='result-snippet'>备胎摘要</td>`;
  const ctx = setup([errRes(403), okRes(liteHtml)]); // 主源 403 → 降级 lite
  const r = await webSearchTool().executor({ query: '测试' }, ctx);
  assert.equal(r.ok, true);
  assert.ok(r.output.includes('备胎标题'));
  assert.ok(r.output.includes('https://c.com/z'));
});

test('parseLiteResults / parseMojeekResults：备胎解析器', () => {
  const lite = `<a rel="nofollow" href="https://a.com/1" class='result-link'>Lite标题</a><td class='result-snippet'>Lite摘要</td>`;
  const lh = parseLiteResults(lite, 8);
  assert.equal(lh.length, 1);
  assert.equal(lh[0]!.title, 'Lite标题');
  assert.equal(lh[0]!.url, 'https://a.com/1');
  assert.equal(lh[0]!.snippet, 'Lite摘要');

  const mojeek = `<h2><a class="ob" href="https://m.com/2">Mojeek标题</a></h2><p class="s">Mojeek摘要</p>`;
  const mh = parseMojeekResults(mojeek, 8);
  assert.equal(mh.length, 1);
  assert.equal(mh[0]!.title, 'Mojeek标题');
  assert.equal(mh[0]!.url, 'https://m.com/2');
  assert.equal(mh[0]!.snippet, 'Mojeek摘要');
});
