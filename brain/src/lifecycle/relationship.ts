// 关系状态机（brain 侧实现，runtime 宿主调用）。
// 规则：intimacy 只升不降；阶段随阈值跃迁并记录 state_change；冲突信号 → 暂停增量，
// 修复协议解除后恢复（冲突不惩罚，防止负反馈螺旋）。
import type { Emitter } from '../session/events.js';

export interface RelationStage {
  k: string;
  min: number;
}

export const REL_STAGES: RelationStage[] = [
  { k: 'stranger', min: 0 },
  { k: 'acquaintance', min: 0.1 },
  { k: 'friend', min: 0.3 },
  { k: 'close', min: 0.6 },
  { k: 'intimate', min: 0.85 },
];

export function stageFor(intimacy: number): string {
  let s = REL_STAGES[0]!.k;
  for (const t of REL_STAGES) if (intimacy >= t.min) s = t.k;
  return s;
}

export interface RelationshipState {
  intimacy: number;
  stage: string;
  /** 冲突中：暂停增量（修复后恢复） */
  conflict: boolean;
}

export function initialRelationship(): RelationshipState {
  return { intimacy: 0, stage: stageFor(0), conflict: false };
}

export interface BumpResult {
  state: RelationshipState;
  changed: boolean;
  stageChanged: boolean;
  from?: string;
  to?: string;
}

/** 亲密增量（默认 0.01；冲突中不增量；只升不降；6 位精度防浮点漂移） */
export function bumpIntimacy(state: RelationshipState, delta = 0.01): BumpResult {
  if (state.conflict || delta <= 0) return { state, changed: false, stageChanged: false };
  const next = Math.min(1, Math.round((state.intimacy + delta) * 1e6) / 1e6);
  const stage = stageFor(next);
  const stageChanged = stage !== state.stage;
  return {
    state: { ...state, intimacy: next, stage },
    changed: next !== state.intimacy,
    stageChanged,
    from: state.stage,
    to: stage,
  };
}

/** 冲突信号：暂停增量（不降亲密） */
export function markConflict(state: RelationshipState): RelationshipState {
  return { ...state, conflict: true };
}

/** 修复协议：冲突解除，恢复增量 */
export function resolveConflict(state: RelationshipState): RelationshipState {
  return { ...state, conflict: false };
}

/** 状态变化事件（进签名日志链的 state_change 记录） */
export function emitStateChange(emit: Emitter, from: string, to: string, intimacy: number): void {
  emit({ type: 'hook', name: 'relationship', event: `state_change:${from}->${to}`, exit: Math.round(intimacy * 1000) });
}
