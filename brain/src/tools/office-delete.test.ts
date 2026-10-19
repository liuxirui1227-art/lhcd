// office / delete 两个工具的契约单测——端口缺失如实拒绝、能力矩阵拦住不支持的组合、
// 删除逐项结果（不整体报成功）。真库行为在 runtime/office.test.mjs（那边是真造真读真改）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { officeTool } from './office.js';
import { deleteTool } from './delete.js';
import type { ExecCtx } from './registry.js';
import type { OfficePort, TrashPort } from '../ports.js';

function ctxWith(ports: { office?: OfficePort; trash?: TrashPort }): ExecCtx {
  return { sessionId: 't', cwd: '/tmp', runtime: {} as ExecCtx['runtime'], config: {} as ExecCtx['config'], ports, emit: () => undefined };
}

const fakeOffice: OfficePort = {
  inspect: async ({ file }) => ({ ok: true, output: `看到了 ${file}` }),
  modify: async ({ file, changes, saveAs }) => ({ ok: true, output: `改了 ${changes.length} 处`, path: saveAs ?? `${file}_改` }),
  create: async ({ saveAs }) => ({ ok: true, output: `建了 ${saveAs}`, path: saveAs }),
  convert: async ({ file }) => ({ ok: true, output: `转了 ${file}` }),
  validate: async () => ({ ok: true, output: '核对过了' }),
  preview: async () => ({ ok: true, output: '预览', html: '<p>x</p>' }),
};

test('office：端口没挂载 → 如实拒绝（不假装有这能力）', async () => {
  const r = await officeTool().executor({ action: 'inspect', file: '/tmp/a.docx' }, ctxWith({}));
  assert.equal(r.ok, false);
  assert.equal(r.error!.code, 'NO_OFFICE');
});

test('office：能力矩阵拦住不支持的组合（pptx 不能 create），并给出可用动作', async () => {
  const r = await officeTool().executor({ action: 'create', format: 'pptx', saveAs: '/tmp/a.pptx' }, ctxWith({ office: fakeOffice }));
  assert.equal(r.ok, false);
  assert.match(r.error!.message, /不支持/);
});

test('office：非 Office 后缀直接拒绝；modify 缺 changes 也拒绝', async () => {
  const t = officeTool();
  const r1 = await t.executor({ action: 'inspect', file: '/tmp/a.txt' }, ctxWith({ office: fakeOffice }));
  assert.equal(r1.ok, false);
  assert.equal(r1.error!.code, 'BAD_FORMAT');
  const r2 = await t.executor({ action: 'modify', file: '/tmp/a.docx' }, ctxWith({ office: fakeOffice }));
  assert.equal(r2.ok, false);
  assert.match(r2.error!.message, /changes/);
});

test('office：正常路径把参数原样交给端口（改文档 → 另存新文件）', async () => {
  const r = await officeTool().executor(
    { action: 'modify', file: '/tmp/报告.docx', changes: [{ kind: 'replace', find: '甲', replace: '乙', expected: 1 }] },
    ctxWith({ office: fakeOffice }),
  );
  assert.equal(r.ok, true);
  assert.match(r.output, /改了 1 处/);
});

test('delete：没有回收站通道 → 拒绝执行（绝不降级为直接删除）', async () => {
  const r = await deleteTool().executor({ paths: ['/tmp/x'] }, ctxWith({}));
  assert.equal(r.ok, false);
  assert.equal(r.error!.code, 'NO_TRASH');
  assert.match(r.error!.message, /不会直接删掉/);
});

test('delete：多文件逐项报结果——全成/部分成/全败，不整体报成功', async () => {
  const trash: TrashPort = { trash: async (p) => (p.includes('ok') ? { ok: true } : { ok: false, error: '回收站不可用（网络盘）' }) };
  const t = deleteTool();
  const all = await t.executor({ paths: ['/tmp/ok1', '/tmp/ok2'] }, ctxWith({ trash }));
  assert.equal(all.ok, true);
  assert.match(all.output, /已把 2 项移到回收站/);

  const partial = await t.executor({ paths: ['/tmp/ok1', '/tmp/nope'] }, ctxWith({ trash }));
  assert.equal(partial.ok, false);
  assert.equal(partial.error!.code, 'PARTIAL_DELETE');
  assert.match(partial.output, /成功 1 项/);
  assert.match(partial.output, /没删成 1 项/);

  const none = await t.executor({ paths: ['/tmp/nope'] }, ctxWith({ trash }));
  assert.equal(none.ok, false);
  assert.equal(none.error!.code, 'TRASH_FAILED');
});

test('delete：paths 空 → 参数错误（不做"什么都没删但报成功"这种事）', async () => {
  const r = await deleteTool().executor({ paths: [] }, ctxWith({ trash: { trash: async () => ({ ok: true }) } }));
  assert.equal(r.ok, false);
  assert.equal(r.error!.code, 'BAD_ARGS');
});
