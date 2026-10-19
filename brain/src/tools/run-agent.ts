// run_agent 工具：调用 subagent 完成独立子任务，结果 tool_result 回传。
// 0 个 agent → 不注册（工厂负责门控）。
import type { ToolEntry } from './registry.js';

export function runAgentTool(): ToolEntry {
  return {
    name: 'run_agent',
    permissionClass: 'internal',
    schema: {
      type: 'function',
      function: {
        name: 'run_agent',
        description: '把一个能独立做完的子任务派给分身，拿结论回来（她读一堆文件/查一圈资料，回来的只有结论）。内置分身：查证员（核实说法真伪）、资料员（收集材料带来源）、整理员（收拾文件与内容）。用户自己写的同名分身可覆盖内置。',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: '分身名（内置：查证员/资料员/整理员；也可是用户自建 <dir>/<name>/AGENT.md 里的 name）' },
            task: { type: 'string', description: '交给 subagent 的任务' },
          },
          required: ['name', 'task'],
        },
      },
    },
    executor: async (args, ctx) => {
      const a = (args ?? {}) as { name?: unknown; task?: unknown };
      if (typeof a.name !== 'string' || typeof a.task !== 'string') {
        return { ok: false, output: '', error: { code: 'BAD_ARGS', message: 'name/task 必填' } };
      }
      // 子代理是"工作模式质量第一"的手段（并行/隔离上下文），**只在工作模式放开**——
      // 闲聊里派子代理既费钱又没必要。
      if (ctx.mode !== 'work') {
        return {
          ok: false, output: '',
          error: { code: 'MODE_NOT_WORK', message: '派子代理只在工作模式可用。这件事需要拆分/并行的活，先说一声「进入工作模式」。' },
        };
      }
      if (!ctx.subagentRunner) {
        return { ok: false, output: '', error: { code: 'NO_AGENTS', message: '未定义任何 subagent' } };
      }
      const r = await ctx.subagentRunner(a.name, a.task);
      return r.ok ? { ok: true, output: r.output } : { ok: false, output: r.output, error: r.error };
    },
  };
}
