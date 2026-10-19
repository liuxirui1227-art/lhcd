// read 工具：读文件带行号（行号<TAB>内容），默认前 2000 行；二进制拒绝。
import type { ToolEntry } from './registry.js';
import { opaqueReadHint } from './opaque.js';

export function readTool(): ToolEntry {
  return {
    name: 'read',
    permissionClass: 'read',
    schema: {
      type: 'function',
      function: {
        name: 'read',
        description: '读取文件内容并附带行号。用于查看文件、定位代码、核对输出。',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: '相对会话目录或绝对路径' },
            offset: { type: 'number', description: '起始行号（1 起，默认 1）' },
            limit: { type: 'number', description: '读取行数（默认 2000）' },
          },
          required: ['path'],
        },
      },
    },
    executor: async (args, ctx) => {
      const a = (args ?? {}) as { path?: unknown; offset?: unknown; limit?: unknown };
      if (typeof a.path !== 'string' || a.path.length === 0) {
        return { ok: false, output: '', error: { code: 'BAD_ARGS', message: 'path 必须为非空字符串' } };
      }
      const offset = typeof a.offset === 'number' && a.offset >= 1 ? Math.floor(a.offset) : 1;
      const limit = typeof a.limit === 'number' && a.limit >= 1 ? Math.floor(a.limit) : 2000;
      let res;
      try {
        res = await ctx.runtime.fs.read(a.path, { offset, limit });
      } catch (err) {
        return { ok: false, output: '', error: { code: 'READ_ERROR', message: (err as Error).message } };
      }
      if (res.content.includes('\0')) {
        const hint = opaqueReadHint(a.path);
        return {
          ok: false, output: '',
          error: { code: 'BINARY_FILE', message: `二进制文件，拒绝读取（硬读出来也是乱码）${hint ? `。${hint}` : ''}` },
        };
      }
      const lines = res.content.split('\n');
      if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop(); // 去掉末尾空行
      const numbered = lines.map((l, i) => `${offset + i}\t${l}`).join('\n');
      const shownTo = offset + lines.length - 1;
      const more = res.lines - shownTo;
      // 分页续读指引（出处 pi `truncate.ts` 的 "Showing lines X-Y of Z. Use offset=N to continue."）：
      // 没读完就直说还有多少行、下一句该怎么写——模型几乎不用再想下一步
      const header = `（文件共 ${res.lines} 行，显示第 ${offset}~${shownTo} 行${more > 0 ? `；还有 ${more} 行没显示，接着看就带 offset=${shownTo + 1}` : ''}）\n`;
      return { ok: true, output: header + numbered };
    },
  };
}
