// 存量中文字串提取（**静态 markup**）
//
// 为什么先做静态 markup：它是"界面静止时看得见的每一个字"（标题/按钮/说明/占位符/无障碍标签），
// 抽取方式机械、可核对、**零行为变化**（只加属性，中文原文原地不动 = 回落链的兜底）。
// JS 生成的文案（模板串、Toast、宿主回给用户看的话）量大得多，由 JS 模式处理。
//
// 四条安全规则（都是"不加就会出错"的）：
//   ① **只提叶子文本节点**：`i18n.js` 的 apply() 是 `el.textContent = 译文`——父元素里还有子元素的话，
//      一翻译就把 `<b>` 这些子节点整段抹掉。所以有子元素的父元素**一律跳过**；
//   ② **已经挂过 `data-i18n` 的元素跳过**（幂等：重复跑不会加第二遍）；
//   ③ 属性只提 `placeholder` / `title` / `aria-label`，写成 `data-i18n-placeholder="键"` 这种形式；
//   ④ `<script>` / `<style>` 里的内容**不碰**（那是代码，不是界面文案）。
//
// 键怎么起：`<页名>.<最近的 id 或 class>.<序号>`，同一页里**重复出现的同一句话复用同一个键**。
//
// 用法：
//   node scripts/extract-i18n.mjs --dry      # 只报"还能提多少"（不写文件）
//   node scripts/extract-i18n.mjs            # 提取全部页面
//   node scripts/extract-i18n.mjs quick.html # 只提一页（分批处理用）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UI = path.join(ROOT, 'runtime', 'ui');
const DICT = path.join(ROOT, 'runtime', 'locales', 'zh-CN.json');
const CN = /[\u4e00-\u9fa5]/;
const ATTRS = ['placeholder', 'title', 'aria-label'];
const DRY = process.argv.includes('--dry');
const only = process.argv.slice(2).filter((a) => a.endsWith('.html'));

/** 找出"可安全提取"的位置：返回 [{ tagStart, key, text, kind, attr }] */
function scan(src, page) {
  // 先把 script/style 的区间标出来，扫描时跳过
  const skip = [];
  for (const m of src.matchAll(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi)) skip.push([m.index, m.index + m[0].length]);
  for (const m of src.matchAll(/<!--[\s\S]*?-->/g)) skip.push([m.index, m.index + m[0].length]);   // 注释不是界面文案
  const inSkip = (i) => skip.some(([a, b]) => i >= a && i < b);

  const out = [];
  const stack = [];          // 开标签栈：{ start, name, keyed, section }
  const used = new Map();    // 本页已用过的中文 → 键（同一句话复用）
  const counters = new Map();
  let seq = 0;

  const re = /<(\/?)([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>|([^<]+)/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    if (inSkip(m.index)) continue;
    const [whole, closing, tagName, attrs, selfClose, text] = m;
    if (tagName) {
      if (closing) {
        for (let i = stack.length - 1; i >= 0; i--) {
          if (stack[i].name === tagName.toLowerCase()) { stack.splice(i, 1); break; }
        }
      } else {
        const el = {
          start: m.index,
          name: String(tagName).toLowerCase(),
          keyed: /data-i18n/.test(attrs ?? ''),
          section: (() => {
            const id = /id="([^"]+)"/.exec(attrs ?? '');
            if (id) return id[1].replace(/[^A-Za-z0-9_-]/g, '-');
            const cls = /class="([^"]+)"/.exec(attrs ?? '');
            if (cls) return cls[1].trim().split(/\s+/)[0].replace(/[^A-Za-z0-9_-]/g, '-');
            return stack.length ? stack[stack.length - 1].section : 'page';
          })(),
        };
        if (selfClose) { /* void：不进栈 */ }
        else stack.push(el);
        for (const attr of ATTRS) {
          const am = new RegExp(`${attr}="([^"]*)"`).exec(attrs ?? '');
          if (!am || !CN.test(am[1])) continue;
          if (new RegExp(`data-i18n-${attr}=`).test(attrs ?? '')) continue;
          const text2 = am[1].trim();
          const key = keyFor(page, el.section, text2, used, counters);
          out.push({ tagStart: m.index, key, text: text2, kind: 'attr', attr });
        }
      }
      continue;
    }
    if (text !== undefined) {
      const t = text.trim();
      if (!t || !CN.test(t)) continue;
      const parent = stack[stack.length - 1];
      if (!parent || parent.keyed || parent.void) continue;
      /* ⚠ **必须是叶子**：`i18n.js` 的 apply() 是 `el.textContent = 译文`——父元素里还有别的子元素/
         注释文字的话，一翻译就把它们整段抹掉。判据：这段文字**后面紧跟的下一个标签就是父元素的闭合标签**
         （否则会把注释文字当成 `.entries` 的文案，给它挂上键 → 切语言会把两个按钮抹掉）。 */
      const nextTag = src.indexOf('<', m.index + whole.length);
      const nextName = nextTag < 0 ? '' : (/^<\/([a-zA-Z][\w-]*)/.exec(src.slice(nextTag, nextTag + 40))?.[1] ?? '').toLowerCase();
      if (nextName !== parent.name) continue;
      const key = keyFor(page, parent.section, t, used, counters);
      parent.keyed = true;                       // 同一父元素只提一次
      out.push({ tagStart: parent.start, key, text: t, kind: 'text' });
    }
  }
  return out;
}

function keyFor(page, section, text, used, counters) {
  const prev = used.get(text);
  if (prev) return prev;                        // 同一页同一句话复用
  const sec = section || 'page';
  const n = (counters.get(sec) ?? 0) + 1;
  counters.set(sec, n);
  const key = `${page}.${sec}.${n}`;
  used.set(text, key);
  return key;
}

function dictOf() {
  return JSON.parse(fs.readFileSync(DICT, 'utf8'));
}

/**
 * JS 模式：把**脚本里**的用户可见文案也提出来。
 *
 * 只收**白名单调用点**里的纯字符串字面量——判据是"这个位置一定是在给用户看话"：
 *   · `UI2.Toast('…')` / `UI2.Toast("…")`
 *   · `setResult('id', '…', …)`（设置页的回执行）
 *   · `UI2.SystemCard({ text: '…' })` / `UI2.EmptyState({ title: '…', desc: '…' })`
 * 包成 `DT('键', '原文')`：**原文留在调用点**当兜底（与 `data-i18n` 一个道理），
 * 这样词表缺键时界面照旧是中文，不会变成空白或键名。
 *
 * 不收（有意）：带 `${}` 的模板串、拼字符串、动态变量——那些要参数化，属于后面的批次；
 * 也不收注释里的例子（先剥注释）。
 */
const JS_CALL_PATTERNS = [
  { re: /(UI2\.Toast\(\s*)'([^'\\\n]*[\u4e00-\u9fa5][^'\\\n]*)'/g, key: 'toast' },
  { re: /(UI2\.Toast\(\s*)"([^"\\\n]*[\u4e00-\u9fa5][^"\\\n]*)"/g, key: 'toast' },
  { re: /(setResult\(\s*'[^']+'\s*,\s*)'([^'\\\n]*[\u4e00-\u9fa5][^'\\\n]*)'/g, key: 'result' },
  { re: /(UI2\.SystemCard\(\{\s*text:\s*)'([^'\\\n]*[\u4e00-\u9fa5][^'\\\n]*)'/g, key: 'card' },
  { re: /(UI2\.EmptyState\(\{\s*icon:\s*'[^']*'\s*,\s*title:\s*)'([^'\\\n]*[\u4e00-\u9fa5][^'\\\n]*)'/g, key: 'empty' },
];

/**
 * 带变量的模板串：``` `还差 ${n} 件` ``` → `DT('键', '还差 {p1} 件', { p1: n })`。
 *
 * 为什么必须做：这类是**存量大头**——不做的话，切成英文时界面骨架是英文、
 * **这些动态文案还是中文**。
 *
 * 四条安全规则：
 *   ① `${…}` 里的表达式**原样搬进参数对象**（不改一个字符，只加一层括号）；
 *   ② 里面再套反引号（嵌套模板串）→ **整条跳过**（那种情况解析成本高、收益小，留给人工）；
 *   ③ 只收**含中文**的模板串（纯英文/纯变量拼接不用翻）；
 *   ④ **带结构的不整条提**（详见 `hasMarkup`）——`<div class="…" id="…" data-…>` 这类整条包进 DT，
 *      等于把**选择器/CSS/结构**搬进词表：门槛（`check-i18n.mjs`）只比对**标签名**，
 *      译文里把 `data-size="small"` 写成别的样子，界面上不报错、只是那个控件**失灵**。
 *      这类留给人工：结构留在代码里，只把**文字**包成 DT（manage 的嵌套模板同一批）。
 */
function scanTemplates(src, page) {
  const skip = [];
  for (const m of src.matchAll(/<!--[\s\S]*?-->/g)) skip.push([m.index, m.index + m[0].length]);
  for (const m of src.matchAll(/\/\*[\s\S]*?\*\//g)) skip.push([m.index, m.index + m[0].length]);
  for (const m of src.matchAll(/(^|[^:'"\\])\/\/[^\n]*/g)) skip.push([m.index, m.index + m[0].length]);
  /* ⚠ **正则字面量**与**普通字符串**里的反引号不是模板串**——
     把 `.replace(/`([^`]+)`/g, …)` 里的反引号当成模板开头，会写坏整段代码。
     所以先把这两类区间标出来，扫模板时跳过。 */
  for (const m of src.matchAll(/(?:^|[=(,:;[!&|?{};+\-*/%<>])\s*\/(?![/*])(?:\\.|\[(?:\\.|[^\]\\])*\]|[^/\\\n])+\/[gimsuy]*/g)) {
    skip.push([m.index, m.index + m[0].length]);
  }
  for (const m of src.matchAll(/'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"/g)) skip.push([m.index, m.index + m[0].length]);
  const inSkip = (i) => skip.some(([a, b]) => i >= a && i < b);

  const out = [];
  const skipped = [];
  let n = 0;
  for (let i = 0; i < src.length; i++) {
    if (src[i] !== '`' || inSkip(i)) continue;
    const startIdx = i;
    // 已被 DT(...) 包住的不再处理（幂等）
    if (/DT\(\s*'[^']*'\s*,\s*$/.test(src.slice(Math.max(0, i - 60), i))) continue;
    const end = findTemplateEnd(src, i);
    if (end < 0) continue;
    const raw = src.slice(startIdx, end + 1);
    /* ⚠ **先消费掉整条模板**再决定翻不翻——包括"有嵌套模板"的情况。
       否则外层模板的**结束反引号**会被当成下一轮的开头，一路配对到很远的另一个反引号
       → 整段代码被写坏（如 `bubble.className = \`bubble${c ? \` ${e}\` : ''}\`` 这类嵌套）。 */
    i = end;
    if (raw.includes('${') && hasNestedTemplate(src, startIdx, end)) continue;   // 嵌套模板：整条留给人工
    if (!CN.test(raw)) continue;
    const parts = []; const params = [];
    const inner = raw.slice(1, -1);
    let text = ''; let last = 0; let m2;
    const reExpr = /\$\{([^{}]*)\}/g;
    while ((m2 = reExpr.exec(inner)) !== null) {
      text += inner.slice(last, m2.index);
      const pname = `p${params.length + 1}`;
      params.push({ name: pname, expr: m2[1] });
      text += `{${pname}}`;
      last = m2.index + m2[0].length;
    }
    text += inner.slice(last);
    if (!CN.test(text)) continue;   // 中文全在被插值的表达式里 → 不用翻
    /* ④ 带结构的整条跳过（判定放在**算出文字之后**：这样"跳过"报出来的条数就是
       "本来会被提、但因为带结构而没提"的真数，不把"本来就不含中文"的算进去）。 */
    if (hasMarkup(inner)) { skipped.push(JSON.stringify([...text].slice(0, 46).join(''))); continue; }
    const key = `${page}.js.tpl.${++n}`;
    const paramObj = params.length ? `, { ${params.map((q) => `${q.name}: ${q.expr}`).join(', ')} }` : '';
    out.push({ start: startIdx, end: end + 1, key, text, replacement: `DT('${key}', ${jsStr(text)}${paramObj})` });
  }
  return { found: out, skipped };
}

/** JS 字符串字面量：优先**单引号**（与仓库既有 `DT('键', '原文')` 一个写法）；
    文本里有引号/反斜杠/换行时交回 `JSON.stringify`（它负责转义，别自己糊）。 */
function jsStr(s) {
  if (/['\\\n\r\u2028\u2029]/.test(s)) return JSON.stringify(s);
  return `'${s}'`;
}

/* 可以在词表里整条保留的**纯强调标签**（门槛会逐条比对标签名，译错当场红）；
    其余任何标签（尤其**带属性**的）都算"结构"，整条不整提。 */
const INLINE_TAGS = new Set(['b', 'i', 'em', 'strong', 'br']);
function hasMarkup(inner) {
  for (const m of inner.matchAll(/<\/?([a-zA-Z][\w-]*)([^>]*)>/g)) {
    if (!INLINE_TAGS.has(m[1].toLowerCase())) return true;
    if (m[2].trim()) return true;          // `<b class="…">` 也算结构
  }
  return false;
}

/** 模板串的真正结束位置（正确处理 `${…}` 里的嵌套模板与转义）；找不到返回 -1 */
function findTemplateEnd(src, start) {
  let j = start + 1;
  while (j < src.length) {
    const c = src[j];
    if (c === '\\') { j += 2; continue; }
    if (c === '`') return j;
    if (c === '$' && src[j + 1] === '{') {
      let depth = 0;
      j += 2;
      while (j < src.length) {
        const d = src[j];
        if (d === '\\') { j += 2; continue; }
        if (d === '{') { depth++; j++; continue; }
        if (d === '}') { depth--; j++; if (depth <= 0) break; continue; }
        if (d === '`') { const e2 = findTemplateEnd(src, j); if (e2 < 0) return -1; j = e2 + 1; continue; }
        j++;
      }
      continue;
    }
    j++;
  }
  return -1;
}

/**
 * 这段模板里有没有嵌套模板（有就整条跳过：解析与翻译成本高、收益小）。
 * ⚠ 花括号要**按真正的嵌套算**：`${Object.entries(x ?? {}).map(...)}` 里的 `{}` 是对象字面量——
 * 只在 `${` 时加深度、遇到任何 `}` 就减，会在对象字面量的 `}` 处把深度打回 0，
 * 后面真正的嵌套反引号就认不出来。
 */
function hasNestedTemplate(src, start, end) {
  const body = src.slice(start + 1, end);
  let depth = 0;
  for (let k = 0; k < body.length; k++) {
    const c = body[k];
    if (c === '\\') { k++; continue; }
    if (c === '$' && body[k + 1] === '{') { depth++; k++; continue; }
    if (depth > 0 && c === '{') { depth++; continue; }
    if (depth > 0 && c === '}') { depth--; continue; }
    if (c === '`' && depth > 0) return true;
  }
  return false;
}

/** 提 JS 里的文案：返回 [{ start, end, key, text }]（start/end 是要被 DT(...) 包住的字面量范围） */
function scanJs(src, page) {
  const skip = [];
  for (const m of src.matchAll(/<!--[\s\S]*?-->/g)) skip.push([m.index, m.index + m[0].length]);
  for (const m of src.matchAll(/\/\*[\s\S]*?\*\//g)) skip.push([m.index, m.index + m[0].length]);
  for (const m of src.matchAll(/(^|[^:'"\\])\/\/[^\n]*/g)) skip.push([m.index, m.index + m[0].length]);
  const inSkip = (i) => skip.some(([a, b]) => i >= a && i < b);
  const out = [];
  const counters = new Map();
  for (const { re, key: kind } of JS_CALL_PATTERNS) {
    for (const m of src.matchAll(re)) {
      const litStart = m.index + m[1].length;
      if (inSkip(litStart)) continue;
      // 已经被 DT(...) 包过 → 幂等跳过
      const before = src.slice(Math.max(0, litStart - 4), litStart);
      if (/DT\(\s*$/.test(before) || /DT\(\s*'[^']*'\s*,\s*$/.test(before)) continue;
      const text = m[2];
      const n = (counters.get(kind) ?? 0) + 1;
      counters.set(kind, n);
      out.push({ start: litStart, end: litStart + m[2].length + 2, key: `${page}.js.${kind}.${n}`, text: `'${text}'` });
    }
  }
  return out;
}

const pages = (only.length ? only : fs.readdirSync(UI).filter((f) => f.endsWith('.html'))).sort();
let addedTotal = 0;
let skippedTotal = 0;
const skippedList = [];
for (const page of pages) {
  const file = path.join(UI, page);
  const src = fs.readFileSync(file, 'utf8');
  const found = scan(src, page.replace(/\.html$/, ''));
  // 按 tagStart 分组：同一个标签上一次把属性都插进去
  const byTag = new Map();
  for (const f of found) {
    if (!byTag.has(f.tagStart)) byTag.set(f.tagStart, []);
    byTag.get(f.tagStart).push(f);
  }
  if (DRY) {
    console.log(`${page.padEnd(16)} 可提 ${String(found.length).padStart(4)} 条（${byTag.size} 个标签）`);
    addedTotal += found.length;
    continue;
  }
  // 从后往前插（保证前面的下标不失效）
  let next = src;
  for (const start of [...byTag.keys()].sort((a, b) => b - a)) {
    const items = byTag.get(start);
    const tagEnd = next.indexOf('>', start);
    const head = next.slice(0, tagEnd);
    const extra = items.map((it) => (it.kind === 'attr' ? ` data-i18n-${it.attr}="${it.key}"` : ` data-i18n="${it.key}"`)).join('');
    next = head + extra + next.slice(tagEnd);
  }
  // JS 文案：包成 DT('键', '原文')；带变量的模板串走 scanTemplates（替换整条）
  const jsFound = scanJs(next, page.replace(/\.html$/, ''));
  const tplScan = scanTemplates(next, page.replace(/\.html$/, ''));
  const tplFound = tplScan.found;
  skippedTotal += tplScan.skipped.length;
  for (const s of tplScan.skipped) skippedList.push(`${page}: ${s}`);
  for (const t of [...tplFound].sort((a, b) => b.start - a.start)) {
    next = next.slice(0, t.start) + t.replacement + next.slice(t.end);
  }
  for (const j of [...jsFound].sort((a, b) => b.start - a.start)) {
    next = next.slice(0, j.start) + `DT('${j.key}', ` + next.slice(j.start, j.end) + ')' + next.slice(j.end);
  }
  const dict = dictOf();
  let added = 0;
  for (const f of [...found, ...jsFound.map((j) => ({ key: j.key, text: j.text.slice(1, -1) })), ...tplFound.map((t) => ({ key: t.key, text: t.text }))]) {
    if (dict[f.key] === undefined) { dict[f.key] = f.text; added++; }
    else if (dict[f.key] !== f.text) {
      console.error(`✗ 键冲突：${f.key} 词表里是「${dict[f.key]}」，这里是「${f.text}」——请人工处理`);
      process.exit(1);
    }
  }
  if (next !== src) fs.writeFileSync(file, next, 'utf8');
  if (added) {
    const ordered = Object.fromEntries(Object.entries(dict).sort(([a], [b]) => a.localeCompare(b)));
    fs.writeFileSync(DICT, JSON.stringify(ordered, null, 2) + '\n', 'utf8');
  }
  addedTotal += added;
  console.log(`${page.padEnd(16)} 标签 ${String(found.length).padStart(4)} · JS ${String(jsFound.length).padStart(4)} · 模板串 ${String(tplFound.length).padStart(4)} · 跳过带结构 ${String(tplScan.skipped.length).padStart(2)} · 新增词表 ${String(added).padStart(4)} 条`);
}
if (skippedList.length) {
  console.log(`\nℹ 跳过**带结构**的模板串 ${skippedTotal} 条（里面有 class/id/data-*/标签，整条提会把选择器搬进词表）：`);
  for (const s of skippedList) console.log(`   ${s}`);
  console.log('   处理方式：结构留在代码里、只把**文字**包成 DT（留给人工，和 manage 的嵌套模板同一批）。');
}
console.log(DRY ? `（dry-run）合计可提 ${addedTotal} 条` : `✅ 合计新增 ${addedTotal} 条`);
