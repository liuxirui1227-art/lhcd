// 混合逻辑时钟（HLC）：物理时间 + 逻辑计数，保证离线分支可按因果关系合并。
// 设备时钟可被修改、多设备会漂移，因此日志时间戳一律用 HLC 而非裸 Date.now()。

export interface HLC {
  /** 物理时间（Unix 毫秒） */
  t: number;
  /** 逻辑计数（同一物理时刻内区分先后） */
  c: number;
}

/** 基于上一个 HLC 生成新的 HLC；同一毫秒内 c 递增，保证严格单调。 */
export function hlcNow(prev?: HLC, nowMs: number = Date.now()): HLC {
  if (!prev) return { t: nowMs, c: 0 };
  if (nowMs > prev.t) return { t: nowMs, c: 0 };
  return { t: prev.t, c: prev.c + 1 };
}

/** 比较两个 HLC：先比物理时间，再比逻辑计数。返回负数 = a 先于 b。 */
export function hlcCompare(a: HLC, b: HLC): number {
  if (a.t !== b.t) return a.t - b.t;
  return a.c - b.c;
}
