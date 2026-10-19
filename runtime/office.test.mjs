// Office 能力单测（三条硬规矩 + 六动作；真造真读真改，不 mock 库）。
// 用法：node office.test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import JSZip from 'jszip';
import { createOfficePort, replaceInXml, defaultSaveAs, sameTarget, MATRIX, formatOf } from './office.mjs';

const office = createOfficePort();
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lh-office-'));

/** 造一份真 docx（用 docx 库；两份段落，用于跨 run/跨段测试） */
async function makeDocx(dir, text1 = '项目报告：第一版。负责人：张三。', text2 = '备注：张三负责验收。') {
  const docx = await import('docx');
  const doc = new docx.Document({
    sections: [{ children: [new docx.Paragraph({ text: text1 }), new docx.Paragraph({ text: text2 })] }],
  });
  const file = path.join(dir, '报告.docx');
  fs.writeFileSync(file, Buffer.from(await docx.Packer.toBuffer(doc)));
  return file;
}

async function makePptx(dir) {
  const zip = new JSZip();
  zip.file('ppt/slides/slide1.xml', `<?xml version="1.0"?><p:sld xmlns:p="x" xmlns:a="y"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>季度目标</a:t></a:r><a:r><a:t>：拿</a:t></a:r><a:r><a:t>下三个客户</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`);
  const file = path.join(dir, '方案.pptx');
  fs.writeFileSync(file, await zip.generateAsync({ type: 'nodebuffer' }));
  return file;
}

async function makeXlsx(dir) {
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('明细');
  ws.addRow(['客户', '金额']);
  ws.addRow(['张三', 100]);
  ws.addRow(['李四', 200]);
  const file = path.join(dir, '账.xlsx');
  await wb.xlsx.writeFile(file);
  return file;
}

test('docx 改：真改到新文件、原件一字不动、读回来能看见新内容', async () => {
  const dir = tmp();
  const file = await makeDocx(dir);
  const before = fs.readFileSync(file);
  const r = await office.modify({ file, changes: [{ kind: 'replace', find: '张三', replace: '李四', expected: 2 }] });
  assert.equal(r.ok, true, r.error?.message);
  const out = r.path;
  assert.equal(out, defaultSaveAs(file));           // ① 绝不原地覆盖：另存 <原名>_改.docx
  assert.deepEqual(fs.readFileSync(file), before);   // 原件字节级不动
  const back = await office.inspect({ file: out });
  assert.ok(back.text.includes('李四'), '新文件里应有新文字');
  assert.ok(!back.text.includes('张三'), '旧文字应已消失');
});

test('docx 改：跨 run 的一句话也能改（OOXML 会把文字切碎）', async () => {
  const dir = tmp();
  const file = await makeDocx(dir, '本季度目标：拿下三个客户。');
  // 手工把一段切成多个 run（模拟真实 Word 文件）
  const zip = await JSZip.loadAsync(fs.readFileSync(file));
  let xml = await zip.file('word/document.xml').async('string');
  xml = xml.replace('<w:t xml:space="preserve">本季度目标：拿下三个客户。</w:t>', '<w:t xml:space="preserve">本季度</w:t></w:r><w:r><w:t>目标：拿下</w:t></w:r><w:r><w:t xml:space="preserve">三个客户。</w:t>');
  zip.file('word/document.xml', xml);
  fs.writeFileSync(file, await zip.generateAsync({ type: 'nodebuffer' }));
  const r = await office.modify({ file, changes: [{ kind: 'replace', find: '拿下三个客户', replace: '拿下五个客户' }] });
  assert.equal(r.ok, true, r.error?.message);
  const back = await office.inspect({ file: r.path });
  assert.ok(back.text.includes('拿下五个客户'), '跨 run 的句子应该被整句替换');
  assert.ok(back.text.includes('本季度目标'), '句子前半段不该被破坏');
});

test('硬规矩②：改不到 → 报错且**不产出文件**（不让"没改动的副本"冒充改好）', async () => {
  const dir = tmp();
  const file = await makeDocx(dir);
  const r = await office.modify({ file, changes: [{ kind: 'replace', find: '这句话原文里根本没有', replace: 'x' }] });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'NO_HIT');
  assert.match(r.error.message, /没有.*产出文件/);
  assert.ok(!fs.existsSync(defaultSaveAs(file)), '不该留下任何新文件');
});

test('硬规矩③：说要改 3 处、只命中 1 处 → 报错且不产出（防止静默写坏）', async () => {
  const dir = tmp();
  const file = await makeDocx(dir);
  const r = await office.modify({ file, changes: [{ kind: 'replace', find: '张三', replace: '李四', expected: 3 }] });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'PARTIAL');
  assert.match(r.error.message, /只改到一部分|实际命中 2 处/);
  assert.ok(!fs.existsSync(defaultSaveAs(file)));
});

test('能力矩阵：不在表内的组合直接报错，并给出可用动作', async () => {
  assert.deepEqual(MATRIX.pdf.includes('create'), true);
  assert.equal(MATRIX.pptx.includes('create'), false);
  const dir = tmp();
  const file = await makePptx(dir);
  const r = await office.create({ format: 'pptx', saveAs: path.join(dir, 'x.pptx') });
  assert.equal(r.ok, false);
  assert.match(r.error.message, /不支持 create/);
  assert.match(r.error.message, /inspect/);
  assert.equal(formatOf('a.PDF'), 'pdf');
  assert.equal(formatOf('a.txt'), null);
});

test('xlsx：改单元格 / 文字替换 / 读回来核对', async () => {
  const dir = tmp();
  const file = await makeXlsx(dir);
  const r = await office.modify({ file, changes: [
    { kind: 'cell', sheet: '明细', cell: 'B2', value: 999 },
    { kind: 'replace', find: '李四', replace: '王五', expected: 1 },
  ] });
  assert.equal(r.ok, true, r.error?.message);
  const back = await office.inspect({ file: r.path });
  assert.ok(back.text.includes('999'), '单元格应改到');
  assert.ok(back.text.includes('王五'));
  assert.ok(!back.text.includes('李四'));
  // 原件还在、内容没变
  const orig = await office.inspect({ file });
  assert.ok(orig.text.includes('李四'));
});

test('pdf：建 → 读 → 旋转页 → 自证；页面操作非法时报错不产出', async () => {
  const dir = tmp();
  const created = await office.create({ format: 'pdf', saveAs: path.join(dir, 'note.pdf'), text: 'Hello LHCD\nSecond line' });
  assert.equal(created.ok, true, created.error?.message);
  const info = await office.inspect({ file: created.path });
  assert.ok(info.text.includes('Hello LHCD'));
  const rot = await office.modify({ file: created.path, changes: [{ kind: 'page', op: 'rotate', page: 1, degrees: 90 }] });
  assert.equal(rot.ok, true, rot.error?.message);
  assert.ok(fs.existsSync(rot.path));
  const bad = await office.modify({ file: created.path, changes: [{ kind: 'page', op: 'rotate', page: 9, degrees: 90 }] });
  assert.equal(bad.ok, false);
  assert.equal(bad.error.code, 'NO_HIT');
});

test('pptx：文字替换（跨 run 的标题）', async () => {
  const dir = tmp();
  const file = await makePptx(dir);
  const r = await office.modify({ file, changes: [{ kind: 'replace', find: '拿下三个客户', replace: '拿下六个客户' }] });
  assert.equal(r.ok, true, r.error?.message);
  const back = await office.inspect({ file: r.path });
  assert.ok(back.text.includes('拿下六个客户'));
  assert.ok(!back.text.includes('拿下三个客户'));
});

test('convert：docx→txt/md、xlsx→csv；validate 能查出"该没的还在"', async () => {
  const dir = tmp();
  const file = await makeDocx(dir);
  const txt = await office.convert({ file, to: 'txt' });
  assert.equal(txt.ok, true, txt.error?.message);
  assert.ok(fs.readFileSync(txt.path, 'utf8').includes('张三'));
  const xls = await makeXlsx(dir);
  const csv = await office.convert({ file: xls, to: 'csv' });
  assert.equal(csv.ok, true, csv.error?.message);
  assert.ok(fs.readFileSync(csv.path, 'utf8').includes('李四'));

  const pass = await office.validate({ file, contains: ['项目报告'], absent: ['绝不该出现的词'] });
  assert.equal(pass.ok, true, pass.error?.message);
  const bad = await office.validate({ file, contains: ['项目报告'], absent: ['张三'] });
  assert.equal(bad.ok, false);
  assert.match(bad.error.message, /该没的还在/);
});

test('preview：docx 出 HTML（能直接给界面看）', async () => {
  const dir = tmp();
  const file = await makeDocx(dir);
  const r = await office.preview({ file });
  assert.equal(r.ok, true, r.error?.message);
  assert.match(r.html, /<p>|项目报告/);
});

test('replaceInXml 纯函数：命中数、跨 run、无命中不改动', () => {
  const xml = '<w:p><w:r><w:t>abc</w:t></w:r><w:r><w:t>def</w:t></w:r></w:p>';
  const r1 = replaceInXml(xml, 'cd', 'X');
  assert.equal(r1.hits, 1);
  assert.ok(r1.xml.includes('<w:t>abX</w:t>') || r1.xml.includes('abX'), r1.xml);
  assert.ok(r1.xml.includes('ef'));
  const r2 = replaceInXml(xml, 'zzz', 'X');
  assert.equal(r2.hits, 0);
  assert.equal(r2.xml, xml);
});

// ---------- P0：任何一条路径都不许覆盖原件 ----------

test('红线①：modify 的 saveAs 指回原件 → 拒绝，且原件字节不变', async () => {
  const dir = tmp();
  const file = await makeDocx(dir);
  const before = fs.readFileSync(file);
  const r = await office.modify({ file, changes: [{ kind: 'replace', find: '张三', replace: '李四' }], saveAs: file });
  assert.equal(r.ok, false, '不能假装改成功');
  assert.equal(r.error.code, 'SAME_PATH');
  assert.match(r.error.message, /不能覆盖原件/);
  assert.deepEqual(fs.readFileSync(file), before, '原件一个字节都不许动');
  const back = await office.inspect({ file });
  assert.ok(back.text.includes('张三'), '原件内容应原样还在');
});

test('红线①：同一路径换写法（./ 与 ..）也拦得住', async () => {
  const dir = tmp();
  const file = await makeDocx(dir);
  const before = fs.readFileSync(file);
  for (const alias of [path.join(dir, '.', '报告.docx'), path.join(dir, 'sub', '..', '报告.docx')]) {
    const r = await office.modify({ file, changes: [{ kind: 'replace', find: '张三', replace: '李四' }], saveAs: alias });
    assert.equal(r.ok, false, `${alias} 应被拦下`);
    assert.equal(r.error.code, 'SAME_PATH');
  }
  assert.deepEqual(fs.readFileSync(file), before);
});

test('红线①：软链接指回原件也拦得住（只比字符串会漏）', async () => {
  const dir = tmp();
  const file = await makeDocx(dir);
  const link = path.join(dir, '看起来是另一个文件.docx');
  fs.symlinkSync(file, link);
  const before = fs.readFileSync(file);
  const r = await office.modify({ file, changes: [{ kind: 'replace', find: '张三', replace: '李四' }], saveAs: link });
  assert.equal(r.ok, false, '软链接写下去就是原地覆盖');
  assert.equal(r.error.code, 'SAME_PATH');
  assert.deepEqual(fs.readFileSync(file), before);
});

test('红线①：不给 saveAs 时，默认另存的新名字照旧可用', async () => {
  const dir = tmp();
  const file = await makeDocx(dir);
  const r = await office.modify({ file, changes: [{ kind: 'replace', find: '张三', replace: '李四', expected: 2 }] });
  assert.equal(r.ok, true, r.error?.message);
  assert.equal(r.path, defaultSaveAs(file));
});

test('红线①：xlsx 走的是另一条写路径，同样不许覆盖原件', async () => {
  const dir = tmp();
  const file = await makeXlsx(dir);
  const before = fs.readFileSync(file);
  const r = await office.modify({ file, changes: [{ kind: 'replace', find: '李四', replace: '王五' }], saveAs: file });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'SAME_PATH');
  assert.deepEqual(fs.readFileSync(file), before);
});

test('红线①：convert 不许把结果写回原件（转成同后缀 / saveAs 指回原件）', async () => {
  const dir = tmp();
  const file = await makeDocx(dir);
  const before = fs.readFileSync(file);
  const same = await office.convert({ file, to: 'docx' });   // 目标是二进制格式，也不该产出假文件
  assert.equal(same.ok, false);
  const back = await office.convert({ file, to: 'txt', saveAs: file });
  assert.equal(back.ok, false);
  assert.equal(back.error.code, 'SAME_PATH');
  assert.deepEqual(fs.readFileSync(file), before, '原件一个字节都不许动');
});

test('红线①：create 撞上已有文件时不覆盖，换个名字就能建', async () => {
  const dir = tmp();
  const file = await makeDocx(dir);
  const before = fs.readFileSync(file);
  const r = await office.create({ format: 'docx', saveAs: file, title: '新文档', text: '覆盖测试' });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'ALREADY_EXISTS');
  assert.deepEqual(fs.readFileSync(file), before, '原件一个字节都不许动');
  const ok = await office.create({ format: 'docx', saveAs: path.join(dir, '另一个名字.docx'), text: 'X' });
  assert.equal(ok.ok, true, ok.error?.message);
});

test('sameTarget 纯函数：同一文件的各种写法都算同一个', () => {
  const dir = tmp();
  const file = path.join(dir, 'a.docx');
  fs.writeFileSync(file, 'x');
  assert.equal(sameTarget(file, file), true);
  assert.equal(sameTarget(file, path.join(dir, '.', 'a.docx')), true);
  assert.equal(sameTarget(file, path.join(dir, 'nope', '..', 'a.docx')), true);
  assert.equal(sameTarget(file, path.join(dir, 'b.docx')), false, '不存在的邻居不是同一个');
});
