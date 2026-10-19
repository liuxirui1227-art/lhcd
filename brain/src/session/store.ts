// 会话存储：
// sessions/<id>/session.json {id, cwd, startedAt, provider, model, configHash, stats}
//             /messages.jsonl 完整历史（resume 依据，save 时全量快照）
//             /events.jsonl   事件协议全文（追加）
// configHash 变更 → 警告并重建冻结前缀；resume 重放 messages.jsonl；fork 复制到新 id。
// 路径以 '/' 连接（跨平台约定）；一切文件操作只经 Runtime。
import type { Runtime } from '../runtime/types.js';
import type { ChatMessage } from '../llm/provider.js';
import type { Session } from '../loop/session.js';
import type { AgentEvent } from './events.js';
import { eventLine } from './events.js';
import { ensureIds, cutAt, branchSessionId, type TreeMessage } from './tree.js';
import { SessionLog } from './log.js';

export interface SessionMeta {
  /** 这条会话是从哪儿分出来的（老会话没有这个字段） */
  branchedFrom?: { sessionId: string; atMessageId: string; at: string };
  id: string;
  cwd: string;
  startedAt: string;
  provider: string;
  model: string;
  configHash: string;
  stats: Session['stats'];
}

export interface LoadedSession {
  meta: SessionMeta;
  history: ChatMessage[];
  /** 当前 config 哈希与存档不一致（需重建冻结前缀并警告） */
  configChanged: boolean;
}

export class SessionStore {
  constructor(private readonly runtime: Runtime) {}

  private dirFor(id: string): string {
    return `${this.runtime.storage.sessionsDir()}/${id}`;
  }

  configHashOf(config: unknown): string {
    return this.runtime.sha256(JSON.stringify(config));
  }

  async save(session: Session, startedAt: string): Promise<void> {
    const dir = this.dirFor(session.id);
    const meta: SessionMeta = {
      id: session.id,
      cwd: session.cwd,
      startedAt,
      provider: session.provider.name,
      model: 'main',
      configHash: this.configHashOf(session.config),
      stats: session.stats,
    };
    await this.runtime.fs.write(`${dir}/session.json`, JSON.stringify(meta, null, 2));
    /* `messages.jsonl` **降级成派生快照**（本机可读可审、排障用），
       真相源是只追加的 `log.jsonl`——压缩不会再让原文从日志里消失。 */
    const lines = session.history.map((m) => JSON.stringify(m)).join('\n');
    await this.runtime.fs.write(`${dir}/messages.jsonl`, lines ? `${lines}\n` : '');
    try {
      await new SessionLog(this.runtime, session.id).sync(session.history, this.runtime.clock());
    } catch { /* 日志写失败不拖垮保存（快照已经落了） */ }
  }

  /** 事件追加（每行 JSON）；返回可挂接到 session.emit 的发射器 */
  async appendEvent(id: string, ev: AgentEvent): Promise<void> {
    await this.runtime.fs.append(`${this.dirFor(id)}/events.jsonl`, `${eventLine(ev)}\n`);
  }

  makeEmitter(id: string): (ev: AgentEvent) => void {
    return (ev: AgentEvent) => {
      void this.appendEvent(id, ev);
    };
  }

  async load(id: string, currentConfig: unknown): Promise<LoadedSession | null> {
    const dir = this.dirFor(id);
    let metaRaw: string;
    try {
      metaRaw = (await this.runtime.fs.read(`${dir}/session.json`, { limit: 1_000_000 })).content;
    } catch {
      return null;
    }
    const meta = JSON.parse(metaRaw) as SessionMeta;
    /* **优先从日志投影**（真相源）；老会话没有日志 → 回落 `messages.jsonl`（快照）。
       两条路都对，只是"能不能重建"的区别：日志能，快照只能看当前这一份。 */
    try {
      const projected = await new SessionLog(this.runtime, id).project();
      if (projected.length > 0) {
        return {
          meta,
          history: ensureIds(projected) as ChatMessage[],
          configChanged: meta.configHash !== this.configHashOf(currentConfig),
        };
      }
    } catch { /* 投影失败就走下面的快照路 */ }
    let messages = '';
    try {
      messages = (await this.runtime.fs.read(`${dir}/messages.jsonl`, { limit: 10_000_000 })).content;
    } catch {
      messages = '';
    }
    const history: ChatMessage[] = messages
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as ChatMessage);
    /* 老会话没有 id/父指针 → **只在内存里补齐**（`ensureIds` 幂等），
       文件一个字节都不改（"不做数据迁移"这条纪律）。 */
    return {
      meta,
      history: ensureIds(history) as ChatMessage[],
      configChanged: meta.configHash !== this.configHashOf(currentConfig),
    };
  }

  /**
   * **从某条消息分支**：新会话 id = `<父>~b<n>`，内容是"那条消息**之前**的历史"。
   * 老分支**一个字节都不动**（所以我们只写新目录，不碰老的）。返回新会话 id 与"回填输入框的原文"。
   *
   * 为什么不在同一个会话里改历史：一旦原地删消息，"老分支"就没了——那不叫回溯，叫丢东西。
   */
  async branch(fromId: string, atMessageId: string, n = 1): Promise<{ id: string; text: string; keptCount: number } | null> {
    const loaded = await this.load(fromId, {});
    if (!loaded) return null;
    const entries = ensureIds(loaded.history) as TreeMessage[];
    const cut = cutAt(entries, atMessageId);
    if (cut.kept.length === entries.length) return null; // 没找到那条消息 → 如实返回 null，不装作成功
    const id = branchSessionId(fromId, n);
    const dir = this.dirFor(id);
    const meta = {
      ...loaded.meta,
      id,
      startedAt: this.runtime.clock(),
      configHash: loaded.meta.configHash,
      // 从哪来、在谁那儿分的岔（界面上要能显示"你现在在一条新分支上"）
      branchedFrom: { sessionId: fromId, atMessageId, at: this.runtime.clock() },
    };
    await this.runtime.fs.write(`${dir}/session.json`, JSON.stringify(meta, null, 2));
    const lines = cut.kept.map((m) => JSON.stringify(m)).join('\n');
    await this.runtime.fs.write(`${dir}/messages.jsonl`, lines ? `${lines}\n` : '');
    return { id, text: cut.text, keptCount: cut.kept.length };
  }

  /** 某个会话的元信息里记着的分支来源（不是分支给 null） */
  branchedFromOf(meta: SessionMeta): { sessionId: string; atMessageId: string } | null {
    const b = (meta as SessionMeta & { branchedFrom?: { sessionId: string; atMessageId: string } }).branchedFrom;
    return b ? { sessionId: b.sessionId, atMessageId: b.atMessageId } : null;
  }

  /** fork：复制 session.json / messages.jsonl / events.jsonl 到新 id（meta.id 更新为新 id） */
  async fork(fromId: string, newId: string): Promise<void> {
    const from = this.dirFor(fromId);
    const to = this.dirFor(newId);
    try {
      const raw = (await this.runtime.fs.read(`${from}/session.json`, { limit: 10_000_000 })).content;
      const meta = JSON.parse(raw) as SessionMeta;
      meta.id = newId;
      await this.runtime.fs.write(`${to}/session.json`, JSON.stringify(meta, null, 2));
    } catch {
      // 源不存在则跳过
    }
    for (const f of ['messages.jsonl', 'events.jsonl']) {
      try {
        const content = (await this.runtime.fs.read(`${from}/${f}`, { limit: 10_000_000 })).content;
        await this.runtime.fs.write(`${to}/${f}`, content);
      } catch {
        // 源文件不存在则跳过
      }
    }
  }
}
