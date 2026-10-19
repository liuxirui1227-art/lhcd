// 能力档位（全本地 / 混合 / 纯云端）。
// 档位 = 能力层配置：安装时按设备能力自动检测给出推荐，用户可手动覆盖、随时热切换；
// 不改灵魂层（宪法/范例/记忆不变）。纯函数，零依赖，双环境可单测。

export type CapabilityTier = 'all-local' | 'hybrid' | 'cloud-only';

export const CAPABILITY_TIERS: readonly CapabilityTier[] = ['all-local', 'hybrid', 'cloud-only'];

/** 设备能力画像（检测输入） */
export interface DeviceProfile {
  /** 物理内存 GB */
  ramGB: number;
  /** 是否有 NPU/统一内存神经引擎 */
  npu: boolean;
  /** 是否具备可用的端侧推理运行时（如 llama-server 可执行） */
  localModelSupport: boolean;
}

export interface TierDetection {
  tier: CapabilityTier;
  /** 逐条判定理由（透出给管理 UI，用户看得懂为什么推荐这个档） */
  reasons: string[];
}

/**
 * 自动检测推荐档位：
 * - all-local：内存 ≥16GB 且有 NPU（强设备：本地 persona 模型扛主路径）
 * - hybrid：内存 ≥8GB 且（有 NPU 或端侧推理运行时可用）（中档设备：本地轻量 + 云端主力）
 * - cloud-only：其余（弱设备，或端侧不可用——推理全云端，离线走存续态）
 */
export function detectCapabilityTier(p: DeviceProfile): TierDetection {
  if (p.ramGB >= 16 && p.npu) {
    return {
      tier: 'all-local',
      reasons: ['内存 ≥16GB 且具备 NPU：本地 persona 模型可扛主路径', '离线仍有完整对话能力'],
    };
  }
  if (p.ramGB >= 8 && (p.npu || p.localModelSupport)) {
    return {
      tier: 'hybrid',
      reasons: ['具备端侧推理条件（NPU 或本地运行时）：本地轻量 persona + 云端主力', '离线由本地 Tier 1 兜底 + 状态层降级'],
    };
  }
  return {
    tier: 'cloud-only',
    reasons: ['设备不具备端侧推理能力：推理全云端', '离线进入存续态（收取消息、暂停主动触达、复网补答）'],
  };
}

/** 档位行为画像（管理 UI / status 透出） */
export const TIER_INFO: Record<CapabilityTier, { label: string; tier1: string; offline: string }> = {
  'all-local': { label: '全本地档', tier1: '本地 persona 模型（主路径）', offline: '完整离线对话' },
  hybrid: { label: '混合档（默认）', tier1: '本地轻量 persona（兜底）', offline: 'Tier 1 兜底 + 状态层降级' },
  'cloud-only': { label: '纯云端档', tier1: '无（本地规则引擎/存续态模板）', offline: '存续态（复网补答）' },
};

/** 用户覆盖校验：非法档位返回 null */
export function validTier(v: unknown): CapabilityTier | null {
  return typeof v === 'string' && (CAPABILITY_TIERS as readonly string[]).includes(v)
    ? (v as CapabilityTier)
    : null;
}

/** 生效档位：用户覆盖优先，否则检测推荐 */
export function effectiveTier(detected: CapabilityTier, userChoice?: unknown): CapabilityTier {
  const u = validTier(userChoice);
  return u ?? detected;
}
