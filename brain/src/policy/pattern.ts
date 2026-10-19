// 参数级 / glob 规则语言
//
// 为什么要有它：以前规则的 `match` 是"拿正则去匹配 `工具 + JSON.stringify(参数)`"——
// 写得出来、但没人写得对：`~/Documents/**` 里的 `*` **不翻译**（写了也是白写），
// 想限"只许改 Documents 里的东西"就只能去拼 JSON 子串，又脆又难改。
//
// 新语法（**只有含 `(` 时才启用**，老规则一条都不用动）：
//
//     工具(参数: 模式)
//
//   · 工具：精确名，或含 `*` 的模式（`*` 匹配任意字符序列）——`mcp.*` 罩住所有外部服务
//   · 参数：工具入参里的一个键（`path` / `paths` / `command` / `name` …）
//   · 模式：glob —— `*` **不跨** `/`、`**` 跨、`?` 匹配一个字符；路径类模式的 `~/` 按家目录展开
//
// 例子：
//     write(path: ~/Documents/**)      她可以改 Documents 里**任意层级**的文件
//     bash(cmd: git *)                 git 开头的单段命令
//     mcp.*(name: github.*)            github 那家的外部服务
//
// 三条纪律（都写进测试）：
//   ① **零迁移**：不含 `(` 的 `match` 仍按老语义（正则）走，行为一字不变；
//   ② **值要全匹配**：数组参数（`paths`）要求**每一个**都落在模式里（"一部分在范围内"不算数）；
//   ③ **大小写敏感**：`~/documents/**` 不匹配 `~/Documents/...`（写错了由体检指出来，不靠猜）。
import type { PolicyRule } from '../config/schema.js';

export interface ParamRule {
  kind: 'param';
  /** 工具名模式（可能含 `*`） */
  toolPattern: string;
  /** 参数名（入参里的键） */
  arg: string;
  /** 原始 glob 模式（给人看） */
  pattern: string;
  /** 展开 `~`、编译好的正则 */
  re: RegExp;
  /** 参数是不是"路径类"（决定要不要做 `~` 展开与 realpath 复判） */
  isPath: boolean;
}
export interface RegexRule { kind: 'regex'; re: RegExp }
export interface BadRule { kind: 'bad'; reason: string; fix: string }

/** 路径类参数名（与 `baseline.collectPaths` 的口径一致；这里只管"要不要展开 ~"） */
const PATH_ARGS = new Set(['path', 'paths', 'file', 'files', 'dir', 'dirs', 'cwd', 'saveAs', 'input', 'inputs', 'target']);

const PARAM_RULE = /^\s*([A-Za-z_][\w.-]*(?:\*[\w.-]*)*)\s*\(\s*([A-Za-z_]\w*)\s*:\s*(.+?)\s*\)\s*$/;
/**
 * "看起来像参数级写法" = 以 `名字(` 开头。
 * ⚠ 判据只能这么松：**老正则里也会有 `(`**（内置 r4 就是 `^(ls|cat|…`，以 `^` 开头 ✓ 不算），
 * 而 `write(path ~/x)` 这种"想写参数级但漏了冒号"的必须被认出来是**写歪了**，
 * 不能当成一条永远不命中的正则悄悄死掉（那正是"写歪的规则比没有更危险"）。
 */
const LOOKS_PARAM = /^\s*[A-Za-z_][\w.-]*\s*\(/;

/** 家目录展开（`~` 与 `~/x`；不碰 `~user` 那种写法） */
export function expandHome(p: string, home: string): string {
  const s = String(p ?? '');
  if (s === '~') return home;
  if (s.startsWith('~/')) return home.replace(/\/+$/, '') + s.slice(1);
  return s;
}

/** glob → 正则：`*` 不跨 `/`、`**` 跨、`?` 一个字符，其余按字面转义 */
export function globToRegExp(glob: string, isPath = true): RegExp {
  const src = String(glob ?? '');
  let out = '';
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (c === '*') {
      if (src[i + 1] === '*') { out += '.*'; i++; }        // `**` 跨目录
      else out += isPath ? '[^/]*' : '.*';                  // `*` 不跨目录
      continue;
    }
    if (c === '?') { out += isPath ? '[^/]' : '.'; continue; }
    out += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  // 路径类：结尾允许多一个 `/`（`~/Documents/**` 也该罩得住 `~/Documents` 本身与目录）
  return new RegExp(`^${out}$`);
}

/** 工具名模式：`*` = 任意字符序列；其余按字面 */
export function toolMatches(pattern: string, tool: string): boolean {
  const p = String(pattern ?? '*');
  if (p === '*') return true;
  if (!p.includes('*')) return p === tool;
  return new RegExp(`^${p.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`).test(String(tool));
}

/**
 * 解析一条规则的 `match`。**只有含 `(` 时才尝试新语法**（零迁移的落点）。
 * 返回 `bad` 时调用方应当**跳过这条规则**并把它报进体检（不静默当成正则去跑）。
 */
export function parseRuleMatch(match: string, opts: { home?: string; tool?: string } = {}): ParamRule | RegexRule | BadRule {
  const raw = String(match ?? '');
  if (!LOOKS_PARAM.test(raw)) return { kind: 'regex', re: safeRegex(raw) ?? /(?!)/ };
  const m = raw.match(PARAM_RULE);
  if (!m) {
    return {
      kind: 'bad',
      reason: '括号写法看不懂（参数级规则的格式是「工具(参数: 模式)」）',
      fix: '照这个样子写：write(path: ~/Documents/**) 或 bash(cmd: git *)',
    };
  }
  const [, toolPattern, arg, pattern] = m as unknown as [string, string, string, string];
  // 工具字段与括号里写的对不上 → 报出来（不然"这条规则到底管谁"全靠猜）
  if (opts.tool && opts.tool !== '*' && !toolMatches(toolPattern, opts.tool) && !toolMatches(opts.tool, toolPattern)) {
    return {
      kind: 'bad',
      reason: `规则里写的是「${toolPattern}」，但这条规则的工具字段是「${opts.tool}」——两边对不上`,
      fix: `把 tool 改成 ${toolPattern}，或者把括号里改成 ${opts.tool}(…)`,
    };
  }
  const isPath = PATH_ARGS.has(arg);
  const glob = isPath && opts.home ? expandHome(pattern, opts.home) : pattern;
  return { kind: 'param', toolPattern, arg, pattern: glob, re: globToRegExp(glob, isPath), isPath };
}

function safeRegex(src: string): RegExp | null {
  try { return new RegExp(src); } catch { return null; }
}

/**
 * 这条参数级规则是否命中这次调用。
 * **值要全匹配**：数组参数要求每一个值都落在模式里（"一部分在范围内"不算数——
 * 那正是"只许改 Documents"会被 `paths: ['~/Documents/a', '/etc/passwd']` 绕过去的地方）。
 */
export function paramRuleHits(rule: ParamRule, tool: string, args: Record<string, unknown>, opts: { home?: string } = {}): boolean {
  if (!toolMatches(rule.toolPattern, tool)) return false;
  const v = args?.[rule.arg];
  if (v === undefined || v === null) return false;
  const values = Array.isArray(v) ? v : [v];
  if (values.length === 0) return false;
  return values.every((x) => {
    if (typeof x !== 'string') return false;   // 参数级规则只认字符串（数字/对象交给老写法）
    const s = rule.isPath && opts.home ? expandHome(x, opts.home) : x;
    return rule.re.test(s);
  });
}

/** 规则是不是参数级写法（设置页与体检都要判这个） */
export function isParamRule(match: string): boolean {
  return LOOKS_PARAM.test(String(match ?? ''));
}

/** 人话预览：`write(path: ~/Documents/**)` → "改文件 · Documents 里任意层级" */
export function describeParamRule(match: string, home = ''): string {
  const p = parseRuleMatch(match, { home });
  if (p.kind !== 'param') return '';
  const argWord: Record<string, string> = { path: '这个位置', paths: '这些位置', command: '命令', cmd: '命令', name: '名字' };
  const scope = p.pattern.includes('**') ? '下面任意层级' : (p.pattern.includes('*') ? '同一层里' : '这一个');
  return `${argWord[p.arg] ?? p.arg}（${scope}）：${p.pattern}`;
}

/** 给规则表加一条参数级规则时用它校验（设置页"加上"按钮与体检共用一处判据） */
export function validateParamRule(rule: PolicyRule, opts: { home?: string } = {}): { ok: true } | { ok: false; reason: string; fix: string } {
  if (!isParamRule(rule.match)) return { ok: true };  // 老写法交给老诊断
  const p = parseRuleMatch(rule.match, { home: opts.home, tool: rule.tool });
  if (p.kind === 'bad') return { ok: false, reason: p.reason, fix: p.fix };
  if (p.kind === 'regex') return { ok: true };
  // 空模式 / 只有通配的模式 = "什么都能干"，那正是这颗按钮不给的东西
  const bare = p.pattern.replace(/[*/?\s]/g, '');
  if (!bare) {
    return {
      ok: false,
      reason: '这条规则等于"什么都能干"（模式里没有具体范围）',
      fix: '写清范围：write(path: ~/Documents/**) 这样至少限定在一个目录里',
    };
  }
  return { ok: true };
}
