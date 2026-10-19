// 硬性 deny 表（不可覆盖，先于用户规则）+ 危险命令判定。
// 两条判据：① 用 parse.ts 的分段+剥壳结果**逐层判、整条取最严**（`bash -c 'rm -rf /'`
// 这种带引号的写法能绕过正则锚点）；② 强制删除直接拒绝。
import { analyzeCommand, executableName, MAX_SHELL_DEPTH } from './parse.js';

export interface DenyHit {
  denied: boolean;
  reason?: string;
  /** 替代路子（给模型"换个办法"的抓手） */
  suggestion?: string;
  /** 说不清但疑似危险 → 调用方**不得放行**，应走审批（ask）：结构不可信时只"劝审"，不做砖墙 */
  caution?: string;
}

/**
 * 被硬拒时给模型的**替代路子**。原文模式命中的这几类都属于"换个写法也还是同一件危险事"，
 * 所以替代话术统一指向"换目标/换工具/让用户自己来"，而不是"再试一次"。
 */
const HARD_DENY_SUGGEST =
  '这条路走不通：换成不危险的做法（换个目标路径、改用受支持的工具），做不到就把原因说给用户听、让 TA 自己来。';

const HARD_DENY: Array<{ re: RegExp; reason: string }> = [
  { re: /(^|[;&|\s])rm\s+(-[a-z]*r[a-z]*\s+|[^-\s][^\s]*\s+)*\/\s*$|(^|[;&|\s])rm\s+-[a-z]*r[a-z]*\s+\/\s*/, reason: '禁止递归删除根目录' },
  { re: /rm\s+-[a-z]*r[a-z]*\s+\/\*/, reason: '禁止递归删除根目录内容' },
  { re: /\bmkfs(\.\w+)?\s/, reason: '禁止格式化文件系统' },
  { re: /\bdd\b[^\n]*\bof=\/dev\//, reason: '禁止 dd 写入设备文件' },
  { re: /\b(shutdown|reboot|poweroff|halt)\b/, reason: '禁止关机/重启命令' },
  { re: /:\s*\|/, reason: '禁止 fork 炸弹（递归管道）' },
  { re: /\(\)\s*\{\s*:\s*\|/, reason: '禁止 fork 炸弹（函数自调用）' },
  { re: />\s*\/dev\/sd[a-z]/, reason: '禁止覆写磁盘设备' },
  { re: /chmod\s+777\s+\//, reason: '禁止对根目录放宽权限' },
];

/** 原文兜底模式（只用于 opaque 命令的"劝审"）：强制删除写法 */
const RAW_FORCE_RM = /(^|[\s;&|(`])rm\s+(-[A-Za-z]*f[A-Za-z]*|--force)\b/;

/** rm 带 force 选项？（-f / -rf / -Rf / --force；executableName 去目录与扩展名） */
export function rmHasForce(words: string[]): boolean {
  if (executableName(words[0] ?? '') !== 'rm') return false;
  return words.slice(1).some((w) => w === '--force' || (/^-[A-Za-z]+$/.test(w) && w.includes('f')));
}

/** 原文匹配（向后兼容：单条命令、正则锚点场景） */
export function isHardDenied(cmd: string): DenyHit {
  for (const { re, reason } of HARD_DENY) {
    if (re.test(cmd)) return { denied: true, reason, suggestion: HARD_DENY_SUGGEST };
  }
  return { denied: false };
}

const SHELL_SWITCHERS = new Set(['shutdown', 'reboot', 'poweroff', 'halt']);

/** 删除类命令：一律改道到 delete 工具（进回收站，可撤回） */
const DELETE_CMDS = new Set(['rm', 'rmdir', 'unlink', 'del', 'remove-item', 'rd', 'srm']);
const DELETE_REDIRECT =
  '删除请改用 delete 工具（会进回收站，可撤回）——用户能接受你改错，不能接受删掉，所以删东西一律走回收站这条路，不走命令行。';

/**
 * 按**可执行名 + 参数**判危险（分层判定用）。
 * 只看第一个词是不是危险程序——不把整串拼回文本再匹配，否则 `echo "rm -rf /"` 会被引号误伤。
 */
function dangerByExec(words: string[]): DenyHit {
  const head = executableName(words[0] ?? '');
  // 删除类命令一律改道（不是"询问"，是"换条路"）——回收站把不可逆变成可撤回。
  // 注意顺序：先把"删根目录"这类最危险的说清楚，再兜住其余删除写法。
  if (DELETE_CMDS.has(head)) {
    const targets = words.slice(1).filter((w) => !w.startsWith('-'));
    const root = targets.some((t) => /^\/\*?$/.test(t) || t === '/');
    if (root) {
      return { denied: true, reason: '禁止递归删除根目录', suggestion: '这属于不可撤销的破坏性操作，请让用户本人确认后自己执行。' };
    }
    return { denied: true, reason: DELETE_REDIRECT, suggestion: '用 delete 工具（走系统回收站，可撤回）；不确定删哪个就先 glob/ls 看一眼。' };
  }
  if (head === 'mkfs' || head.startsWith('mkfs.')) {
    return { denied: true, reason: '禁止格式化文件系统', suggestion: '格式化只能由用户本人在终端里亲自执行。' };
  }
  if (head === 'dd' && words.some((w) => /^of=\/dev\//.test(w))) {
    return { denied: true, reason: '禁止 dd 写入设备文件', suggestion: '写设备只能由用户本人执行；普通文件复制请用 cp。' };
  }
  if (SHELL_SWITCHERS.has(head)) {
    return { denied: true, reason: '禁止关机/重启命令', suggestion: '关机/重启请让用户自己操作（或在设备操作工具里走用户确认）。' };
  }
  return { denied: false };
}

/**
 * 危险命令判定：原文（模式类）→ 分段+剥壳逐层（命令类），**整条取最严**。
 * 只能发现危险，不能自证安全（剥壳时动态部分已被省略）——"安全"由 engine 的
 * "单段 + 非 opaque + 未剥壳"另行判定。
 */
export function checkDanger(cmd: string): DenyHit {
  const raw = isHardDenied(cmd);
  if (raw.denied) return raw;

  const analysis = analyzeCommand(cmd);
  if (analysis.tooDeep) {
    return {
      denied: true,
      reason: `命令嵌套过深（剥壳超过 ${MAX_SHELL_DEPTH} 层），按危险处理`,
      suggestion: '别把命令套这么多层壳：直接跑你要跑的那条命令（套壳只会让我看不清你要干什么）。',
    };
  }
  for (const c of analysis.commands) {
    const hit = dangerByExec(c.inner);
    if (hit.denied) return hit;
  }

  // 结构不可信（opaque）时的兜底：只"劝审"不硬拒——误伤不该变成砖墙，
  // 但含重定向/替换的写法里出现强制删除，确实不能放行。
  if (analysis.opaque && RAW_FORCE_RM.test(cmd)) {
    return { denied: false, caution: '命令里有说不清的构造（重定向/变量/替换），且出现了强制删除的写法——需要你确认。' };
  }
  return { denied: false };
}
