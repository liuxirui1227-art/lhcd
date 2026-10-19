// 语法护栏：把"能解析"这件事在门槛里查一遍。
//
// 为什么要单列一步：
//   ① **模板串里写反引号**：页内脚本放在模板字面量里时，注释里一个反引号就把串截断
//      → 语法错。这类错 `node --check` 当场就能报；
//   ② Electron 主进程脚本语法错 → 弹一个错误对话框**干等**（不打印、不退出），
//      外部只会看到"卡住"，排查成本极高。
// 所以：所有 `runtime/*.mjs` + 各页面的**内联脚本**，在门槛里统一过一遍 `node --check`。
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lhcd-syntax-'));
const targets = [];

for (const f of fs.readdirSync(path.join(ROOT, 'runtime'))) {
  if (f.endsWith('.mjs')) targets.push({ name: `runtime/${f}`, file: path.join(ROOT, 'runtime', f) });
}
for (const page of ['home.html', 'conv.html', 'manage.html', 'me.html', 'pet.html', 'arrange.html', 'stage.html', 'quick.html', 'birth.html']) {
  const p = path.join(ROOT, 'runtime', 'ui', page);
  if (!fs.existsSync(p)) continue;
  const html = fs.readFileSync(p, 'utf8');
  const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  if (!blocks.length) continue;
  const out = path.join(tmp, `${page}.js`);
  fs.writeFileSync(out, blocks.join('\n'), 'utf8');
  targets.push({ name: `ui/${page}（内联脚本）`, file: out });
}

/* 逐个 `node --check` 是**进程级**的：179 个文件串行要 48 秒（门槛里太贵）。
   并发 8 路跑 → 稳定在 6~8 秒，仍然是一个文件一个进程（快、且不共享状态）。 */
const queue = [...targets];
const failures = [];
const worker = async () => {
  for (;;) {
    const t = queue.shift();
    if (!t) return;
    try {
      await promisify(execFile)(process.execPath, ['--check', t.file], { encoding: 'utf8' });
    } catch (e) {
      failures.push({ name: t.name, msg: String(e.stderr ?? e.message ?? '').split('\n').slice(0, 6).join('\n') });
    }
  }
};
await Promise.all(Array.from({ length: Math.min(8, targets.length) }, worker));
const bad = failures.length;
for (const f of failures) console.log(`✗ ${f.name}\n${f.msg}`);
fs.rmSync(tmp, { recursive: true, force: true });
console.log(bad ? `语法护栏：${bad} 处不通过（共查 ${targets.length} 个文件）` : `语法护栏 ✅（${targets.length} 个文件全部可解析）`);
process.exit(bad ? 1 : 0);
