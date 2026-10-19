// session_search：检索本会话被压缩掉的**历史原文**。
// 为什么要有它：摘要块里写着"需要细节用 session_search 去查"——没有这个工具，那句话就是空话。
// 只读工具；中文召回用双字 + 连续命中打分，中文历史照样搜得动。
import type { ToolEntry } from './registry.js';
import { SessionArchive } from '../session/archive.js';

export function sessionSearchTool(): ToolEntry {
  return {
    name: 'session_search',
    permissionClass: 'read',
    schema: {
      type: 'function',
      function: {
        name: 'session_search',
        description:
          '检索本会话的历史原文（含被压缩掉的旧消息，它们完整保留在存档里）。' +
          '当摘要里没有你要的细节——原始命令输出、文件内容、报错原文、用户原话、早先的推理——用它去查，**别猜**。',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '查询词（关键词或短句；中文可直接写）' },
            max: { type: 'number', description: '返回条数，默认 5' },
          },
          required: ['query'],
        },
      },
    },
    executor: async (args, ctx) => {
      const a = (args ?? {}) as { query?: unknown; max?: unknown };
      if (typeof a.query !== 'string' || a.query.trim().length === 0) {
        return { ok: false, output: '', error: { code: 'BAD_ARGS', message: 'query 必须为非空字符串' } };
      }
      const max = typeof a.max === 'number' && a.max >= 1 ? Math.min(Math.floor(a.max), 20) : 5;
      const hits = await new SessionArchive(ctx.runtime, ctx.sessionId).search(a.query, max);
      if (hits.length === 0) {
        return { ok: true, output: '（历史原文里没有找到相关内容；可能这段从没被压缩过，本会话仍在上下文里）' };
      }
      const lines = hits.map(
        (h, i) => `${i + 1}. [${h.msg.at} ${h.msg.role}${h.msg.toolCallId ? `(${h.msg.toolCallId})` : ''}] ${h.excerpt}`,
      );
      return { ok: true, output: lines.join('\n') };
    },
  };
}
