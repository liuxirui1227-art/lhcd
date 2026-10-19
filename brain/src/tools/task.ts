// 任务账本工具：让"长活能接着干"可以被说出来。
//
// 与 schedule 的分工：schedule 管"什么时候做"（定时），task 管"做到哪一步了"（账本）。
// 她说「帮我把这个项目整理完，没弄完别停」→ 模型 create（带完成信号）→ 没输出信号就会被拦回来继续；
// 她说「这件事卡住了，要你拍板」→ 模型 block（一等状态）→ 催办退避按曲线来问。
import type { ToolEntry } from './registry.js';
import type { TaskStore } from '../task/store.js';
import { completionBriefing } from '../task/criteria.js';
import { statusWord, progressOf, type RunState, type StepState } from '../task/types.js';

const STEP_STATES: StepState[] = ['pending', 'running', 'completed', 'failed', 'blocked', 'skipped', 'cancelled'];

/** 状态词的英文→落库态（模型可能给 in_progress 这类可见态词） */
function normalizeStepState(v: unknown): StepState | undefined {
  const s = String(v ?? '').trim().toLowerCase();
  if (!s) return undefined;
  if (s === 'in_progress' || s === 'in-progress' || s === 'doing') return 'running';
  if (s === 'done') return 'completed';
  if (s === 'todo') return 'pending';
  return (STEP_STATES as string[]).includes(s) ? (s as StepState) : undefined;
}

function renderRun(run: ReturnType<TaskStore['get']> & object, withSteps = true): string {
  const w = statusWord(run);
  const p = progressOf(run);
  const head = `[${run.id}] ${run.title}｜${w.label}${p ? `（${p.done}/${p.total} 步）` : ''}${w.hint ? `｜${w.hint}` : ''}`;
  if (!withSteps || !run.steps.length) return head;
  const steps = run.steps
    .map((s) => `  ${s.id === '' ? '' : ''}${s.state === 'completed' ? '✅' : s.state === 'running' ? '🔄' : s.state === 'failed' ? '❌' : s.state === 'blocked' ? '⛔' : s.state === 'skipped' ? '⏭' : '⬜'} ${s.id} ${s.title}${s.resultSummary ? `（${String(s.resultSummary).slice(0, 60)}）` : ''}`)
    .join('\n');
  return `${head}\n${steps}`;
}

export function taskTool(store: TaskStore): ToolEntry {
  return {
    name: 'task',
    permissionClass: 'write',
    exclusive: true,
    schema: {
      type: 'function',
      function: {
        name: 'task',
        description:
          '任务账本：把"要跨很多步、可能跨重启的长活"记在账上，关掉软件再打开还能接着干。' +
          'action=create 建一件事（title 一句话说清；steps 给步骤清单；promise 给"完成信号"——' +
          '**给了它就必须真做完**：没原样输出这个信号之前，每次想收尾都会被拦回来继续；' +
          '用户说"没弄完别停/做完为止"时就用它）；action=start/step 更新某一步的进展（step 要 id 与 state）；' +
          'action=block 卡住了、**需要用户拍板**（question 写清要他决定什么）；action=answer 用户答了、接着干；' +
          'action=complete 收尾；action=cancel 不做了；action=list 看手上有什么；action=get 看一件事的细节。',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['create', 'start', 'step', 'block', 'answer', 'complete', 'cancel', 'list', 'get'], description: '要做什么' },
            title: { type: 'string', description: 'create：这件事一句话（如"整理季度报表"）' },
            explanation: { type: 'string', description: 'create：为什么要做（人话，将来跟她/他复述用）' },
            steps: {
              type: 'array',
              description: 'create：步骤清单（按顺序；不写依赖时默认第 N 步等第 N-1 步）',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string', description: '步骤 id（如 s1；不写自动编号）' },
                  title: { type: 'string', description: '这一步做什么' },
                  goal: { type: 'string', description: '这一步的目标' },
                  acceptance: { type: 'string', description: '怎么算做完（写给人看，也用来自查）' },
                  dependencies: { type: 'array', items: { type: 'string' }, description: '依赖的前置步骤 id' },
                },
                required: ['title'],
              },
            },
            promise: { type: 'string', description: 'create：完成信号（如 DONE-ALL；真做完时原样输出它）' },
            maxIterations: { type: 'number', description: 'create：最多拦回来续跑几次（默认 12，上限 50）' },
            id: { type: 'string', description: '任务 id（start/step/block/answer/complete/cancel/get 用）' },
            stepId: { type: 'string', description: 'step：哪一步' },
            state: { type: 'string', description: 'step：这一步的状态（pending/running/completed/failed/blocked/skipped）' },
            summary: { type: 'string', description: 'step：做完了有什么结果 / complete：整件事的收尾说明' },
            artifacts: { type: 'array', items: { type: 'string' }, description: 'step：产物文件路径' },
            detail: { type: 'string', description: 'step：失败/卡住的原因（人话）' },
            question: { type: 'string', description: 'block：要用户决定什么（人话，一句话）' },
            answer: { type: 'string', description: 'answer：用户答了什么' },
          },
          required: ['action'],
        },
      },
    },
    executor: async (args, ctx) => {
      const a = (args ?? {}) as Record<string, unknown>;
      const action = String(a.action ?? '');

      if (action === 'create') {
        const title = String(a.title ?? '').trim();
        if (!title) return { ok: false, output: '', error: { code: 'BAD_ARGS', message: 'create 需要 title' } };
        const promise = a.promise ? String(a.promise).slice(0, 60) : undefined;
        const run = await store.create({
          title,
          explanation: String(a.explanation ?? ''),
          origin: 'chat',
          sessionId: ctx.sessionId,
          steps: Array.isArray(a.steps) ? (a.steps as Array<{ title: string }>) : [],
          completionPromise: promise,
          maxIterations: a.maxIterations === undefined ? undefined : Number(a.maxIterations),
        });
        const lines = [`已记在账上：[${run.id}] ${run.title}`];
        if (run.steps.length) lines.push(`步骤：${run.steps.map((s) => `${s.id} ${s.title}`).join('；')}`);
        if (promise) lines.push(completionBriefing(promise, run.maxIterations));
        else lines.push('（这件事没有完成信号：你判断做完了就算完；如果用户要求"没弄完别停"，下次建的时候给 promise。）');
        return { ok: true, output: lines.join('\n') };
      }

      if (action === 'list') {
        const runs = store.list().filter((r) => !['completed', 'cancelled'].includes(r.state));
        if (!runs.length) return { ok: true, output: '账上是空的（没有未完成的事）。' };
        return { ok: true, output: runs.map((r) => renderRun(r, false)).join('\n') };
      }

      const id = String(a.id ?? '').trim();
      if (!id) return { ok: false, output: '', error: { code: 'BAD_ARGS', message: `${action} 需要 id（先用 action=list 看有哪些）` } };

      if (action === 'get') {
        const run = store.get(id);
        if (!run) return { ok: false, output: '', error: { code: 'NOT_FOUND', message: `账上没有 ${id}` } };
        return { ok: true, output: renderRun(run, true) };
      }

      if (action === 'start' || action === 'step') {
        const stepId = String(a.stepId ?? '').trim();
        if (!stepId) {
          const run = store.get(id);
          const next = run?.steps.find((s) => s.state === 'pending' || s.state === 'running');
          if (!next) return { ok: false, output: '', error: { code: 'BAD_ARGS', message: 'step 需要 stepId（也可以用 action=get 看有哪几步）' } };
          return { ok: false, output: '', error: { code: 'BAD_ARGS', message: `step 需要 stepId——眼下该推进的是 ${next.id}（${next.title}）` } };
        }
        const state = normalizeStepState(a.state) ?? 'completed';
        const r = await store.updateStep(id, stepId, {
          state,
          ...(a.summary !== undefined ? { resultSummary: String(a.summary) } : {}),
          ...(a.detail !== undefined ? { detail: String(a.detail) } : {}),
          ...(Array.isArray(a.artifacts) ? { artifacts: (a.artifacts as string[]).map(String) } : {}),
        });
        if (!r.ok) return { ok: false, output: '', error: { code: 'STEP_REJECTED', message: r.error ?? '更新失败' } };
        const run = store.get(id)!;
        const p = progressOf(run);
        return { ok: true, output: `记下了：${stepId} → ${state}。${p ? `现在 ${p.done}/${p.total} 步。` : ''}\n${renderRun(run, true)}` };
      }

      if (action === 'block') {
        const q = String(a.question ?? '').trim();
        if (!q) return { ok: false, output: '', error: { code: 'BAD_ARGS', message: 'block 需要 question（写清要他决定什么）' } };
        const r = await store.askUser(id, q);
        if (!r.ok) return { ok: false, output: '', error: { code: 'NOT_FOUND', message: r.error ?? '没找到这件事' } };
        return { ok: true, output: `记下了：这件事卡在等你拍板——「${q}」。**现在就把这个问题用你自己的话问他**（别只说"我需要你决定一件事"就完了，把问题和选项说清楚）。他要是没回，我会按退避曲线过 30 分钟/1 小时/2 小时各提醒一次。` };
      }

      if (action === 'answer') {
        const r = await store.answerUser(id, a.answer ? String(a.answer) : undefined);
        if (!r.ok) return { ok: false, output: '', error: { code: 'NOT_FOUND', message: r.error ?? '没找到这件事' } };
        return { ok: true, output: '好，接着干。' };
      }

      if (action === 'complete') {
        const r = await store.complete(id, a.summary ? String(a.summary) : undefined);
        if (!r.ok) return { ok: false, output: '', error: { code: 'NOT_FOUND', message: r.error ?? '没找到这件事' } };
        return { ok: true, output: '这件事收尾了。' };
      }

      if (action === 'cancel') {
        const r = await store.cancel(id, a.detail ? String(a.detail) : undefined);
        if (!r.ok) return { ok: false, output: '', error: { code: 'NOT_FOUND', message: r.error ?? '没找到这件事' } };
        return { ok: true, output: '好，这件事不做了。' };
      }

      return { ok: false, output: '', error: { code: 'BAD_ARGS', message: `未知 action：${action}` } };
    },
  };
}

export type { RunState };
