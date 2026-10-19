// 生成 `brain/src/lifecycle/emotion-hant.ts`（繁体情绪词库）
//
// 为什么要有这一步：中文情绪词库是**简体**写的，繁体用户（zh-Hant）说「很難過，特別孤獨」时一条都命中不了——
// 那正是"某一种语言没被覆盖"。做法不是手抄一遍繁体（必然漏），而是**从简体词库按同一份简繁映射生成**，
// 与界面词表用的是同一个映射源（`scripts/zh-hant-map.mjs`），保证两边口径一致。
//
// 用法：node scripts/make-emotion-hant.mjs   （改动中文词库后要重跑；门槛会查生成物是否对齐）
import fs from 'node:fs';
import { toHant } from './zh-hant-map.mjs';

const SRC = 'brain/src/lifecycle/emotion.ts';
const OUT = 'brain/src/lifecycle/emotion-hant.ts';
const src = fs.readFileSync(SRC, 'utf8');
const body = src.slice(src.indexOf('const LEXICON: Record'), src.indexOf('/**\n * 其他语言的词库'));
const rows = [];
let cls = '';
for (const line of body.split('\n')) {
  const m0 = /^\s{2}(\w+): \[/.exec(line);
  if (m0) { cls = m0[1]; continue; }
  for (const m of line.matchAll(/\['([^']+)', (\d+)\]/g)) {
    const hant = toHant(m[1]);
    if (hant !== m[1]) rows.push([cls, hant, Number(m[2])]);   // 只留"真的变了"的那些
  }
}
// 口语梗表（`SLANG`）：同样是中文写的，繁体用户那句也得认得出——按概念 key 生成繁体写法
const slangRows = [];
for (const m of src.matchAll(/\{ key: '([\w-]+)', cls: '(\w+)', zh: \['([^']+)', (\d+)\]/g)) {
  const [, key, c, zh, w] = m;
  const hant = toHant(zh);
  if (hant !== zh) slangRows.push([key, c, hant, Number(w)]);
}

const byCls = {};
for (const [c, t, w] of rows) (byCls[c] ??= []).push([t, w]);
const lines = Object.entries(byCls).map(([c, list]) => `  ${c}: [${list.map(([t, w]) => `['${t}', ${w}]`).join(', ')}],`);
const SLANG_LINES = slangRows.length
  ? slangRows.map(([key, , hant, w]) => `  '${key}': ['${hant}', ${w}],`).join('\n')
  : '  // （目前每个概念的繁体写法都与简体同形，无需额外生成）';
const file = `// ⚠ **本文件由 \`scripts/make-emotion-hant.mjs\` 生成，不要手改**（改了会被下次生成覆盖）。
// 内容 = 简体情绪词库的繁体写法（同一份 \`zh-hant-map.mjs\` 映射生成）——让繁体用户说的话也能被识别到。
// 改动中文词库或口语梗表后请重跑：\`node scripts/make-emotion-hant.mjs\`。
import type { EmotionClass } from './emotion.js';

export const LEXICON_HANT: Record<Exclude<EmotionClass, 'neutral'>, Array<[string, number]>> = {
${lines.join('\n')}
};

/**
 * 口语梗（SLANG 那张表）的繁体写法，按**概念 key** 对回来——繁体用户那条也要认得出。
 * 简体与繁体同形的概念**不在这里**（中文那条本身就命中），查表时用 SLANG_HANT[key] ?? zh。
 */
export const SLANG_HANT: Record<string, [string, number]> = {
${SLANG_LINES}
};
`;
fs.writeFileSync(OUT, file, 'utf8');
const slangTotal = [...src.matchAll(/\{ key: '[\w-]+', cls: '\w+', zh: \['([^']+)', \d+\]/g)].length;
console.log(`emotion-hant.ts 生成：${rows.length} 条繁体词（来源 ${Object.keys(byCls).length} 类）· 口语梗 ${slangRows.length}/${slangTotal} 条需要繁体写法`);
if (src.includes('export const SLANG') && slangTotal === 0) {
  console.error('❌ 口语梗表在源文件里，却一条都没解析到——生成器与源文件的写法已经对不上了');
  process.exit(1);
}
