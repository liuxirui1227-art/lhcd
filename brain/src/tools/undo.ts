// undo 工具——文件回滚：把改过的文件整体退回改动前的样子。
//
// 干什么：**把这一轮（或指定的某一轮）改过的文件整体退回改动前的样子**。
//   · 本来存在的 → 写回改动前的内容；
//   · 本来是新建的 → **删掉**（走回收站，不是直接 rm——"不可逆的事不做"是 `delete` 那条线的规矩）；
//   · 还原不了的（当时没留快照）→ **如实说哪几个没退成**，绝不整体报成功。
//
// 与 `.bak` 的分工：`.bak` 还在（单层、就近可见，人工排障方便），但**回滚不靠它**——
// 一轮里改三次，`.bak` 里躺的只是"第二次改之前"，真正要退回去的是"这一轮开始之前"（快照里才有）。
//
// 为什么做成工具而不是只有按钮：用户在对话里说"刚才那个改回去"也该走得通；界面那颗按钮走的是同一条路。
import type { ToolEntry } from './registry.js';

export function undoTool(): ToolEntry {
  return {
    name: 'undo',
    permissionClass: 'write',
    exclusive: true,
    schema: {
      type: 'function',
      function: {
        name: 'undo',
        description:
          '把刚才这一轮（或指定回合）改过的文件**整体退回改动前的样子**：改过的写回去，这一轮新建的删掉。' +
          '用户说「改回去 / 撤销刚才那次 / 退回原样」时用它。只能退到"这一轮开始前"，不是任意历史点。',
        parameters: {
          type: 'object',
          properties: {
            turnId: { type: 'string', description: '要退的回合（可省：缺省退最近一次改动）' },
            why: { type: 'string', description: '为什么退（可省；会记进审计）' },
          },
        },
      },
    },
    executor: async (args, ctx) => {
      const store = ctx.snapshotStore;
      if (!store) {
        return { ok: false, output: '', error: { code: 'NO_SNAPSHOTS', message: '这台机器上没挂快照通道，退不回去（如实说，不假装）' } };
      }
      const a = (args ?? {}) as { turnId?: unknown; why?: unknown };
      const turnId = typeof a.turnId === 'string' && a.turnId ? a.turnId : await store.lastTurnId();
      if (!turnId) return { ok: false, output: '', error: { code: 'NOTHING_TO_UNDO', message: '没有可退的回合：这一轮（以及之前）没改过任何文件' } };
      const plan = await store.plan(turnId);
      if (!plan.total) return { ok: false, output: '', error: { code: 'NOTHING_TO_UNDO', message: `回合 ${turnId} 没改过文件，没什么可退的` } };
      /* **已经退回去过的回合不许再退**。再跑一遍的后果不是"没变化"，而是
         "把用户在这之后新建的文件送进回收站、把他手改过的内容用陈旧快照盖回去"（不可逆）。 */
      if (plan.alreadyUndone) {
        return { ok: false, output: '', error: { code: 'ALREADY_UNDONE', message: `回合 ${turnId} 之前已经退回去过了——不再退一遍（再退会删掉你之后新建的文件、盖掉你后来的手改）` } };
      }

      const restored: string[] = [];
      const removed: string[] = [];
      const failed: Array<{ path: string; reason: string }> = [...plan.failed];

      for (const r of plan.restore) {
        try {
          await ctx.runtime.fs.write(r.path, r.content);
          restored.push(r.path);
        } catch (e) {
          failed.push({ path: r.path, reason: String((e as Error)?.message ?? e) });
        }
      }
      for (const p of plan.remove) {
        const trash = ctx.ports?.trash;
        if (!trash) {
          failed.push({ path: p, reason: '这台机器上没有回收站通道——我不直接删（不可逆的事不做），这一个没退成' });
          continue;
        }
        try {
          await trash.trash(p);
          removed.push(p);
        } catch (e) {
          failed.push({ path: p, reason: String((e as Error)?.message ?? e) });
        }
      }

      /* 全部退成了才记"这一回合已退"（部分失败不记：留着重试那没退成的几个，
         再点时"已写回的"是幂等的，"已进回收站的"会如实报没退成——不会造成新的破坏）。 */
      if (failed.length === 0) await store.markUndone(turnId);

      ctx.emit({
        type: 'undo.done',
        turnId,
        restored: restored.length,
        removed: removed.length,
        failed: failed.length,
        why: String(a.why ?? ''),
      });
      // 退回去的文件不该再算"这一轮改过的"（否则改后自检会拿着旧账来核对）
      for (const p of [...restored, ...removed]) {
        const i = (ctx.mutations ?? []).findIndex((m) => m.path === p);
        if (i >= 0) ctx.mutations!.splice(i, 1);
      }

      const lines = [
        `已退回：回合 ${turnId} 动过的 ${plan.total} 个文件`,
        restored.length ? `· 写回原样 ${restored.length} 个：${restored.join('、')}` : '',
        removed.length ? `· 这一轮新建的删掉 ${removed.length} 个（在回收站里）：${removed.join('、')}` : '',
        failed.length ? `· **没退成 ${failed.length} 个**：${failed.map((f) => `${f.path}（${f.reason}）`).join('；')}` : '',
      ].filter(Boolean);
      return { ok: true, output: lines.join('\n') };
    },
  };
}
