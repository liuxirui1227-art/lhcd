// 回合级文件快照（文件回滚 v1）
//
// 为什么要它：`write` / `edit` 只写**一个** `<path>.bak`，而且**第二次改就被覆盖**——
// 一轮里改三次，`a.md.bak` 里躺的是"第二次改之前"的内容，**这一轮开始前**的原文已经没了；
// 更别说"一次改 3 个文件、一键全退回"（零还原入口）。
//
// 这一版是**回合级快照**——
//   · 一个回合里，某个文件**第一次**被改动时记一份**改动前**的内容（第一次赢：那才是这一轮开始前的样子）；
//   · 全部落在 `<snapshotsDir>/<turnId>/` 下，`index.jsonl` 只追加（谁、什么时候、哪个文件、多大）；
//   · `undo` 按回合整体还原：**本来存在的写回去，本来不存在的删掉**（新建的文件还原 = 删掉）。
//
// 三条边界：
//   ① **删掉的文件不在这里管**——那是回收站那条线（`delete` 工具走 OS 回收站），快照只负责"改坏了的能改回来"；
//   ② 快照**只写数据目录以内**（`snapshotsDir` 由宿主给，宿主给的是 `<dataDir>/snapshots`）；路径不做任何猜测；
//   ③ 保留策略：**最近 N 个回合**（默认 20），超了先删最老的整目录（连索引一起清）。
import type { Runtime } from '../runtime/types.js';

/** 一条快照索引（只追加；还原时按 turnId 取） */
export interface SnapshotEntry {
  /** 回合 id（宿主/内核给的；同一回合的改动归一份） */
  turnId: string;
  at: string;
  /** 被改的文件（绝对路径或相对 cwd 的路径，原样记） */
  path: string;
  /** 改动前这个文件**在不在**：false = 这一轮新建的 → 还原时删掉 */
  existed: boolean;
  /** 内容落在哪（相对快照根目录；`existed:false` 时为 null） */
  file: string | null;
  /** 改动前内容的字节数（`existed:false` 时为 0） */
  bytes: number;
}

/** 还原计划（**只算不动**：真正落盘/删文件在 `undo` 工具那一层，因为删要有回收站通道） */
export interface RestorePlan {
  turnId: string;
  /** 写回这些（内容已读进内存） */
  restore: Array<{ path: string; content: string }>;
  /** 删掉这些（这一轮新建的） */
  remove: string[];
  /** 还原不了的（如实列出，不假装成功） */
  failed: Array<{ path: string; reason: string }>;
  /** 这个回合一共动过几个文件 */
  total: number;
  /** 这个回合**已经退回去过**了：再把同一份快照跑一遍 = 把用户新建的文件删掉、
   *  把用户手改的内容盖回去。所以两条路（界面按钮 / `undo` 工具）看到它就**拒绝执行**。 */
  alreadyUndone?: boolean;
}

/** 一回合最多记多少文件（防止有人拿它当备份系统用；超了如实拒绝并说清） */
export const MAX_FILES_PER_TURN = 200;
// `undone.jsonl` —— 记"哪个回合已经退回去过"。为什么必须有它：「撤销」必须**幂等**——
// 撤完不消失、再点一次会拿同一份快照再跑一遍：中间新建的文件被送进回收站、
// 用户手改过的内容被陈旧快照盖掉（不可逆）。
// 判据收在快照层这一处，宿主按钮与内核 `undo` 工具**共用**（两处各写一套必然漂移）。
const UNDONE_FILE = 'undone.jsonl';
/** 单个文件快照上限（超过就不记内容，只记"这个文件这轮动过"——还原时如实说没快照） */
export const MAX_SNAPSHOT_BYTES = 4 * 1024 * 1024;

export class SnapshotStore {
  constructor(private readonly runtime: Runtime, private readonly root: string, private readonly keepTurns = 20) {}

  private get indexFile(): string { return `${this.root}/index.jsonl`; }

  /** 快照根目录（只读；诊断/测试用） */
  get dir(): string { return this.root; }

  /** 读全部索引（坏行跳过，不让一行坏数据拖垮整份索引） */
  async list(): Promise<SnapshotEntry[]> {
    let raw: string;
    try {
      raw = (await this.runtime.fs.read(this.indexFile, { limit: 50_000_000 })).content;
    } catch {
      return [];
    }
    const out: SnapshotEntry[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line) as SnapshotEntry); } catch { /* 坏行跳过 */ }
    }
    return out;
  }

  /** 最近一个有快照的回合 id（`undo` 不带参数时用它） */
  async lastTurnId(): Promise<string | null> {
    const all = await this.list();
    return all.length ? all[all.length - 1]!.turnId : null;
  }

  /** 某个回合记了哪些文件（按记录顺序） */
  async entriesOf(turnId: string): Promise<SnapshotEntry[]> {
    return (await this.list()).filter((e) => e.turnId === turnId);
  }

  /**
   * 记一份"改动前"的快照。
   * @param before 改动前的原文；`null` = 这个文件**当时不存在**（新建）
   * @returns true = 记下了；false = 这一轮已经记过这个文件（第一次赢，后面的不再覆盖）
   */
  async record(turnId: string, path: string, before: string | null): Promise<boolean> {
    const existing = await this.entriesOf(turnId);
    if (existing.some((e) => e.path === path)) return false;          // 第一次赢
    if (existing.length >= MAX_FILES_PER_TURN) return false;          // 一回合最多这么多
    const bytes = before === null ? 0 : Buffer.byteLength(before, 'utf8');
    const keepContent = before !== null && bytes <= MAX_SNAPSHOT_BYTES;
    const seq = existing.length + 1;
    const safe = `${String(seq).padStart(3, '0')}-${path.split('/').pop() ?? 'file'}`.replace(/[^\w.\-\u4e00-\u9fa5]/g, '_');
    const rel = keepContent ? `${turnId}/${safe}` : null;
    if (rel) {
      try {
        await this.runtime.fs.write(`${this.root}/${rel}`, String(before));
      } catch {
        return false;   // 写不进去就不写索引：宁可没有这条，也不留一条指向空气的索引
      }
    }
    const entry: SnapshotEntry = { turnId, at: this.runtime.clock(), path, existed: before !== null, file: rel, bytes };
    try {
      await this.runtime.fs.append(this.indexFile, `${JSON.stringify(entry)}\n`);
    } catch {
      return false;
    }
    if (seq === 1) void this.prune();   // 新回合第一笔：顺手清理老回合（不阻塞写入）
    return true;
  }

  /**
   * 算出"把这个回合改过的文件整体还原"要做哪两件事：**写回**什么、**删掉**什么。
   * **只算不动**：这里不写盘也不删文件——删要走回收站通道（`delete` 那条线的规矩：不可逆的事不做），
   * 那一层在 `undo` 工具里。`existed:false` = 这一轮新建的 → 列进 `remove`。
   */
  async plan(turnId: string): Promise<RestorePlan> {
    const entries = await this.entriesOf(turnId);
    const plan: RestorePlan = { turnId, restore: [], remove: [], failed: [], total: entries.length };
    // 已经退回去过的回合：**给出空计划 + 明确的标记**（调用方据此拒绝，而不是再跑一遍快照）
    if (entries.length && (await this.isUndone(turnId))) return { ...plan, alreadyUndone: true };
    for (const e of entries) {
      if (!e.existed) { plan.remove.push(e.path); continue; }
      if (!e.file) {
        plan.failed.push({ path: e.path, reason: `改动前的内容没留快照（超过 ${Math.round(MAX_SNAPSHOT_BYTES / 1024 / 1024)}MB），还原不了` });
        continue;
      }
      try {
        const content = (await this.runtime.fs.read(`${this.root}/${e.file}`, { limit: MAX_SNAPSHOT_BYTES + 1024 })).content;
        plan.restore.push({ path: e.path, content });
      } catch (err) {
        plan.failed.push({ path: e.path, reason: `快照读不出来：${String((err as Error)?.message ?? err)}` });
      }
    }
    return plan;
  }

  /** 已经退回去过的回合 id 集合（坏行跳过，不让一行坏数据把整份名单废掉） */
  async undoneTurns(): Promise<Set<string>> {
    let raw: string;
    try {
      raw = (await this.runtime.fs.read(`${this.root}/${UNDONE_FILE}`, { limit: 1_000_000 })).content;
    } catch {
      return new Set();     // 还没有这份文件 = 一次都没退过
    }
    const out = new Set<string>();
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try { const j = JSON.parse(line) as { turnId?: unknown }; if (typeof j.turnId === 'string' && j.turnId) out.add(j.turnId); } catch { /* 坏行跳过 */ }
    }
    return out;
  }

  async isUndone(turnId: string): Promise<boolean> {
    return (await this.undoneTurns()).has(turnId);
  }

  /** 记一笔"这个回合退回去了"——**撤销成功后**调用（部分失败时不记，留着重试那没退成的几个）。 */
  async markUndone(turnId: string): Promise<void> {
    try {
      await this.runtime.fs.append(`${this.root}/${UNDONE_FILE}`, `${JSON.stringify({ turnId, at: this.runtime.clock() })}\n`);
    } catch { /* 记不上不致命：最坏是"再点一次还能退"，与改动前同行为 */ }
  }

  /** 保留最近 `keepTurns` 个回合：更老的整目录删掉，索引里那几行也删掉（重写索引）。 */
  async prune(): Promise<{ droppedTurns: string[] }> {
    const all = await this.list();
    const turns: string[] = [];
    for (const e of all) if (!turns.includes(e.turnId)) turns.push(e.turnId);
    if (turns.length <= this.keepTurns) return { droppedTurns: [] };
    /* 没有删的能力 → **整件事都不做**：只删索引不删目录是最坏的一种（目录还在、却再也退不回去）。
       "不假装清理过"在这里的具体含义就是这一行。 */
    if (!this.runtime.fs.remove) return { droppedTurns: [] };
    const drop = turns.slice(0, turns.length - this.keepTurns);
    for (const t of drop) {
      try {
        await this.runtime.fs.remove(`${this.root}/${t}`);
      } catch { /* 删不掉就留着，下回再试 */ }
    }
    const kept = all.filter((e) => !drop.includes(e.turnId));
    try {
      await this.runtime.fs.write(this.indexFile, kept.map((e) => JSON.stringify(e)).join('\n') + (kept.length ? '\n' : ''));
    } catch { /* 索引重写失败不致命：老条目还在，只是多留了目录 */ }
    return { droppedTurns: drop };
  }
}

/**
 * 一路回合里的记录器（工具在**改动之前**调用它）。
 * 为什么不直接在工具里 new 一个 store：工具每次调用都要读一遍索引——
 * 一个回合里改 3 个文件就是 3 次读盘。这里在内存里记"这一轮已经记过哪些路径"，第一次赢。
 */
export class TurnSnapshots {
  private readonly seen = new Set<string>();
  constructor(private readonly store: SnapshotStore, private readonly turnId: string) {}

  /** 记一份改动前的内容（`before === null` = 当时不存在）。真记下了返回 true。 */
  async record(path: string, before: string | null): Promise<boolean> {
    if (this.seen.has(path)) return false;
    this.seen.add(path);
    return this.store.record(this.turnId, path, before);
  }

  /** 这一轮记过哪些文件（诊断/界面用） */
  paths(): string[] { return [...this.seen]; }
}
