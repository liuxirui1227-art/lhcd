// tool_call 校验修复：
// 1) args JSON 损坏 → 回注错误，最多修 2 次后丢弃；
// 2) 工具不存在 → 回注可用工具列表（顺序固定）；
// 3) 工具抛错 → 结构化错误结果回传（执行层处理，见 turn.ts）；
// 4) 参数不符 schema → 回注校验错误，1 次修复机会。
import type { ToolCall } from '../llm/provider.js';
import type { ToolEntry, ToolResult } from '../tools/registry.js';
import type { Session } from './session.js';
import { validateArgs } from './schema-lite.js';

export interface PreparedCall {
  call: ToolCall;
  /** 校验通过的入口；undefined 时用 presetResult 回传 */
  entry?: ToolEntry;
  /** 校验失败/丢弃时的预置结果（不再执行） */
  presetResult?: ToolResult;
}

function errorResult(code: string, message: string): ToolResult {
  return { ok: false, output: '', error: { code, message } };
}

export function prepareCalls(session: Session, calls: ToolCall[]): PreparedCall[] {
  const prepared: PreparedCall[] = [];
  /* 报"可用工具"时按**这一轮真正允许的**报（不报全套）——
     报全套等于告诉模型"这些名字存在，你叫得出就能用"；
     复盘会话（白名单=只读+提候选）尤其危险。 */
  const available = session.registry.all().map((t) => t.name).filter((n) => session.toolAllowed(n)).join('、');
  for (const call of calls) {
    // 1) args 必须为对象（provider 解析失败时可能是原始字符串）
    if (typeof call.args !== 'object' || call.args === null || Array.isArray(call.args)) {
      const key = `bad-args:${call.name}`;
      const message = session.bumpRepair(key, 2)
        ? '参数 JSON 损坏：args 必须为对象。请修复后重试。'
        : '参数 JSON 损坏且已修复 2 次仍失败，此调用已丢弃。';
      prepared.push({ call, presetResult: errorResult('BAD_ARGS', message) });
      continue;
    }
    // 2) 工具不存在
    const entry = session.registry.get(call.name);
    if (!entry) {
      prepared.push({
        call,
        presetResult: errorResult('UNKNOWN_TOOL', `工具 ${call.name} 不存在。可用工具（顺序固定）：${available}`),
      });
      continue;
    }
    /* 2b) **存在但不允许**：注册表里有、这一轮的白名单/只读档里没有 → 拒绝。
       为什么必须有这一条：白名单与只读档只作用于"发给模型的清单"，执行路径只查 registry——
       复盘会话的 registry 是**全套工具**的副本，模型吐出一个清单外的名字就能真执行（chat 档还是静默放行）。 */
    if (!session.toolAllowed(call.name)) {
      prepared.push({
        call,
        presetResult: errorResult('TOOL_NOT_ALLOWED', `工具 ${call.name} 这一轮不允许使用。这一轮可用的工具：${available}`),
      });
      continue;
    }
    // 4) 参数 schema 校验（1 次修复机会）
    const errs = validateArgs(call.args, entry.schema.function.parameters);
    if (errs.length > 0) {
      const key = `bad-schema:${call.name}`;
      const detail = errs.map((e) => `${e.path}: ${e.message}`).join('；');
      const message = session.bumpRepair(key, 1)
        ? `参数不符合 schema（${detail}）。请修复后重试（仅 1 次修复机会）。`
        : `参数不符合 schema（${detail}）且已修复 1 次仍失败，此调用已丢弃。`;
      prepared.push({ call, presetResult: errorResult('BAD_SCHEMA', message) });
      continue;
    }
    prepared.push({ call, entry });
  }
  return prepared;
}
