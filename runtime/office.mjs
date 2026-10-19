// 灵核 · Office 能力——六动作：
//   inspect 看 / modify 改 / create 建 / convert 转格式 / validate 校验 / preview 预览
//
// **库在 runtime 侧**（brain 零运行时依赖的红线不破；brain 只声明 OfficePort 接口，宿主注入实现）。
//
// 三条硬规矩（与"不假成功"红线同源）：
//   ① **绝不原地覆盖**：改一律另存新文件（默认 `<原名>_改.<ext>`），原件不动
//   ② **改不到就不产出**：命中 0 处 → 报错且**不写文件**（产出"没改动的副本" = 假成功）
//   ③ **改了要自证**：请求 N 处、只验证通过 M<N → 报错且**不写文件**
//
// 能力矩阵（声明式，不在表内的组合直接报错并给出可选目标）见 MATRIX。
// 读的声明：**不保留字体/颜色/坐标/版式**——"读内容"与"排版任务"分流。
import fs from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';

export const MATRIX = {
  docx: ['create', 'inspect', 'modify', 'validate', 'convert', 'preview'],
  xlsx: ['create', 'inspect', 'modify', 'validate', 'convert', 'preview'],
  pptx: ['inspect', 'modify', 'validate', 'preview'],
  pdf: ['create', 'inspect', 'modify', 'validate', 'convert', 'preview'],
};

export const READ_DECLARATION = '（只读文字内容，不含字体/颜色/坐标/版式；要动排版请说明，那是另一回事）';

/** 大文件保护：超过这个大小拒绝（exceljs 在进程内跑，防大表拖垮主进程） */
export const MAX_BYTES = 24 * 1024 * 1024;

export function formatOf(file) {
  const ext = String(path.extname(String(file ?? ''))).toLowerCase().replace('.', '');
  return ['docx', 'xlsx', 'pptx', 'pdf'].includes(ext) ? ext : null;
}

function fail(message, code = 'OFFICE_ERROR') {
  return { ok: false, output: '', error: { code, message } };
}

function ensureSupported(format, action) {
  if (!format) return fail('只认 .docx / .xlsx / .pptx / .pdf 这四种；其它格式用 read/write 当文本处理', 'BAD_FORMAT');
  const allowed = MATRIX[format] ?? [];
  if (!allowed.includes(action)) {
    return fail(`${format} 不支持 ${action}（可用：${allowed.join(' / ')}）`, 'UNSUPPORTED');
  }
  return null;
}

function guardSize(file) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) return fail(`${file} 不是文件`, 'NOT_FILE');
    if (st.size > MAX_BYTES) return fail(`文件 ${(st.size / 1048576).toFixed(1)}MB 超过上限 ${MAX_BYTES / 1048576}MB——先拆分再处理`, 'TOO_BIG');
  } catch (e) {
    return fail(`打不开 ${file}：${e.message}`, 'NOT_FOUND');
  }
  return null;
}

// ---------- XML 小工具 ----------

function decodeXml(s) {
  return String(s)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, '&');
}

function encodeXml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * 跨 run 的段落内文字替换（docx 的 `<w:t>` / pptx 的 `<a:t>` 同构）：
 * OOXML 会把一句话切成多个 run（改一个字可能只动其中一段），所以必须**先合并再匹配、再摊回各个 run**。
 * 返回替换后的整段 XML 与命中数。
 */
export function replaceInXml(xml, find, replace, tag = 'w:t') {
  const openTag = `<${tag}`;
  const closeTag = `</${tag}>`;
  const segRe = new RegExp(`<${tag}(\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'g');

  const segments = [];
  let m;
  while ((m = segRe.exec(xml))) {
    segments.push({ full: m[0], attrs: m[1] ?? '', text: decodeXml(m[2]), start: m.index, end: segRe.lastIndex });
  }
  if (!segments.length) return { xml, hits: 0 };

  let hits = 0;
  // 逐个匹配、逐个摊回（每次重算位置——比一次性批量映射更不容易错）
  for (let guard = 0; guard < 1000; guard++) {
    let combined = '';
    const owner = []; // 每个字符属于哪个 segment、段内偏移
    for (let i = 0; i < segments.length; i++) {
      for (let j = 0; j < segments[i].text.length; j++) owner.push([i, j]);
      combined += segments[i].text;
    }
    const at = combined.indexOf(find);
    if (at < 0) break;
    const end = at + find.length;

    // 命中落在哪些 segment 上
    const first = owner[at], last = owner[end - 1];
    if (!first || !last) break;
    for (let i = first[0]; i <= last[0]; i++) {
      const seg = segments[i];
      const from = i === first[0] ? first[1] : 0;
      const to = i === last[0] ? last[1] + 1 : seg.text.length;
      seg.text = seg.text.slice(0, from) + (i === first[0] ? replace : '') + seg.text.slice(to);
    }
    hits++;
  }
  if (!hits) return { xml, hits: 0 };

  // 摊回：按段落顺序重建（保 attrs；有前后空格时补 xml:space="preserve"）
  let out = '';
  let cursor = 0;
  for (const seg of segments) {
    out += xml.slice(cursor, seg.start);
    const needsPreserve = /^\s|\s$/.test(seg.text) && !/xml:space|preserve/.test(seg.attrs);
    const attrs = needsPreserve ? `${seg.attrs} xml:space="preserve"` : seg.attrs;
    out += seg.text.length === 0 ? '' : `${openTag}${attrs}>${encodeXml(seg.text)}${closeTag}`;
    cursor = seg.end;
  }
  out += xml.slice(cursor);
  return { xml: out, hits };
}

// ---------- docx ----------

async function inspectDocx(file) {
  const mammoth = await import('mammoth');
  const { value: html } = await mammoth.convertToHtml({ path: file });
  const { value: text } = await mammoth.extractRawText({ path: file });
  const paras = String(text).split(/\n{2,}/).filter((p) => p.trim()).length;
  return {
    ok: true,
    output: `【Word 文档】${path.basename(file)}\n段落 ${paras} 段，约 ${String(text).trim().length} 字。${READ_DECLARATION}\n\n${String(text).trim().slice(0, 2500)}`,
    html: String(html),
    text: String(text),
  };
}

/** docx 改：OOXML 直改（jszip），保留原样式 */
async function modifyDocx(file, changes, saveAs) {
  const buf = fs.readFileSync(file);
  const zip = await JSZip.loadAsync(buf);
  const targets = Object.keys(zip.files).filter((n) => /^word\/(document|header\d*|footer\d*|footnotes)\.xml$/.test(n));
  if (!targets.length) return fail('这个 .docx 结构看不懂（没有 word/document.xml）', 'BAD_DOCX');

  const per = new Map();  // 每个 change 的命中数
  changes.forEach((c, i) => per.set(i, 0));

  for (const name of targets) {
    let xml = await zip.file(name).async('string');
    // 段落级替换：按 <w:p> 切段，段内跨 run 匹配
    xml = xml.replace(/<w:p[\s>][\s\S]*?<\/w:p>/g, (para) => {
      let out = para;
      changes.forEach((c, i) => {
        if (c.kind !== 'replace') return;
        const r = replaceInXml(out, c.find, c.replace ?? '', 'w:t');
        if (r.hits > 0) { out = r.xml; per.set(i, per.get(i) + r.hits); }
      });
      return out;
    });
    zip.file(name, xml);
  }
  const counts = changes.map((c, i) => ({ change: c, hits: per.get(i) }));
  return finishModify({ format: 'docx', zip, counts, file, saveAs });
}

// ---------- pptx ----------

async function inspectPptx(file) {
  const zip = await JSZip.loadAsync(fs.readFileSync(file));
  const slides = Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => Number(a.match(/(\d+)/)[1]) - Number(b.match(/(\d+)/)[1]));
  const parts = [];
  for (const [i, name] of slides.entries()) {
    const xml = await zip.file(name).async('string');
    const texts = [...xml.matchAll(/<a:t[^>]*>([\s\S]*?)<\/a:t>/g)].map((m) => decodeXml(m[1]));
    parts.push(`— 第 ${i + 1} 页 —\n${texts.join('\n')}`);
  }
  return {
    ok: true,
    output: `【PPT】${path.basename(file)}\n共 ${slides.length} 页。${READ_DECLARATION}\n\n${parts.join('\n\n').slice(0, 2500)}`,
    text: parts.join('\n'),
    pages: slides.length,
  };
}

async function modifyPptx(file, changes, saveAs) {
  const zip = await JSZip.loadAsync(fs.readFileSync(file));
  const slides = Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n));
  const per = new Map();
  changes.forEach((c, i) => per.set(i, 0));
  for (const name of slides) {
    let xml = await zip.file(name).async('string');
    xml = xml.replace(/<a:p>[\s\S]*?<\/a:p>/g, (para) => {
      let out = para;
      changes.forEach((c, i) => {
        if (c.kind !== 'replace') return;
        const r = replaceInXml(out, c.find, c.replace ?? '', 'a:t');
        if (r.hits > 0) { out = r.xml; per.set(i, per.get(i) + r.hits); }
      });
      return out;
    });
    zip.file(name, xml);
  }
  const counts = changes.map((c, i) => ({ change: c, hits: per.get(i) }));
  return finishModify({ format: 'pptx', zip, counts, file, saveAs });
}

// ---------- xlsx ----------

async function loadExcel(file) {
  const ExcelJS = (await import('exceljs')).default ?? (await import('exceljs'));
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  return wb;
}

function cellRefOf(cell) { return cell.fullAddress ?? cell.address; }

async function inspectXlsx(file) {
  const wb = await loadExcel(file);
  const parts = [];
  for (const ws of wb.worksheets) {
    const rows = [];
    ws.eachRow({ includeEmpty: false }, (row, n) => {
      if (n > 30) return;
      rows.push(row.values.slice(1).map((v) => cellText(v)).join(' | '));
    });
    parts.push(`— 工作表「${ws.name}」（${ws.rowCount} 行 × ${ws.columnCount} 列）—\n${rows.join('\n')}`);
  }
  return {
    ok: true,
    output: `【Excel】${path.basename(file)}\n共 ${wb.worksheets.length} 个工作表。${READ_DECLARATION}\n\n${parts.join('\n\n').slice(0, 2500)}`,
    text: parts.join('\n'),
    sheets: wb.worksheets.map((w) => w.name),
  };
}

function cellText(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') {
    if (v.richText) return v.richText.map((r) => r.text).join('');
    if (v.text !== undefined) return String(v.text);
    if (v.result !== undefined) return String(v.result);
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    return JSON.stringify(v);
  }
  return String(v);
}

async function modifyXlsx(file, changes, saveAs) {
  const wb = await loadExcel(file);
  const counts = [];
  for (const c of changes) {
    if (c.kind === 'cell') {
      const ws = c.sheet ? wb.getWorksheet(c.sheet) : wb.worksheets[0];
      if (!ws) return fail(`没有工作表「${c.sheet}」`, 'NO_SHEET');
      const prev = cellText(ws.getCell(c.cell).value);
      ws.getCell(c.cell).value = c.value;
      counts.push({ change: c, hits: 1, detail: `${c.cell}: ${prev || '(空)'} → ${c.value}` });
      continue;
    }
    if (c.kind === 'replace') {
      let hits = 0;
      for (const ws of wb.worksheets) {
        ws.eachRow({ includeEmpty: false }, (row) => {
          row.eachCell({ includeEmpty: false }, (cell) => {
            const t = cellText(cell.value);
            if (t.includes(c.find)) {
              cell.value = c.find === t ? c.replace : t.split(c.find).join(c.replace);
              hits++;
            }
          });
        });
      }
      counts.push({ change: c, hits });
      continue;
    }
    return fail(`Excel 不支持这种改法：${c.kind ?? '(未指定)'}（可用 replace / cell）`, 'UNSUPPORTED');
  }
  // 自证：重新读一遍，逐项核对
  const out = await buildAndVerifyXlsx(wb, counts);
  if (!out.ok) return out;
  return writeVerified(out.bytes, file, saveAs, counts, 'xlsx');
}

async function buildAndVerifyXlsx(wb, counts) {
  const bytes = Buffer.from(await wb.xlsx.writeBuffer());
  const check = await verifyBytes('xlsx', bytes, counts);
  if (!check.ok) return fail(check.message, 'SELF_CHECK_FAILED');
  return { ok: true, bytes };
}

async function inspectPdf(file) {
  const { PDFParse } = await import('pdf-parse');
  const data = new Uint8Array(fs.readFileSync(file));
  const parser = new PDFParse({ data });
  const r = await parser.getText();
  const fields = await pdfFormFields(data);
  await parser.destroy?.();
  const fieldNote = fields.length ? `\n可填表单字段：${fields.map((f) => `${f.name}${f.value ? `（现为"${f.value}"）` : ''}`).join('、')}` : '';
  return {
    ok: true,
    output: `【PDF】${path.basename(file)}\n共 ${r.total ?? 1} 页。${READ_DECLARATION}${fieldNote}\n\n${String(r.text).replace(/-- \d+ of \d+ --/g, '').trim().slice(0, 2500)}`,
    text: String(r.text),
    pages: r.total ?? 1,
    fields,
  };
}

async function pdfFormFields(data) {
  try {
    const { PDFDocument } = await import('pdf-lib');
    const doc = await PDFDocument.load(data, { ignoreEncryption: true });
    const form = doc.getForm();
    return form.getFields().map((f) => {
      const name = f.getName();
      let value = '';
      try { value = String(f.getText?.() ?? ''); } catch { value = ''; }
      return { name, type: f.constructor.name, value };
    });
  } catch { return []; }
}

async function modifyPdf(file, changes, saveAs) {
  const { PDFDocument, degrees } = await import('pdf-lib');
  const doc = await PDFDocument.load(fs.readFileSync(file), { ignoreEncryption: true });
  const counts = [];
  const pages = doc.getPages();

  for (const c of changes) {
    if (c.kind === 'field') {
      try {
        const form = doc.getForm();
        const field = form.getField(c.name);
        if (typeof field.setText === 'function') field.setText(String(c.value ?? ''));
        else if (typeof field.check === 'function') field.check();
        counts.push({ change: c, hits: 1, detail: `表单字段 ${c.name} → ${c.value}` });
      } catch (e) {
        counts.push({ change: c, hits: 0, detail: `没有这个表单字段：${c.name}（${e.message}）` });
      }
      continue;
    }
    if (c.kind === 'page') {
      const idx = Number(c.page) - 1;
      const page = pages[idx];
      if (!page) { counts.push({ change: c, hits: 0, detail: `没有第 ${c.page} 页（共 ${pages.length} 页）` }); continue; }
      if (c.op === 'rotate') { page.setRotation(degrees(Number(c.degrees ?? 90))); counts.push({ change: c, hits: 1, detail: `第 ${c.page} 页旋转 ${c.degrees ?? 90}°` }); }
      else if (c.op === 'remove') { doc.removePage(idx); counts.push({ change: c, hits: 1, detail: `删除第 ${c.page} 页` }); }
      else { counts.push({ change: c, hits: 0, detail: `PDF 页面操作只支持 rotate / remove，收到 ${c.op}` }); }
      continue;
    }
    counts.push({ change: c, hits: 0, detail: `PDF 不支持这种改法：${c.kind ?? '(未指定)'}（可用 field 表单 / page 页面操作；改正文文字请走 Word 转档）` });
  }
  doc.setProducer?.('灵核 LHCD');
  return finishModify({ format: 'pdf', doc, counts, file, saveAs });
}

// ---------- 收尾：三条硬规矩在这里落地 ----------

/** ② 改不到就不产出 + ③ 改了要自证 → 全过了才写文件（且是**新文件**，① 绝不原地覆盖） */
async function finishModify({ format, zip, doc, counts, file, saveAs }) {
  const missed = counts.filter((c) => c.hits === 0);
  if (missed.length) {
    return fail(
      `有 ${missed.length} 处没改到，我**没有**产出文件（不让"没改动的副本"冒充改好了）：\n` +
      missed.map((c) => `· ${describeChange(c.change)}：${c.detail ?? '原文里找不到这段文字'}`).join('\n'),
      'NO_HIT',
    );
  }
  const short = counts.filter((c) => c.change.kind === 'replace' && c.change.expected !== undefined && c.hits !== c.change.expected);
  if (short.length) {
    return fail(
      `有 ${short.length} 处**只改到一部分**，我**没有**产出文件：\n` +
      short.map((c) => `· ${describeChange(c.change)}：说要改 ${c.change.expected} 处，实际命中 ${c.hits} 处`).join('\n'),
      'PARTIAL',
    );
  }
  let bytes;
  try {
    bytes = zip ? await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }) : Buffer.from(await doc.save());
  } catch (e) {
    return fail(`生成新文件失败：${e.message}`, 'BUILD_FAILED');
  }
  const check = await verifyBytes(format, bytes, counts);
  if (!check.ok) return fail(check.message, 'SELF_CHECK_FAILED');
  return writeVerified(bytes, file, saveAs, counts, format);
}

async function verifyBytes(format, bytes, counts) {
  try {
    if (format === 'docx' || format === 'pptx') {
      const zip = await JSZip.loadAsync(bytes);
      const names = Object.keys(zip.files);
      const parts = names.filter((n) => format === 'docx' ? /^word\/(document|header\d*|footer\d*)\.xml$/.test(n) : /^ppt\/slides\/slide\d+\.xml$/.test(n));
      let all = '';
      for (const n of parts) all += decodeXml(String(await zip.file(n).async('string')).replace(/<[^>]+>/g, ''));
      // 每处"改成的新文字"必须真的在文件里（证明改动落进去了）
      const missing = counts.filter((c) => c.change.kind === 'replace' && !String(c.change.replace ?? '').split('\n').every((piece) => !piece || all.includes(piece)));
      if (missing.length) return { ok: false, message: `自证没过：改完读回来，有 ${missing.length} 处新文字不在文件里（我没有产出文件）` };
      return { ok: true, bytes };
    }
    if (format === 'xlsx') {
      const ExcelJS = (await import('exceljs')).default ?? (await import('exceljs'));
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(bytes);
      for (const c of counts) {
        if (c.change.kind === 'cell') {
          const ws = c.change.sheet ? wb.getWorksheet(c.change.sheet) : wb.worksheets[0];
          if (cellText(ws?.getCell(c.change.cell).value) !== String(c.change.value)) {
            return { ok: false, message: `自证没过：${c.change.cell} 写进去的不是期望的值（我没有产出文件）` };
          }
        }
      }
      return { ok: true, bytes };
    }
    if (format === 'pdf') {
      const { PDFParse } = await import('pdf-parse');
      const parser = new PDFParse({ data: new Uint8Array(bytes) });
      const r = await parser.getText();
      await parser.destroy?.();
      return { ok: true, bytes, text: r.text };
    }
  } catch (e) {
    return { ok: false, message: `自证时读不回产物（${e.message}）——我没有产出文件` };
  }
  return { ok: true, bytes };
}

/**
 * 目标路径是不是**原件本身**（防原地覆盖的判据）。
 * 不能只比字符串：`./a.docx` vs `a.docx`、软链接、硬链接、macOS 大小写不敏感卷（`A.docx` vs `a.docx`）
 * 指的都是同一个文件——比 inode 才归得干净。目标还不存在时退化成"父目录真身 + 文件名"比较。
 */
export function sameTarget(a, b) {
  const ra = path.resolve(String(a));
  const rb = path.resolve(String(b));
  if (ra === rb) return true;
  try {
    const sa = fs.statSync(ra);
    const sb = fs.statSync(rb);
    return sa.dev === sb.dev && sa.ino === sb.ino;
  } catch { /* 目标还不存在——走下面的父目录真身比较 */ }
  try {
    return path.join(fs.realpathSync(path.dirname(ra)), path.basename(ra))
      === path.join(fs.realpathSync(path.dirname(rb)), path.basename(rb));
  } catch {
    return false;
  }
}

/** 覆盖原件的统一话术（三处闸门共用一套说法，用户看到的前后一致） */
const SAME_PATH_MESSAGE = '不能覆盖原件。我可以另存为新文件，或你确认后我先备份再改。';

function writeVerified(bytes, file, saveAs, counts, format) {
  if (saveAs && sameTarget(saveAs, file)) return fail(SAME_PATH_MESSAGE, 'SAME_PATH');
  const target = saveAs || defaultSaveAs(file);
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes);
  } catch (e) {
    return fail(`写新文件失败：${e.message}`, 'WRITE_FAILED');
  }
  const lines = counts.map((c) => `· ${describeChange(c.change)}${c.hits > 1 ? `（${c.hits} 处）` : ''}${c.detail ? `：${c.detail}` : ''}`);
  return {
    ok: true,
    output: `改好了，**另存为新文件**（原件没动）：${target}\n${lines.join('\n')}\n（我读回来核对过，改动都在里面）`,
    path: target,
    hits: counts.reduce((n, c) => n + c.hits, 0),
    source: file,
  };
}

export function defaultSaveAs(file) {
  const dir = path.dirname(file);
  const ext = path.extname(file);
  const base = path.basename(file, ext);
  return path.join(dir, `${base}_改${ext}`);
}

function describeChange(c) {
  if (!c) return '(空改动)';
  if (c.kind === 'replace') return `把「${String(c.find).slice(0, 30)}」改成「${String(c.replace ?? '').slice(0, 30)}」`;
  if (c.kind === 'cell') return `${c.sheet ? c.sheet + '!' : ''}${c.cell} 设为「${c.value}」`;
  if (c.kind === 'field') return `表单字段 ${c.name} 填「${c.value}」`;
  if (c.kind === 'page') return `第 ${c.page} 页 ${c.op}`;
  return c.kind;
}

// ---------- 建 / 转 / 校验 / 预览 ----------

async function createOffice({ format, saveAs, title, text, rows, headings }) {
  const bad = ensureSupported(format, 'create');
  if (bad) return bad;
  if (!saveAs) return fail('create 需要 saveAs（新文件的路径）', 'BAD_ARGS');
  // 新建 ≠ 覆盖：目标已经存在就换名字（红线①"绝不原地覆盖"，这里最容易踩）
  if (fs.existsSync(saveAs)) {
    return fail(`那里已经有文件了：${saveAs}。换个名字我就建（我不会把已有文件覆盖掉）。`, 'ALREADY_EXISTS');
  }
  try {
    fs.mkdirSync(path.dirname(saveAs), { recursive: true });
    if (format === 'docx') {
      const docx = await import('docx');
      const paras = String(text ?? '').split('\n').filter((l) => l.trim()).map((l) => new docx.Paragraph({ text: l }));
      const doc = new docx.Document({
        sections: [{ children: [title ? new docx.Paragraph({ text: String(title), heading: docx.HeadingLevel.HEADING_1 }) : null, ...paras].filter(Boolean) }],
      });
      fs.writeFileSync(saveAs, Buffer.from(await docx.Packer.toBuffer(doc)));
      return { ok: true, output: `已新建 Word：${saveAs}`, path: saveAs };
    }
    if (format === 'xlsx') {
      const ExcelJS = (await import('exceljs')).default ?? (await import('exceljs'));
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet(title ? String(title).slice(0, 28) : 'Sheet1');
      if (Array.isArray(headings) && headings.length) ws.addRow(headings.map(String));
      for (const row of Array.isArray(rows) ? rows : []) ws.addRow(Array.isArray(row) ? row : [row]);
      if (!rows?.length && text) for (const line of String(text).split('\n')) ws.addRow(line.split(/\t|,/).map((s) => s.trim()));
      await wb.xlsx.writeFile(saveAs);
      return { ok: true, output: `已新建 Excel：${saveAs}`, path: saveAs };
    }
    if (format === 'pdf') {
      const { PDFDocument, StandardFonts } = await import('pdf-lib');
      const doc = await PDFDocument.create();
      const font = await doc.embedFont(StandardFonts.Helvetica);
      const lines = String(text ?? title ?? '').split('\n').flatMap((l) => wrap(l, 80));
      const perPage = 40;
      for (let i = 0; i < Math.max(1, Math.ceil(lines.length / perPage)); i++) {
        const page = doc.addPage([595, 842]); // A4
        lines.slice(i * perPage, (i + 1) * perPage).forEach((line, j) => {
          // pdf-lib 标准字体不支持中文——非 ASCII 行跳过（避免画出来是乱码/抛错）
          if (!/^[\x20-\x7e]*$/.test(line)) return;
          page.drawText(line, { x: 50, y: 790 - j * 18, size: 11, font });
        });
      }
      fs.writeFileSync(saveAs, Buffer.from(await doc.save()));
      const skipped = lines.some((l) => !/^[\x20-\x7e]*$/.test(l));
      return { ok: true, output: `已新建 PDF：${saveAs}${skipped ? '（注意：PDF 建文件只支持英文，含中文的行我没写进去——中文文档请新建 Word/Excel）' : ''}`, path: saveAs };
    }
    return fail(`${format} 不支持新建（可用：docx / xlsx / pdf）`, 'UNSUPPORTED');
  } catch (e) {
    return fail(`新建失败：${e.message}`, 'CREATE_FAILED');
  }
}

function wrap(line, width) {
  const s = String(line);
  const out = [];
  for (let i = 0; i < s.length; i += width) out.push(s.slice(i, i + width));
  return out.length ? out : [''];
}

/** 转格式只产出纯文本——二进制目标写出来的是打不开的假文件（不假成功红线） */
export const CONVERT_TARGETS = ['txt', 'md', 'html', 'csv'];

async function convertOffice({ file, to, saveAs }) {
  const format = formatOf(file);
  const bad = ensureSupported(format, 'convert');
  if (bad) return bad;
  const target = String(to ?? 'txt').toLowerCase().replace(/^\./, '');
  if (!CONVERT_TARGETS.includes(target)) {
    return fail(`${format} 转不了 .${target}（转格式只出纯文本：${CONVERT_TARGETS.join(' / ')}）；要另一种 Office 格式请说明，那得单独做`, 'UNSUPPORTED');
  }
  const targetPath = saveAs || path.join(path.dirname(file), `${path.basename(file, path.extname(file))}.${target}`);
  // 转出来的东西绝不能落回原件头上（`to` 与原件同后缀、或 saveAs 指回原件，都会把原件毁了）
  if (sameTarget(targetPath, file)) return fail(SAME_PATH_MESSAGE, 'SAME_PATH');
  try {
    let content = '';
    if (target === 'csv' && format === 'xlsx') {
      const wb = await loadExcel(file);
      const ws = wb.worksheets[0];
      const rows = [];
      ws.eachRow((row) => rows.push(row.values.slice(1).map((v) => {
        const t = cellText(v);
        return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
      }).join(',')));
      content = rows.join('\n');
    } else if (format === 'docx') {
      const mammoth = await import('mammoth');
      content = target === 'html'
        ? (await mammoth.convertToHtml({ path: file })).value
        : target === 'md'
          ? (await mammoth.convertToMarkdown({ path: file })).value
          : (await mammoth.extractRawText({ path: file })).value;
    } else if (format === 'pdf') {
      const { PDFParse } = await import('pdf-parse');
      const parser = new PDFParse({ data: new Uint8Array(fs.readFileSync(file)) });
      content = String((await parser.getText()).text).replace(/-- \d+ of \d+ --/g, '');
      await parser.destroy?.();
    } else if (format === 'xlsx') {
      const wb = await loadExcel(file);
      content = wb.worksheets.map((ws) => {
        const rows = [];
        ws.eachRow((row) => rows.push(row.values.slice(1).map(cellText).join('\t')));
        return `# ${ws.name}\n${rows.join('\n')}`;
      }).join('\n\n');
    } else if (format === 'pptx') {
      const r = await inspectPptx(file);
      content = r.text;
    }
    fs.writeFileSync(targetPath, content, 'utf8');
    return { ok: true, output: `转好了：${targetPath}（${content.length} 字符）`, path: targetPath };
  } catch (e) {
    return fail(`转格式失败：${e.message}`, 'CONVERT_FAILED');
  }
}

/** 校验：把"我改的都在"变成机器可验的结论 */
async function validateOffice({ file, contains = [], absent = [] }) {
  const format = formatOf(file);
  if (!format) return fail('只认 .docx / .xlsx / .pptx / .pdf', 'BAD_FORMAT');
  let text = '';
  try {
    if (format === 'xlsx') text = (await inspectXlsx(file)).text;
    else if (format === 'pptx') text = (await inspectPptx(file)).text;
    else if (format === 'pdf') text = (await inspectPdf(file)).text;
    else text = (await inspectDocx(file)).text;
  } catch (e) {
    return fail(`校验时读不回：${e.message}`, 'VERIFY_READ_FAILED');
  }
  const missing = contains.filter((s) => !text.includes(s));
  const leftover = absent.filter((s) => text.includes(s));
  if (missing.length || leftover.length) {
    return fail(
      [
        missing.length ? `该在的没在：${missing.map((s) => `「${s}」`).join('、')}` : '',
        leftover.length ? `该没的还在：${leftover.map((s) => `「${s}」`).join('、')}` : '',
      ].filter(Boolean).join('；'),
      'VALIDATE_FAILED',
    );
  }
  return { ok: true, output: `核对过了：${contains.length} 项该在的都在${absent.length ? `，${absent.length} 项该没的都没了` : ''}。` };
}

async function previewOffice({ file }) {
  const format = formatOf(file);
  if (!format) return fail('只认 .docx / .xlsx / .pptx / .pdf', 'BAD_FORMAT');
  try {
    if (format === 'docx') {
      const r = await inspectDocx(file);
      return { ok: true, output: `预览：${path.basename(file)}`, html: r.html, path: file, kind: 'html' };
    }
    if (format === 'xlsx') {
      const wb = await loadExcel(file);
      const html = wb.worksheets.map((ws) => {
        const rows = [];
        ws.eachRow((row, n) => { if (n <= 200) rows.push(`<tr>${row.values.slice(1).map((v) => `<td>${escapeHtml(cellText(v))}</td>`).join('')}</tr>`); });
        return `<h4>${escapeHtml(ws.name)}</h4><table>${rows.join('')}</table>`;
      }).join('');
      return { ok: true, output: `预览：${path.basename(file)}`, html, path: file, kind: 'html' };
    }
    const text = format === 'pdf' ? (await inspectPdf(file)).text : (await inspectPptx(file)).text;
    return { ok: true, output: `预览：${path.basename(file)}`, html: `<pre>${escapeHtml(text.slice(0, 20000))}</pre>`, path: file, kind: 'text' };
  } catch (e) {
    return fail(`预览失败：${e.message}`, 'PREVIEW_FAILED');
  }
}

function escapeHtml(s) {
  return String(s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
}

// ---------- 对外统一入口（宿主注入给 brain 的 OfficePort） ----------

export function createOfficePort() {
  return {
    async inspect({ file }) {
      const bad = ensureSupported(formatOf(file), 'inspect') ?? guardSize(file);
      if (bad) return bad;
      const f = formatOf(file);
      return f === 'docx' ? inspectDocx(file) : f === 'xlsx' ? inspectXlsx(file) : f === 'pptx' ? inspectPptx(file) : inspectPdf(file);
    },
    async modify({ file, changes, saveAs }) {
      const bad = ensureSupported(formatOf(file), 'modify') ?? guardSize(file);
      if (bad) return bad;
      if (!Array.isArray(changes) || !changes.length) return fail('modify 需要 changes（要改什么）', 'BAD_ARGS');
      // 覆盖原件的闸门（第一道）：先拦下来，别白读一遍文件再报错
      if (saveAs && sameTarget(saveAs, file)) return fail(SAME_PATH_MESSAGE, 'SAME_PATH');
      const f = formatOf(file);
      try {
        if (f === 'docx') return await modifyDocx(file, changes, saveAs);
        if (f === 'pptx') return await modifyPptx(file, changes, saveAs);
        if (f === 'xlsx') return await modifyXlsx(file, changes, saveAs);
        return await modifyPdf(file, changes, saveAs);
      } catch (e) {
        return fail(`改文档失败：${e.message}`, 'MODIFY_FAILED');
      }
    },
    async create(input) { return createOffice(input); },
    async convert(input) { return convertOffice(input); },
    async validate(input) { return validateOffice(input); },
    async preview(input) { return previewOffice(input); },
  };
}
