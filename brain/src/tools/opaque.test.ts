// 二进制文档"纯文本写回"护栏 + 显示文本检测（出处 hermes file_tools_write_guards.py）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { refuseTextWrite, opaqueReadHint, looksLikeNumberedDisplay } from './opaque.js';
import { writeTool } from './write.js';
import { editTool } from './edit.js';
import type { ExecCtx } from './registry.js';

function ctx(dir: string): ExecCtx {
  return {
    sessionId: 't', cwd: dir, runtime: { fs: {} } as unknown as ExecCtx['runtime'],
    config: {} as ExecCtx['config'], emit: () => undefined,
  };
}

test('word/excel/ppt/pdf 一律拒绝纯文本写入，并指路 office 工具（教学式）', async () => {
  for (const f of ['/tmp/报告.docx', '/tmp/账.XLSX', '/tmp/方案.pptx', '/tmp/说明.pdf']) {
    const msg = refuseTextWrite(f);
    assert.ok(msg, `${f} 应该被拦`);
    assert.match(msg!, /二进制文档/);
    assert.match(msg!, /office 工具/);
  }
  assert.equal(refuseTextWrite('/tmp/笔记.md'), null);
  assert.equal(refuseTextWrite('/tmp/notes.txt'), null);
  assert.equal(refuseTextWrite('/tmp/a.png') !== null, true); // 图片同样不许写
});

test('write/edit 工具真的会用这条护栏拒绝（不是只在纯函数里）', async () => {
  const w = await writeTool().executor({ path: '/tmp/报告.docx', content: '我改好了' }, ctx('/tmp'));
  assert.equal(w.ok, false);
  assert.equal(w.error!.code, 'OPAQUE_FILE');
  assert.match(w.error!.message, /另存为新文件|office 工具/);
  const e = await editTool().executor({ path: '/tmp/报告.docx', oldString: '甲', newString: '乙' }, ctx('/tmp'));
  assert.equal(e.ok, false);
  assert.equal(e.error!.code, 'OPAQUE_FILE');
});

test('read 的提示指路 office inspect（别让模型对着乱码猜）', () => {
  assert.match(opaqueReadHint('/tmp/a.docx')!, /office 工具 action=inspect/);
  assert.match(opaqueReadHint('/tmp/a.zip')!, /二进制/);
  assert.equal(opaqueReadHint('/tmp/a.md'), null);
});

test('把 read 的行号显示文本写回去会被拦（那会给文件插满行号）', async () => {
  const display = '1\t第一行\n2\t第二行\n3\t第三行\n4\t第四行\n5\t第五行\n6\t第六行';
  assert.equal(looksLikeNumberedDisplay(display), true);
  assert.equal(looksLikeNumberedDisplay('代码里有 1\t2\t3 这种制表符\n第二行\n第三行\n第四行\n第五行'), false);
  const w = await writeTool().executor({ path: '/tmp/x.txt', content: display }, ctx('/tmp'));
  assert.equal(w.ok, false);
  assert.equal(w.error!.code, 'DISPLAY_TEXT');
});
