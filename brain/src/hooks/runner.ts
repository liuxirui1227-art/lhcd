// Hooks：事件自动化，订阅式。
// matcher：'tool:<name>:<permissionClass>' 或 '*'；事件负载 JSON 走子进程 stdin；
// 环境变量 AGENT_HOOK_EVENT / AGENT_HOOK_TOOL / AGENT_SESSION_ID；exit 0 继续、exit 2 阻止（仅 PreToolUse）、
// 其余非零记日志（hook 事件）。执行一律经 runtime.exec（红线：不直接 spawn）。
import type { Runtime } from '../runtime/types.js';
import type { Config, HookName, HookSpec } from '../config/schema.js';
import type { AgentEvent } from '../session/events.js';

export interface HookRunResult {
  hook: HookName;
  command: string;
  exit: number;
  /** exit 2（PreToolUse）→ 阻止 */
  blocked: boolean;
  output: string;
}

/** matcher 是否命中事件：'tool:<name>:<class>' 或 '*'（name 经 opts.tool 传入） */
export function matchesHook(matcher: string, ev: AgentEvent, opts: { tool?: string; permissionClass?: string } = {}): boolean {
  if (matcher === '*') return true;
  if (ev.type === 'tool.call' || ev.type === 'tool.result') {
    const parts = matcher.split(':');
    if (parts[0] !== 'tool') return false;
    if (parts.length >= 2 && parts[1] !== '*' && parts[1] !== (opts.tool ?? '')) return false;
    if (parts.length >= 3 && parts[2] !== '*' && parts[2] !== (opts.permissionClass ?? '')) return false;
    return true;
  }
  return false;
}

export interface HookCtx {
  runtime: Runtime;
  sessionId: string;
  event: AgentEvent;
  tool?: string;
  permissionClass?: string;
  cwd?: string;
}

/** 运行一个 hook 命令（事件 JSON 走 stdin）。TODO(spec)：AGENT_HOOK_* 环境注入（env 白名单扩展后） */
export async function runHookCommand(spec: HookSpec, hook: HookName, ctx: HookCtx): Promise<HookRunResult> {
  const { runtime, event } = ctx;
  const res = await runtime.exec(spec.command, {
    timeoutMs: 30_000,
    stdin: JSON.stringify(event),
  });
  const blocked = hook === 'PreToolUse' && res.code === 2;
  return { hook, command: spec.command, exit: res.code, blocked, output: res.output };
}

/** 运行某 Hook 名下全部匹配命令；返回结果列表 */
export async function runHooks(
  config: Config,
  hook: HookName,
  ctx: HookCtx,
): Promise<HookRunResult[]> {
  const results: HookRunResult[] = [];
  for (const spec of config.hooks[hook] ?? []) {
    if (!matchesHook(spec.matcher, ctx.event, { tool: ctx.tool, permissionClass: ctx.permissionClass })) continue;
    results.push(await runHookCommand(spec, hook, ctx));
  }
  return results;
}
