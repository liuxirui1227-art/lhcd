// 情绪识别评测（发布门槛：macro-F1 ≥ 0.8）。用法：node emotion-eval.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyEmotion } from '../brain/dist/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const lines = fs.readFileSync(path.join(__dirname, 'emotion-corpus.jsonl'), 'utf8')
  .split('\n').filter(Boolean).map((l) => JSON.parse(l));

const CLASSES = ['comfort', 'joy', 'sad', 'angry', 'anxious', 'neutral'];
const stat = Object.fromEntries(CLASSES.map((c) => [c, { tp: 0, fp: 0, fn: 0, n: 0 }]));
const errors = [];

for (const item of lines) {
  const pred = classifyEmotion(item.text).emotion;
  stat[item.label].n++;
  if (pred === item.label) stat[item.label].tp++;
  else {
    stat[pred].fp++;
    stat[item.label].fn++;
    errors.push({ text: item.text, label: item.label, pred });
  }
}

let macroF1 = 0;
console.log('分类        精确率   召回率   F1      n');
for (const c of CLASSES) {
  const { tp, fp, fn, n } = stat[c];
  const p = tp + fp > 0 ? tp / (tp + fp) : 0;
  const r = tp + fn > 0 ? tp / (tp + fn) : 0;
  const f1 = p + r > 0 ? (2 * p * r) / (p + r) : 0;
  macroF1 += f1;
  console.log(`${c.padEnd(10)} ${(p * 100).toFixed(0).padStart(5)}%   ${(r * 100).toFixed(0).padStart(5)}%  ${f1.toFixed(2).padStart(5)}  ${n}`);
}
macroF1 /= CLASSES.length;
console.log(`\n总样本 ${lines.length}，macro-F1 = ${macroF1.toFixed(3)} ${macroF1 >= 0.8 ? '✅ 过线' : '❌ 未过线（<0.8）'}`);
if (errors.length > 0) {
  console.log('\n误判样本（前 20）：');
  for (const e of errors.slice(0, 20)) console.log(`  [${e.label}→${e.pred}] ${e.text}`);
  console.log(`（共 ${errors.length} 条误判）`);
}
process.exit(macroF1 >= 0.8 ? 0 : 1);
