// 多端日志合并：
// 多设备各自离线追加线性签名链；合并 = 按 HLC 全序归并（共享历史按签名去重）→ 收敛重写为单一线性链。
// 重写是显式用户操作（可携带包导入/双设备合并）：以同一 seed 派生身份重排、重编号、重签名，
// 收敛后所有设备以同一链为唯一真相；冲突（同 id 记忆内容不同）保留 HLC 较新者并剧情化记录。
import { hlcCompare, type HLC } from './hlc.js';
import { entryHash, signEntry } from './signature.js';
import { randomUUID } from 'node:crypto';
import type { Author, LogEntry } from './types.js';
import type { IdentitySet } from './chain.js';

export interface MergeConflict {
  /** 冲突记忆 id（memory_append 的 payload.id / memory_correct 的 target） */
  id: string;
  /** 各分支的最终版本（HLC 升序，≥2 条；用于剧情化叙述） */
  branches: Array<{ hlc: HLC; text: string }>;
}

/** 条目是否为携带"记忆全文"的事件（append / correct 的 text 字段） */
function textOf(e: LogEntry): { id: string; text: string } | null {
  if (typeof e.payload?.text !== 'string') return null;
  if (e.type === 'memory_append' && typeof e.payload?.id === 'string') {
    return { id: String(e.payload.id), text: e.payload.text };
  }
  if (e.type === 'memory_correct' && typeof e.target === 'string') {
    return { id: e.target, text: e.payload.text };
  }
  return null;
}

/**
 * 多段日志按 HLC 全序归并（各段内部保持原序；不修改任何段）。
 * 去重：稳定条目 id 相同的条目只保留第一份（重写后签名会变，id 不变——共享历史 / 同一包重复导入 /
 * 合并后再同步都不会复制历史）；历史无 id 条目回退按 sig 去重（sig 相同 = 逐字节同一条目）。
 * 冲突检测：按"各分支各自的最新版本"判定——同一记忆 id 在 ≥2 个分支里各自最终文本不同才算冲突
 * （同链内 append→correct 是正常修正，不算冲突）。按 HLC 保留较新者，各分支最终版本记入冲突（供剧情化叙述）。
 */
export function mergeByHlc(chains: LogEntry[][]): { entries: LogEntry[]; conflicts: MergeConflict[] } {
  const indices = chains.map(() => 0);
  const out: LogEntry[] = [];
  const seenSigs = new Set<string>();
  const seenIds = new Set<string>();
  // id → (chainIndex → 该分支最新版本 {hlc, text})
  const byId = new Map<string, Map<number, { hlc: HLC; text: string }>>();

  for (;;) {
    let best = -1;
    let bestHlc: HLC | null = null;
    for (let i = 0; i < chains.length; i++) {
      if (indices[i]! >= chains[i]!.length) continue;
      const cand = chains[i]![indices[i]!]!;
      if (best < 0 || hlcCompare(cand.hlc, bestHlc!) < 0) {
        best = i;
        bestHlc = cand.hlc;
      }
    }
    if (best < 0) break;
    const e = chains[best]![indices[best]!]!;
    indices[best] = (indices[best] ?? 0) + 1;

    // 去重：id 优先（跨重写稳定），无 id 的历史条目回退 sig
    if (e.id) {
      if (seenIds.has(e.id)) continue;
      seenIds.add(e.id);
    } else {
      if (seenSigs.has(e.sig)) continue;
      seenSigs.add(e.sig);
    }
    out.push(e);

    // 分支最新版本跟踪（冲突判定依据）
    const t = textOf(e);
    if (t) {
      let perChain = byId.get(t.id);
      if (!perChain) {
        perChain = new Map();
        byId.set(t.id, perChain);
      }
      const prev = perChain.get(best);
      if (!prev || hlcCompare(e.hlc, prev.hlc) > 0) {
        perChain.set(best, { hlc: e.hlc, text: t.text });
      }
    }
  }

  // 冲突 = 同一记忆 id 在不同分支的最终文本分歧（各分支最新版本，按 HLC 升序）
  const conflicts: MergeConflict[] = [];
  for (const [id, perChain] of byId) {
    const versions = [...perChain.values()].sort((a, b) => hlcCompare(a.hlc, b.hlc));
    const texts = new Set(versions.map((v) => v.text));
    if (texts.size > 1) conflicts.push({ id, branches: versions });
  }
  return { entries: out, conflicts };
}

/**
 * 收敛重写：HLC 全序 → 重新编号、重链、重签，输出单一线性链（genesis 指向 seed 哈希）。
 * 返回重写后的条目；调用方负责落盘替换旧链。重写是显式合并操作，允许换链。
 */
export function rewriteChain(entries: LogEntry[], identities: IdentitySet, seedHash: string): LogEntry[] {
  const sorted = [...entries].sort((a, b) => hlcCompare(a.hlc, b.hlc));
  let prevHash = seedHash;
  let lastHlc: HLC | null = null;
  return sorted.map((e, i) => {
    // 排序后 HLC 已单调；防御同 (t,c) 碰撞时推进逻辑计数
    const hlc = lastHlc && hlcCompare(e.hlc, lastHlc) <= 0 ? { t: lastHlc.t, c: lastHlc.c + 1 } : e.hlc;
    lastHlc = hlc;
    const partial = {
      seq: i,
      id: e.id ?? randomUUID(), // 保留稳定 id；历史无 id 条目在此获得 id（重写 = 迁移到可合并格式）
      hlc,
      prev_hash: prevHash,
      author: e.author,
      type: e.type,
      target: e.target,
      payload: e.payload,
    };
    prevHash = entryHash(partial);
    const priv = identities[partial.author as Author]?.privateKey;
    if (!priv) throw new Error(`重写失败：缺少作者身份 ${partial.author}`);
    return { ...partial, sig: signEntry(partial, priv) };
  });
}
