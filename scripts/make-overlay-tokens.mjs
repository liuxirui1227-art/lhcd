// 覆盖层 token 供给 —— 给三个「刻意不引 ui.css 的页面」（pet / birth / stage）补上它们引用的设计 token。
//
// 为什么需要它：
//   色值收进 `runtime/ui/ui.css` 的 token 后，页面里只留 `var(--token)`。多数页面 link 了 ui.css，
//   但**这三个页面没 link**——它们是透明/深色覆盖层（形象端整屏透明层、出生页/出镜页整屏深色场景），
//   引 ui.css 会一起带进它的全局 `body` 与一堆组件类（.btn/.card/.msg…）。
//   于是这三页引用的 token **一个都解析不出来**；`var()` 没兜底时，
//   「计算值阶段整条声明失效」= 颜色/边框/阴影成片消失（出生页整页变色、形象端环绕菜单与
//   面板没了"底"、气泡变空心）——而且不报错、测试全绿，只有人眼看得见。
//
// 这份生成物 = 只含 token、不含任何组件样式的供给文件（三页在各自 <style> 之前 link 它）。
// 纪律：值只认 ui.css 这一处（本脚本从 ui.css 的 `:root` 里抄），**别手改生成物**；
//      `scripts/check-overlay-tokens.mjs`（门槛）会重跑本脚本比对，手改 / 新引用没补都当场红。
//
// 用法：
//   node scripts/make-overlay-tokens.mjs           # 重新生成 runtime/ui/overlay-tokens.css
//   node scripts/make-overlay-tokens.mjs --dry     # 只打印，不写文件（校验用同一套逻辑）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UI = path.join(ROOT, 'runtime', 'ui');
export const OUT_FILE = path.join(UI, 'overlay-tokens.css');
export const PAGES = ['pet.html', 'birth.html', 'stage.html'];

/** 从 ui.css 的 `:root {}` 块里取全部 token（**只认浅色基准块**：这三个页面不设 data-theme，
 *  跟随系统的暗色分支只覆盖 --glass/--ink 那几只，与它们引用的集合不相交）。 */
function parseUiTokens() {
  const css = fs.readFileSync(path.join(UI, 'ui.css'), 'utf8');
  const start = css.indexOf(':root {');
  if (start < 0) throw new Error('ui.css 里找不到 `:root {`');
  const end = css.indexOf('\n}', start);
  const block = css.slice(start, end);
  const tokens = new Map();      // 保序：按 ui.css 里的出现顺序输出
  for (const m of block.matchAll(/(--[a-zA-Z0-9-]+)\s*:\s*([^;}]+)/g)) {
    if (!tokens.has(m[1])) tokens.set(m[1], m[2].trim());
  }
  return tokens;
}

const REF_RE = /var\(\s*(--[a-zA-Z0-9-]+)/g;

export function build() {
  const uiTokens = parseUiTokens();
  const pageText = new Map(PAGES.map((p) => [p, fs.readFileSync(path.join(UI, p), 'utf8')]));

  // ① 每页引用了哪些 token（var(--x)）
  const referenced = new Set();
  for (const s of pageText.values()) for (const m of s.matchAll(REF_RE)) referenced.add(m[1]);

  // ② 只供给 ui.css 里有的（其余是页面本地定义或 JS 动态设置）
  const needed = new Set([...referenced].filter((v) => uiTokens.has(v)));

  // ③ 传递闭包：被供给的 token 自己若引用了别的 token（如 `--glass-shadow: var(--scrim-38)`），也得有
  for (let changed = true; changed;) {
    changed = false;
    for (const name of [...needed]) {
      for (const m of (uiTokens.get(name) ?? '').matchAll(REF_RE)) {
        if (uiTokens.has(m[1]) && !needed.has(m[1])) { needed.add(m[1]); changed = true; }
      }
    }
  }

  // ④ 页面引用了、但 ui.css 里没有的：应为「页面本地定义」或「JS setProperty」——两者都不是就是真漏账
  const missing = [];
  for (const [page, s] of pageText) {
    const localDefs = new Set([...s.matchAll(/(--[a-zA-Z0-9-]+)\s*:/g)].map((m) => m[1]));
    const jsSet = new Set([...s.matchAll(/setProperty\(\s*['"](--[a-zA-Z0-9-]+)['"]/g)].map((m) => m[1]));
    for (const m of s.matchAll(REF_RE)) {
      const v = m[1];
      if (!uiTokens.has(v) && !localDefs.has(v) && !jsSet.has(v)) missing.push(`${page}: ${v}`);
    }
  }

  const lines = [];
  lines.push('/* ============================================================');
  lines.push('   覆盖层 token 供给（**生成物，别手改**）');
  lines.push('   谁用：pet.html / birth.html / stage.html —— 三个刻意不引 ui.css 的覆盖层页面。');
  lines.push('   为什么：这三个页面不 link ui.css，却引用 ui.css 的 token；不供给 = 变量解析为空、');
  lines.push('   颜色/边框/阴影整片失效（出生页整页变色、形象端环绕菜单与面板没底）。');
  lines.push('   值从 `runtime/ui/ui.css` 的 `:root` 抄来（唯一真源在那边）。');
  lines.push('   重新生成：node scripts/make-overlay-tokens.mjs');
  lines.push('   同源校验：node scripts/check-overlay-tokens.mjs');
  lines.push('   ============================================================ */');
  lines.push(':root {');
  for (const [name, value] of uiTokens) {
    if (needed.has(name)) lines.push(`  ${name}: ${value};`);
  }
  lines.push('}');
  lines.push('');
  return { text: lines.join('\n'), count: needed.size, missing, total: uiTokens.size };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dry = process.argv.includes('--dry');
  const { text, count, missing, total } = build();
  if (missing.length) {
    console.error('⚠ 页面引用了、但 ui.css 没有、页面也没定义、JS 也没设置的 token：');
    for (const m of missing) console.error('   ' + m);
  }
  if (dry) { process.stdout.write(text); }
  else {
    fs.writeFileSync(OUT_FILE, text);
    console.log(`已写出 ${path.relative(ROOT, OUT_FILE)}：${count} 个 token（ui.css 共 ${total} 个）`);
  }
}
