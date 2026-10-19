// 点「总是允许」的安全阀。两道闸：
// ① **禁提前缀清单**：shell / 解释器 / `env` / `sudo` / `rm` / 包管理器脚本位 / `git` 等
//    **永远不能被提成规则**——允许 `bash` 等于允许一切；`git` 上榜是因为别名与 hook 能跑任意命令；
// ② 候选规则**先在内存里试装一遍**：确认这条命令的**每一个分段**都会被放行，才真的提议。
// 它不减少放行次数，它让每次放行都是精确的——"审批全放行"的成因多半就是顺手点了"总是允许"。
import { DEFAULT_CONFIG, type PermissionsCfg, type PolicyRule } from '../config/schema.js';
import { analyzeCommand, executableName, MAX_SHELL_DEPTH } from './parse.js';
import { PolicyEngine } from './engine.js';

/**
 * 禁提前缀：这些头一旦被提成规则就等于"放行一切"，**连提议都不提**。
 * （清单覆盖：shell/解释器/提权/删除/脚本位/可执行任意代码的工具）
 */
export const BANNED_PREFIXES = new Set([
  // shell 与解释器
  'bash', 'sh', 'zsh', 'dash', 'ksh', 'fish', 'csh', 'tcsh',
  'python', 'python3', 'pythonw', 'py', 'pypy', 'pypy3', 'node', 'nodejs', 'deno', 'bun',
  'ruby', 'perl', 'php', 'lua', 'julia', 'rscript', 'osascript', 'swift',
  'cmd', 'cmd.exe', 'powershell', 'powershell.exe', 'pwsh',
  // 提权与包装（剥壳之后才是真命令，本身不该成为规则）
  'sudo', 'doas', 'su', 'env', 'xargs', 'eval', 'exec', 'source',
  // 删除类
  'rm', 'find', 'shred', 'unlink',
  // 脚本位/别名/hook 能跑任意命令的
  'npm', 'pnpm', 'yarn', 'npx', 'bunx', 'make', 'cargo', 'go', 'git', 'brew', 'pip', 'pip3', 'uv',
]);

export interface PrefixRuleSuggestion {
  ok: true;
  rule: PolicyRule;
  /**
   * 建议的完整规则表：**新规则插在最前**——"用户刚说的"优先于既有规则，否则会被
   * 更早的宽规则（如 `.*` ask）或 r4 挡在前面永不生效。硬底线（禁区/危险命令）先于一切规则，不受影响。
   */
  rules: PolicyRule[];
  /** 该规则会放行这条命令的哪几段（给人看的说明） */
  covers: string[];
}
export interface PrefixRuleRefusal {
  ok: false;
  reason: string;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 从一条命令推导"以后都允许"的规则。任一闸不过 → 拒绝提议（reason 是给用户看的人话）。
 * @param cmd 用户点了「总是允许」的那条命令
 * @param cfg 当前权限配置（试装验证要用；缺省用内置默认）
 */
export function proposePrefixRule(
  cmd: string,
  cfg?: PermissionsCfg,
  opts: { id?: string; tool?: string; engine?: PolicyEngine } = {},
): PrefixRuleSuggestion | PrefixRuleRefusal {
  const tool = opts.tool ?? 'bash';
  const analysis = analyzeCommand(cmd);
  if (analysis.opaque) {
    return { ok: false, reason: '这条命令里有说不清的构造（重定向/变量/括号/后台任务），规则边界没法确定——只能每次问你。' };
  }
  if (analysis.tooDeep) {
    return { ok: false, reason: `这条命令套了超过 ${MAX_SHELL_DEPTH} 层壳，看不清真正要跑什么——只能每次问你。` };
  }
  if (analysis.segments.length === 0) {
    return { ok: false, reason: '没解析出可执行的命令。' };
  }

  // 闸一：禁提前缀（取第一段的头词）
  const first = analysis.commands[0];
  const head = executableName(first?.inner[0] ?? '');
  if (!head) return { ok: false, reason: '没解析出可执行的命令。' };
  if (BANNED_PREFIXES.has(head)) {
    return {
      ok: false,
      reason: `「${head}」不能被记成规则：它自己就能跑任意命令（允许它等于允许一切）。这类命令只能每次问你。`,
    };
  }

  // 候选规则：头词 +（无选项的）第一个子命令词，锚定在开头
  const words = first!.inner;
  const sub = words[1] && !words[1].startsWith('-') ? words[1] : '';
  const match = sub ? `^${escapeRe(words[0]!)}\\s+${escapeRe(sub)}\\b` : `^${escapeRe(words[0]!)}(\\s|$)`;
  const rule: PolicyRule = { id: opts.id ?? `user-prefix-${Date.now().toString(36)}`, tool, match, action: 'allow' };

  // 闸二：试装验证——按"插到最前"的实际位置试装，这条命令的每一个分段都必须被放行，否则不提
  const base = cfg ?? DEFAULT_CONFIG.permissions;
  const rules = [rule, ...base.rules];
  const engine = opts.engine ?? new PolicyEngine({ ...base, rules });
  for (const seg of analysis.segments) {
    const d = engine.check(tool, 'bash', { command: seg });
    if (d.action !== 'allow') {
      return {
        ok: false,
        reason: `这条命令里还有别的部分（${seg}）不会被这条规则放行（${d.ruleId}）——规则要覆盖整条命令才有意义。`,
      };
    }
  }
  return { ok: true, rule, rules, covers: analysis.segments };
}
