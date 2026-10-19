// selfCheck——未核实数字/文件名/URL/日期标注；证据命中保留；纯对话跳过。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selfCheck, collectEvidence } from './selfcheck.js';
import type { ChatMessage } from '../llm/provider.js';

test('有依据的数字保留，无依据的标注【未核实】', () => {
  const evidence = '查询结果：共 123 个文件\n价格 42 元';
  const r = selfCheck('仓库里有 123 个文件，价格 42 元，体积 99 GB。', evidence);
  assert.ok(r.text.includes('123 个文件'));
  assert.ok(r.text.includes('42 元'));
  assert.ok(r.text.includes('99 GB【未核实】'));
  assert.deepEqual(r.flags.map((f) => f.rule), ['number-no-source']);
});

test('URL / 文件名 / 日期无来源 → 标注', () => {
  const evidence = '工具结果：与本题无关的内容';
  const r = selfCheck('详见 https://example.com/x 与 a.txt，发布于 2026-08-21。', evidence);
  assert.ok(r.text.includes('https://example.com/x【未核实】'));
  assert.ok(r.text.includes('a.txt【未核实】'));
  assert.ok(r.text.includes('2026-08-21【未核实】'));
  assert.ok(r.flags.some((f) => f.rule === 'url-no-source'));
  assert.ok(r.flags.some((f) => f.rule === 'filename-no-source'));
  assert.ok(r.flags.some((f) => f.rule === 'date-no-source'));
});

test('纯对话（无 tool_result 证据）→ 跳过，不误伤', () => {
  const r = selfCheck('我今年 25 岁，住在杭州。', '');
  assert.equal(r.text, '我今年 25 岁，住在杭州。');
  assert.equal(r.flags.length, 0);
});

test('数字精度（迭代 12 实测修复）：序数词里的单个数字不当事实（"文件 1"/"第 3 段"）', () => {
  const r = selfCheck('文件 1 已经写好，第 3 段也改了，另外体积是 99 GB。', '无关证据');
  assert.equal(r.text.includes('文件 1【未核实】'), false, r.text);
  assert.equal(r.text.includes('第 3 段【未核实】'), false, r.text);
  assert.ok(r.text.includes('99 GB【未核实】'), '带单位的真数字仍要标'); // 两位数 + 单位
  assert.equal(r.flags.length, 1, JSON.stringify(r.flags));
});

test('collectEvidence：最近 6 条 tool + 最后一条 assistant（迭代 12 放宽）', () => {
  const history: ChatMessage[] = [
    ...Array.from({ length: 8 }, (_, i) => ({ role: 'tool' as const, content: `r${i}`, toolCallId: `t${i}` })),
    { role: 'assistant', content: '已确认事实 A' },
  ];
  const ev = collectEvidence(history);
  assert.ok(ev.includes('r7'));   // 最近 6 条都在
  assert.ok(ev.includes('r2'));
  assert.ok(!ev.includes('r1'));  // r0/r1 被挤出
  assert.ok(ev.includes('已确认事实 A'));
});

test('collectEvidence（迭代 12 实测修复）：工具**参数**里写过的文件名/数字也算有依据', () => {
  // 由来：她把「投资能力诊断报告.md」「20 KB」写在自己调用的工具参数里，
  // 旧口径只看 tool_result 正文 → 文件名和数字被大面积标【未核实】，用户看到一排花。
  const history: ChatMessage[] = [
    { role: 'assistant', content: '我这就写', toolCalls: [{ id: 'c1', name: 'write', args: { path: 'Obsidian Vault/codex/投资能力诊断报告.md', content: '（20 KB）' } }] },
    { role: 'tool', content: '已写入', toolCallId: 'c1' },
  ];
  const ev = collectEvidence(history);
  assert.ok(ev.includes('投资能力诊断报告.md'));
  assert.ok(ev.includes('20 KB'));
  // 真凭实据地对得上就不再标【未核实】
  const r = selfCheck('已写入 `投资能力诊断报告.md`（20 KB）。', ev);
  assert.equal(r.flags.length, 0, r.text);
});
