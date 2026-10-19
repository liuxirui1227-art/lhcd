// UI 2.0 · 统一 Task State 状态机(纯逻辑零依赖;main.mjs 持全局单例 taskBus,三窗口广播)
// 流转规则:
//   Idle → Listening → Thinking → Working → Success / Error
//   Working ↔ Approval(高风险审批;允许 → 回 Working 继续,拒绝 → Cancelled)
//   活动态(Listening/Thinking/Working/Approval)→ Cancelled → Idle
//   Quiet:全局静默氛围态(TA 不主动出现)↔ Idle 互转,不参与任务链
//   Success / Error / Cancelled 展示后由 UI 层回落 Idle(状态机不设定时器)
// 文案为人话:普通 UI 只许出现 label/detail,禁止 tool/ruleId/模型名等技术字段。
//
// **状态词不在这份文件里**：唯一真源是 `ui/state-words.js`——同时被渲染层（classic script，
//   `window.TaskWords`）与主进程（ESM，`globalThis.TaskWords`）加载。这里只重新导出，保持
//   `import { TASK_STATE_LABELS } from './ui/task-state.mjs'` 的老调用方照旧可用。
import './state-words.js';

const Words = globalThis.TaskWords;

/** 全部状态词(9):Idle 空闲 / Listening 我在听 / Thinking 让我想想 / Working 干活中 / Approval 求批准 / Success 搞定 / Error 没成 / Cancelled 已停 / Quiet 安静陪伴 */
export const TASK_STATES = Words.TASK_STATES;

/** 活动态:正在为用户做一件事,Quiet/Idle 之外的收尾态不算 */
export const BUSY_STATES = Words.BUSY_STATES;

/** 合法流转表:from → 允许的 to 集合 */
const TRANSITIONS = {
  Idle: ['Listening', 'Thinking', 'Quiet'], // Thinking:直答类请求可跳过 Listening
  Quiet: ['Idle', 'Listening'], // 安静中也可被直接唤起干活
  // Working:她可能在**一个字都没说**的时候就动手了（模型直接发 tool_call，没有 text.delta）。
  // 原先只有 Thinking→Working，于是工具执行全程落在 Listening 里 → 界面只能显示「我在听」，
  // 而屏幕上正滚着「看了 yyy.php」——这就是"我在做怎么是听呢"的根因。
  Listening: ['Thinking', 'Working', 'Cancelled', 'Idle'],
  Thinking: ['Working', 'Success', 'Error', 'Cancelled', 'Listening'], // Listening:追问澄清
  Working: ['Approval', 'Success', 'Error', 'Cancelled', 'Thinking'],
  Approval: ['Working', 'Cancelled'], // 允许 → 回 Working;不允许 → Cancelled
  Success: ['Idle'],
  Error: ['Idle', 'Listening', 'Thinking'], // 重试 = 重新进任务链
  Cancelled: ['Idle'],
};

/** 人话文案(detail 由调用方带具体事项,如「帮你整理下载文件夹」) */
export const TASK_STATE_LABELS = Words.TASK_STATE_LABELS;

/** 「正在…」进行态用词——对话流里那行计时抬头用它。**与 LABELS 同一处真源**：
 *  多处各存一份必然漂移（"正在做" / "正在干活" / "我正在做" 说的是同一件事）。 */
export const TASK_STATE_PENDING = Words.TASK_STATE_PENDING;

/** i18n key（宿主广播时用 lib.t(key) 取值）。 */
export const TASK_STATE_KEYS = Words.TASK_STATE_KEYS;
export const TASK_STATE_PENDING_KEYS = Words.TASK_STATE_PENDING_KEYS;

/** 一次给出某个状态的两句话（宿主广播 task-state 时挂在事件上；页面零表消费）。 */
export const stateWords = Words.stateWords;

/** 流转失败的稳定 reason 码(UI 层人话化,不直接上屏) */
export const DENY_REASONS = { BAD_TARGET: 'bad_target', NO_PATH: 'no_path' };

/**
 * 创建状态机实例。main.mjs 全局一个单例;测试可多实例。
 * set() 返回 { ok, from, to } 或 { ok:false, reason, from, to };订阅回调收到 { from, to, at, detail }。
 */
export function createTaskState(initial = 'Idle') {
  if (!TASK_STATES.includes(initial)) throw new Error(`未知初始状态 ${initial}`);
  let state = initial;
  const subs = new Set();
  const history = []; // 最近 50 条流转,详情排障用(可进 diag.log,不上普通 UI)
  const api = {
    get state() { return state; },
    isBusy() { return BUSY_STATES.includes(state); },
    can(next) { return !!TRANSITIONS[state]?.includes(next); },
    set(next, detail = null) {
      if (!TASK_STATES.includes(next)) return { ok: false, reason: DENY_REASONS.BAD_TARGET, from: state, to: next };
      if (!api.can(next)) return { ok: false, reason: DENY_REASONS.NO_PATH, from: state, to: next };
      const from = state;
      state = next;
      const ev = { from, to: next, at: Date.now(), detail };
      history.push(ev);
      if (history.length > 50) history.shift();
      for (const fn of subs) { try { fn(ev); } catch { /* 订阅者异常不阻断状态机 */ } }
      return { ok: true, from, to: next };
    },
    /** 订阅流转 → 返回退订函数(三窗口广播用) */
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
    /** 只读历史(最近流转,测试与排障) */
    get history() { return [...history]; },
    /** 仅供测试钩子:重置到 Idle(生产 UI 不得调用) */
    __reset() { state = 'Idle'; subs.clear(); history.length = 0; },
  };
  return api;
}
