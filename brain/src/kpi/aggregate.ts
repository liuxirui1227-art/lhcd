// KPI 日聚合（五项）
//
// 为什么做成**纯函数**："五个数字每个都能用账本/事件流**手工复算对上**"——
// 那就必须把"算什么"与"从哪读"分开：这里只吃**已经读出来的行**，不碰文件。
// 手工复算的过程 = 用同一批行按同样的口径数一遍，对不上就是这里写错了。
//
// 五项：
//   ① 任务成功率：任务账本里的终态（completed / failed / cancelled）——"交给她的活，成了几件"；
//   ② 验证成功率：`verify.report` 事件（工作模式才有）——"干了活之后，验证报告过没过"；
//   ③ 恢复成功率：`recovery.plan` 里 `recovered:true` 的占比（**分母是"重来过"的次数**）；
//   ④ 工具效率：`tool.result` 的失败率（**失败率越低越好**，所以同时给"效率 = 1 - 失败率"）；
//   ⑤ 每次成功成本：当天花销 ÷ 当天完成的任务数（**没有完成任务时不给数**——不给 0，也不给 ∞）。
//
// 口径纪律（写死在这里，免得下次换个人又换一套）：
//   · **分母为 0 就给 null**，绝不用 0 假装"零失败"或"没花钱"；
//   · 只数**这一天**的行（按调用方给的日期过滤好的行进来）；
//   · `cancelled` 不算失败也不算成功——它是"用户自己叫停的"，混进成功率会冤枉她。

export interface KpiTaskRow {
  state: string;
  /** 终态时间（ISO）；没有就当"不是这天收的" */
  completedAt?: string;
  updatedAt?: string;
}

export interface KpiEventRow {
  type: string;
  /** `tool.result` 的成败 */
  ok?: boolean;
  /** `verify.report` 的结论 */
  passed?: boolean;
  /** `verify.report` 的自评置信（可选，界面上只用来提示"她自己也拿不准"） */
  confidence?: string;
  /** `recovery.plan` 的重来是否成了 */
  recovered?: boolean;
  /** 事件时间（信封 `env.at`） */
  at?: string;
}

export interface KpiRatio {
  /** 分子 / 分母（分母为 0 时都为 null） */
  hit: number | null;
  total: number | null;
  /** 占比（0~1）；分母为 0 时 null */
  rate: number | null;
}

export interface KpiDay {
  day: string;
  tasks: KpiRatio & { completed: number; failed: number; cancelled: number };
  verify: KpiRatio;
  recovery: KpiRatio;
  tools: { calls: number; failed: number; failRate: number | null; efficiency: number | null };
  cost: { spentUsd: number; perSuccessUsd: number | null };
}

export interface KpiInput {
  /** 本地日（`YYYY-MM-DD`）：只用来标记这一行属于哪天 */
  day: string;
  tasks: KpiTaskRow[];
  events: KpiEventRow[];
  /** 当天花销（美元） */
  spentUsd: number;
}

function ratio(hit: number, total: number): KpiRatio {
  return { hit: total > 0 ? hit : null, total: total > 0 ? total : null, rate: total > 0 ? hit / total : null };
}

/** 某条任务算不算"这一天收的"（终态时间落在这一天；没有终态时间的按 updatedAt 兜底） */
export function taskFinalizedOn(t: KpiTaskRow, day: string): boolean {
  const at = t.completedAt ?? (t.state === 'completed' || t.state === 'failed' || t.state === 'cancelled' ? t.updatedAt : undefined);
  return typeof at === 'string' && at.slice(0, 10) === day;
}

/** 一天的五项（**纯函数**：同样的输入永远同样的输出，好复算） */
export function computeKpiDay(input: KpiInput): KpiDay {
  const { day, tasks, events, spentUsd } = input;

  const done = tasks.filter((t) => t.state === 'completed' && taskFinalizedOn(t, day));
  const failed = tasks.filter((t) => t.state === 'failed' && taskFinalizedOn(t, day));
  const cancelled = tasks.filter((t) => t.state === 'cancelled' && taskFinalizedOn(t, day));
  // 成功率的分母**不含 cancelled**：那是用户自己叫停的，不该算在她头上（也不算成功）
  const taskTotal = done.length + failed.length;

  const verifyRows = events.filter((e) => e.type === 'verify.report');
  const verifyPassed = verifyRows.filter((e) => e.passed === true);

  // 恢复：分母只数**真的重来过**的那些（`recovery.plan` 每一行都是一次"打算怎么办"）
  const recRows = events.filter((e) => e.type === 'recovery.plan');
  const recovered = recRows.filter((e) => e.recovered === true);

  const toolRows = events.filter((e) => e.type === 'tool.result');
  const toolFailed = toolRows.filter((e) => e.ok === false);

  return {
    day,
    tasks: { ...ratio(done.length, taskTotal), completed: done.length, failed: failed.length, cancelled: cancelled.length },
    verify: ratio(verifyPassed.length, verifyRows.length),
    recovery: ratio(recovered.length, recRows.length),
    tools: {
      calls: toolRows.length,
      failed: toolFailed.length,
      failRate: toolRows.length ? toolFailed.length / toolRows.length : null,
      efficiency: toolRows.length ? 1 - toolFailed.length / toolRows.length : null,
    },
    // 每次成功成本：没有完成的任务就不给这个数（给 0 会读成"没花钱"，给 ∞ 没法看）
    cost: { spentUsd, perSuccessUsd: done.length > 0 ? spentUsd / done.length : null },
  };
}

/** 给人看的一行（设置页那五张卡的文字版；数字仍然是机器算的，这里只做格式化） */
export function formatKpiDay(k: KpiDay): string {
  const pct = (r: number | null) => (r === null ? '—' : `${Math.round(r * 100)}%`);
  const usd = (v: number | null) => (v === null ? '—' : `$${v.toFixed(4)}`);
  return [
    `${k.day}`,
    `任务成功率 ${pct(k.tasks.rate)}（${k.tasks.hit ?? 0}/${k.tasks.total ?? 0}）`,
    `验证成功率 ${pct(k.verify.rate)}（${k.verify.hit ?? 0}/${k.verify.total ?? 0}）`,
    `恢复成功率 ${pct(k.recovery.rate)}（${k.recovery.hit ?? 0}/${k.recovery.total ?? 0}）`,
    `工具失败率 ${pct(k.tools.failRate)}（${k.tools.failed}/${k.tools.calls}）`,
    `每次成功成本 ${usd(k.cost.perSuccessUsd)}（当天 ${usd(k.cost.spentUsd)}）`,
  ].join(' · ');
}
