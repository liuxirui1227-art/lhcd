// 语义记忆条目：memory/semantic/<slug>.md（frontmatter + 正文）。
// 零依赖 YAML-lite：仅支持本项目固定的键值行（name/scope/description/confidence/source/tags/domain/updatedAt），
// tags 为逗号分隔；字符串原样保存。TODO(spec)：复杂 YAML 场景接 yaml 库。
import type { Runtime } from '../runtime/types.js';
import type { Domain } from '../lifecycle/facets.js';
import { hybridRecall, importanceWeight, type HybridOptions, type HybridScoredEntry } from './recall.js';
import { analyzeQuery, entryText, scoreTerms } from './text.js';

export interface SemanticEntry {
  name: string;          // 记忆唯一标识，如 user.preferred_language
  scope: 'global' | 'project';
  description: string;
  confidence: 'high' | 'medium' | 'low';
  source: string;        // 来源会话/工具结果，可追溯（无 source 不写入）
  tags: string[];
  /** 数据域标签（权限矩阵列）：缺省未打标 → 按 schedule 域可见性处理（所有侧面可读） */
  domain?: Domain;
  updatedAt: string;     // ISO 8601
  content: string;       // 正文
  // ── 生命周期字段。**全部可选**——老文件读出来就是 undefined，
  //    语义与行为都不变（向后兼容），读到旧条目时 createdAt 按 updatedAt 兜底（不回头改写文件）。
  /** 显式重要性 0~1；缺省由 confidence 派生（recall.ts 的 importanceWeight，老行为不变） */
  importance?: number;
  /** 首次写入时间；**同名覆盖不刷新**（原来只有 updatedAt，创建时间会被覆盖吃掉） */
  createdAt?: string;
  /** 最近一次被召回/注入的时间（召回回流；谁用谁 touch，见 MemoryService.touch） */
  lastUsedAt?: string;
  /** 到期时间（TTL 开关打开时按 ttlDays 算；显式给出优先）——到点由 purgeExpired 收走 */
  expiresAt?: string;
  /**
   * 信任分：**这条记忆有多可信/多有用**。
   * 0~1，缺省按 0.5 读（老文件没有这一行 = 中性，行为完全不变）；
   * 用户说"有用" +0.05、"没用" −0.10（**罚是奖的两倍**），最终**乘在相关性上**（recall.ts 的 trustFactor）。
   * 只在被打过分时才写进文件 —— 没打分的条目读出来是 undefined，写回去不会凭空多一行。
   */
  trust?: number;
  /** 候选态：缺省 active = 老文件语义不变。candidate 需用户批准才转正 */
  status?: MemoryStatus;
}

/** 候选态：自动提炼的记忆先当候选，用户在「我的 TA」里批准/忽略 */
export type MemoryStatus = 'active' | 'candidate' | 'deprecated';

const STATUSES: readonly MemoryStatus[] = ['active', 'candidate', 'deprecated'];

/**
 * 首次写入时的默认状态——判据是**"这句话是谁交代的"**，不是猜内容：
 *   · 她自己从对话里提炼的 / 会话摘要滚出来的 / 两人约会记录 / 日程同步来的 → candidate（等用户批准）
 *   · 用户当面说的（对话里的 remember 工具、用户纠正、界面里明说的）→ active（直接生效）
 * 与来源权威性用同一张来源表（recall.ts 的 sourceAuthority），出处一致。
 */
const AUTO_EXTRACT_SOURCES: readonly RegExp[] = [
  /^chat-digest/, /^session[.-]/, /^scene-report/, /^info-sync/,
  // **后台复盘**提的候选——"她自己琢磨出来的"和"她自己从对话里提炼的"是同一类，
  // 同样要用户点头才转正（写进这张表，`defaultStatusFor('review')` 就是 candidate）。
  /^review/,
];

export function defaultStatusFor(source: string): MemoryStatus {
  const s = String(source ?? '');
  return AUTO_EXTRACT_SOURCES.some((re) => re.test(s)) ? 'candidate' : 'active';
}

export interface ScoredEntry {
  entry: SemanticEntry;
  score: number;
}

/** 敏感值扫描：命中即拒绝写入（memory.redacted 事件）。含中英文密钥类关键词 */
const SECRET_RE =
  /((?:^|[^A-Za-z0-9])sk-[A-Za-z0-9_-]{8,}|(?:api[_-]?key|secret|password|token|密码|密钥|令牌)\s*[:=]\s*\S+|\b\d{16,19}\b)/i;

export function hasSecret(content: string): boolean {
  return SECRET_RE.test(content);
}

export class SemanticStore {
  constructor(
    private readonly runtime: Runtime,
    /** semantic 目录（config.memory.semanticDir） */
    private readonly dir: string,
  ) {}

  private slug(name: string): string {
    return name.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/-+/g, '-').toLowerCase();
  }

  private pathFor(name: string): string {
    return `${this.dir}/${this.slug(name)}.md`;
  }

  serialize(entry: SemanticEntry): string {
    return [
      '---',
      `name: ${entry.name}`,
      `scope: ${entry.scope}`,
      `description: ${entry.description}`,
      `confidence: ${entry.confidence}`,
      `source: ${entry.source}`,
      `tags: ${entry.tags.join(', ')}`,
      ...(entry.domain ? [`domain: ${entry.domain}`] : []),
      `updatedAt: ${entry.updatedAt}`,
      // 只在有值时写行 —— 老条目（无这些行）读出来是 undefined，写回去也不会凭空多出空行
      ...(typeof entry.importance === 'number' ? [`importance: ${entry.importance}`] : []),
      ...(entry.createdAt ? [`createdAt: ${entry.createdAt}`] : []),
      ...(entry.lastUsedAt ? [`lastUsedAt: ${entry.lastUsedAt}`] : []),
      ...(entry.expiresAt ? [`expiresAt: ${entry.expiresAt}`] : []),
      ...(typeof entry.trust === 'number' ? [`trust: ${entry.trust}`] : []),
      ...(entry.status && entry.status !== 'active' ? [`status: ${entry.status}`] : []),
      '---',
      entry.content,
    ].join('\n');
  }

  parse(raw: string): SemanticEntry | null {
    const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    if (!m) return null;
    const fm: Record<string, string> = {};
    for (const line of m[1]!.split('\n')) {
      const idx = line.indexOf(':');
      if (idx <= 0) continue;
      fm[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    }
    if (!fm.name) return null;
    const dom = fm.domain as Domain | undefined;
    const imp = Number.parseFloat(fm.importance ?? '');
    const status = STATUSES.includes(fm.status as MemoryStatus) ? (fm.status as MemoryStatus) : undefined;
    return {
      name: fm.name,
      scope: fm.scope === 'project' ? 'project' : 'global',
      description: fm.description ?? '',
      confidence: fm.confidence === 'high' || fm.confidence === 'low' ? fm.confidence : 'medium',
      source: fm.source ?? '',
      tags: (fm.tags ?? '').split(',').map((t) => t.trim()).filter(Boolean),
      domain: dom && ['schedule', 'emotion_log', 'work_log', 'private_diary'].includes(dom) ? dom : undefined,
      updatedAt: fm.updatedAt ?? '',
      content: m[2] ?? '',
      ...(Number.isFinite(imp) ? { importance: Math.min(1, Math.max(0, imp)) } : {}),
      // 老条目没有 createdAt：**按 updatedAt 兜底**（内存里补齐，不回写文件）——
      // 于是消费者永远拿得到一个创建时间，而老文件的字节面一个都不动。
      ...(fm.createdAt ? { createdAt: fm.createdAt } : fm.updatedAt ? { createdAt: fm.updatedAt } : {}),
      ...(fm.lastUsedAt ? { lastUsedAt: fm.lastUsedAt } : {}),
      ...(fm.expiresAt ? { expiresAt: fm.expiresAt } : {}),
      // 信任分：老条目没这一行 = 中性 0.5。**内存里补默认值、不回写文件**（同 createdAt 的处置），
      // 于是消费者永远拿得到一个数，而老文件字节面一个都不动。
      trust: Number.isFinite(Number.parseFloat(fm.trust ?? ''))
        ? Math.min(1, Math.max(0, Number.parseFloat(fm.trust!)))
        : 0.5,
      ...(status ? { status } : {}),
    };
  }

  /**
   * 写入（同名 key 覆盖；updatedAt 取新）。返回实际动作（redacted = 拒写）。
   * **覆盖 = 换内容，不重置生命周期** ——
   *   createdAt 留着（创建时间不该被覆盖吃掉）、用户批准过的 status 不许被下一次自动提炼打回候选、
   *   lastUsedAt/importance 留着。**expiresAt 例外：按内容更新重新计时**（老 deadline 会立刻过期，不合理）。
   */
  async write(entry: SemanticEntry): Promise<{ action: 'write' | 'overwrite' | 'redacted'; key: string }> {
    if (hasSecret(entry.content) || hasSecret(entry.description)) {
      return { action: 'redacted', key: entry.name };
    }
    const existed = await this.read(entry.name);
    const now = entry.updatedAt || this.runtime.clock();
    const merged: SemanticEntry = {
      ...entry,
      updatedAt: now,
      createdAt: entry.createdAt ?? existed?.createdAt ?? now,
    };
    const importance = entry.importance ?? existed?.importance;
    if (importance !== undefined) merged.importance = importance;
    const lastUsedAt = entry.lastUsedAt ?? existed?.lastUsedAt;
    if (lastUsedAt !== undefined) merged.lastUsedAt = lastUsedAt;
    // 候选态的默认值**只在首次写入时生效**：覆盖时要么用显式给的，要么保留老状态
    // （老状态读出来是 undefined = active —— 用户批准过的记忆，绝不许被下一次自动提炼打回候选）
    const status = entry.status ?? existed?.status ?? (existed ? undefined : defaultStatusFor(entry.source));
    if (status !== undefined) merged.status = status;
    await this.runtime.fs.write(this.pathFor(entry.name), this.serialize(merged));
    await this.updateIndex(entry.name, entry.description);
    return { action: existed ? 'overwrite' : 'write', key: entry.name };
  }

  /**
   * 召回回流：只更新 lastUsedAt —— **不动 updatedAt**
   * （updatedAt 是"内容新鲜度"，被检索到不是内容变了；动它会把时间衰减打分带偏）。
   */
  async touch(name: string, at?: string): Promise<boolean> {
    const existed = await this.read(name);
    if (!existed) return false;
    existed.lastUsedAt = at ?? this.runtime.clock();
    await this.runtime.fs.write(this.pathFor(name), this.serialize(existed));
    return true;
  }

  /**
   * 打分：用户说"这条有用/没用"。
   * **罚是奖的两倍**（有用 +0.05 / 没用 −0.10）：记错一次的代价要比记对一次的大，
   * 否则"偶尔记歪"永远追不回来。钳在 0~1；缺省 0.5（老条目没这一行）。
   */
  async rateTrust(name: string, kind: 'useful' | 'useless'): Promise<number | null> {
    const existed = await this.read(name);
    if (!existed) return null;
    const cur = typeof existed.trust === 'number' ? existed.trust : 0.5;
    const raw = Math.min(1, Math.max(0, cur + (kind === 'useful' ? 0.05 : -0.10)));
    // 收到两位小数再落盘：浮点会把 0.55-0.10 写成 0.45000000000000007，这行是要给人看的 frontmatter。
    const next = Math.round(raw * 100) / 100;
    existed.trust = next;
    await this.runtime.fs.write(this.pathFor(name), this.serialize(existed));
    return next;
  }

  /** 改名状态：批准 → active；忽略 → deprecated */
  async setStatus(name: string, status: MemoryStatus): Promise<boolean> {
    const existed = await this.read(name);
    if (!existed) return false;
    existed.status = status;
    await this.runtime.fs.write(this.pathFor(name), this.serialize(existed));
    return true;
  }

  async read(name: string): Promise<SemanticEntry | null> {
    try {
      const raw = (await this.runtime.fs.read(this.pathFor(name), { limit: 1_000_000 })).content;
      return this.parse(raw);
    } catch {
      return null;
    }
  }

  async delete(name: string): Promise<boolean> {
    const existed = await this.read(name);
    if (!existed) return false;
    await this.runtime.fs.write(this.pathFor(name), ''); // 墓碑（空文件；read 返回 null）
    await this.removeIndex(name);
    return true;
  }

  async list(): Promise<SemanticEntry[]> {
    const out: SemanticEntry[] = [];
    let files: string[] = [];
    try {
      files = await this.runtime.fs.list(this.dir);
    } catch {
      return [];
    }
    for (const f of files.sort()) {
      if (!f.endsWith('.md')) continue;
      try {
        const e = this.parse((await this.runtime.fs.read(`${this.dir}/${f}`, { limit: 1_000_000 })).content);
        if (e) out.push(e);
      } catch {
        // 跳过坏文件
      }
    }
    return out;
  }

  /**
   * 关键词 + BM25（零向量依赖；embedding 缺失时降级路径）。默认按相关性排序。
   * 分数 0~1（已归一化，此前为无上限原始分）——阈值消费方（runtime 聊天摘要去重）已同步按新量纲调整。
   */
  /**
   * 纯关键词检索（BM25/词频口径；评测基线锁定用）。
   * `includeDeprecated`（被纠正/删除的旧说法不得复活）：
   * **查重必须看得见 deprecated 条目** —— 否则自动提炼再抽到同样的内容时查不到旧条目，
   * 会拿新 key 再写一条，"用户忽略过的记忆"就自己回来了。默认 false：召回路径不该看见它们。
   */
  async search(query: string, max = 8, opts?: { includeDeprecated?: boolean }): Promise<ScoredEntry[]> {
    // **deprecated 不再被想起来**（用户忽略过的，别再端上来）
    const entries = (await this.list()).filter((e) => opts?.includeDeprecated === true || e.status !== 'deprecated');
    const q = analyzeQuery(query);
    if (q.terms.length === 0) {
      // 空查询 = 冻结前缀要的"稳定核心"：取**重要性优先**，同分再按新近。
      // 必须是**确定性**的（同一份记忆库 → 同一段字节，差一个字就缓存全失效）。
      return entries
        .sort((a, b) => (importanceWeight(b) - importanceWeight(a)) || b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, max)
        .map((e) => ({ entry: e, score: 0 }));
    }
    const scored = entries.map((e) => ({ entry: e, score: scoreTerms(entryText(e), q).score }));
    return scored
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score || b.entry.updatedAt.localeCompare(a.entry.updatedAt))
      .slice(0, max);
  }

  /**
   * 混合召回：图谱 + 向量 + 时间衰减 + 重要性（见 recall.ts）。
   * 与 search()（纯 BM25，检索评测基线锁定用）并存；运行期注入路径用本方法。
   */
  async searchHybrid(
    query: string,
    max = 8,
    opts?: HybridOptions,
  ): Promise<HybridScoredEntry[]> {
    // 同上：deprecated 不进召回（candidate 进，但降权 ×0.8 —— 见 recall.ts 的 statusWeight）
    const entries = (await this.list()).filter((e) => e.status !== 'deprecated');
    const scored = await hybridRecall(query, entries, opts);
    return scored.slice(0, max);
  }

  /**
   * 过期清理：**显式 expiresAt 优先**，否则按 updatedAt + ttlDays
   * （老行为逐字保留：ts < now - ttlDays）。confidence=high 的条目**永不清**
   * （"长期记忆不蒸发"）。
   * ⚠ **调用方负责"TTL 开关"**：config.memory.ttlEnabled 默认 false —— 关着时谁都不许调本方法。
   */
  async purgeExpired(ttlDays: number, now: string): Promise<number> {
    const nowMs = Date.parse(now);
    let deleted = 0;
    for (const e of await this.list()) {
      if (e.confidence === 'high') continue;
      const exp = e.expiresAt ? Date.parse(e.expiresAt) : Number.NaN;
      const due = Number.isFinite(exp) ? exp : Date.parse(e.updatedAt) + ttlDays * 24 * 3600 * 1000;
      if (Number.isFinite(due) && due < nowMs) {
        await this.delete(e.name);
        deleted++;
      }
    }
    return deleted;
  }

  /** MEMORY.md 索引：每行 - [<name>](semantic/<slug>.md) — <description> */
  private async updateIndex(name: string, description: string): Promise<void> {
    const lines = await this.readIndex();
    const next = lines.filter((l) => !l.includes(`[${name}]`));
    next.push(`- [${name}](semantic/${this.slug(name)}.md) — ${description}`);
    await this.runtime.fs.write(`${this.dir}/../MEMORY.md`, next.sort().join('\n'));
  }

  private async removeIndex(name: string): Promise<void> {
    const lines = await this.readIndex();
    await this.runtime.fs.write(`${this.dir}/../MEMORY.md`, lines.filter((l) => !l.includes(`[${name}]`)).join('\n'));
  }

  private async readIndex(): Promise<string[]> {
    try {
      const raw = (await this.runtime.fs.read(`${this.dir}/../MEMORY.md`, { limit: 1_000_000 })).content;
      return raw.split('\n').filter(Boolean);
    } catch {
      return [];
    }
  }
}
