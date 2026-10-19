// 世界状态差分注入：**只讲"这次变了什么"**。
//
// 设计出处（外部项目源码：codex `core/src/context/world_state/`）：
//   · `WorldStateSection` trait（`mod.rs:226`）；**ID 要稳定**——"`ID` is persisted in rollouts and must remain stable"
//   · `PreviousSectionState`（`mod.rs:208-216`）三态：`Absent`（既没有快照、也认不出旧片段）/
//     `Unknown`（历史里有这一节，但没有可用的结构化快照 → **保守重播**）/ `Known(&T)`（有精确快照 → 只发差异）
//   · `merge_patch_from`（`mod.rs:313`，**RFC 7386** merge patch）；没差异返回 `None`（`mod.rs:329`）→
//     `render_with` 的 filter_map（`mod.rs:437-441`）直接丢弃 → **一个字都不发**
//   · 小节消失 → 通知原文（`agents_md.rs:9-11`）：
//     `"These AGENTS.md instructions replace all previously provided AGENTS.md instructions."` /
//     `"The previously provided AGENTS.md instructions no longer apply."`
//   · 快照随对话落盘（`RolloutItem::WorldState(WorldStateItem { full, state })`，`session/mod.rs:3618`）；
//     **恢复时没有 full 基线的 patch 会被丢弃**（`rollout_reconstruction.rs:445-455`）
//   · 除"相等即不发"外，**当前状态为空时部分小节也主动静默**（`tools.rs:62-66`）
//
// 差分规则：把**每轮注入到 user 前缀的动态块**（账上欠着的事 / 侧面规范 / 状态提醒）纳入差分——
// 没变就一个字都不发（省 token，也免得模型把旧设定当新的反复"重新学会"）；
// 变了只发差量；某块消失了明说"之前给你的 X 不再适用"；**首次/快照丢失 → 保守重播全量**。
// （冻结前缀里的记忆/人格不参与差分——它们按设计就不变，由缓存负责。）

/** 一个小节的当前状态（JSON 可序列化；`null` = 这一轮没有这一节） */
export type SectionState = Record<string, unknown> | null;

export interface SectionSpec {
  /** 稳定 id（换 id 等于换小节——出处 codex "ID must remain stable"） */
  id: string;
  /** 给模型看的名字（人话） */
  label: string;
  /** 把状态渲染成人话（`null` 状态不被调用） */
  render(state: Record<string, unknown>): string;
}

export interface WorldStateSnapshot {
  /** sectionId → 上一次的状态 */
  sections: Record<string, SectionState>;
  /** 上一次生成文本时的整块内容（用于"完全没变"判定） */
  rendered?: string;
}

export interface DiffResult {
  /** 要注入的文本；空串 = 一个字都不发 */
  text: string;
  /** 这轮有没有变化（审计/测试用） */
  changed: boolean;
  /** 本轮快照（调用方落盘） */
  snapshot: WorldStateSnapshot;
}

/** RFC 7386 merge patch：算出"从 prev 到 next 要改什么"；没差异返回 null（出处 codex `merge_patch_from`） */
export function mergePatchFrom(prev: SectionState, next: SectionState): Record<string, unknown> | null {
  if (prev === null && next === null) return null;
  if (prev === null) return next ?? null;                    // 从无到有 → 全量
  if (next === null) return {};                              // 从有到无 → 空 patch（调用方据此发"不再适用"）
  const patch: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(next)) {
    const before = prev[k];
    if (JSON.stringify(before) !== JSON.stringify(v)) patch[k] = v;
  }
  for (const k of Object.keys(prev)) {
    if (!(k in next)) patch[k] = null;                       // 删掉的键（merge patch 里 null = 删除）
  }
  return Object.keys(patch).length ? patch : null;
}

/** 三态判定（出处 codex `PreviousSectionState`） */
export type PrevState = 'known' | 'unknown' | 'absent';

export function prevStateOf(snapshot: WorldStateSnapshot | undefined, sectionId: string): PrevState {
  if (!snapshot) return 'absent';
  return sectionId in snapshot.sections ? 'known' : 'absent';
}

export class WorldStateTracker {
  private snap: WorldStateSnapshot;
  private readonly specs: SectionSpec[];

  constructor(specs: SectionSpec[], snapshot?: WorldStateSnapshot) {
    this.specs = specs;
    this.snap = snapshot ?? { sections: {} };
  }

  currentSnapshot(): WorldStateSnapshot {
    return this.snap;
  }

  /**
   * 渲染这一轮要注入的块：
   * · 首次（没有快照）→ **保守重播全量**（宁可重播，不假设"没变过"）
   * · 有快照 → 只发变化的那些小节；**全都没变 → 空串**
   * · 某节从有到无 → 发"不再适用"
   */
  render(next: Record<string, SectionState>): DiffResult {
    const isFirst = Object.keys(this.snap.sections).length === 0 && !this.snap.rendered;
    const lines: string[] = [];
    const gone: string[] = [];
    const sections: Record<string, SectionState> = {};
    let changed = false;

    for (const spec of this.specs) {
      const state = next[spec.id] ?? null;
      sections[spec.id] = state;
      const prev = isFirst ? undefined : this.snap.sections[spec.id];

      if (state === null) {
        // 当前没有这一节：之前给过 → 明说不再适用；从来没给过 → 什么都不说（出处 tools.rs 的静默）
        if (prev !== undefined && prev !== null) gone.push(spec.label);
        continue;
      }
      if (isFirst || prev === undefined) {
        // 保守重播（Absent/Unknown 都走这条）
        lines.push(`【${spec.label}】\n${spec.render(state)}`);
        changed = true;
        continue;
      }
      if (prev === null) {
        lines.push(`【${spec.label}】\n${spec.render(state)}`);
        changed = true;
        continue;
      }
      const patch = mergePatchFrom(prev, state);
      if (patch) {
        lines.push(`【${spec.label}·有更新】\n${spec.render(state)}`);
        changed = true;
      }
      // patch 为 null → 这一节没变 → 一个字都不发
    }

    const parts: string[] = [];
    if (gone.length) parts.push(`（之前提到的这${gone.length > 1 ? '几' : ''}件事不再适用了：${gone.join('、')}）`);
    if (lines.length) parts.push(...lines);
    const text = parts.join('\n');
    const snapshot: WorldStateSnapshot = { sections, rendered: text };
    this.snap = snapshot;
    return { text, changed, snapshot };
  }
}
