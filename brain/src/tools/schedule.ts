// 定时任务工具：让"答应你的事，关掉软件也算数"可以被自然语言设出来。
// 任务表由宿主（factory 构造的 CronJobs）持有：原子写 + 触发前推进 + 崩溃只补一次 + 一次性过期作废。
import type { ToolEntry } from './registry.js';
import type { CronJobs } from '../orchestrate/jobs.js';

function humanNext(ts: number | null): string {
  if (!ts) return '不再触发';
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function scheduleTool(jobs: CronJobs): ToolEntry {
  return {
    name: 'schedule',
    permissionClass: 'write',
    exclusive: true,
    schema: {
      type: 'function',
      function: {
        name: 'schedule',
        description:
          '设定时提醒/定时任务（关掉软件也会算数：下次打开会补上错过的、且只补一次）。' +
          'action=create 建任务：spec 用 5 字段 cron（分 时 日 月 周，如 每天8点="0 8 * * *"，每天9点半="30 9 * * *"，工作日9点="0 9 * * 1-5"）' +
          '或一次性时间 kind=once + ISO 时间（如 2026-09-19T08:00:00）；task 写清"到点要做什么"（用你自己的口吻）。' +
          'action=list 列出任务；action=cancel 取消（要 id）；action=note 给任务记一个小本子（key/value，跨次记住进度）。',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['create', 'list', 'cancel', 'note'], description: '要做什么' },
            spec: { type: 'string', description: 'create：cron 表达式（5 字段）或 once 的 ISO 时间' },
            kind: { type: 'string', enum: ['cron', 'once'], description: 'create：循环任务（cron）还是一次性提醒（once）' },
            task: { type: 'string', description: 'create：到点要做的内容（自然语言，会作为一条消息送回对话）' },
            id: { type: 'string', description: 'cancel/note：任务 id' },
            key: { type: 'string', description: 'note：小本子的键' },
            value: { type: 'string', description: 'note：小本子的值（≤16KB）' },
          },
          required: ['action'],
        },
      },
    },
    executor: async (args, ctx) => {
      const cron = ctx.cronJobs;
      if (!cron) return { ok: false, output: '', error: { code: 'NO_CRON', message: '定时任务表未挂载（宿主未启动调度）' } };
      const a = (args ?? {}) as Record<string, unknown>;
      const action = String(a.action ?? '');

      if (action === 'create') {
        const r = await cron.create({
          spec: String(a.spec ?? ''),
          task: String(a.task ?? ''),
          kind: a.kind === 'once' ? 'once' : undefined,
          origin: 'assistant',
        });
        if (!r.ok) return { ok: false, output: '', error: { code: 'BAD_SCHEDULE', message: r.error ?? '创建失败' } };
        return { ok: true, output: `已记下：${r.job!.task}（下次 ${humanNext(r.job!.nextRunAt)}，id=${r.job!.id}）` };
      }

      if (action === 'list') {
        const list = cron.list();
        if (!list.length) return { ok: true, output: '现在没有定时任务。' };
        return {
          ok: true,
          output: list.map((j) => `- [${j.id}] ${j.task}｜${j.kind === 'once' ? '一次性 ' + j.spec : 'cron ' + j.spec}｜下次 ${humanNext(j.nextRunAt)}${j.enabled ? '' : '（已停）'}`).join('\n'),
        };
      }

      if (action === 'cancel') {
        const r = await cron.cancel(String(a.id ?? ''));
        if (!r.ok) return { ok: false, output: '', error: { code: 'NOT_FOUND', message: r.error ?? '没有这个任务' } };
        return { ok: true, output: '好，这个任务取消了。' };
      }

      if (action === 'note') {
        const id = String(a.id ?? '');
        const key = String(a.key ?? '');
        if (!key) return { ok: false, output: '', error: { code: 'BAD_ARGS', message: 'note 需要 key' } };
        const r = await cron.setNote(id, key, String(a.value ?? ''));
        if (!r.ok) return { ok: false, output: '', error: { code: 'NOTE_REJECTED', message: r.error ?? '记事本写入失败' } };
        return { ok: true, output: `已记下 ${key}（下次跑这个任务时会带着它）。` };
      }

      return { ok: false, output: '', error: { code: 'BAD_ARGS', message: `未知 action：${action}` } };
    },
  };
}
