// **签名链条目必须合 spec**。
// 用法：node --test log-spec.test.mjs（或 npm test）；零成本。
//
// 来由：审计发现 `validateLogEntryObject` **零调用**——校验器写好了、没人用，
// 于是链上悄悄出现了一批**枚举外的类型**：`cron` / `heartbeat` / `resume` / `screen` / `screenshot` / `drop`
// 被当成事件类型写进去（其实那是"来源"，该进 payload.origin），而 spec 里的 EVENT_TYPES 根本没有这些值。
// 这条测试把它钉住：**宿主写进链的每一条都要通过 `spec/spec.schema.json` 的 logEntry 校验**。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'lhcd-logspec-'));
process.env.LHCD_DATA_DIR = DATA;
process.env.LHCD_LLM_MOCK = '1';
const done = { type: 'done' };
const say = (t) => [{ type: 'text.delta', text: t }, done];
// 一轮里同时踩到：普通用户回合 / 非用户来源回合 / 工具动作 / 审批决定
const toolTurn = () => [{ type: 'tool_calls', calls: [{ id: 'c1', name: 'write', args: { path: 'note.txt', content: 'x' } }] }, done];
fs.writeFileSync(path.join(DATA, 'mock-script.json'), JSON.stringify([toolTurn(), say('写好了'), say('看到你在写东西')]));
process.env.LHCD_LLM_MOCK_SCRIPT = path.join(DATA, 'mock-script.json');

const lib = await import('./lib.mjs');
const { validateLogEntryObject } = await import('../core/dist/spec/validate.js');

if (!fs.existsSync('/tmp/birth-3.json')) throw new Error('缺少 /tmp/birth-3.json（先跑 make-birth-fixture.mjs）');
assert.equal(lib.importPackageFromPath('/tmp/birth-3.json').ok, true);
assert.equal(lib.bind().ok, true);

test('宿主写进签名链的每一条都合 spec（含来源回合 / 工具动作 / 审批）', async () => {
  lib.setApprovalBridge(() => Promise.resolve('allow'));
  await lib.chat('帮我写个文件');                                   // 普通用户回合 + 工具动作 + 审批
  await lib.chat('[屏幕观察模式] 这是用户当前屏幕的截图。', undefined, { origin: 'screen' }); // 非用户来源
  await lib.chat('收到', undefined, { origin: 'cron' });            // 定时来源
  lib.setApprovalBridge(null);

  const rows = fs.readFileSync(path.join(DATA, 'log.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.ok(rows.length >= 5, `样本太少（${rows.length} 条），这条测试就没意义了`);

  const bad = [];
  for (const r of rows) {
    const v = validateLogEntryObject(r);
    if (!v.ok) bad.push(`${r.type ?? '?'}: ${v.errors.slice(0, 3).join(' / ')}`);
  }
  assert.deepEqual(bad, [], '有条目不合 spec（类型必须在 EVENT_TYPES 里；来源要进 payload.origin）');

  // 顺带钉住"来源没丢"：来源回合都能在 payload 里找回它的 origin
  const origins = rows.map((r) => r.payload?.origin).filter(Boolean);
  assert.ok(origins.includes('screen'), '屏幕观察的来源要留在 payload.origin');
  assert.ok(origins.includes('cron'), '定时回合的来源要留在 payload.origin');
  // 而且不许再有人把来源当类型写
  const types = new Set(rows.map((r) => r.type));
  for (const t of ['screen', 'cron', 'heartbeat', 'resume', 'screenshot', 'drop']) {
    assert.equal(types.has(t), false, `「${t}」是来源，不是事件类型——不许写进 type（审计 2026-09-26 的老毛病）`);
  }
});
