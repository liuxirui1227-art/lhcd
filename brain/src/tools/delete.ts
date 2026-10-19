// delete 工具：删文件一律走回收站（可撤回）。
//
// 为什么单列一条：这是"敢不敢让 TA 碰文件"的**心理前提**——用户能接受 TA 改错，不能接受 TA 删掉。
// **回收站把"不可逆"变成"可撤回"，性质就变了**。
//
// 三条：
//   ① `rm` 一类命令在硬 deny 里（policy/deny.ts），错误信息直接指向本工具
//   ② 本工具走宿主注入的 TrashPort（macOS = 系统回收站）
//   ③ 回收站不可用（网络盘等）→ **拒绝执行并说明**，绝不降级为直接删除
// 多文件：逐项返回结果（成功/失败分开报，**不整体报成功**）。
import type { ToolEntry } from './registry.js';

export function deleteTool(): ToolEntry {
  return {
    name: 'delete',
    permissionClass: 'write',
    exclusive: true,
    schema: {
      type: 'function',
      function: {
        name: 'delete',
        description:
          '把文件/文件夹移到**回收站**（可撤回——这是删东西的唯一正确方式；rm 这类命令会被拦下来）。' +
          'paths 可以给多个，逐个报告结果。删之前先确认是哪一个（不确定就先 list/glob 看一眼），别删错。',
        parameters: {
          type: 'object',
          properties: {
            paths: { type: 'array', items: { type: 'string' }, description: '要删的路径（一个或多个）' },
            reason: { type: 'string', description: '为什么删（可省；会记进审计）' },
          },
          required: ['paths'],
        },
      },
    },
    executor: async (args, ctx) => {
      const port = ctx.ports?.trash;
      const a = (args ?? {}) as { paths?: unknown; reason?: unknown };
      const paths = Array.isArray(a.paths) ? (a.paths as unknown[]).map(String).filter(Boolean) : [];
      if (!paths.length) return { ok: false, output: '', error: { code: 'BAD_ARGS', message: 'paths 必须是非空数组' } };
      if (!port) {
        return {
          ok: false, output: '',
          error: { code: 'NO_TRASH', message: '这台机器上没有可用的回收站通道——我不会直接删掉（不可逆的事不做）；请用户自己删，或换个方式' },
        };
      }
      const done: string[] = [];
      const failed: string[] = [];
      for (const p of paths) {
        try {
          const r = await port.trash(p);
          if (r.ok) done.push(p);
          else failed.push(`${p}（${r.error ?? '回收站不可用'}）`);
        } catch (e) {
          failed.push(`${p}（${(e as Error).message}）`);
        }
      }
      if (done.length && !failed.length) {
        return { ok: true, output: `已把 ${done.length} 项移到回收站（找不回来可以去回收站捞）：${done.join('、')}${a.reason ? `（原因：${String(a.reason)}）` : ''}` };
      }
      if (done.length && failed.length) {
        // 逐项分开报，不整体报成功
        return { ok: false, output: `成功 ${done.length} 项：${done.join('、')}\n没删成 ${failed.length} 项：${failed.join('、')}`, error: { code: 'PARTIAL_DELETE', message: '有一部分没删成，逐项结果见上' } };
      }
      return { ok: false, output: '', error: { code: 'TRASH_FAILED', message: `一项都没删成：${failed.join('；')}` } };
    },
  };
}
