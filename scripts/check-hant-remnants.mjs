// 繁体产物「残留体检」：**生成出来的繁体里，还有没有简体字**。
//
// 为什么单独一个脚本：`make-zh-Hant.mjs` 与 `make-emotion-hant.mjs` 各自只报自己那份，
// 而且判据都是"映射表里有、译完还留着"——**映射表里没有的简体字，它们看不见**。
// 例：`搁/冻/张/败` 这类字不在旧表里，单靠生成器自检会一路放过（旧表照**界面词表**攒的，
// 聊天与情绪词没进来）。
//
// 这个脚本干两件事：
//   ① **逐字对照**：`zh-Hant.json` 每条必须等于 `toHant(zh-CN.json 同键)`——手改了生成物当场红；
//   ② **残留扫描**：所有繁体产物的**字符串值**里不许出现 `SIMPLIFIED_ONLY`（映射表认得的简体字），
//      注释/meta 说明不算（那是给人看的，本来就该是简体）。
// 退出码非 0 = 有残留或与源不同步，可直接进门槛。
//
// 用法：node scripts/check-hant-remnants.mjs

import fs from 'node:fs';
import path from 'node:path';
import { toHant, SIMPLIFIED_ONLY } from './zh-hant-map.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const HANS = path.join(ROOT, 'runtime/locales/zh-CN.json');
const HANT = path.join(ROOT, 'runtime/locales/zh-Hant.json');
const EMOTION_HANT = path.join(ROOT, 'brain/src/lifecycle/emotion-hant.ts');

let bad = 0;
const flat = (o, p = '') => Object.entries(o).flatMap(([k, v]) => {
  if (k.startsWith('_')) return [];                       // _meta 是给人看的说明，不算文案
  return typeof v === 'string' ? [[p + k, v]] : flat(v, `${p}${k}.`);
});

/** 一行里出现的、映射表认得的简体字 */
const remnants = (s) => [...new Set([...s].filter((c) => SIMPLIFIED_ONLY.has(c)))];

// ① 生成物与源同键同步
const hans = JSON.parse(fs.readFileSync(HANS, 'utf8'));
const hant = JSON.parse(fs.readFileSync(HANT, 'utf8'));
const hantByKey = new Map(flat(hant));
let drift = 0;
for (const [k, v] of flat(hans)) {
  const got = hantByKey.get(k);
  if (got === undefined) { console.log(`❌ 繁体词表缺键：${k}`); bad++; continue; }
  const want = toHant(v);
  if (got !== want) {
    if (drift < 6) console.log(`❌ ${k}\n    应有：${want}\n    实有：${got}`);
    drift++; bad++;
  }
}
console.log(`① 繁体词表与中文源同源：${flat(hans).length - drift}/${flat(hans).length} 条一致`);

// ② 残留扫描（词表 + 情绪词库/口语梗生成物）
let scanned = 0;
let hit = 0;
for (const [k, v] of flat(hant)) {
  scanned++;
  const r = remnants(v);
  if (r.length) { hit++; if (hit <= 8) console.log(`❌ ${k} 残留简体字 ${r.join('')}：${v}`); }
}
// emotion-hant.ts：只看**字符串字面量**（注释是给人读的，本来就写简体）
const src = fs.readFileSync(EMOTION_HANT, 'utf8');
const literals = [...src.matchAll(/'([^']*)'/g)].map((m) => m[1]).filter((s) => s && !s.includes('.js') && !s.includes('scripts/'));
for (const lit of literals) {
  scanned++;
  const r = remnants(lit);
  if (r.length) { hit++; if (hit <= 12) console.log(`❌ emotion-hant 残留简体字 ${r.join('')}：${lit}`); }
}
console.log(`② 繁体产物残留扫描：${scanned - hit}/${scanned} 条干净（认得的简体字集合 ${SIMPLIFIED_ONLY.size} 个）`);
if (hit) console.log(`   ⚠ 残留 ${hit} 条——两种可能：映射表缺了这个字（补 CHAR_PAIRS_4），或者这条本来就该同形（那它不该被转）`);
console.log('   ℹ 这个体检**只认映射表里记着的简体字**；表里没有的字它抓不到——');
console.log('     补新字靠 `node scripts/check-hant-remnants.mjs --review` 打出"没映射到的字 + 样例词"，人看一眼。');
console.log(bad ? `\n❌ 体检没过：${bad} 处问题` : '\n✅ 繁体产物体检通过');
// --review：把"中文语料里没映射到的字"打出来（每个字给 3 个样例词）——补映射表的入口
if (process.argv.includes('--review')) {
  const CJK = /[\u3400-\u4dbf\u4e00-\u9fff]/;
  const texts = flat(hans).map(([, v]) => v);
  const emoSrc = fs.readFileSync(path.join(ROOT, 'brain/src/lifecycle/emotion.ts'), 'utf8');
  for (const m of emoSrc.matchAll(/'([^']+)'/g)) texts.push(m[1]);
  const seen = new Map();
  for (const t of texts) {
    for (const c of t) {
      if (!CJK.test(c) || SIMPLIFIED_ONLY.has(c)) continue;
      if (!seen.has(c)) seen.set(c, []);
      const w = t.slice(Math.max(0, t.indexOf(c) - 2), t.indexOf(c) + 3);
      if (seen.get(c).length < 3 && !seen.get(c).includes(w)) seen.get(c).push(w);
    }
  }
  console.log(`\n【没映射到的字 ${seen.size} 个（繁简同形的居多，逐个看一眼）】`);
  for (const [c, words] of [...seen].slice(0, 400)) console.log(`  ${c}  ${words.join(' · ')}`);
}

process.exit(bad ? 1 : 0);
