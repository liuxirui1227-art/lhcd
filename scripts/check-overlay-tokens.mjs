// 覆盖层 token 供给 · 同源校验（门槛步骤）
//
// 挡的是三类「静默失效」，都属于"不查就永远不知道"：
//   ① **生成物被手改 / 忘了重生成**：ui.css 改了值，overlay-tokens.css 还是旧的 → 三页颜色与别处不一致；
//   ② **页面新引用了 token 但没补供给**：`var(--x)` 又解析不出来 → 那条声明静默失效；
//   ③ **页面引用了谁都没定义的 token**（拼错名 / 已删除的 token）——页面本地、JS 动态设置的两类豁免。
//
// 用法：node scripts/check-overlay-tokens.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, OUT_FILE, PAGES } from './make-overlay-tokens.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rel = (p) => path.relative(ROOT, p);
const { text: want, count, missing } = build();
const have = fs.existsSync(OUT_FILE) ? fs.readFileSync(OUT_FILE, 'utf8') : null;

const problems = [];
if (have === null) problems.push(`缺生成物 ${rel(OUT_FILE)} —— 跑 node scripts/make-overlay-tokens.mjs`);
else if (have !== want) {
  const h = new Set(have.split('\n')), w = new Set(want.split('\n'));
  const gone = [...h].filter((l) => !w.has(l) && l.trim() && !l.startsWith('/*'));
  const added = [...w].filter((l) => !h.has(l) && l.trim());
  problems.push(`生成物与 ui.css 不同源（${rel(OUT_FILE)}）：
    该删/该改的行：${gone.slice(0, 8).join(' | ') || '（无）'}
    该补的行：${added.slice(0, 8).join(' | ') || '（无）'}
    → 跑 node scripts/make-overlay-tokens.mjs 重新生成`);
}
for (const m of missing) problems.push(`引用无定义：${m}（页面没定义、ui.css 没有、JS 也没 setProperty）`);

// 三页必须真的 link 了供给文件（否则上面全白做）
for (const p of PAGES) {
  const s = fs.readFileSync(path.join(ROOT, 'runtime', 'ui', p), 'utf8');
  if (!/<link[^>]+overlay-tokens\.css/.test(s)) problems.push(`${p} 没有 link overlay-tokens.css`);
  if (/<link[^>]+ui\.css/.test(s)) problems.push(`${p} 引了 ui.css —— 这三页刻意不引它（见生成物头注释）`);
}

if (problems.length) {
  console.error('✗ 覆盖层 token 供给检查未通过：');
  for (const p of problems) console.error('  · ' + p);
  process.exit(1);
}
console.log(`✓ 覆盖层 token 供给同源：${count} 个 token · 三页均已 link · 无未定义引用`);
