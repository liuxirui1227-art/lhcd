// 能力自述 + 目录预算 单测（预算规则照 codex render.rs 的三个分支）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ToolRegistry } from '../tools/registry.js';
import { readTool } from '../tools/read.js';
import { writeTool } from '../tools/write.js';
import { officeTool } from '../tools/office.js';
import {
  renderToolCatalog, catalogBudgetChars, renderCatalogLine, TOOL_CATALOG,
  MAX_CONFIGURED_CATALOG_TOKENS, UNKNOWN_WINDOW_CHAR_BUDGET, CATALOG_CONTEXT_PERCENT,
} from './tool-catalog.js';

function reg() {
  const r = new ToolRegistry();
  for (const t of [readTool(), writeTool(), officeTool()]) r.register(t);
  return r;
}
const CONFIG = { tools: { enabled: ['read', 'write', 'office'] } };

test('预算三分支照 codex：默认=窗口 2%；显式设值夹到 10k token；未知窗口=8000 字符兜底', () => {
  const a = catalogBudgetChars({ contextWindow: 128000 });
  assert.equal(a.chars, Math.floor((128000 * CATALOG_CONTEXT_PERCENT) / 100) * 4); // 2560 token → 10240 字符
  const b = catalogBudgetChars({ contextWindow: 1_000_000 });
  assert.equal(b.chars, 20000 * 4, '20k token（默认路径不受 10k 夹取）');
  const c = catalogBudgetChars({ configuredTokens: 50_000 });
  assert.equal(c.chars, MAX_CONFIGURED_CATALOG_TOKENS * 4, '显式设值被夹到 10k');
  const d = catalogBudgetChars({});
  assert.equal(d.chars, UNKNOWN_WINDOW_CHAR_BUDGET);
});

test('目录：一行一个工具，带"别用"提示（歧义消解）', () => {
  const text = renderToolCatalog(reg(), CONFIG, { exec: true, net: true, app: true, browser: true, background: true });
  assert.match(text, /【手上有什么本事】/);
  assert.match(text, /- read: /);
  assert.match(text, /- office: /);
  assert.match(text, /别用：Word\/Excel\/PPT\/PDF 用 office 工具看/, 'read 的"别用"提示要在（防它拿 read 读 docx）');
  assert.match(text, /别用：二进制文档禁止纯文本写回/, 'write 的"别用"提示要在');
});

test('目录预算：超了先丢低优先级（office 优先级 10 > read 0），并说明丢了多少', () => {
  const tight = renderToolCatalog(reg(), CONFIG, { exec: true, net: true, app: true, browser: true, background: true }, { configuredTokens: 20 });
  assert.match(tight, /- read: /, '高优先级保留');
  assert.match(tight, /还有 2 个不常用的没列出来/, JSON.stringify(tight)); // write 与 office 都被裁掉
  assert.ok(!/- office: /.test(tight), '低优先级被裁掉');
  // 宽松预算 → 全在、无尾巴
  const roomy = renderToolCatalog(reg(), CONFIG, { exec: true, net: true, app: true, browser: true, background: true }, { configuredTokens: 2000 });
  assert.match(roomy, /- office: /);
  assert.ok(!/没列出来/.test(roomy));
});

test('没登记过的工具用描述首句兜底（不至于没介绍）', () => {
  const r = new ToolRegistry();
  r.register({ ...readTool(), name: 'weird_tool', schema: { type: 'function', function: { name: 'weird_tool', description: '干一件很怪的事。细节略。', parameters: { type: 'object', properties: {} } } } });
  const text = renderToolCatalog(r, { tools: { enabled: ['weird_tool'] } }, { exec: true, net: true, app: true, browser: true, background: true });
  assert.match(text, /weird_tool: 干一件很怪的事/);
});

test('渲染单行：超长截断到 1024 字符（照 codex 的单条上限）', () => {
  const long = renderCatalogLine({ name: 'x', blurb: 'a'.repeat(3000), priority: 0 });
  assert.equal(long.length, 1024);
});

test('目录里列的工具名都在 TOOL_CATALOG 里登记过（防新工具漏写自述）', () => {
  // 与 tools-guard 同类：新加工具时提醒补一句"给模型的话"
  const core = ['bash', 'read', 'write', 'edit', 'grep', 'glob', 'remember', 'recall', 'forget', 'session_search', 'load_skill', 'web_search', 'web_fetch', 'app', 'office', 'delete', 'task', 'schedule'];
  for (const name of core) {
    assert.ok(TOOL_CATALOG[name], `${name} 应在 TOOL_CATALOG 里有一句自述`);
    assert.ok(TOOL_CATALOG[name]!.blurb.length > 0);
  }
});
