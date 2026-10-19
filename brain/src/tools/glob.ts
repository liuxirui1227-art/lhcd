// glob 工具：按模式列文件路径，最多 500 条。
import type { ToolEntry } from './registry.js';

const MAX_FILES = 500;

export function globTool(): ToolEntry {
  return {
    name: 'glob',
    permissionClass: 'read',
    schema: {
      type: 'function',
      function: {
        name: 'glob',
        description: '按 glob 模式列出文件路径。',
        parameters: {
          type: 'object',
          properties: {
            pattern: { type: 'string', description: 'glob 模式，如 src/**/*.ts' },
            path: { type: 'string', description: '根目录（默认会话目录）' },
            max: { type: 'number', description: '最多返回条数（默认 500）' },
          },
          required: ['pattern'],
        },
      },
    },
    executor: async (args, ctx) => {
      const a = (args ?? {}) as { pattern?: unknown; path?: unknown; max?: unknown };
      if (typeof a.pattern !== 'string' || a.pattern.length === 0) {
        return { ok: false, output: '', error: { code: 'BAD_ARGS', message: 'pattern 必须为非空字符串' } };
      }
      const max = typeof a.max === 'number' && a.max >= 1 ? Math.floor(a.max) : MAX_FILES;
      // 根目录：会话目录 + 模式内目录前缀（相对会话目录）
      const files = await ctx.runtime.fs.glob(a.pattern);
      const truncated = files.length > max;
      return {
        ok: true,
        output: files.slice(0, max).join('\n') + (truncated ? `\n…（共 ${files.length} 个文件，已截断至 ${max}）` : ''),
        truncated,
      };
    },
  };
}
