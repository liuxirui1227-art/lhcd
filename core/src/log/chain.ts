// 追加式记忆日志：哈希链 + HLC + 作者签名 + 重放派生当前状态。
// 设计原则：
// - 日志只追加，永不改写历史；"不可静默篡改"由哈希链 + 签名保证。
// - 纠错/遗忘都是新条目（memory_correct / memory_delete），当前状态 = 重放到 seq N 的结果。
// - 时间戳用 HLC，多设备离线分支可合并。

import { randomUUID } from 'node:crypto';
import { hlcCompare, hlcNow, type HLC } from './hlc.js';
import { entryHash, signEntry, verifyEntry, type KeyPair } from './signature.js';
import type { Author, EventType, LogEntry } from './types.js';

export interface IdentitySet {
  user: KeyPair;
  companion: KeyPair;
  system: KeyPair;
}

export interface ReplayResult {
  /** 有效记忆：id → 最新内容（纠正已应用、墓碑已剔除） */
  memories: Map<string, Record<string, unknown>>;
  /** 记忆纠正版本号：id → 版本（每纠正一次 +1） */
  versions: Map<string, number>;
  /** 已删除的记忆 id */
  deleted: Set<string>;
}

export class MemoryLog {
  private entries: LogEntry[] = [];
  private lastHlc: HLC | null = null;

  constructor(
    private identities: IdentitySet,
    /** genesis 的 prev_hash = 种子哈希 */
    public seedHash: string,
  ) {}

  get length(): number {
    return this.entries.length;
  }

  get head(): LogEntry | null {
    return this.entries[this.entries.length - 1] ?? null;
  }

  /** 追加一条日志。seq 自动递增，id 稳定生成（重写保留），HLC 自动推进，prev_hash 自动链接，签名由作者身份完成。 */
  append(author: Author, type: EventType, payload: Record<string, unknown>, target: string | null = null): LogEntry {
    const seq = this.entries.length;
    const prevHash = this.entries.length ? entryHash(this.entries[this.entries.length - 1]) : this.seedHash;
    this.lastHlc = hlcNow(this.lastHlc ?? undefined);
    const partial = { seq, id: randomUUID(), hlc: this.lastHlc, prev_hash: prevHash, author, type, target, payload };
    const entry: LogEntry = { ...partial, sig: signEntry(partial, this.identities[author].privateKey) };
    this.entries.push(entry);
    return entry;
  }

  /** 便捷方法：新增记忆（payload 需含 id）。 */
  appendMemory(author: Author, id: string, content: Record<string, unknown>): LogEntry {
    return this.append(author, 'memory_append', { id, ...content });
  }

  /** 便捷方法：纠正记忆（target = 记忆 id，payload 为修正内容）。 */
  correctMemory(author: Author, id: string, correction: Record<string, unknown>): LogEntry {
    return this.append(author, 'memory_correct', correction, id);
  }

  /** 便捷方法：删除记忆（墓碑）。 */
  deleteMemory(author: Author, id: string, reason?: string): LogEntry {
    return this.append(author, 'memory_delete', { reason: reason ?? 'user_request' }, id);
  }

  /** 完整性校验：prev_hash 链接、签名、HLC 单调、作者已知。任何改动都会断链或被检出。 */
  verifyIntegrity(): { ok: boolean; error?: string } {
    let prevHash = this.seedHash;
    let last: HLC | null = null;
    for (const e of this.entries) {
      if (e.prev_hash !== prevHash) return { ok: false, error: `seq ${e.seq}: prev_hash 断链（历史被改动）` };
      const pub = this.identities[e.author]?.publicKey;
      if (!pub) return { ok: false, error: `seq ${e.seq}: 未知作者 ${e.author}` };
      if (!verifyEntry(e, pub)) return { ok: false, error: `seq ${e.seq}: 签名无效（条目被篡改或伪造）` };
      if (last && hlcCompare(e.hlc, last) <= 0) return { ok: false, error: `seq ${e.seq}: HLC 非单调` };
      prevHash = entryHash(e);
      last = e.hlc;
    }
    return { ok: true };
  }

  /** 重放日志 → 派生当前有效状态：纠正已应用、墓碑已剔除。 */
  replay(): ReplayResult {
    const memories = new Map<string, Record<string, unknown>>();
    const versions = new Map<string, number>();
    const deleted = new Set<string>();
    for (const e of this.entries) {
      switch (e.type) {
        case 'memory_append': {
          const id = String(e.payload.id);
          memories.set(id, e.payload);
          versions.set(id, 1);
          deleted.delete(id);
          break;
        }
        case 'memory_correct': {
          if (!e.target) break;
          const cur = memories.get(e.target);
          if (cur) {
            memories.set(e.target, { ...cur, ...e.payload });
            versions.set(e.target, (versions.get(e.target) ?? 1) + 1);
          }
          break;
        }
        case 'memory_delete': {
          if (!e.target) break;
          memories.delete(e.target);
          deleted.add(e.target);
          break;
        }
        default:
          break;
      }
    }
    return { memories, versions, deleted };
  }

  /** 载入已持久化的条目（加载/导入场景，不重新签名；完整性由 verifyIntegrity 校验）。 */
  loadEntry(entry: LogEntry): void {
    this.entries.push(entry);
    this.lastHlc = entry.hlc;
  }

  /** 导出全量条目（用于持久化/合并/包导出）。 */
  export(): LogEntry[] {
    return [...this.entries];
  }

  /** 导入并校验（用于加载/合并后验证）。 */
  static verify(entries: LogEntry[], identities: IdentitySet, seedHash: string): { ok: boolean; error?: string } {
    const log = new MemoryLog(identities, seedHash);
    log.entries = [...entries].sort((a, b) => a.seq - b.seq);
    return log.verifyIntegrity();
  }
}
