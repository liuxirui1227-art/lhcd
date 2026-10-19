// 时间与年龄系统（生命引擎核心）。
// age = f(birth_anchor, now) 纯派生：无状态、跨设备一致、离线可用、可回放。
// 年龄驱动形象/声音/叙事，不限制能力。

export interface GrowthParams {
  /** 成熟度 0~1（跨年龄档的连续量） */
  maturity: number;
  /** 魅力成长层：肤质光泽 0~1 */
  skinGlow: number;
  /** 发质光泽 0~1 */
  hairShine: number;
  /** 体态（0 稚嫩蜷缩 → 1 挺拔舒展） */
  posture: number;
  /** 音高系数（1.25 清亮 → 0.95 沉稳） */
  voicePitch: number;
}

export interface Milestone {
  id: string;
  label: string;
  /** 触发时间戳（ms） */
  dueAt: number;
}

/** 出生年龄档 → 起始年龄（岁）：少年 14 / 青年 20 / 成年 26 */
export function birthAgeTierToYears(tier: unknown): number {
  const t = Number(tier);
  if (t === 1) return 14;
  if (t === 2) return 20;
  if (t === 3) return 26;
  return 20; // 默认青年档
}

/** 从出生锚点起算的年龄（岁，含小数） */
export function ageYears(birthAnchorMs: number, nowMs: number): number {
  const ms = Math.max(0, nowMs - birthAnchorMs);
  return ms / (365.25 * 24 * 3600 * 1000);
}

/** 叙事阶段（出生后的成长阶段，中文标签） */
export function narrativeStage(age: number): { key: string; label: string } {
  if (age < 0.25) return { key: 'newborn', label: '初生' };
  if (age < 1) return { key: 'infant', label: '婴幼' };
  if (age < 6) return { key: 'child', label: '童年' };
  if (age < 14) return { key: 'youth', label: '少年' };
  if (age < 18) return { key: 'teen', label: '青春期' };
  if (age < 45) return { key: 'adult', label: '成年' };
  return { key: 'mature', label: '成熟' };
}

/** 年龄阶段锚点：魅力成长层目标参数（随年龄按天插值 → 渐变式变美，不可逆） */
const GROWTH_ANCHORS: Array<[age: number, g: Omit<GrowthParams, 'voicePitch'>]> = [
  [0, { maturity: 0.1, skinGlow: 0.45, hairShine: 0.4, posture: 0.35 }],
  [0.25, { maturity: 0.22, skinGlow: 0.55, hairShine: 0.52, posture: 0.48 }],
  [1, { maturity: 0.4, skinGlow: 0.7, hairShine: 0.66, posture: 0.62 }],
  [6, { maturity: 0.6, skinGlow: 0.82, hairShine: 0.8, posture: 0.78 }],
  [14, { maturity: 0.8, skinGlow: 0.92, hairShine: 0.9, posture: 0.9 }],
  [18, { maturity: 0.95, skinGlow: 1.0, hairShine: 1.0, posture: 1.0 }],
];

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * Math.max(0, Math.min(1, t));
}

/** 魅力成长层参数（锚点间线性插值，按天渐变） */
export function growthParams(age: number): GrowthParams {
  if (age <= 0) age = 0;
  let lo = GROWTH_ANCHORS[0]!;
  let hi = GROWTH_ANCHORS[GROWTH_ANCHORS.length - 1]!;
  for (let i = 0; i < GROWTH_ANCHORS.length - 1; i++) {
    if (age >= GROWTH_ANCHORS[i]![0] && age <= GROWTH_ANCHORS[i + 1]![0]) {
      lo = GROWTH_ANCHORS[i]!;
      hi = GROWTH_ANCHORS[i + 1]!;
      break;
    }
  }
  const t = hi[0] === lo[0] ? 0 : (age - lo[0]) / (hi[0] - lo[0]);
  const g = hi[1];
  const base = lo[1];
  return {
    maturity: lerp(base.maturity, g.maturity, t),
    skinGlow: lerp(base.skinGlow, g.skinGlow, t),
    hairShine: lerp(base.hairShine, g.hairShine, t),
    posture: lerp(base.posture, g.posture, t),
    voicePitch: lerp(1.25, 0.95, lerp(base.maturity, g.maturity, t)), // 幼年清亮 → 成年沉稳
  };
}

/**
 * 里程碑队列：按年龄时钟触发的仪式事件。
 * 满月 / 百日 / 半岁 / 周岁 / 每个生日 / 成年礼（出生年龄档 <18 时，18 周岁触发）。
 */
export function milestoneQueue(
  birthAnchorMs: number,
  nowMs: number,
  horizonMs = 365.25 * 24 * 3600 * 1000,
  /** 宽限：也包含最近 graceMs 内已到期的（离线错过后补触发，幂等由调用方记录） */
  graceMs = 30 * 24 * 3600 * 1000,
): Milestone[] {
  const out: Milestone[] = [];
  const push = (id: string, label: string, atDays: number) => {
    const dueAt = birthAnchorMs + atDays * 24 * 3600 * 1000;
    if (dueAt > nowMs - graceMs && dueAt <= nowMs + horizonMs) out.push({ id, label, dueAt });
  };
  push('full-moon', '满月', 30);
  push('hundred-days', '百日', 100);
  push('half-year', '半岁', 182.625);
  push('first-birthday', '一周岁生日', 365.25);
  // 之后每年生日（未来一年内）
  const startAge = ageYears(birthAnchorMs, nowMs);
  for (let y = Math.max(1, Math.floor(startAge) + 1); y <= Math.floor(startAge) + 2; y++) {
    push(`birthday-${y}`, `${y} 岁生日`, y * 365.25);
  }
  return out;
}

/** 含出生年龄档的里程碑队列（成年礼按档位补入） */
export function milestoneQueueForTier(birthAnchorMs: number, birthAgeTier: number, nowMs: number, graceMs?: number): Milestone[] {
  const queue = milestoneQueue(birthAnchorMs, nowMs, undefined, graceMs);
  const startYears = birthAgeTierToYears(birthAgeTier);
  if (startYears < 18) {
    const dueAt = birthAnchorMs + (18 - startYears) * 365.25 * 24 * 3600 * 1000;
    if (dueAt > nowMs) queue.push({ id: 'coming-of-age', label: '成年礼', dueAt });
  }
  return queue.sort((a, b) => a.dueAt - b.dueAt);
}
