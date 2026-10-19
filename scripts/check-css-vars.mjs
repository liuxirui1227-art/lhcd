// CSS 变量引用完整性（全量）—— 扫 `runtime/ui` 下所有页面的 `var(--x)`：**引用了但谁都没定义**的，当场红。
//
// 为什么要有它：普通的字面量扫描只数**页面里的字面量**，数不到"引用了一个不存在的 token"；
//   `var()` 无兜底 → 整条声明在计算值阶段静默失效（颜色直接继承父级，不报错、测试也测不出）。
//
// 四类豁免（都是设计如此，不算漏账）：
//   ① 同文件（或任一被扫文件）里有 `--x:` 定义；
//   ② JS 动态设置：同仓库里有 `setProperty('--x'`（如 `--H` / `--obsize` / `--ring-*`）；
//   ③ 名字以 `-` 结尾：模板串拼出来的（`var(--mood-${m.mood})`），静态量不到；
//   ④ 写了兜底 `var(--x, 兜底)`：缺了也不破相（如 `--atmo-img-a`）。
//
// 用法：node scripts/check-css-vars.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UI = path.join(ROOT, 'runtime', 'ui');
const FILES = fs.readdirSync(UI).filter((f) => /\.(html|css|js)$/.test(f));

const defined = new Set();
const jsSet = new Set();
for (const f of FILES) {
  const s = fs.readFileSync(path.join(UI, f), 'utf8');
  for (const m of s.matchAll(/(--[a-zA-Z0-9_-]+)\s*:/g)) defined.add(m[1]);
  for (const m of s.matchAll(/setProperty\(\s*['"](--[a-zA-Z0-9_-]+)['"]/g)) jsSet.add(m[1]);
}

const problems = [];
for (const f of FILES) {
  const s = fs.readFileSync(path.join(UI, f), 'utf8');
  const lines = s.split('\n');
  lines.forEach((line, i) => {
    for (const m of line.matchAll(/var\(\s*(--[a-zA-Z0-9_-]+)\s*([,)])/g)) {
      const name = m[1];
      if (m[2] === ',') continue;              // ④ 有兜底
      if (name.endsWith('-')) continue;        // ③ 模板串拼的
      if (defined.has(name) || jsSet.has(name)) continue;
      problems.push(`${f}:${i + 1}  var(${name}) —— 谁都没定义`);
    }
  });
}

if (problems.length) {
  console.error(`✗ CSS 变量引用完整性：${problems.length} 处引用了不存在的变量（无兜底 → 整条声明静默失效）`);
  for (const p of problems.slice(0, 40)) console.error('  · ' + p);
  if (problems.length > 40) console.error(`  …另有 ${problems.length - 40} 处`);
  process.exit(1);
}
console.log(`✓ CSS 变量引用完整性：${FILES.length} 个文件 · ${defined.size} 个定义 · 无未定义引用`);
