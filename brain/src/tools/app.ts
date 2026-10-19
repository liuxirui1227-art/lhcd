// app 工具：打开/激活应用、剪贴板、通知、osascript 脚本、
// 以及日历事件/提醒事项（经 runtime.app.run 的 osascript）。
// 权限：permissionClass='app'（默认 ask；白名单/信任模式见 policy/engine.ts）。
// 分级模型：观察 observe（自动，一次授权）/ 建议 suggest（LLM 起草，确认后执行）/
// 执行 execute（每次确认或规则批量授权）/ 高风险 highRisk（必须逐次确认 + device_action 审计）。
import type { ToolEntry } from './registry.js';

export type DeviceLevel = 'observe' | 'suggest' | 'execute' | 'highRisk';
export const DEVICE_LEVELS: readonly DeviceLevel[] = ['observe', 'suggest', 'execute', 'highRisk'];

/**
 * 动作分级（确定性分类，不信任模型自报）：
 * - observe：只读系统信息（剪贴板读取）
 * - execute：常规系统操作（打开/激活应用、通知、日历、提醒）
 * - highRisk：任意脚本执行（可删文件/发消息等不可预期副作用）
 * - suggest：LLM 起草类（无对应工具动作；对话层生成，宿主确认后转 execute）
 */
export function deviceLevelFor(action: string): DeviceLevel {
  switch (action) {
    case 'clipboard':
      return 'observe';
    case 'run':
      return 'highRisk';
    case 'open':
    case 'activate':
    case 'notify':
    case 'calendar':
    case 'reminder':
      return 'execute';
    default:
      return 'highRisk'; // 未知动作按最高风险对待（保守兜底）
  }
}

/** 撤销信息（device_action 审计字段；不可自动撤销的动作明示） */
export function deviceUndoHint(action: string): string {
  switch (action) {
    case 'open':
    case 'activate':
      return '再次切换或退出该应用即可还原';
    case 'calendar':
      return '在日历中删除该事件即可撤销';
    case 'reminder':
      return '在提醒事项中删除该提醒即可撤销';
    case 'notify':
      return '通知仅展示一次，无副作用，无需撤销';
    case 'clipboard':
      return '只读操作，无副作用';
    default:
      return '脚本执行无法自动撤销，已记录完整审计（动作/结果/时间）';
  }
}

/** 转义 AppleScript 双引号字符串 */
function asq(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function calendarScript(title: string, date: string): string {
  return `tell application "Calendar" to tell calendar 1 to make new event with properties {summary:${asq(title)}, start date:date ${asq(date)}, end date:date ${asq(date)}}`;
}

function reminderScript(title: string, date: string): string {
  return `tell application "Reminders" to tell list 1 to make new reminder with properties {name:${asq(title)}, due date:date ${asq(date)}}`;
}

export function appTool(): ToolEntry {
  return {
    name: 'app',
    permissionClass: 'app',
    capabilityRequirement: 'app',
    schema: {
      type: 'function',
      function: {
        name: 'app',
        description:
          '操作系统应用（macOS，分级授权）：观察级=clipboard 读剪贴板（只读）；执行级=open/activate 打开激活应用、notify 发通知、calendar 添加日历事件、reminder 创建提醒；高风险级=run 执行 osascript 脚本（必须逐次人工确认）。所有操作全程审计（device_action 入日志）。',
        parameters: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: ['open', 'activate', 'clipboard', 'notify', 'run', 'calendar', 'reminder'],
              description: 'open=打开应用; activate=激活; clipboard=读剪贴板; notify=发通知; run=执行脚本; calendar=添加日历事件; reminder=创建提醒',
            },
            target: { type: 'string', description: '应用名/路径（open/activate 用）' },
            text: { type: 'string', description: '通知标题与正文用 | 分隔（notify 用）' },
            script: { type: 'string', description: 'osascript 脚本（run 用）' },
            title: { type: 'string', description: '日历事件/提醒标题（calendar/reminder 用）' },
            date: { type: 'string', description: '日期时间 "YYYY-MM-DD HH:mm"（calendar/reminder 用）' },
          },
          required: ['action'],
        },
      },
    },
    executor: async (args, ctx) => {
      const a = (args ?? {}) as {
        action?: unknown; target?: unknown; text?: unknown; script?: unknown; title?: unknown; date?: unknown;
      };
      if (typeof a.action !== 'string') {
        return { ok: false, output: '', error: { code: 'BAD_ARGS', message: 'action 必填' } };
      }
      const app = ctx.runtime.app;
      switch (a.action) {
        case 'open': {
          if (typeof a.target !== 'string' || !a.target) {
            return { ok: false, output: '', error: { code: 'BAD_ARGS', message: 'open 需要 target（应用名或路径）' } };
          }
          const r = await app.open(a.target);
          return r.ok ? { ok: true, output: r.output || `已打开 ${a.target}` } : { ok: false, output: r.output, error: { code: 'APP_ERROR', message: r.output || '打开失败' } };
        }
        case 'activate': {
          if (typeof a.target !== 'string' || !a.target) {
            return { ok: false, output: '', error: { code: 'BAD_ARGS', message: 'activate 需要 target' } };
          }
          const r = await app.activate(a.target);
          return r.ok ? { ok: true, output: r.output || `已激活 ${a.target}` } : { ok: false, output: r.output, error: { code: 'APP_ERROR', message: r.output || '激活失败' } };
        }
        case 'clipboard': {
          const r = await app.clipboard();
          return r.ok ? { ok: true, output: r.content } : { ok: false, output: '', error: { code: 'APP_ERROR', message: '读取剪贴板失败' } };
        }
        case 'notify': {
          if (typeof a.text !== 'string' || !a.text) {
            return { ok: false, output: '', error: { code: 'BAD_ARGS', message: 'notify 需要 text（标题|正文）' } };
          }
          const [title, ...rest] = a.text.split('|');
          const body = rest.join('|') || title!;
          const r = await app.notify(title!, body);
          return r.ok ? { ok: true, output: '通知已发送' } : { ok: false, output: r.output, error: { code: 'APP_ERROR', message: r.output || '通知失败' } };
        }
        case 'run': {
          if (typeof a.script !== 'string' || !a.script) {
            return { ok: false, output: '', error: { code: 'BAD_ARGS', message: 'run 需要 script' } };
          }
          const r = await app.run(a.script);
          return r.ok ? { ok: true, output: r.output } : { ok: false, output: r.output, error: { code: 'APP_ERROR', message: r.output || '脚本执行失败' } };
        }
        case 'calendar': {
          if (typeof a.title !== 'string' || typeof a.date !== 'string') {
            return { ok: false, output: '', error: { code: 'BAD_ARGS', message: 'calendar 需要 title 与 date（"YYYY-MM-DD HH:mm"）' } };
          }
          const r = await app.run(calendarScript(a.title, a.date));
          return r.ok ? { ok: true, output: `日历事件已创建：${a.title} @ ${a.date}` } : { ok: false, output: r.output, error: { code: 'APP_ERROR', message: r.output || '创建日历事件失败' } };
        }
        case 'reminder': {
          if (typeof a.title !== 'string' || typeof a.date !== 'string') {
            return { ok: false, output: '', error: { code: 'BAD_ARGS', message: 'reminder 需要 title 与 date（"YYYY-MM-DD HH:mm"）' } };
          }
          const r = await app.run(reminderScript(a.title, a.date));
          return r.ok ? { ok: true, output: `提醒已创建：${a.title} @ ${a.date}` } : { ok: false, output: r.output, error: { code: 'APP_ERROR', message: r.output || '创建提醒失败' } };
        }
        default:
          return { ok: false, output: '', error: { code: 'BAD_ACTION', message: `未知 action: ${String(a.action)}` } };
      }
    },
  };
}
