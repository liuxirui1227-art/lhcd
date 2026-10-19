// 命令结构化（切段 + 剥壳）。判据：
// ① 切段只认 `&& || ; |` 与换行、引号；出现括号/花括号/重定向/反引号/命令替换/变量展开/后台 `&`
//    等"说不清"的构造 → 整条判 **opaque**，退回按原文匹配（收紧而非放行）；
// ② 壳递归剥开：`sudo`/`env VAR=x`/`bash -c '…'`/`trap '…'`/`nohup`/`xargs` 等逐层剥到真命令，
//    深度封顶 8 层，**超深按危险处理**（剥不完 = 看不清 = 不放行）；
// ③ **字面命令只能用来发现危险，绝不能用来自证安全**——动态部分在剥壳时已被省略，
//    所以本模块只回答"看见了什么"，不回答"安不安全"；"安全"只能由调用方对
//    "单段 + 非 opaque + 未剥壳"的命令另行判定（见 engine.ts 的 auto 分支）。

/**
 * 可作为壳被剥开的包装命令（跳过其自身参数后，剩下的是真命令）。
 * `watch` / `setsid` 也要剥壳：不剥的话 `watch -n1 rm -rf build` 里面的 `rm -rf` **看不见**，
 * 只剩硬 deny 的子串匹配兜底；全放行那类配置下就是一条真绕过。
 * 两者的选项都不带值（`-n1` 连着写、`-n 1` 分开写两种都被下面的选项循环吃掉），加进来即可。
 */
const WRAPPERS = new Set(['sudo', 'doas', 'nohup', 'time', 'timeout', 'command', 'builtin', 'exec', 'stdbuf', 'nice', 'ionice', 'xargs', 'watch', 'setsid']);
/** 带 `-c <脚本>` 的 shell：脚本本身还要再按命令解析 */
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'fish']);

export const MAX_SHELL_DEPTH = 8;

export interface PeeledCommand {
  /** 该层的完整词序列 */
  words: string[];
  /** 剥掉壳之后最内层的命令词序列（无壳时与 words 相同） */
  inner: string[];
  /** 剥了几层壳 */
  depth: number;
}

export interface CommandAnalysis {
  /** 顶层切段文本（opaque 时为空） */
  segments: string[];
  /** 每段剥壳后的命令（用于发现危险） */
  commands: PeeledCommand[];
  /** 含说不清的构造 → 调用方只能按原文判 */
  opaque: boolean;
  /** 剥壳超过 MAX_SHELL_DEPTH → 按危险处理 */
  tooDeep: boolean;
}

/** 取可执行名（去目录、去 Windows 扩展名）：/bin/rm、rm.exe → rm */
export function executableName(word: string): string {
  const base = word.split(/[/\\]/).pop() ?? word;
  return base.replace(/\.(exe|cmd|bat|com)$/i, '').toLowerCase();
}

/**
 * 引号感知的词切分。无法闭合的引号 → null（说不清）。
 * 注意：双引号内的 `$`/反引号在真 shell 里会展开，这里不做展开——含它们时由 splitSegments 判 opaque。
 */
export function splitWords(segment: string): string[] | null {
  const words: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  let i = 0;
  while (i < segment.length) {
    const ch = segment[i]!;
    if (quote === "'") {
      if (ch === "'") quote = null;
      else cur += ch;
      i++;
      continue;
    }
    if (ch === '\\') {
      const next = segment[i + 1];
      if (next === undefined) return null;
      cur += next;
      i += 2;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') quote = null;
      else cur += ch;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      i++;
      continue;
    }
    if (/\s/.test(ch)) {
      if (cur) words.push(cur);
      cur = '';
      i++;
      continue;
    }
    cur += ch;
    i++;
  }
  if (quote !== null) return null; // 引号没闭合
  if (cur) words.push(cur);
  return words;
}

/**
 * 顶层切段：引号感知；按 `&& || ; | &` 与换行切。
 * 碰到说不清的构造（括号/重定向/反引号/变量展开/后台 &）**只标 opaque、不中止扫描**——
 * "说不清"只该禁止"自证安全"，不该禁止"发现危险"。
 */
export function splitSegments(cmd: string): { segments: string[]; opaque: boolean } {
  const segments: string[] = [];
  let opaque = false;
  let cur = '';
  let quote: '"' | "'" | null = null;
  let i = 0;
  while (i < cmd.length) {
    const ch = cmd[i]!;
    if (quote === "'") {
      cur += ch;
      if (ch === "'") quote = null;
      i++;
      continue;
    }
    if (ch === '\\' && quote === null) {
      cur += ch + (cmd[i + 1] ?? '');
      i += 2;
      continue;
    }
    if (quote === '"') {
      cur += ch;
      if (ch === '"') quote = null;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
      i++;
      continue;
    }
    // 说不清的构造：括号/花括号/重定向/反引号/变量展开/后台 & —— **只标 opaque、不中止扫描**：
    // "说不清"只该禁止"自证安全"，不该禁止"发现危险"
    if ('(){}<>`$'.includes(ch)) {
      opaque = true;
      cur += ch;
      i++;
      continue;
    }
    if (ch === '&') {
      segments.push(cur);
      cur = '';
      if (cmd[i + 1] === '&') {
        i += 2;
      } else {
        opaque = true; // 单个 & = 后台任务
        i++;
      }
      continue;
    }
    if (ch === '|') {
      segments.push(cur);
      cur = '';
      i += cmd[i + 1] === '|' ? 2 : 1;
      continue;
    }
    if (ch === ';' || ch === '\n') {
      segments.push(cur);
      cur = '';
      i++;
      continue;
    }
    cur += ch;
    i++;
  }
  if (quote !== null) opaque = true; // 引号没闭合
  segments.push(cur);
  return { segments: segments.map((s) => s.trim()).filter(Boolean), opaque };
}

/** 把一段脚本字符串（shell -c / trap 的动作）当命令重新切段剥壳，深度 +1 */
function collectScript(script: string, depth: number, ctx: CollectCtx): void {
  const seg = splitSegments(script);
  if (seg.opaque) ctx.opaque = true; // 内层说不清 → 整条也不能自证安全
  let any = false;
  for (const s of seg.segments) {
    const words = splitWords(s);
    if (words === null) {
      ctx.opaque = true;
      continue;
    }
    any = true;
    collect(words, depth, ctx);
  }
  if (!any) ctx.opaque = true;
}

interface CollectCtx {
  commands: PeeledCommand[];
  tooDeep: boolean;
  /** 内层脚本里出现说不清的构造 → 整条也不能自证安全 */
  opaque: boolean;
}

/** 剥壳递归：把一层的词序列剥到真命令；遇到 shell `-c` 脚本则重新按命令解析、深度 +1 */
function collect(words: string[], depth: number, ctx: CollectCtx): void {
  if (words.length === 0) return;
  if (depth > MAX_SHELL_DEPTH) {
    ctx.tooDeep = true;
    return;
  }
  let rest = words;
  while (rest.length > 0) {
    const head = executableName(rest[0]!);
    if (head === 'env') {
      // env [-i] [VAR=value…] cmd…：跳过选项与赋值
      let k = 1;
      while (k < rest.length && (rest[k]!.startsWith('-') || rest[k]!.includes('='))) k++;
      rest = rest.slice(k);
      continue;
    }
    if (head === 'trap') {
      // trap '动作' 信号…：动作是脚本 → 按命令解析（同为剥壳一层）
      const action = rest[1];
      if (action) collectScript(action, depth + 1, ctx);
      return;
    }
    if (SHELLS.has(head)) {
      const cIdx = rest.findIndex((w, idx) => idx > 0 && /^-[a-z]*c[a-z]*$/i.test(w));
      const script = cIdx >= 0 ? rest[cIdx + 1] : undefined;
      if (script !== undefined) collectScript(script, depth + 1, ctx);
      else ctx.commands.push({ words, inner: rest, depth });
      return;
    }
    if (WRAPPERS.has(head)) {
      // 跳过包装命令自身的选项（sudo -u x / xargs -0 / nice -n 5 …）
      let k = 1;
      while (k < rest.length && rest[k]!.startsWith('-')) {
        // 带值的选项（sudo -u alice）→ 连值一起跳
        k += /^-(u|g|p|C|n|I|s|U|G)$/.test(rest[k]!) && rest[k + 1] ? 2 : 1;
      }
      // timeout 后面第一个非选项参数是时长（timeout 5 rm -rf x）→ 一并跳掉
      if (head === 'timeout' && k < rest.length && !rest[k]!.startsWith('-')) k += 1;
      const inner = rest.slice(k);
      if (inner.length === 0) {
        ctx.commands.push({ words, inner: rest, depth });
        return;
      }
      rest = inner;
      depth += 1; // 每剥一层都计入深度（套娃式 sudo/nohup 也受 8 层封顶约束）
      if (depth > MAX_SHELL_DEPTH) {
        ctx.tooDeep = true;
        return;
      }
      continue;
    }
    ctx.commands.push({ words, inner: rest, depth });
    return;
  }
  // 全是壳（如 `sudo` 单独一个词）
  ctx.commands.push({ words, inner: rest, depth });
}

/**
 * 命令结构化：切段 + 逐段剥壳。
 * opaque=true 表示"结构不可信"（调用方不得据此**自证安全**），但本函数仍会尽力切段剥壳
 * 以供**发现危险**——两者是分开的两件事。
 */
export function analyzeCommand(cmd: string): CommandAnalysis {
  const { segments, opaque } = splitSegments(cmd);
  const ctx: CollectCtx = { commands: [], tooDeep: false, opaque: false };
  let opaqueFinal = opaque;
  for (const seg of segments) {
    const words = splitWords(seg);
    if (words === null) {
      opaqueFinal = true; // 词法不清 → 该段不参与剥壳，但别的段照常判
      continue;
    }
    collect(words, 0, ctx);
  }
  return { segments, commands: ctx.commands, opaque: opaqueFinal || ctx.opaque, tooDeep: ctx.tooDeep };
}
