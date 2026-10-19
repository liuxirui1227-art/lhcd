// 零依赖 glob 匹配与目录遍历（Runtime 内部用；排除 node_modules/.git/dist）。
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_EXCLUDE = new Set(['node_modules', '.git', 'dist', 'vendor']);

function escapeChar(c: string): string {
  return /[\\^$.*+?()[\]{}|]/.test(c) ? `\\${c}` : c;
}

/** glob 模式 → 正则（支持 ** / * / ? / {a,b}；** 跨目录） */
export function globToRegExp(pattern: string): RegExp {
  let re = '^';
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i]!;
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        i += 2;
        if (pattern[i] === '/') i++;
        re += '.*';
      } else {
        re += '[^/]*';
        i++;
      }
    } else if (c === '?') {
      re += '[^/]';
      i++;
    } else if (c === '{') {
      const end = pattern.indexOf('}', i);
      if (end > i) {
        const opts = pattern.slice(i + 1, end).split(',').map((s) => [...s].map(escapeChar).join(''));
        re += `(${opts.join('|')})`;
        i = end + 1;
      } else {
        re += '\\{';
        i++;
      }
    } else {
      re += escapeChar(c);
      i++;
    }
  }
  return new RegExp(`${re}$`);
}

/** 相对路径是否命中 glob 模式 */
export function matchGlob(relPath: string, pattern: string): boolean {
  return globToRegExp(pattern).test(relPath);
}

/** 递归列出 root 下全部文件（相对路径，/ 分隔；排除默认目录；上限 cap） */
export function walkFiles(root: string, opts: { exclude?: Set<string>; cap?: number } = {}): string[] {
  const exclude = opts.exclude ?? DEFAULT_EXCLUDE;
  const cap = opts.cap ?? 10000;
  const out: string[] = [];
  const walk = (dir: string, rel: string): void => {
    if (out.length >= cap) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= cap) return;
      if (exclude.has(e.name)) continue;
      const abs = path.join(dir, e.name);
      const relPath = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        walk(abs, relPath);
      } else if (e.isFile()) {
        out.push(relPath);
      } else if (e.isSymbolicLink()) {
        try {
          if (fs.statSync(abs).isFile()) out.push(relPath);
        } catch {
          // 断链忽略
        }
      }
    }
  };
  walk(root, '');
  return out.sort();
}

/** 按 glob 模式列文件（相对 root） */
export function listGlob(root: string, pattern: string): string[] {
  const re = globToRegExp(pattern);
  return walkFiles(root).filter((rel) => re.test(rel));
}
