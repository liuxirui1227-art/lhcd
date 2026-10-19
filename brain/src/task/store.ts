// 任务账本 · 存储。
//
// 选型：**append-only 事件流（真相源）+ 快照（加速加载）**，不引 SQLite——
// 零原生依赖（打包/签名不撞坑）、纯文本可审计、与 messages.jsonl / 签名链同源。
//
// 文件布局：
//   <dir>/index.json              ← 全部 run 的轻量索引
//   <dir>/<id>/task.json          ← 快照（原子写）
//   <dir>/<id>/events.jsonl       ← 事件流（追加；快照损坏时重放重建）
//
// 三条纪律：
//   ① 一切落盘经 Runtime（架构红线：核心不得直接用 node:fs）
//   ② 快照一律原子写（临时文件 + fsync + rename）——半个 JSON 不允许存在
//   ③ 解析失败**绝不带着坏状态继续**：隔离坏文件（改名 .corrupt）并停用该 run
import type { Runtime } from '../runtime/types.js';
import type { TaskEvent, TaskEventType, TaskRun, TaskStep, TaskIndexEntry } from './types.js';
import { indexEntry, isTerminal } from './types.js';
import { nudgeDecision } from './nudge.js';

export interface CreateRunInput {
  title: string;
  explanation?: string;
  origin?: TaskRun['origin'];
  sessionId?: string;
  workspace?: string;
  /** 完成信号（给了它，这个 run 就是"没做到不许收工"的） */
  completionPromise?: string;
  maxIterations?: number;
  steps?: Array<Partial<TaskStep> & { title: string }>;
}

export const DEFAULT_MAX_ITERATIONS = 12;

function nowIso(clock: () => Date): string {
  return clock().toISOString();
}

function makeId(now: Date): string {
  return `t-${now.getTime().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

export class TaskStore {
  private runs = new Map<string, TaskRun>();
  /** 坏掉的 run（快照与事件流都读不出）——保留 id，永不带着坏状态继续 */
  private readonly quarantined = new Set<string>();
  /** 事件流序号（内存计数，不混进 run 的持久化字段） */
  private readonly seqs = new Map<string, number>();

  constructor(
    private readonly runtime: Runtime,
    private readonly dir: string,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  // ---------- 加载 ----------

  /** 启动时调一次：读索引 → 逐个读快照；快照缺失/损坏 → 重放事件流重建。 */
  async load(): Promise<void> {
    this.runs.clear();
    this.quarantined.clear();
    let ids: string[] = [];
    try {
      const idx = JSON.parse((await this.runtime.fs.read(`${this.dir}/index.json`)).content) as { runs?: Array<{ id: string }> };
      ids = (idx.runs ?? []).map((r) => String(r.id));
    } catch {
      /* 首次运行 / 索引损坏 → 用目录扫描兜底 */
      try {
        ids = (await this.runtime.fs.list(this.dir)).filter((n) => n.startsWith('t-'));
      } catch {
        return;
      }
    }
    for (const id of ids) {
      const run = await this.readRun(id);
      if (run) this.runs.set(id, run);
    }
  }

  private async readRun(id: string): Promise<TaskRun | null> {
    try {
      const snap = JSON.parse((await this.runtime.fs.read(`${this.dir}/${id}/task.json`)).content) as TaskRun;
      if (snap && typeof snap.id === 'string' && Array.isArray(snap.steps)) return normalizeRun(snap);
      throw new Error('快照形状不对');
    } catch {
      // 快照缺失/损坏 → 重放事件流重建（事件流是真相源）
      const rebuilt = await this.replay(id);
      if (rebuilt) return rebuilt;
      // 两条路都不通：隔离，绝不带坏状态继续
      this.quarantined.add(id);
      try {
        await this.runtime.fs.write(`${this.dir}/${id}/task.json.corrupt`, JSON.stringify({ quarantinedAt: nowIso(this.clock), reason: 'snapshot 与事件流都不可解析' }));
      } catch { /* 隔离标记失败不阻断启动 */ }
      return null;
    }
  }

  /** 重放事件流重建 run（快照损坏时的兜底）。 */
  private async replay(id: string): Promise<TaskRun | null> {
    let lines: string;
    try {
      lines = (await this.runtime.fs.read(`${this.dir}/${id}/events.jsonl`)).content;
    } catch {
      return null;
    }
    let run: TaskRun | null = null;
    for (const line of lines.split('\n')) {
      if (!line.trim()) continue;
      let ev: TaskEvent;
      try {
        ev = JSON.parse(line) as TaskEvent;
      } catch {
        continue; // 尾部半行（崩溃写了一半）——跳过，不炸
      }
      run = applyEvent(run, id, ev);
    }
    return run ? normalizeRun(run) : null;
  }

  // ---------- 落盘 ----------

  private async saveRun(run: TaskRun): Promise<void> {
    run.updatedAt = nowIso(this.clock);
    await this.runtime.fs.writeAtomic(`${this.dir}/${run.id}/task.json`, JSON.stringify(run, null, 2));
    await this.saveIndex();
  }

  private async saveIndex(): Promise<void> {
    const runs = [...this.runs.values()]
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
      .map((r) => ({ id: r.id, title: r.title, state: r.state, updatedAt: r.updatedAt, sessionId: r.sessionId }));
    await this.runtime.fs.writeAtomic(`${this.dir}/index.json`, JSON.stringify({ version: 1, runs }, null, 2));
  }

  /** 事件流唯一写入口（append-only）。 */
  async appendEvent(runId: string, type: TaskEventType, payload: Record<string, unknown> = {}, stepId?: string): Promise<void> {
    const run = this.runs.get(runId);
    if (!run) return;
    const seq = (this.seqs.get(runId) ?? 0) + 1;
    this.seqs.set(runId, seq);
    const ev: TaskEvent = { seq, at: nowIso(this.clock), type, payload, ...(stepId ? { stepId } : {}) };
    try {
      await this.runtime.fs.append(`${this.dir}/${runId}/events.jsonl`, `${JSON.stringify(ev)}\n`);
    } catch { /* 事件流写失败不阻断主流程：快照仍是可用状态 */ }
  }

  // ---------- 读 ----------

  get(id: string): TaskRun | null {
    const r = this.runs.get(id);
    return r ? clone(r) : null;
  }

  list(): TaskRun[] {
    return [...this.runs.values()].map(clone).sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  }

  /** 未终结的任务（管理界面/催办扫描用） */
  active(): TaskRun[] {
    return this.list().filter((r) => !isTerminal(r.state));
  }

  index(): TaskIndexEntry[] {
    return this.list().map(indexEntry);
  }

  isQuarantined(id: string): boolean {
    return this.quarantined.has(id);
  }

  /** 本会话里"带着完成判据、还没终结"的 run（turn 收尾时问它要不要放行）。 */
  activeWithPromise(sessionId?: string): TaskRun | null {
    const hit = [...this.runs.values()].find(
      (r) => !isTerminal(r.state) && !!r.completionPromise && (sessionId === undefined || r.sessionId === sessionId),
    );
    return hit ? clone(hit) : null;
  }

  /** 廉价版（每次 delta 都要问一次，不做深拷贝）：本会话有没有"没做到别说完事"的活。 */
  hasActivePromise(sessionId?: string): boolean {
    for (const r of this.runs.values()) {
      if (!isTerminal(r.state) && r.completionPromise && (sessionId === undefined || r.sessionId === sessionId)) return true;
    }
    return false;
  }

  /** 本会话里最近的活跃任务（给提示词注入"你手上还欠着的事"）。 */
  activeForSession(sessionId: string): TaskRun | null {
    const hit = [...this.runs.values()]
      .filter((r) => !isTerminal(r.state) && r.sessionId === sessionId)
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))[0];
    return hit ? clone(hit) : null;
  }

  // ---------- 写 ----------

  async create(input: CreateRunInput): Promise<TaskRun> {
    const now = this.clock();
    const id = makeId(now);
    const steps: TaskStep[] = makeSteps(input.steps ?? []);
    const run: TaskRun = {
      id,
      origin: input.origin ?? 'chat',
      sessionId: input.sessionId,
      title: String(input.title ?? '').slice(0, 120),
      explanation: String(input.explanation ?? ''),
      state: 'running',
      workspace: input.workspace,
      steps,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      completionPromise: input.completionPromise ? String(input.completionPromise) : undefined,
      maxIterations: Math.max(1, Math.min(Number(input.maxIterations ?? DEFAULT_MAX_ITERATIONS) || DEFAULT_MAX_ITERATIONS, 50)),
      iterations: 0,
      nudgeCount: 0,
    };
    this.runs.set(id, run);
    await this.saveRun(run);
    await this.appendEvent(id, 'run_created', { title: run.title, explanation: run.explanation, promise: run.completionPromise ?? null });
    if (steps.length) await this.appendEvent(id, 'plan_set', { steps: steps.map((s) => ({ id: s.id, title: s.title })) });
    return clone(run);
  }

  /** 落定计划（已有计划 → 不覆盖，返回错误——防模型反复重写计划刷掉进度）。 */
  async setPlan(runId: string, steps: Array<Partial<TaskStep> & { title: string }>): Promise<{ ok: true } | { ok: false; error: string; validSteps: string[] }> {
    const run = this.runs.get(runId);
    if (!run) return { ok: false, error: '没有这个任务', validSteps: [] };
    if (run.steps.length > 0) return { ok: false, error: '计划已经定过了（不覆盖）', validSteps: run.steps.map((s) => s.id) };
    run.steps = makeSteps(steps);
    await this.saveRun(run);
    await this.appendEvent(runId, 'plan_set', { steps: run.steps.map((s) => ({ id: s.id, title: s.title })) });
    return { ok: true };
  }

  /** 更新单步（状态机校验：终态不可回退，completed 不可被 pending 覆盖）。 */
  async updateStep(runId: string, stepId: string, patch: Partial<TaskStep>): Promise<{ ok: boolean; error?: string }> {
    const run = this.runs.get(runId);
    if (!run) return { ok: false, error: '没有这个任务' };
    const step = run.steps.find((s) => s.id === stepId);
    if (!step) return { ok: false, error: `没有这一步：${stepId}（现有 ${run.steps.map((s) => s.id).join('/') || '无'}）` };
    const from = step.state;
    if (patch.state) {
      if (STEP_TERMINAL.has(from) && patch.state !== from) {
        return { ok: false, error: `第 ${stepId} 步已经是${stepStateWord(from)}了，不能再改回去` };
      }
      // 依赖未完成不许开工（"前面的步骤没成"就不该往前跑）
      if (patch.state === 'running' || patch.state === 'completed') {
        const unmet = step.dependencies.filter((d) => !STEP_DONE_SET.has(run.steps.find((s) => s.id === d)?.state ?? 'pending'));
        if (unmet.length > 0) return { ok: false, error: `第 ${stepId} 步还等着 ${unmet.join('/')} 先做完` };
      }
    }
    Object.assign(step, patch, { artifacts: patch.artifacts ?? step.artifacts });
    if (patch.state === 'running' && !step.startedAt) step.startedAt = nowIso(this.clock);
    if (patch.state === 'completed') { step.completedAt = nowIso(this.clock); step.detail = undefined; }
    if (patch.state === 'failed' || patch.state === 'blocked') step.retryCount = (step.retryCount ?? 0) + (from === patch.state ? 0 : 0);
    await this.saveRun(run);
    const evType: TaskEventType = patch.state === 'completed' ? 'step_completed'
      : patch.state === 'failed' ? 'step_failed'
        : patch.state === 'blocked' ? 'step_blocked'
          : patch.state === 'running' ? 'step_started' : 'note';
    // 产物必须进事件载荷——否则快照一坏、重放一跑，`artifacts` 整段消失
    await this.appendEvent(runId, evType, { from, to: patch.state ?? from, summary: patch.resultSummary ?? null, detail: patch.detail ?? null, artifacts: patch.artifacts ?? null }, stepId);
    await this.deriveState(run);
    return { ok: true };
  }

  /** 改 run 级字段（含"需要你决定"的一等状态）。 */
  async patchRun(runId: string, patch: Partial<TaskRun>, evType: TaskEventType = 'note', payload: Record<string, unknown> = {}): Promise<{ ok: boolean; error?: string }> {
    const run = this.runs.get(runId);
    if (!run) return { ok: false, error: '没有这个任务' };
    if (isTerminal(run.state) && patch.state && !isTerminal(patch.state)) {
      return { ok: false, error: '这个任务已经结束了' };
    }
    Object.assign(run, patch);
    await this.saveRun(run);
    await this.appendEvent(runId, evType, payload);
    return { ok: true };
  }

  /** 卡住要人拍板——一等状态（进 blocked/needs_input + 记下要问的话）。 */
  async askUser(runId: string, question: string): Promise<{ ok: boolean; error?: string }> {
    const q = String(question ?? '').trim();
    if (!q) return { ok: false, error: '要问的问题不能为空' };
    const run = this.runs.get(runId);
    if (!run) return { ok: false, error: '没有这个任务' };
    run.state = 'blocked';
    run.blockReason = 'needs_input';
    run.question = q;
    run.blockedAt = this.clock().getTime();
    run.nudgeCount = 0;          // 新问题 → 催办周期重新开始
    run.lastUserAt = run.blockedAt;
    run.stateDetail = '等你拍板';
    await this.saveRun(run);
    await this.appendEvent(runId, 'needs_input', { question: q });
    return { ok: true };
  }

  /** 用户可以回答那条问题了（继续干活）。 */
  async answerUser(runId: string, answer?: string): Promise<{ ok: boolean; error?: string }> {
    const run = this.runs.get(runId);
    if (!run) return { ok: false, error: '没有这个任务' };
    const now = this.clock().getTime();
    run.question = undefined;
    run.blockReason = undefined;
    run.blockedAt = undefined;
    run.state = 'running';
    run.stateDetail = answer ? `你说：${String(answer).slice(0, 200)}` : '你给了答复，接着干';
    run.nudgeCount = 0;
    run.lastUserAt = now;
    await this.saveRun(run);
    await this.appendEvent(runId, 'run_resumed', { answer: answer ?? null });
    return { ok: true };
  }

  /** 记下"为什么停下"（限流 / 额度 / 上下文），三个词分开。 */
  async markLimited(runId: string, kind: 'usage_limited' | 'budget_limited' | 'paused', detail: string): Promise<void> {
    const run = this.runs.get(runId);
    if (!run || isTerminal(run.state)) return;
    run.state = kind;
    run.stateDetail = String(detail ?? '').slice(0, 300);
    await this.saveRun(run);
    await this.appendEvent(runId, 'limited', { kind, detail: run.stateDetail });
  }

  /** 终态推导：没有可推进的步时——有失败/阻塞 → blocked，否则 completed。 */
  async deriveState(run: TaskRun): Promise<TaskRun['state']> {
    if (isTerminal(run.state)) return run.state;
    if (run.steps.length === 0) return run.state;
    const pendingOrRunning = run.steps.filter((s) => s.state === 'pending' || s.state === 'running');
    if (pendingOrRunning.length > 0) {
      run.state = 'running';
      await this.saveRun(run);
      return run.state;
    }
    const bad = run.steps.filter((s) => s.state === 'failed' || s.state === 'blocked');
    if (bad.length > 0) {
      run.state = 'blocked';
      run.blockReason = run.blockReason ?? 'dependency';
      run.stateDetail = `第 ${bad.map((s) => s.id).join('/')} 步没成`;
    } else {
      run.state = 'completed';
      run.completedAt = nowIso(this.clock);
    }
    await this.saveRun(run);
    await this.appendEvent(run.id, 'run_finalized', { state: run.state });
    return run.state;
  }

  /** 收尾（模型/用户确认做完）。 */
  async complete(runId: string, summary?: string): Promise<{ ok: boolean; error?: string }> {
    const run = this.runs.get(runId);
    if (!run) return { ok: false, error: '没有这个任务' };
    run.state = 'completed';
    run.completedAt = nowIso(this.clock);
    run.stateDetail = summary ? String(summary).slice(0, 300) : '';
    await this.saveRun(run);
    await this.appendEvent(runId, 'run_finalized', { state: 'completed', summary: summary ?? null });
    return { ok: true };
  }

  async cancel(runId: string, reason?: string): Promise<{ ok: boolean; error?: string }> {
    const run = this.runs.get(runId);
    if (!run) return { ok: false, error: '没有这个任务' };
    run.state = 'cancelled';
    run.completedAt = nowIso(this.clock);
    run.stateDetail = reason ? String(reason).slice(0, 300) : '不做了';
    await this.saveRun(run);
    await this.appendEvent(runId, 'run_cancelled', { reason: reason ?? null });
    return { ok: true };
  }

  /**
   * 启动时被动恢复——running/pending 一律置 paused（**绝不自动续跑**：
   * 流式执行不可能跨重启存活，自动重跑有副作用的步骤是灾难）。
   */
  async recoverOnStart(): Promise<TaskRun[]> {
    const recovered: TaskRun[] = [];
    for (const run of this.runs.values()) {
      if (run.state !== 'running' && run.state !== 'pending') continue;
      for (const s of run.steps) {
        if (s.state === 'running') {
          s.state = 'pending';
          s.detail = '上次退出时被打断，可以继续';
        }
      }
      run.state = 'paused';
      run.stateDetail = '上次退出时被打断';
      await this.saveRun(run);
      await this.appendEvent(run.id, 'recovered_requires_confirmation', { at: nowIso(this.clock) });
      recovered.push(clone(run));
    }
    return recovered;
  }

  /** 该催办的任务（退避曲线由 nudge.ts 判定）。 */
  async takeNudgeDue(now: number, lastUserActivityAt: number): Promise<Array<{ run: TaskRun; message: string }>> {
    const out: Array<{ run: TaskRun; message: string }> = [];
    for (const run of this.runs.values()) {
      const d = nudgeDecision(run, now, lastUserActivityAt);
      if (!d.due) continue;
      run.nudgeCount = d.nextCount;
      run.lastNudgeAt = now;
      await this.saveRun(run);
      await this.appendEvent(run.id, 'nudge_sent', { n: run.nudgeCount, reason: d.reason });
      out.push({ run: clone(run), message: d.message });
    }
    return out;
  }
}

// ---------- 纯工具 ----------

const STEP_TERMINAL: ReadonlySet<TaskStep['state']> = new Set<TaskStep['state']>(['completed', 'skipped', 'cancelled']);
const STEP_DONE_SET: ReadonlySet<TaskStep['state']> = new Set<TaskStep['state']>(['completed', 'skipped']);

function stepStateWord(s: TaskStep['state']): string {
  return { pending: '等着', running: '在做', completed: '做完了', failed: '没做成', blocked: '卡住了', skipped: '跳过了', cancelled: '不做了' }[s] ?? s;
}

/** 补齐缺省字段（老文件/手改文件也能读） */
function normalizeRun(run: TaskRun): TaskRun {
  return {
    ...run,
    steps: (run.steps ?? []).map((s, i) => ({
      ...s,
      id: String(s.id ?? `s${i + 1}`),
      sequence: Number(s.sequence ?? i + 1),
      dependencies: Array.isArray(s.dependencies) ? s.dependencies : [],
      artifacts: Array.isArray(s.artifacts) ? s.artifacts : [],
      retryCount: Number(s.retryCount ?? 0),
      state: s.state ?? 'pending',
    })),
    iterations: Number(run.iterations ?? 0),
    nudgeCount: Number(run.nudgeCount ?? 0),
    maxIterations: Number(run.maxIterations ?? DEFAULT_MAX_ITERATIONS),
  };
}

/** 步骤构造（create 与 setPlan 共用）：不写默认依赖 = 顺序链（第 N 步等第 N-1 步）。 */
function makeSteps(input: Array<Partial<TaskStep> & { title: string }>): TaskStep[] {
  return input.map((s, i) => ({
    id: s.id ?? `s${i + 1}`,
    sequence: i + 1,
    title: String(s.title ?? `第 ${i + 1} 步`),
    goal: String(s.goal ?? ''),
    dependencies: Array.isArray(s.dependencies) ? s.dependencies.map(String) : (i > 0 ? [`s${i}`] : []),
    acceptance: String(s.acceptance ?? ''),
    state: 'pending' as const,
    artifacts: [],
    retryCount: 0,
  }));
}

/** 事件重放（快照损坏时的重建路径；与 store 的写入语义一一对应） */
function applyEvent(run: TaskRun | null, id: string, ev: TaskEvent): TaskRun | null {
  const p = ev.payload ?? {};
  if (ev.type === 'run_created') {
    return normalizeRun({
      id,
      origin: 'chat',
      title: String(p.title ?? '（未命名任务）'),
      explanation: String(p.explanation ?? ''),
      state: 'running',
      steps: [],
      createdAt: ev.at,
      updatedAt: ev.at,
      completionPromise: p.promise ? String(p.promise) : undefined,
      maxIterations: DEFAULT_MAX_ITERATIONS,
      iterations: 0,
      nudgeCount: 0,
    });
  }
  if (!run) return null;
  const steps = run.steps;
  switch (ev.type) {
    case 'plan_set': {
      const list = Array.isArray(p.steps) ? (p.steps as Array<{ id?: string; title?: string }>) : [];
      run.steps = list.map((s, i) => ({
        id: String(s.id ?? `s${i + 1}`), sequence: i + 1, title: String(s.title ?? ''), goal: '',
        dependencies: i > 0 ? [`s${i}`] : [], acceptance: '', state: 'pending' as const, artifacts: [], retryCount: 0,
      }));
      break;
    }
    case 'step_started':
    case 'step_completed':
    case 'step_failed':
    case 'step_blocked': {
      const s = steps.find((x) => x.id === ev.stepId);
      if (s) {
        s.state = ev.type === 'step_started' ? 'running' : ev.type === 'step_completed' ? 'completed' : ev.type === 'step_failed' ? 'failed' : 'blocked';
        if (p.summary) s.resultSummary = String(p.summary);
        if (p.detail) s.detail = String(p.detail);
        // 重放要能把产物装回来（否则产物在重放后全丢）
        if (Array.isArray(p.artifacts)) s.artifacts = (p.artifacts as unknown[]).map(String);
      }
      break;
    }
    case 'needs_input':
      run.state = 'blocked';
      run.blockReason = 'needs_input';
      run.question = String(p.question ?? '');
      run.blockedAt = Date.parse(ev.at) || undefined;
      break;
    case 'run_resumed':
      run.state = 'running';
      run.question = undefined;
      run.blockReason = undefined;
      break;
    case 'run_cancelled':
      run.state = 'cancelled';
      break;
    case 'run_finalized':
      run.state = (p.state as TaskRun['state']) ?? 'completed';
      break;
    case 'recovered_requires_confirmation':
      run.state = 'paused';
      break;
    case 'limited':
      run.state = (p.kind as TaskRun['state']) ?? run.state;
      run.stateDetail = String(p.detail ?? '');
      break;
    case 'nudge_sent':
      run.nudgeCount = Number(p.n ?? run.nudgeCount + 1);
      run.lastNudgeAt = Date.parse(ev.at) || undefined;
      break;
    default:
      break;
  }
  run.updatedAt = ev.at;
  return run;
}

/** 深拷贝（外部拿到的是快照，改不动内部状态——账本的正确性靠"唯一写入口"） */
function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

export { clone as __cloneTaskRun };
