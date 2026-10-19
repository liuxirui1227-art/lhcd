// 国际化完整性门——把"词表与代码对得上"这件事放进门槛。
//
// 它挡的是什么（都是"静默失败"，不查就永远不知道）：
//   ① **用了但没有的词**：`data-i18n="manage.foo"` 在词表里没有 → 界面**保持 DOM 原文**（中文），
//      看着没事，切语言时那一条就是原文——**最难发现的一类 i18n bug**；
//   ② **重复键**：JSON 里同一个 key 写两遍，后者静默覆盖前者（`JSON.parse` 不报错）；
//   ③ **空值**：`""` 会让界面变成空白，比缺键更糟（缺键至少回落中文）；
//   ④ **别的语言有、中文没有的键**：翻译挂在空处，永远显示不出来；
//   ⑤ **进度**：各语言翻了多少（**不是门槛**，是给人看的数字）。
//
// 用法：node scripts/check-i18n.mjs [--quiet]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SIMPLIFIED_ONLY as HANT_MAPPED } from './zh-hant-map.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOCALES = path.join(ROOT, 'runtime', 'locales');
const FALLBACK = 'zh-CN';
const QUIET = process.argv.includes('--quiet');
const PAGES = fs.readdirSync(path.join(ROOT, 'runtime', 'ui')).filter((f) => f.endsWith('.html'));
const SOURCES = [
  ...PAGES.map((f) => `runtime/ui/${f}`),
  'runtime/lib.mjs',
  'runtime/main.mjs',
  'runtime/ui/components.js',
  'runtime/ui/i18n.js',
];

/** 原始文本里数重复键（JSON.parse 会把重复键静默吃掉，所以只能扫文本） */
function duplicateKeys(raw) {
  const seen = new Map();
  const dup = [];
  for (const m of raw.matchAll(/^\s*"((?:[^"\\]|\\.)+)"\s*:/gm)) {
    const k = m[1];
    if (seen.has(k)) dup.push(k);
    seen.set(k, true);
  }
  return dup;
}

function readDict(locale) {
  const p = path.join(LOCALES, `${locale}.json`);
  if (!fs.existsSync(p)) return { ok: false, missing: true, keys: [], dict: {}, raw: '' };
  const raw = fs.readFileSync(p, 'utf8');
  try {
    const dict = JSON.parse(raw);
    return { ok: true, missing: false, keys: Object.keys(dict).filter((k) => !k.startsWith('_')), dict, raw };
  } catch (e) {
    return { ok: false, error: String(e.message), keys: [], dict: {}, raw };
  }
}

/** 去掉注释再扫：注释里的示例（如 `[data-i18n="key"]`）不算用法，否则写文档会把门弄红。 */
function stripJsComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1');   // 避开 http:// 与字符串里的 //
}

function stripComments(text, isHtml) {
  /* ⚠ 按文件类型分开剥注释（HTML 里 `//` 太常见：URL、CSS 的 url(//…)、正文里的斜杠，
     统一套 JS 剥法会误删 `data-i18n`）：
     · HTML：先去掉 `<!-- -->`，**只对 `<script>`/`<style>` 块内部**套 JS/CSS 的剥注释；
     · JS：整套都套。 */
  const html = text.replace(/<!--[\s\S]*?-->/g, '');
  if (!isHtml) return stripJsComments(html);
  return html
    .replace(/(<script\b[^>]*>)([\s\S]*?)(<\/script>)/gi, (_m, a, body, c) => a + stripJsComments(body) + c)
    .replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi, (_m, a, body, c) => a + body.replace(/\/\*[\s\S]*?\*\//g, '') + c);
}

/** 代码/页面里**用到的** key（只认字面量：`data-i18n="x"`、`t('x'`、`DT('x'`、`I18N.t('x'`） */
function usedKeys() {
  const used = new Map();   // key → 出处（第一个见到的文件）
  for (const rel of SOURCES) {
    const p = path.join(ROOT, rel);
    if (!fs.existsSync(p)) continue;
    const src = stripComments(fs.readFileSync(p, 'utf8'), rel.endsWith('.html'));
    // 正文与属性两种挂法都算（`data-i18n` / `data-i18n-placeholder` / `-title` / `-aria-label`）
    for (const m of src.matchAll(/data-i18n(?:-[a-z-]+)?="([^"{}]+)"/g)) if (!used.has(m[1])) used.set(m[1], rel);
    // t('k') / DT('k') / I18N.t('k')：只收**带点的**字面量（`t(variable)` 不收——那是动态键）
    /* 认 `t('k')` / `DT('k')` / `I18N.t('k')`，也认 `lib.t('k')`（宿主 main.mjs 就是这么调的）。
       只收**带点的**字面量：`t(variable)` 是动态键，静态扫不到（那类只能靠"用了但没有"这半边兜）。 */
    for (const m of src.matchAll(/(?<![A-Za-z0-9_.])(?:[A-Za-z_$][\w$]*\.)?(?:DT|T|t)\(\s*'([a-z][A-Za-z0-9._-]*\.[A-Za-z0-9._-]+)'/g)) {
      if (!used.has(m[1])) used.set(m[1], rel);
    }
  }
  return used;
}

/**
 * 表驱动键：`{ tag: 'me.mem.src.correction' }` 这种**存在表里**的键，`t(x)` 传的是变量，
 * 静态扫不出"用了它"，但它的字面量就摆在代码里——按"**像我们词表键**"再收一遍：
 * 前缀必须是已知命名空间（`me.` / `manage.` / `app.` …），免得把 `example.com`、`a.txt` 这类误收。
 */
function tableKeys(namespaces) {
  const out = new Map();
  /* 排除"长得像文件名"的：`state.json` / `app.asar` 也带点、也撞命名空间前缀，
     但它们不是词表键（第二次跑就是被这两个弄红的）。 */
  const FILE_EXT = new Set(['json', 'jsonl', 'asar', 'md', 'txt', 'js', 'mjs', 'cjs', 'html', 'css', 'png', 'jpg', 'log', 'ts', 'yml', 'yaml', 'toml']);
  const re = new RegExp(`'((?:${namespaces.join('|')})\\.[A-Za-z0-9._-]+)'`, 'g');
  for (const rel of SOURCES) {
    const p = path.join(ROOT, rel);
    if (!fs.existsSync(p)) continue;
    const src = stripComments(fs.readFileSync(p, 'utf8'), rel.endsWith('.html'));
    for (const m of src.matchAll(re)) {
      const last = m[1].split('.').pop();
      if (FILE_EXT.has(last)) continue;
      if (!out.has(m[1])) out.set(m[1], rel);
    }
  }
  return out;
}

const problems = [];
const zh = readDict(FALLBACK);
if (!zh.ok) {
  problems.push(`✗ ${FALLBACK}.json 读不了：${zh.error ?? '文件不存在'}`);
} else {
  const dup = duplicateKeys(zh.raw);
  if (dup.length) problems.push(`✗ ${FALLBACK}.json 有重复键（后写的会静默覆盖前面的）：${[...new Set(dup)].join(', ')}`);
  const empty = zh.keys.filter((k) => String(zh.dict[k]).trim() === '');
  if (empty.length) problems.push(`✗ ${FALLBACK}.json 有空值（界面会变空白，比缺键更糟）：${empty.join(', ')}`);
}

/* 页面挂了 `data-i18n` 却没引 `i18n.js` = **属性白挂**（界面上什么都不发生）。 */
const noRuntime = [];
for (const f of PAGES) {
  const src = fs.readFileSync(path.join(ROOT, 'runtime', 'ui', f), 'utf8');
  if (/data-i18n/.test(src) && !/i18n\.js/.test(src)) noRuntime.push(f);
}
if (noRuntime.length) problems.push(`✗ 这些页面挂了 data-i18n 却没引 i18n.js（属性白挂，界面上什么都不发生）：${noRuntime.join(', ')}`);

const used = usedKeys();
const namespaces = [...new Set(zh.keys.map((k) => k.split('.')[0]))];
const table = tableKeys(namespaces);
const missing = [...new Map([...used, ...table]).entries()].filter(([k]) => !zh.dict[k]);
if (missing.length) {
  problems.push(`✗ 用了但词表里没有的键 ${missing.length} 个（界面会一直显示中文原文）：\n   `
    + missing.map(([k, f]) => `${k}（${f}）`).join('\n   '));
}

// 其它语言：键必须是中文的子集（挂在不存在的 key 上等于永远显示不出来）
const others = fs.readdirSync(LOCALES).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, '')).filter((l) => l !== FALLBACK);
const progress = [];
for (const l of others) {
  const d = readDict(l);
  if (!d.ok) { problems.push(`✗ ${l}.json 读不了：${d.error ?? '不存在'}`); continue; }
  /* 每种语言都必须与中文词表**逐键对齐**——少一个键，那种语言的用户就会看到一段中文。
     `zh-Hant` 是生成物（`_meta.status = generated`）：少键还意味着"改了中文词表、忘了重跑生成器"
     （那种漏很隐蔽：界面回落显示简体，看着像没翻，其实是没生成）；
     `planned` 的空壳（en/ja/ko）不查这条：它们**本来就该是空的**。 */
  {
    const miss = zh.keys.filter((k) => !(k in d.dict));
    if (miss.length) {
      problems.push(`✗ ${l}.json 比中文词表少 ${miss.length} 个键`
        + (d.dict?._meta?.status === 'generated' ? '（它是生成物：改了中文词表要重跑生成器）' : '（那种语言会露出中文原文）')
        + `：${miss.slice(0, 6).join(', ')}${miss.length > 6 ? ' …' : ''}`);
    }
  }
  /* **不能存在错误**（同一句话的三种"硬错误"，都会让界面直接崩或显示错东西）：
     ① 占位符不一致：中文有 `{name}`、译文没有 → 名字永远填不进去；
     ② HTML 标签不一致：中文有 `<b>…</b>`、译文没有 → 样式丢；反过来更糟（译文带了原文没有的标签）；
     ③ 译文与中文一模一样：多半是漏翻（专有名词除外——那类在下面白名单里）。 */
  {
    const ph = (t) => [...String(t).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
    const tg = (t) => [...String(t).matchAll(/<\/?([a-z][\w-]*)>/gi)].map((m) => m[1].toLowerCase()).sort().join(',');
    /* 同形白名单（**每条都写清为什么**）：
       · 中文就是这几个字，日韩照样用汉字词：社交 / 能力 / 技能 / 音色 / 保存 / 一般 …
       · 纯占位符与品牌名：`{n} / {max}`、`Linghe`、`TA`；
       · 界面名（各语言都叫 Linghe）：page 标题那几条。 */
    const SAME_OK = new Set([
      'me.lang.t', 'manage.lang.t', 'birth.lang.t', 'app.tray.tooltip', 'birth.lockup.1', 'birth.page.1',
      'home.page.1', 'conv.page.1', 'manage.mg-h1.1', 'stage.page.1', 'pet.page.1', 'quick.page.1', 'arrange.page.1',
      'me.mem.rules.count',
      'manage.b-save.1', 'manage.h.4', 'manage.mg-h1.5', 'manage.st-tb.1', 'manage.t.5', 'manage.mg-h1.3',
      'me.tab.persona',   // 人格：日语里就是这个写法
    ]);
    const badPh = []; const badTag = []; const untranslated = [];
    for (const k of d.keys) {
      const zhV = String(zh.dict[k]); const t = String(d.dict[k]);
      if (ph(zhV) !== ph(t)) badPh.push(`${k}（中文 {${ph(zhV)}} vs 译文 {${ph(t)}}）`);
      if (tg(zhV) !== tg(t)) badTag.push(`${k}（中文 <${tg(zhV)}> vs 译文 <${tg(t)}>）`);
      /* "一字不差"到底算不算漏翻，**看这句话里有没有会变的字**：
         · zh-Hant 是映射生成的——没有"会变的字"，那它本来就该同形（退出/能力/保存…）；
         · en/ja/ko 是人翻的——同形多半是漏翻，但**日韩用汉字词**（社交/能力/技能/音色/保存）本来就同形，
           所以那几条进白名单（写得明明白白，不是"眼不见为净"）。 */
      const hasConvertible = l === 'zh-Hant' ? [...zhV].some((c) => HANT_MAPPED.has(c)) : true;
      if (t === zhV && !SAME_OK.has(k) && l !== FALLBACK && hasConvertible) untranslated.push(k);
    }
    if (badPh.length) problems.push(`✗ ${l}.json 占位符对不上 ${badPh.length} 处（名字/数字会填不进去）：${badPh.slice(0, 4).join('；')}${badPh.length > 4 ? ' …' : ''}`);
    if (badTag.length) problems.push(`✗ ${l}.json HTML 标签对不上 ${badTag.length} 处：${badTag.slice(0, 4).join('；')}${badTag.length > 4 ? ' …' : ''}`);
    if (untranslated.length) problems.push(`✗ ${l}.json 有 ${untranslated.length} 条与中文一字不差（多半漏翻；确实是同一写法的请加进白名单）：${untranslated.slice(0, 6).join(', ')}${untranslated.length > 6 ? ' …' : ''}`);
  }
  const orphan = d.keys.filter((k) => !zh.dict[k]);
  if (orphan.length) problems.push(`✗ ${l}.json 里有 ${orphan.length} 个中文词表没有的键（永远显示不出来）：${orphan.slice(0, 8).join(', ')}${orphan.length > 8 ? ' …' : ''}`);
  progress.push(`${l} ${d.keys.length}/${zh.keys.length}`);
}

const allUsed = new Set([...used.keys(), ...table.keys()]);
const unused = zh.keys.filter((k) => !allUsed.has(k));

/* 进度（**不是门槛**，是"还剩多少要搬"）：脚本里还没被 `DT(...)` 包住的中文字面量。
   为什么只报不判红：那些大多是**带变量的模板串**（要参数化）与内部逻辑串，
   一刀切判红会逼着人把不该提的也提走——但数字必须看得见，否则"全覆盖"就成了口号。

   口径：`DT('键', '中文原文')` 里的**兜底原文**算"已经搬过"，排除掉；
   `{ p1: isDir ? '目录' : '文件' }` 这种**参数里**的中文字面量照旧算"还没搬"。 */
function remainingLiterals() {
  let n = 0;
  const per = [];
  for (const f of PAGES) {
    const src = fs.readFileSync(path.join(ROOT, 'runtime', 'ui', f), 'utf8');
    const blocks = [...src.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
    const noC = stripJsComments(blocks);
    const lits = [...noC.matchAll(/'([^'\\\n]*[\u4e00-\u9fa5][^'\\\n]*)'/g)]
      .filter((m) => !/DT\(\s*'[^']*'\s*,\s*$/.test(noC.slice(Math.max(0, m.index - 80), m.index)));
    const tpl = [...noC.matchAll(/`([^`]*[\u4e00-\u9fa5][^`]*)`/g)].length;
    n += lits.length + tpl;
    if (lits.length + tpl) per.push(`${f.replace('.html', '')} ${lits.length + tpl}`);
  }
  return { n, per };
}

if (!QUIET) {
  console.log(`国际化完整性：中文词表 ${zh.keys.length} 条 · 代码/页面用到 ${allUsed.size} 条（其中表驱动 ${table.size} 条）`
    + (others.length ? ` · 其它语言 ${progress.join(' / ')}` : ''));
  {
    const r = remainingLiterals();
    console.log(`ℹ 脚本里还没搬的中文（带变量的模板串 + 内部串，${r.n} 条）：${r.per.join(' · ')}`);
  }
  if (unused.length) {
    // 不算门槛（有些键按条件渲染，静态扫不出来），但要说出来：**词表里有、没人读 = 死功能的候选**
    console.log(`ℹ 词表里有、静态扫不到用的 ${unused.length} 条（可能是按条件渲染，也可能是死键）：${unused.slice(0, 10).join(', ')}${unused.length > 10 ? ' …' : ''}`);
  }
}
/* 非中文语言里**不许再出现裸 `TA`**——它是中文里的中性代词写法，换语言就得跟着换。
   注意：**用户自己取的名字不作要求**（名字是数据：`{name}` 参数、记忆内容、模型名都不查）。 */
for (const lang of ['en', 'ja', 'ko']) {
  const dict = JSON.parse(fs.readFileSync(path.join(ROOT, 'runtime', 'locales', `${lang}.json`), 'utf8'));
  const bad = Object.entries(dict).filter(([k, v]) => !k.startsWith('_') && typeof v === 'string' && /\bTA\b/.test(v));
  if (bad.length) problems.push(`✗ ${lang}.json 里还有 ${bad.length} 条裸 TA（换语言要全换）：${bad.slice(0, 5).map(([k]) => k).join(', ')}`);
}

if (problems.length) {
  console.log(problems.join('\n'));
  console.log(`国际化完整性门：✗ ${problems.length} 类问题`);
  process.exit(1);
}
console.log('国际化完整性门 ✅（键对得上、没有重复/空值）');
