// grep 工具：正则搜索 文件:行号:内容，最多 200 条；排除 node_modules/.git/dist。
import type { ToolEntry } from './registry.js';

const MAX_HITS = 200;

export function grepTool(): ToolEntry {
  return {
    name: 'grep',
    permissionClass: 'read',
    schema: {
      type: 'function',
      function: {
        name: 'grep',
        description: '正则搜索文件内容，返回 文件:行号:内容。',
        parameters: {
          type: 'object',
          properties: {
            pattern: { type: 'string', description: '正则表达式' },
            path: { type: 'string', description: '搜索目录（默认会话目录）' },
            glob: { type: 'string', description: '文件名过滤，如 *.ts' },
            max: { type: 'number', description: '最多返回条数（默认 200）' },
          },
          required: ['pattern'],
        },
      },
    },
    executor: async (args, ctx) => {
      const a = (args ?? {}) as { pattern?: unknown; path?: unknown; glob?: unknown; max?: unknown };
      if (typeof a.pattern !== 'string' || a.pattern.length === 0) {
        return { ok: false, output: '', error: { code: 'BAD_ARGS', message: 'pattern 必须为非空字符串' } };
      }
      const root = typeof a.path === 'string' && a.path ? a.path : '.';
      const glob = typeof a.glob === 'string' && a.glob ? a.glob : undefined;
      const max = typeof a.max === 'number' && a.max >= 1 ? Math.floor(a.max) : MAX_HITS;
      let hits;
      try {
        hits = await ctx.runtime.fs.grep(a.pattern, root, glob);
      } catch (err) {
        return { ok: false, output: '', error: { code: 'BAD_REGEX', message: (err as Error).message } };
      }
      const truncated = hits.length > max;
      const lines = hits.slice(0, max).map((h) => `${h.file}:${h.line}:${h.text}`).join('\n');
      return {
        ok: true,
        output: lines + (truncated ? `\n…（共 ${hits.length} 条，已截断至 ${max}）` : ''),
        truncated,
      };
    },
  };
}
