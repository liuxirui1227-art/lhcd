// 任务拆解 planner（Task Decomposer）。
// 复杂请求 → 深度档模型拆成子任务 DAG（步骤 + 依赖 + 各自任务画像）；
// 简单请求直接单步（decomposed=false）。拆解结果可入日志审计——"TA 是怎么想的"全程可见。
// 本模块纯逻辑可单测：decomposeTask 之外的全部函数零依赖。

import type { LLMProvider } from '../llm/provider.js';
import type { ModelTier } from '../llm/registry.js';

export interface PlanStep {
  id: string;
  description: string;
  /** 依赖的前置步骤 id（DAG 边） */
  dependsOn: string[];
  /** 任务画像（按任务选模型的路由输入） */
  profile: { modality: 'text' | 'vision' | 'audio'; depth: ModelTier };
}

export interface Plan {
  id: string;
  goal: string;
  steps: PlanStep[];
  createdAt: string;
  /** false = 简单请求未拆解（单步直行） */
  decomposed: boolean;
}

/** 拆解触发（启发式，保守：显式任务动词或超长请求；避免闲聊误触发的 reasoner 成本） */
const DECOMPOSE_RE = /拆解|子任务|分几步|按步骤|逐步|帮我计划|帮我规划|写一份方案|行动计划|执行计划/;

export function shouldDecompose(goal: string): boolean {
  return DECOMPOSE_RE.test(goal) || goal.length > 300;
}

/** 单步计划（简单请求直行路径） */
export function singleStepPlan(goal: string, now: string): Plan {
  return {
    id: `plan-${Date.now().toString(36)}`,
    goal,
    steps: [{ id: 's1', description: goal, dependsOn: [], profile: { modality: 'text', depth: 'standard' } }],
    createdAt: now,
    decomposed: false,
  };
}

export interface PlanValidation {
  ok: boolean;
  errors: string[];
}

/** DAG 校验：id 唯一 / 依赖存在 / 无自依赖 / 无环 */
export function validatePlan(plan: Plan): PlanValidation {
  const errors: string[] = [];
  if (!plan.goal.trim()) errors.push('goal 为空');
  if (plan.steps.length === 0) errors.push('steps 为空');
  const ids = new Set<string>();
  for (const s of plan.steps) {
    if (!s.id) errors.push('存在缺 id 的步骤');
    if (ids.has(s.id)) errors.push(`步骤 id 重复: ${s.id}`);
    ids.add(s.id);
    if (!s.description.trim()) errors.push(`步骤 ${s.id} description 为空`);
    for (const d of s.dependsOn) {
      if (d === s.id) errors.push(`步骤 ${s.id} 依赖自身`);
      if (!ids.has(d)) errors.push(`步骤 ${s.id} 依赖不存在的步骤: ${d}`);
    }
  }
  // 环检测（DFS 三色）
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>();
  const dfs = (id: string, chain: string[]): string | null => {
    const c = color.get(id) ?? WHITE;
    if (c === GRAY) return `依赖环: ${[...chain, id].join(' → ')}`;
    if (c === BLACK) return null;
    color.set(id, GRAY);
    const step = plan.steps.find((s) => s.id === id);
    for (const d of step?.dependsOn ?? []) {
      const hit = dfs(d, [...chain, id]);
      if (hit) return hit;
    }
    color.set(id, BLACK);
    return null;
  };
  for (const s of plan.steps) {
    const hit = dfs(s.id, []);
    if (hit) {
      errors.push(hit);
      break;
    }
  }
  return { ok: errors.length === 0, errors };
}

/** 拓扑序执行顺序（稳定：同层按声明序）。调用前应先 validatePlan。 */
export function executionOrder(plan: Plan): PlanStep[] {
  const out: PlanStep[] = [];
  const done = new Set<string>();
  const pending = [...plan.steps];
  let guard = plan.steps.length + 1;
  while (pending.length > 0 && guard-- > 0) {
    const ready = pending.find((s) => s.dependsOn.every((d) => done.has(d)));
    if (!ready) break; // 环（validatePlan 已拦）
    out.push(ready);
    done.add(ready.id);
    pending.splice(pending.indexOf(ready), 1);
  }
  return [...out, ...pending];
}

/** 审计渲染（入签名日志的 human-readable 文本） */
export function planToText(plan: Plan): string {
  const order = executionOrder(plan);
  const lines = order.map((s, i) => {
    const deps = s.dependsOn.length > 0 ? `（依赖 ${s.dependsOn.join(', ')}）` : '';
    return `${i + 1}. [${s.profile.depth}] ${s.description}${deps}`;
  });
  return `【计划】${plan.goal}\n${lines.join('\n')}`;
}

/** 提取首个 JSON 块（容错：代码围栏/前后杂质） */
function extractJson(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) return fenced[1]!.trim();
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  return first >= 0 && last > first ? text.slice(first, last + 1) : '';
}

/** 模型输出归一化（缺省字段补齐；非法步骤丢弃由 validatePlan 上报） */
function normalize(raw: unknown, goal: string, createdAt: string, id: string): Plan {
  const obj = (raw ?? {}) as { steps?: unknown[] };
  const steps: PlanStep[] = Array.isArray(obj.steps)
    ? obj.steps.map((s, i) => {
        const o = (s ?? {}) as Record<string, unknown>;
        const depth = o.depth === 'deep' || o.depth === 'light' ? (o.depth as ModelTier) : 'standard';
        return {
          id: typeof o.id === 'string' && o.id ? o.id : `s${i + 1}`,
          description: typeof o.description === 'string' ? o.description.trim() : '',
          dependsOn: Array.isArray(o.dependsOn) ? o.dependsOn.filter((d): d is string => typeof d === 'string') : [],
          profile: {
            modality: o.modality === 'vision' || o.modality === 'audio' ? (o.modality as 'vision' | 'audio') : 'text',
            depth,
          },
        };
      })
    : [];
  return { id, goal, steps, createdAt, decomposed: true };
}

/**
 * 拆解：深度档模型（thinking）纯文本单轮，严格 JSON 协议。
 * 永不抛错：模型/解析/DAG 任一失败 → 单步计划兜底（宁可直行，不阻塞用户）。
 */
export async function decomposeTask(opts: {
  provider: LLMProvider;
  goal: string;
  signal?: AbortSignal;
  now?: () => string;
  maxSteps?: number;
  /** 强制拆解（plan_task 工具：模型已自主决定拆解，跳过启发式触发门） */
  force?: boolean;
  /** 把这次拆解调用的用量交回调用方记账（拆解也是钱） */
  onUsage?: (usage: import('../llm/provider.js').Usage) => void;
}): Promise<Plan> {
  const now = opts.now ?? (() => new Date().toISOString());
  const createdAt = now();
  const id = `plan-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  if (!opts.force && !shouldDecompose(opts.goal)) return singleStepPlan(opts.goal, createdAt);
  const max = opts.maxSteps ?? 8;
  const system = [
    '你是任务拆解器。把用户的目标拆成 2~' + max + ' 个可执行子任务，输出严格 JSON（不要任何其他文字）：',
    '{"steps":[{"id":"s1","description":"子任务描述（可执行、结果可验证）","dependsOn":[],"depth":"standard","modality":"text"}]}',
    '规则：dependsOn 只能引用更早步骤的 id（DAG 无环）；depth 取值 light/standard/deep（需要深度推理、比较、权衡的步骤用 deep）；',
    'modality 取 text/vision/audio（绝大多数是 text）；每个 description 一句话，用中文；步骤总数不要超过 ' + max + '。',
  ].join('\n');
  try {
    let text = '';
    const stream = opts.provider.chat({
      system,
      messages: [{ role: 'user', content: opts.goal }],
      tools: [],
      model: { role: 'main', thinking: true },
      maxOutputTokens: 1500,
      temperature: 0.3,
      signal: opts.signal,
    });
    for await (const ev of stream) {
      if (ev.type === 'text.delta') text += ev.text;
      if (ev.type === 'done') opts.onUsage?.(ev.usage);
      if (ev.type === 'done' && !text) text += ''; // 无文本：下方兜底
    }
    const raw = JSON.parse(extractJson(text)) as unknown;
    const plan = normalize(raw, opts.goal, createdAt, id);
    if (plan.steps.length === 0) return singleStepPlan(opts.goal, createdAt);
    const v = validatePlan(plan);
    if (!v.ok) return singleStepPlan(opts.goal, createdAt);
    return plan;
  } catch {
    return singleStepPlan(opts.goal, createdAt);
  }
}
