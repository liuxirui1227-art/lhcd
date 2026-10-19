// 动作风险分级
//
// 六档（R0 纯读 … R5 不可逆）按**自己的产品语汇**落成，
// 判据只有一条：**"这一步做错了，用户能不能自己收拾"**。
//
// 为什么要有它：有了风险档，"问不问"才能落到"这一步到底危不危险"上，
// 而不是靠工具名硬编码（宿主侧那套 3 档徽章就是硬编码 tool 名）。
//
// 与审批的关系（策略表在 `lifecycle/mode.ts`）：
//   闲聊模式 `approval: 'silent'`  → 一律不问（尊重用户「不要二次确认」）
//   工作模式 `approval: 'askR3'`   → **R3 及以上才问**（重要本地修改 / 对外写入 / 不可逆）
// R5 也照样受内核硬 deny 与禁区约束——**风险档只决定"问不问"，永远不决定"禁不禁"**。
//
// **R5 是"强制逐次确认"，与作用域无关**：宿主那层"要不要打扰用户"的闸门
// （`runtime/lib.mjs` 的 askApprovalViaBridge）天生只能把 ask **收窄**（少问几句），
// 不能把内核判的 ask **改写成 allow**——对强制档必须让路：
// **问不成（后台回合 / 没有审批通道）= 不许干**。

import type { PermissionClass } from '../tools/registry.js';

export type RiskLevel = 'R0' | 'R1' | 'R2' | 'R3' | 'R4' | 'R5';

export const RISK_RANK: Record<RiskLevel, number> = { R0: 0, R1: 1, R2: 2, R3: 3, R4: 4, R5: 5 };

export const RISK_LABELS: Record<RiskLevel, string> = {
  R0: '只是看看',
  R1: '记一笔',
  R2: '做完能撤',
  R3: '动你的文件',
  R4: '会对外发生',
  R5: '不可逆',
};

/** 工具默认档（不看参数就能定的那一半） */
const TOOL_RISK: Record<string, RiskLevel> = {
  // R0 纯读
  read: 'R0', grep: 'R0', glob: 'R0', web_fetch: 'R0', web_search: 'R0',
  recall: 'R0', session_search: 'R0', load_skill: 'R0',
  // R1 低风险本地写（新文件、账本、记忆）
  remember: 'R1', forget: 'R1', task: 'R1', write: 'R1', edit: 'R1',
  // R2 可逆执行（有 .bak / 另存新文件 / 走回收站）
  bash: 'R2', media: 'R2', office: 'R2', delete: 'R2',
  // R4 对外发生（装了/发了/排了，就不是"本机一件事"了）
  schedule: 'R4', install_skill: 'R4', install_mcp: 'R4', save_skill: 'R2',
  // R5 不可逆 / 任意脚本
  app: 'R2', run_agent: 'R2', plan_task: 'R2',
};

/** 明显会在磁盘上"改/搬/删"的 bash（`>` 覆写、mv/cp/rm、git push、包管理器…） */
const BASH_WRITES = /(^|[;&|]\s*)(rm|mv|cp|mkdir|rmdir|touch|chmod|chown|ln|truncate|tee)\s|>>?\s|\bgit\s+(push|reset|clean|checkout)\b|\b(npm|pnpm|yarn|pip|brew|apt|go|cargo)\s+(i|install|add|remove|uninstall|update)\b/;
/** 会对外联通的 bash */
const BASH_NET = /\b(curl|wget|ssh|scp|rsync|nc|telnet|git\s+(clone|pull|push|fetch))\b/;

/**
 * 判一档。`args` 是工具入参（用于逐参数细化；缺省按工具默认档）。
 * 这是**唯一出处**：宿主 UI 的徽章、审批作用域、日志都读它，不许各写一套。
 */
export function riskLevelOf(tool: string, permissionClass: PermissionClass, args: unknown): RiskLevel {
  const a = (args ?? {}) as Record<string, unknown>;
  const name = String(tool ?? '');

  // app 工具按动作用户能感觉到的程度分（设备和现实世界打交道，单独一套）
  if (name === 'app') {
    const action = String(a.action ?? '');
    if (action === 'run') return 'R5'; // 任意脚本
    if (action === 'open' || action === 'activate' || action === 'clipboard') return 'R1';
    return 'R2'; // 通知/日历/提醒
  }

  if (name === 'bash') {
    const cmd = String(a.command ?? '');
    if (BASH_WRITES.test(cmd)) return 'R3'; // 会动盘 → 按"动你的文件"算
    if (BASH_NET.test(cmd)) return 'R4';
    return 'R2';
  }

  // 删除：走回收站（可捞回），但删的是用户的东西 → R3
  if (name === 'delete') return 'R3';

  const base = TOOL_RISK[name];
  if (base) return base;

  // 未知工具（含 MCP 装进来的）：按权限类兜底——保守但不吓人
  if (permissionClass === 'read') return 'R0';
  if (permissionClass === 'net') return 'R4';
  if (permissionClass === 'bash') return 'R3';
  if (permissionClass === 'app') return 'R2';
  return 'R3';
}

/**
 * 审批作用域（界面上可选的三级）：
 *   silent 完全访问：什么都不问（= 闲聊模式的默认行为）
 *   askR2  请求批准：可逆执行（跑命令、处理媒体）也先问一句
 *   askR3  帮我批准：只对"检测到的风险动作"问（动你的文件、对外发生、装东西、不可逆）
 */
export type ApprovalScope = 'silent' | 'askR3' | 'askR2';

/**
 * 强制逐次确认的档：内核判了 ask、且落在这几档时，
 * 宿主"要不要打扰用户"的闸门**不许把它收成 allow**——只能让问得更少，不能让"必须问"变成"不问就干"。
 * R5 = 任意脚本（`app.run`）：不可逆、无预览、无撤销 → 任何模式、任何档位都要问；
 * 问不成（后台回合 / 没有审批通道）= 拒绝，不是放行。
 */
export const MANDATORY_ASK_RISKS: readonly RiskLevel[] = ['R5'];

export function isMandatoryAsk(risk: RiskLevel): boolean {
  return MANDATORY_ASK_RISKS.includes(risk);
}

export function shouldAskForRisk(scope: ApprovalScope, risk: RiskLevel): boolean {
  if (isMandatoryAsk(risk)) return true; // 强制档：先于作用域判定（"强制"的唯一下沉处）
  if (scope === 'silent') return false;
  if (scope === 'askR2') return RISK_RANK[risk] >= RISK_RANK.R2;
  return RISK_RANK[risk] >= RISK_RANK.R3;
}
