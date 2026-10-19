// 繁体 → 简体归一表生成器（召回侧）。
//
// 为什么需要它：zh-CN / zh-Hant 的检索策略是 **CJK 双字 + 连续命中 + 简繁归一层**，
// **索引与查询都归一化到简体**。否则港台用户拿繁体问句搜他以前用简体存下的记忆
// —— **一条都搜不到**（实测 0.963 → 0.000）。
//
// 三条口径（都有实际教训）：
//   · **映射不另写一份**：反向来自 `zh-hant-map.mjs`（生成 zh-Hant.json 用的同一份 TERMS + 单字对）——
//     两份各写一份必然漂移；
//   · **反面是一对多，不许硬选一个**：`資料` 既可能是"资料"也可能是"数据"，`本機` 既可能是"本机"
//     也可能是"本地"（一个来自单字映射、一个来自地区用语，**在同一层看不出冲突**）。
//     所以归一化返回的是**候选**（第一个是首选），召回侧"任一候选命中即算命中"；
//   · **判据是仓库里真正在用的中文**：候选排序看 `runtime/locales/zh-CN.json` 的出现次数，
//     再用**已上线的繁中文案做回环自检**（繁体归一化回来，简体原文必须在候选里）。
//     这条自检就是生成器的判据：`--check` 模式下它进门槛。
//
// ⚠ 一条**试过但回退**的路：用"繁中文案逐键对齐"反推对应关系（见证法），会抽出一批**错的单字对**
//   （`入→錄`、`機→地`、`採→采/口采`）——最长公共子串把句子里**碰巧相同的字**当成切分点，
//   于是"输入框/輸入框"这类位置被切歪。结论：**对应关系得由策展映射说了算，语料只配当排序依据与自检标尺。**
//
// 用法：`node scripts/make-hans-norm.mjs`（写文件）· `node scripts/make-hans-norm.mjs --check`（只查，红了退出码 1）

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { TERMS, CHARS, toHant } from './zh-hant-map.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const HANS_SRC = path.join(ROOT, 'runtime/locales/zh-CN.json');
const HANT_SRC = path.join(ROOT, 'runtime/locales/zh-Hant.json');
const OUT = path.join(ROOT, 'brain/src/memory/hans.ts');
const CHECK = process.argv.includes('--check');

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
const pureCjk = (s) => s.length > 0 && [...s].every((c) => CJK.test(c));

const corpus = fs.readFileSync(HANS_SRC, 'utf8');
const corpusCount = (s) => {
  let n = 0;
  let i = corpus.indexOf(s);
  while (i !== -1) { n++; i = corpus.indexOf(s, i + 1); }
  return n;
};

const flat = (o) => Object.entries(o).flatMap(([k, v]) => (typeof v === 'string' ? [[k, v]] : flat(v)));

const witnesses = new Map(); // 繁体 → Map(简体 → 权重)
const witness = (hans, hant, w) => {
  if (hans === hant || !pureCjk(hans) || !pureCjk(hant)) return;
  if (!witnesses.has(hant)) witnesses.set(hant, new Map());
  const m = witnesses.get(hant);
  m.set(hans, Math.max(m.get(hans) ?? 0, w));
};

// —— 一、反向映射来自 `zh-hant-map.mjs`（唯一权威：生成 zh-Hant.json 用的就是它） ——
// `回车→Enter` 这种右边带拉丁的必须排除：反过来会把全篇 "Enter" 变成"回车"。
// 权重 = 这个词在我们自己的中文词表里出现多少次（候选排序用；出现多的排前面当首选）。
for (const [hans, hant] of Object.entries(TERMS)) {
  if (pureCjk(hans) && pureCjk(hant)) witness(hans, hant, corpusCount(hans));
}
for (const [hans, hant] of Object.entries(CHARS)) {
  if ([...hans].length === 1 && [...hant].length === 1) witness(hans, hant, corpusCount(hans));
}

// —— 二、拆成"单字表"与"词表"（长的先替）；候选按语料频次排序，第一个是首选 ——
const CHARS_OUT = new Map();
const PHRASES_OUT = new Map();
for (const [hant, m] of witnesses) {
  const cands = [...m.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([h]) => h);
  if ([...hant].length === 1 && cands.every((c) => [...c].length === 1)) CHARS_OUT.set(hant, cands);
  else PHRASES_OUT.set(hant, cands);
}
const PHRASES = [...PHRASES_OUT.entries()].sort((a, b) => b[0].length - a[0].length || (a[0] < b[0] ? -1 : 1));
const ambiguous = [...CHARS_OUT, ...PHRASES].filter(([, c]) => c.length > 1);

// 回环自检要对的那份：已上线的繁中文案（逐键）
const hansJson = JSON.parse(fs.readFileSync(HANS_SRC, 'utf8'));
const hantJson = JSON.parse(fs.readFileSync(HANT_SRC, 'utf8'));
const hantByKey = new Map(flat(hantJson));


const file = `// ⚠ **本文件由 \`scripts/make-hans-norm.mjs\` 生成，不要手改**（改了会被下次生成覆盖）。
// 内容 = 繁体 → 简体的**候选**表（正面映射见 \`scripts/zh-hant-map.mjs\`），供召回侧"简繁归一"用：
// 港台用户用繁体问句，也要能搜到他以前用简体存下的记忆（\`14\` 号 §5.2）。
// 改完 \`zh-hant-map.mjs\` 或 \`runtime/locales/zh-CN.json\` 请重跑：\`node scripts/make-hans-norm.mjs\`。
//
// 词 ${PHRASES.length} 条 · 单字 ${CHARS_OUT.size} 条 · 一对多 ${ambiguous.length} 条
// （一对多的**不硬选**：候选就是全部可能，召回侧"任一命中即算命中"——\`資料\` 既可能是"资料"也可能是"数据"）。

/** 词级候选（已按长度倒序，长的先替）：繁体写法 → 简体候选（第一个是首选） */
const PHRASES: Array<[string, string[]]> = [
${PHRASES.map(([h, c]) => `  ['${h}', [${c.map((x) => `'${x}'`).join(', ')}]],`).join('\n')}
];

/** 单字级候选：繁体字 → 简体候选 */
const CHARS: Record<string, string[]> = {
${[...CHARS_OUT.entries()].map(([h, c]) => `  '${h}': [${c.map((x) => `'${x}'`).join(', ')}],`).join('\n')}
};

export const HANS_STATS = {
  phrases: PHRASES.length,
  chars: ${CHARS_OUT.size},
  ambiguous: ${ambiguous.length},
  /** 回环自检：已上线的繁中文案归一化回来，简体原文落在候选里的比例（生成时实测，见生成器输出） */
  roundTrip: '__RT__',
};

/** 按首字索引，免得每次都扫全表 */
const BY_FIRST = new Map<string, Array<[string, string[]]>>();
for (const [hant, cands] of PHRASES) {
  const k = hant[0]!;
  if (!BY_FIRST.has(k)) BY_FIRST.set(k, []);
  BY_FIRST.get(k)!.push([hant, cands]);
}
const SIGNAL = new Set<string>([...Object.keys(CHARS), ...BY_FIRST.keys()]);

/** 这条文本里有没有"会变体的字"——没有就原样返回，零成本（绝大多数条目走这条） */
function hasSignal(text: string): boolean {
  for (const c of text) if (SIGNAL.has(c)) return true;
  return false;
}

/**
 * 归一化成简体**候选**（第一个是首选，通常就是最可能的那个）。
 *
 * 两条路都给（不硬选一条）：
 *   · 词级优先（「專案→项目」「檔案→文件」——地区用语只能整词换，逐字换会换出鬼话）；
 *   · 逐字兜底（「本機→本机」「清單→清单」——词级映射在这两个字上给的是另一种说法，
 *     但用户也可能就是逐字写的，两条都得留着，否则"本機"永远搜不到他简体存的"本机"）；
 *   · 最后一手是原样保留，保证候选里一定含输入本身（调用方不用特判）。
 * 有歧义时给多个，召回侧"**任一候选命中即算命中**"。cap 是候选数上限。
 */
export function hansCandidates(text: string, cap = 8): string[] {
  const s = String(text);
  if (!hasSignal(s)) return [s];
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (v: string) => { if (!seen.has(v) && out.length < cap) { seen.add(v); out.push(v); } };
  /** 词级优先那条路（会分叉，最多占 cap-2 个名额） */
  const walk = (i: number, acc: string) => {
    if (out.length >= cap - 2) return;
    if (i >= s.length) { push(acc); return; }
    let matched = false;
    for (const [hant, cands] of BY_FIRST.get(s[i]!) ?? []) {
      if (!s.startsWith(hant, i)) continue;
      matched = true;
      for (const c of cands) walk(i + hant.length, acc + c);
    }
    if (matched) return;
    // 没有词级映射就逐字走（不给逐字映射才原样保留）——少了这一步会输出"导入記憶包"这种半成品
    const chars = CHARS[s[i]!];
    if (chars) { for (const c of chars) walk(i + 1, acc + c); return; }
    walk(i + 1, acc + s[i]!);
  };
  walk(0, '');
  /** 逐字那条路（一个候选） */
  let byChar = '';
  let charChanged = false;
  for (const c of s) {
    const cands = CHARS[c];
    if (cands) { byChar += cands[0]!; charChanged = true; } else byChar += c;
  }
  if (charChanged) push(byChar);
  push(s);
  return out;
}

/** 首选归一化（= 第一个候选）。**没变化时原样返回同一个字符串**，调用方可据此跳过第二条路径 */
export function hansNormalize(text: string): string {
  const s = String(text);
  return hasSignal(s) ? hansCandidates(s, 1)[0]! : s;
}
`;

// 先落到临时文件里跑回环自检（自检要 import 生成物），拿到实测数字再落最终文件——
// 这样头注释里印的回环数字是**真跑出来的**，不是手写的。
// （写成 .ts：生成物带类型标注，Node 24 的类型剥离能直接 import 它）
const TMP = path.join(os.tmpdir(), `lhcd-hans-probe-${process.pid}.ts`);
fs.writeFileSync(TMP, file, 'utf8');
const probe = await import(`${TMP}?v=${Date.now()}`);

// —— 三、回环自检：已上线的繁中文案归一化回来，简体原文必须在候选里 ——
// 分母里**摘掉"一侧带拉丁"的键**：回车发送 ↔ Enter發送 不是简繁关系（是 UI 词本身换了说法），
// 反向归一化本来就恢复不出"回车"——把它算进分母只会逼着映射去做一件不该做的事。
let ok = 0;
let exact = 0;
let skipped = 0;
const bad = [];
for (const [k, hans] of flat(hansJson)) {
  const hant = hantByKey.get(k);
  if (typeof hant !== 'string' || hant === hans) continue;
  if (!pureCjk(hans) || !pureCjk(hant)) { skipped++; continue; }
  const cands = probe.hansCandidates(hant);
  if (cands.includes(hans)) ok++; else bad.push({ k, hans, hant, cands });
  if (cands[0] === hans) exact++;
}
const total = ok + bad.length;

console.log(`hans.ts：词 ${PHRASES.length} 条 · 单字 ${CHARS_OUT.size} 条 · 一对多 ${ambiguous.length} 条（${ambiguous.map(([h, c]) => `${h}→${c.join('/')}`).join(' · ') || '无'}）`);
console.log(`回环自检：候选里含简体原文 ${ok}/${total}（另有 ${skipped} 条一侧带拉丁，不算简繁关系）· 首选即原文 ${exact}/${total}`);
if (bad.length) {
  console.log(`⚠ 对不上 ${bad.length} 条（前 8 条）：`);
  for (const b of bad.slice(0, 8)) console.log(`   ${b.k}\n     中：${b.hans}\n     繁：${b.hant}\n     候选：${b.cands.join(' | ')}`);
}

// 顺带看一眼反方向：纯中文的简体文案转繁体，再归一化回来，原文必须在候选里
// （**比的是"在候选里"而不是"等于首选"**：`本机` 转成 `本機` 之后，`本機` 的首选是"本地"
//   ——两条都合法，硬要求首选等于原文是在逼映射做一个它做不到的判断）
let selfBad = 0;
let selfN = 0;
let selfFirst = 0;
const selfBadSample = [];
for (const [, v] of flat(hansJson)) {
  if (!pureCjk(v) || !pureCjk(toHant(v))) continue; // 转出来带拉丁的（回车→Enter）不是简繁关系
  selfN++;
  const back = probe.hansCandidates(toHant(v));
  if (!back.includes(v)) { selfBad++; if (selfBadSample.length < 6) selfBadSample.push(`${v} → ${toHant(v)} → ${back.join(' | ')}`); }
  if (back[0] === v) selfFirst++;
}
console.log(`简→繁→简自洽：原文在候选里 ${selfN - selfBad}/${selfN}（首选即原文 ${selfFirst}/${selfN}）`);
for (const line of selfBadSample) console.log(`   ⚠ ${line}`);

const finalFile = file.replace('__RT__', `${ok}/${total}`);
fs.writeFileSync(OUT, finalFile, 'utf8');
fs.rmSync(TMP, { force: true });

if (CHECK) {
  const disk = fs.readFileSync(OUT, 'utf8');
  const drift = disk !== finalFile;
  console.log(drift ? '❌ 磁盘上的 hans.ts 与映射/语料不同源（重跑 `node scripts/make-hans-norm.mjs`）' : '✅ hans.ts 与映射、语料同源');
  if (drift) {
    const a = disk.split('\n');
    const b = finalFile.split('\n');
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      if (a[i] !== b[i]) { console.log(`   第一处不同在第 ${i + 1} 行：\n     磁盘：${a[i] ?? '(缺)'}\n     应有：${b[i] ?? '(缺)'}`); break; }
    }
  }
  process.exit(drift || bad.length || selfBad ? 1 : 0);
}
