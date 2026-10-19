// 规则可达性诊断。判据：**写歪的规则比没有规则更危险——它给虚假的安全感**。
// 只做可判定的三类（不做通用可达性证明，那需要规则语言本身升级）：
//   ① 正则写错 → 这条规则永远不会生效（会被 try/catch 静默跳过，最危险的一类）
//   ② 被更早的"兜底规则"挡死（同工具 + `.*` 这样的全匹配，且排在它前面）→ 后写的规则永不触发
//   ③ 工具名不存在（打错字/工具已改名）→ 规则永不匹配
// 每条都带**可执行的修法**（拒绝/警告要写"改用某某"）。
import type { PermissionsCfg } from '../config/schema.js';
import { isParamRule, parseRuleMatch, toolMatches } from './pattern.js';

export interface RuleIssue {
  ruleId: string;
  kind: 'invalid-regex' | 'shadowed' | 'unknown-tool' | 'redos' | 'too-broad' | 'too-many' | 'too-long'
    // 参数级 / glob 规则语言
    | 'bad-param-rule' | 'unknown-arg';
  /** 给人看的一句话 */
  message: string;
  /** 可执行的修法 */
  fix: string;
}

/** 覆盖一切的模式（`.*` / `^.*` / `.+` 之类）——排在后面就没有意义了 */
const CATCH_ALL = /^(?:\^?\.\*|\.\+|\(\?:\.\*\))$/;

/**
 * 三处硬上限。
 * ⚠ **有意不静默截断**（那种做法里最先被丢的往往是用户级规则）：改成
 * **在体检里报出来**——静默丢规则和"写歪的规则"是同一类毛病：给虚假的安全感。
 * 所以这里是"看得见的上限"，不是"悄悄砍掉"。
 */
export const MAX_RULES = 50;
export const MAX_RULE_PATTERN = 1024;
export const MAX_RULE_TEXT = 8192;

/**
 * 灾难性回溯（ReDoS）粗筛：**嵌套的量词**——`(a+)+`、`(\s*)*`、`(.*)*` 这类，
 * 输入一长就指数级回溯，等于让她自己卡死（规则跑在她的主循环里）。
 * 这是**启发式**，不是完备判定（完备要真跑一遍或上 safe-regex）：命中的直接跳过并在体检里报出来——
 * 宁可少一条规则，也不让一条正则把循环挂住。`(a|b)*`、`[a-z]*` 这种**不算**（单个量词是线性的）。
 */
export function isRiskyRegex(pattern: string): boolean {
  return /\((?:\\.|[^()\\])*[*+](?:\\.|[^()\\])*\)\s*[*+]/.test(pattern);
}

/** 一条模式是不是"过宽"：没有锚定 + 去掉元字符后短到几乎什么都命中（`build`、`x`） */
export function isTooBroad(pattern: string): boolean {
  const p = pattern.trim();
  if (!p || CATCH_ALL.test(p)) return false; // 兜底规则是**故意**这么宽，不算问题
  if (/^\^|\$$/.test(p)) return false;      // 有锚定就不算
  const literal = p.replace(/[\\^$.|?*+()[\]{}]/g, '');
  return literal.length <= 8;
}

export interface DiagnoseOptions {
  /** 当前可用的工具名（不给则跳过"工具不存在"检查） */
  tools?: string[];
  /** 家目录（参数级规则的 `~/` 展开要用；不给就用 `os.homedir()`） */
  home?: string;
  /** 工具名 → 它的入参名列表（给了才能查"这个参数根本不存在"；不给就跳过那一条） */
  argNames?: Record<string, string[]>;
}

/** 诊断规则表：返回所有"永远不会按预期生效"的规则（空数组 = 健康） */
export function diagnoseRules(cfg: PermissionsCfg, opts: DiagnoseOptions = {}): RuleIssue[] {
  const issues: RuleIssue[] = [];
  const seenCatchAll = new Map<string, string>(); // tool → 兜底规则 id（先出现的）

  // 上限：条数、单条模式长度、全部规则文本总量
  if (cfg.rules.length > MAX_RULES) {
    issues.push({
      ruleId: '(规则表)',
      kind: 'too-many',
      message: `规则有 ${cfg.rules.length} 条，超过上限 ${MAX_RULES} 条——排在后面的那些实际上很难被你维护到`,
      fix: `删掉已经不需要的规则，或把同类合并成一条（规则是"首条命中生效"，越多越难推理）`,
    });
  }
  const totalText = cfg.rules.reduce((n, r) => n + r.id.length + r.match.length, 0);
  if (totalText > MAX_RULE_TEXT) {
    issues.push({
      ruleId: '(规则表)',
      kind: 'too-long',
      message: `规则文本合计 ${totalText} 字符，超过上限 ${MAX_RULE_TEXT}——这种量级已经没法一眼看懂`,
      fix: `精简：把长正则拆成多条短规则，或改用工具维度（rule.tool）先收窄范围`,
    });
  }

  for (const rule of cfg.rules) {
    /* 参数级写法先过一遍语法——写歪的 glob 会被当成
       "一条永远不命中的正则"悄悄死掉（比没有规则更危险：它给虚假的安全感）。 */
    if (isParamRule(rule.match)) {
      const parsed = parseRuleMatch(rule.match, { home: opts.home, tool: rule.tool });
      if (parsed.kind === 'bad') {
        issues.push({ ruleId: rule.id, kind: 'bad-param-rule', message: `规则 ${rule.id} 写歪了：${parsed.reason}`, fix: parsed.fix });
        continue;
      }
      if (parsed.kind === 'param' && opts.argNames) {
        // 参数名在该工具的入参里不存在 → 这条规则永远匹配不上（工具名支持 `*`，逐个查）
        const candidates = opts.tools?.filter((t) => toolMatches(rule.tool, t)) ?? [];
        const anyHas = candidates.some((t) => (opts.argNames?.[t] ?? []).includes(parsed.arg));
        if (candidates.length > 0 && !anyHas) {
          const known = [...new Set(candidates.flatMap((t) => opts.argNames?.[t] ?? []))].slice(0, 8).join('、');
          issues.push({
            ruleId: rule.id,
            kind: 'unknown-arg',
            message: `规则 ${rule.id} 里写的参数「${parsed.arg}」在这些工具里都不存在，这条永远不会生效`,
            fix: `换成真实存在的参数名（${known || '见工具说明'}）`,
          });
          continue;
        }
      }
      continue;   // 参数级规则不走正则那条路
    }
    try {
      new RegExp(rule.match);
    } catch {
      issues.push({
        ruleId: rule.id,
        kind: 'invalid-regex',
        message: `规则 ${rule.id} 的正则写错了，永远不会生效（运行时被静默跳过）`,
        fix: `改成合法的正则；不确定就用 ^前缀 这种最简形式`,
      });
      continue;
    }
    if (rule.match.length > MAX_RULE_PATTERN) {
      issues.push({
        ruleId: rule.id,
        kind: 'too-long',
        message: `规则 ${rule.id} 的正则长 ${rule.match.length} 字符，超过单条上限 ${MAX_RULE_PATTERN}`,
        fix: `拆成多条短规则；很长的正则基本等于"谁都看不懂、也没人敢改"`,
      });
      continue;
    }
    // 灾难性回溯：可疑的直接跳过（engine 侧同一判据），并在这里说清楚
    if (isRiskyRegex(rule.match)) {
      issues.push({
        ruleId: rule.id,
        kind: 'redos',
        message: `规则 ${rule.id} 的正则里有嵌套量词（形如 (a+)+），输入一长会指数级回溯——`
          + `为了不让她自己卡住，这条**不会被加载**`,
        fix: `把嵌套拆开：用 [a-z]+ 这类字符类，或把 ^前缀 锚定住，避免"组里一个量词、组外又一个"`,
      });
      continue;
    }
    if (opts.tools && rule.tool !== '*' && !opts.tools.includes(rule.tool)) {
      issues.push({
        ruleId: rule.id,
        kind: 'unknown-tool',
        message: `规则 ${rule.id} 指向的工具「${rule.tool}」不存在，永远不会匹配`,
        fix: `改成已有工具名，或用 * 匹配所有工具（现有：${opts.tools.join(', ')}）`,
      });
      continue;
    }
    // 被更早的兜底规则挡死：同一条规则链上，先出现的 `.*` 已经吃掉了所有输入
    const blocker =
      seenCatchAll.get(rule.tool) ?? (rule.tool === '*' ? undefined : seenCatchAll.get('*'));
    if (CATCH_ALL.test(rule.match.trim()) === false && blocker) {
      issues.push({
        ruleId: rule.id,
        kind: 'shadowed',
        message: `规则 ${rule.id} 排在兜底规则「${blocker}」后面，永远不会被命中`,
        fix: `把这条规则移到「${blocker}」前面（规则是"首条命中生效"，越靠前越优先）`,
      });
    }
    // 过宽：没锚定 + 几乎什么都命中 —— 反过来的毛病是"它把正功能也拦了"
    if (rule.action !== 'allow' && isTooBroad(rule.match)) {
      issues.push({
        ruleId: rule.id,
        kind: 'too-broad',
        message: `规则 ${rule.id} 的模式「${rule.match}」没有锚定、又短到几乎命中一切`
          + `（${rule.action === 'deny' ? '拒' : '问'}的范围会远超你的本意）`,
        fix: `锚定住位置（^开头 / $结尾）或写全一点，例如把 build 改成 ^npm run build`,
      });
    }
    if (CATCH_ALL.test(rule.match.trim())) {
      // 兜底规则本身：比它更早的同工具兜底会让它变成死条目
      const earlier = seenCatchAll.get(rule.tool);
      if (earlier) {
        issues.push({
          ruleId: rule.id,
          kind: 'shadowed',
          message: `规则 ${rule.id} 与更早的兜底规则「${earlier}」重复，它永远不会被命中`,
          fix: `二选一删掉（保留更符合意图的那条）`,
        });
      } else {
        seenCatchAll.set(rule.tool, rule.id);
      }
    }
  }
  return issues;
}
