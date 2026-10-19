// 事件类型与日志条目定义。与 spec/spec.schema.json 的 logEntry 保持一致。

export const EVENT_TYPES = [
  'binding',
  'memory_append',
  'memory_correct',
  'memory_delete',
  'persona_upgrade',
  'milestone',
  'state_change',
  'asset_change',
  'social_link',
  'social_message',
  'joint_event',
  'gift',
  'device_action',
  // **工具动作**（改了哪个文件 / 跑了什么）与**审批决定**（谁点的头）也进签名链，
  // 以便凭链证明她当时到底做了什么。
  'tool_action',
  'approval',
  'capability_upgrade',
  // **屏幕截取**：每一次截取（用户按的 / 定时观察的 / 被策略拦下的）都进链：
  // `{ source, ok, reason }`。
  'screen_capture',
  // **记忆包导出**：导出 = 出生信息 + 日志链 + 记忆落到一个文件；落点是否离开本机
  // （云同步目录 / 外接卷）必须留痕。
  'memory_export',
  // **计划与步骤**：此前链上已在写这两个类型，但 `EVENT_TYPES` 与 spec 里没有它们
  // （"链上有、契约里没有"），现一并登记。
  'planner_plan',
  'planner_step',
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

export type Author = 'user' | 'companion' | 'system';

export interface HLC {
  t: number;
  c: number;
}

export interface LogEntry {
  /** 单调递增序号（同一日志内） */
  seq: number;
  /** 稳定条目身份：创建时生成，收敛重写时保留——跨链合并去重的依据（历史无 id 条目按 sig 去重） */
  id?: string;
  hlc: HLC;
  /** 上一条的哈希；genesis（seq 0）指向 seed 哈希 */
  prev_hash: string;
  author: Author;
  type: EventType;
  /** 被引用条目（纠正/墓碑指向的记忆 id） */
  target: string | null;
  payload: Record<string, unknown>;
  /** 作者 ed25519 签名（对 canonical 序列化） */
  sig: string;
}
