// bash 工具：单条 shell（sh -c，cwd=会话目录，超时默认 60s，env 白名单，输出截断 50KB）。
import type { ToolEntry } from './registry.js';

const MAX_OUTPUT = 50 * 1024;

export function bashTool(): ToolEntry {
  return {
    name: 'bash',
    permissionClass: 'bash',
    capabilityRequirement: 'exec',
    schema: {
      type: 'function',
      function: {
        name: 'bash',
        description: '在 shell 中执行单条命令（工作目录=会话目录）。用于编译/运行/安装/git 等命令行操作。禁止交互式命令。',
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string', description: '要执行的命令（单条）' },
            timeout: { type: 'number', description: '超时秒数', default: 60 },
          },
          required: ['command'],
        },
      },
    },
    executor: async (args, ctx) => {
      const a = (args ?? {}) as { command?: unknown; timeout?: unknown };
      if (typeof a.command !== 'string' || a.command.length === 0) {
        return { ok: false, output: '', error: { code: 'BAD_ARGS', message: 'command 必须为非空字符串' } };
      }
      const timeoutSec = typeof a.timeout === 'number' && a.timeout > 0 ? a.timeout : 60;
      const res = await ctx.runtime.exec(a.command, { timeoutMs: timeoutSec * 1000 });
      const output = res.output.length > MAX_OUTPUT ? `${res.output.slice(0, MAX_OUTPUT)}\n…（输出已截断 50KB）` : res.output;
      const truncated = res.output.length > MAX_OUTPUT;
      if (!res.ok) {
        return {
          ok: false,
          output,
          truncated,
          error: { code: `EXIT_${res.code}`, message: `命令退出码 ${res.code}` },
        };
      }
      return { ok: true, output, truncated };
    },
  };
}
