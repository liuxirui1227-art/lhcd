// 待办工具：她把「闲聊里聊出来的事」记进家里右栏那张待办卡。
//
// 为什么要这个工具：闲聊里聊出来的事也得记得住——
// 待办如果只能手工加，那她听你说「下周三之前得把名单发出去」时就只能嘴上应着，
// 你一关窗就没了。数据落在宿主侧的 todos.json（原子写、按天收起都在那边，
// 这里只管"记一条 / 看有哪些"，**不在 brain 里存任何待办状态**）。
//
// ❗ 与 schedule 的分工写进了工具说明（模型看得见）：
//   有明确时间点、到点要提醒 → schedule；只是一件要做的事 → todo。两个都记就会重复。
import type { ToolEntry } from './registry.js';

const PRIORITIES = ['high', 'mid', 'low'] as const;

export function todoTool(): ToolEntry {
  return {
    name: 'todo',
    permissionClass: 'write',
    exclusive: true,
    schema: {
      type: 'function',
      function: {
        name: 'todo',
        description:
          '记待办——会出现在用户家里右栏的「今日待办」里，能勾选、能标优先级。' +
          'action=add 记一条：text 写清"要做什么"（一句人话，像"把桌面那批截图归档"），' +
          'priority 可选 high/mid/low（**拿不准就别填**，没标就是「默认」档，不是错）。' +
          'action=list 看现在有哪些待办。' +
          '❗ 什么时候用它、什么时候用 schedule：**有明确时间点、到点要提醒**（"每天8点"、"下周三下午三点"）用 schedule；' +
          '**只是一件要做的事**（"把名单发出去"、"看看季报里那个数"）用它。**同一件事别两个都记。**',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['add', 'list'], description: '要做什么' },
            text: { type: 'string', description: 'add：要做什么（一句人话，别带路径）' },
            priority: { type: 'string', enum: [...PRIORITIES], description: 'add：优先级（可选；拿不准就别填）' },
          },
          required: ['action'],
        },
      },
    },
    executor: async (args, ctx) => {
      const port = ctx.ports?.todos;
      if (!port) {
        return { ok: false, output: '', error: { code: 'NO_TODO', message: '这台机器上没有挂载待办能力——别假装记下了，如实告诉用户这个能力没开' } };
      }
      const a = (args ?? {}) as Record<string, unknown>;
      const action = String(a.action ?? '');

      if (action === 'list') {
        try {
          const items = await port.list();
          if (!items.length) return { ok: true, output: '现在没有待办（今天还没排事）。' };
          const lines = items.map((t) => {
            const pri = t.priority === 'high' ? '（高）' : t.priority === 'mid' ? '（中）' : t.priority === 'low' ? '（低）' : '';
            return `- ${t.text}${pri}`;
          });
          return { ok: true, output: `现在有 ${items.length} 条待办：\n${lines.join('\n')}` };
        } catch (e) {
          return { ok: false, output: '', error: { code: 'TODO_FAIL', message: `读待办没成功：${(e as Error)?.message ?? e}` } };
        }
      }

      if (action === 'add') {
        const text = String(a.text ?? '').trim();
        if (!text) return { ok: false, output: '', error: { code: 'BAD_ARG', message: 'add 要带 text（要做什么）' } };
        const raw = a.priority === undefined || a.priority === null ? null : String(a.priority);
        if (raw !== null && !(PRIORITIES as readonly string[]).includes(raw)) {
          return { ok: false, output: '', error: { code: 'BAD_ARG', message: `priority 只能是 high / mid / low（或干脆不填）：${raw}` } };
        }
        try {
          const r = await port.add(text, { priority: (raw as 'high' | 'mid' | 'low' | null) });
          if (!r.ok) return { ok: false, output: '', error: { code: 'TODO_FAIL', message: r.error ?? '没记上' } };
          const pri = raw === 'high' ? '（高优先级）' : raw === 'mid' ? '（中优先级）' : raw === 'low' ? '（低优先级）' : '';
          return { ok: true, output: `记下了：${text}${pri}` };
        } catch (e) {
          return { ok: false, output: '', error: { code: 'TODO_FAIL', message: `没记上：${(e as Error)?.message ?? e}` } };
        }
      }

      return { ok: false, output: '', error: { code: 'BAD_ARG', message: `不认识的 action：${action || '(空)'}（可用：add / list）` } };
    },
  };
}
