// 模型清单数据化。
//
// 设计取舍已核 pi 源码：
//   · `ai/src/models.ts:97-149`：`getModels()` **同步且绝不抛**（"Models treats a throwing implementation as having no models"）；
//     `refreshModels?(context)` 异步；`filterModels?(models, credential)` 按账号过滤
//   · `ai/src/models-store.ts:3-14`：条目形态 `{ models, lastModified?, checkedAt?, etag? }`；
//     **etag 原样存、原样回**（含引号，`If-None-Match`）
//   · `core/remote-catalog-provider.ts:6-8`：`REMOTE_CATALOG_ATTEMPT_TIMEOUT_MS = 4_000`、
//     `REMOTE_CATALOG_REFRESH_INTERVAL_MS = 4 * 60 * 60 * 1000`（4 小时）
//   · 状态码分治：`304 && stored` → 只推 checkedAt；`404 || 501` → 清验证器；瞬时失败 → **保留 etag** 供下轮 revalidate
//   · URL 只带 provider id / 版本号（`/api/models/providers/<id>` + User-Agent）→ **"只发元数据"属实**
//   · 用户缺省值（`provider-composer.ts:159-161`）：`cost {0,0,0,0}` / `contextWindow ?? 128000` / `maxTokens ?? 16384`
//   · 网关下发字段（`providers/radius-config.ts:8-16`）：id / name / reasoning / thinkingLevelMap? / input / cost / contextWindow / maxTokens
//     ——**价格与上下文一起下发**，客户端逐字段校验后落本地
//
// 本实现：**清单是数据**（随包一份 + 用户/平台可覆盖一份 + 可选联网刷新），
// 于是"新模型当天可选"不用等 App 发版；断网用缓存（读不抛，坏文件当没有）。

import type { Runtime } from '../runtime/types.js';

export interface CatalogCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** 一条模型（字段与 pi 的网关下发形态对齐；全部可选，缺省值见 CATALOG_DEFAULTS） */
export interface CatalogModel {
  id: string;
  name?: string;
  /** 是否深度思考档（推理模型） */
  reasoning?: boolean;
  /** 支持的输入模态 */
  input?: { text?: boolean; image?: boolean };
  cost?: CatalogCost;
  contextWindow?: number;
  maxTokens?: number;
  /** 思考档位映射（供应商自己的叫法 → 通用档），如 { low: 'low', high: 'high' } */
  thinkingLevelMap?: Record<string, string>;
  /** 可选：写死的 wire 模型名（缺省 = id） */
  wire?: string;
}

export interface CatalogFile {
  models: CatalogModel[];
  /** 远端给的版本标识（如 Last-Modified），仅作展示/审计 */
  lastModified?: string;
  /** 上次校验时间（毫秒） */
  checkedAt?: number;
  /** 验证器（原样存原样回；出处 pi models-store.ts:3-14） */
  etag?: string;
}

export const CATALOG_DEFAULTS = { cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 16384 } as const;

/** 远端尝试超时（出处 pi remote-catalog-provider.ts:6-8 的 4_000） */
export const REMOTE_CATALOG_ATTEMPT_TIMEOUT_MS = 4_000;
/** 刷新窗口：4 小时（出处同上） */
export const REMOTE_CATALOG_REFRESH_INTERVAL_MS = 4 * 60 * 60 * 1000;

/** 逐字段类型校验（照 pi `isRadiusGatewayModel` 的严度：一个字段不对就整条不收） */
export function isValidCatalogModel(x: unknown): x is CatalogModel {
  if (!x || typeof x !== 'object') return false;
  const m = x as Record<string, unknown>;
  if (typeof m.id !== 'string' || !m.id.trim()) return false;
  if (m.name !== undefined && typeof m.name !== 'string') return false;
  if (m.reasoning !== undefined && typeof m.reasoning !== 'boolean') return false;
  if (m.contextWindow !== undefined && (typeof m.contextWindow !== 'number' || m.contextWindow <= 0)) return false;
  if (m.maxTokens !== undefined && (typeof m.maxTokens !== 'number' || m.maxTokens <= 0)) return false;
  if (m.cost !== undefined) {
    const c = m.cost as Record<string, unknown>;
    if (!c || typeof c !== 'object') return false;
    for (const k of ['input', 'output', 'cacheRead', 'cacheWrite']) {
      if (c[k] !== undefined && typeof c[k] !== 'number') return false;
    }
  }
  if (m.input !== undefined && (typeof m.input !== 'object' || m.input === null)) return false;
  if (m.thinkingLevelMap !== undefined && (typeof m.thinkingLevelMap !== 'object' || m.thinkingLevelMap === null)) return false;
  return true;
}

/** 补缺省（对照 pi provider-composer 的 ?? 缺省值） */
export function normalizeCatalogModel(m: CatalogModel): Required<Pick<CatalogModel, 'id' | 'name' | 'reasoning' | 'cost' | 'contextWindow' | 'maxTokens'>> & CatalogModel {
  return {
    ...m,
    id: m.id,
    name: m.name ?? m.id,
    reasoning: m.reasoning ?? false,
    cost: { ...CATALOG_DEFAULTS.cost, ...(m.cost ?? {}) },
    contextWindow: m.contextWindow ?? CATALOG_DEFAULTS.contextWindow,
    maxTokens: m.maxTokens ?? CATALOG_DEFAULTS.maxTokens,
  };
}

/** 合并（同 id 覆盖、新 id 追加——出处 pi provider-composer.ts:207-213 的语义） */
export function mergeCatalog(base: CatalogModel[], overlay: CatalogModel[]): CatalogModel[] {
  const out = [...base];
  for (const item of overlay) {
    const i = out.findIndex((m) => m.id === item.id);
    if (i >= 0) out[i] = { ...out[i], ...item };
    else out.push(item);
  }
  return out;
}

/** 从任意 JSON 里安全取清单（**绝不抛**——出处 pi models.ts:114-118 那条纪律） */
export function parseCatalog(raw: unknown): CatalogFile {
  if (!raw || typeof raw !== 'object') return { models: [] };
  const f = raw as Record<string, unknown>;
  const models = Array.isArray(f.models) ? f.models.filter(isValidCatalogModel).map(normalizeCatalogModel) : [];
  return {
    models,
    ...(typeof f.lastModified === 'string' ? { lastModified: f.lastModified } : {}),
    ...(typeof f.checkedAt === 'number' ? { checkedAt: f.checkedAt } : {}),
    ...(typeof f.etag === 'string' ? { etag: f.etag } : {}),
  };
}

export interface RefreshResult {
  changed: boolean;
  /** not-modified / no-network / too-soon / error / ok */
  outcome: 'ok' | 'not-modified' | 'offline-disabled' | 'too-soon' | 'gone' | 'error';
  catalog: CatalogFile;
  detail?: string;
}

/**
 * 刷新清单（**只发元数据**：URL 里只有供应商 id，头部只有版本号）。
 * 状态码分治照抄 pi：304 → 只推 checkedAt；404/501 → 清验证器；其它失败 → **保留 etag**（下轮再 revalidate）。
 */
export async function refreshCatalog(opts: {
  baseUrl: string;
  providerId: string;
  stored: CatalogFile;
  fetchFn: (url: string, init?: Record<string, unknown>) => Promise<{ status: number; ok: boolean; json(): Promise<unknown>; headers?: { get?(k: string): string | null } }>;
  allowNetwork: boolean;
  now?: number;
  userAgent?: string;
}): Promise<RefreshResult> {
  const now = opts.now ?? Date.now();
  if (!opts.allowNetwork) return { changed: false, outcome: 'offline-disabled', catalog: opts.stored };
  if (opts.stored.checkedAt && now - opts.stored.checkedAt < REMOTE_CATALOG_REFRESH_INTERVAL_MS) {
    return { changed: false, outcome: 'too-soon', catalog: opts.stored };
  }
  const url = `${opts.baseUrl.replace(/\/$/, '')}/api/models/providers/${encodeURIComponent(opts.providerId)}`;
  const headers: Record<string, string> = { 'User-Agent': opts.userAgent ?? 'lhcd' };
  // 只在"有缓存内容兜底"时才带验证器——否则 304 会让清单变空（出处 pi remote-catalog-provider.ts:80 的注释）
  if (opts.stored.etag && opts.stored.models.length > 0) headers['If-None-Match'] = opts.stored.etag;
  try {
    const res = await opts.fetchFn(url, { headers, signal: AbortSignal.timeout(REMOTE_CATALOG_ATTEMPT_TIMEOUT_MS) });
    if (res.status === 304 && opts.stored.models.length > 0) {
      return { changed: false, outcome: 'not-modified', catalog: { ...opts.stored, checkedAt: now } };
    }
    if (res.status === 404 || res.status === 501) {
      // 这个供应商没有远端清单：清验证器（下次别再拿旧 etag 去问）
      return { changed: false, outcome: 'gone', catalog: { models: opts.stored.models, checkedAt: now } };
    }
    if (!res.ok) return { changed: false, outcome: 'error', catalog: opts.stored, detail: `HTTP ${res.status}` };
    const body = await res.json();
    const parsed = parseCatalog(body);
    if (!parsed.models.length) return { changed: false, outcome: 'error', catalog: opts.stored, detail: '清单为空' };
    const etag = res.headers?.get?.('etag') ?? undefined;
    return {
      changed: true,
      outcome: 'ok',
      catalog: {
        models: parsed.models,
        ...(typeof (body as { lastModified?: string })?.lastModified === 'string' ? { lastModified: (body as { lastModified: string }).lastModified } : {}),
        checkedAt: now,
        ...(etag ? { etag } : {}),
      },
    };
  } catch (e) {
    // 瞬时失败：**保留 etag**（下轮还能走 304）——出处 pi remote-catalog-provider.ts:113-117
    return { changed: false, outcome: 'error', catalog: opts.stored, detail: String((e as Error)?.message ?? e).slice(0, 120) };
  }
}

/**
 * 清单仓：随包基线 + 用户覆盖 + 远端缓存，三层合并（读同步、绝不抛）。
 * 落盘形态就是 CatalogFile（JSON），坏文件当没有。
 */
export class CatalogStore {
  private file: CatalogFile = { models: [] };
  private loaded = false;

  constructor(
    private readonly runtime: Runtime,
    private readonly path: string,
    /** 随包基线（内置清单；读不到就当空） */
    private readonly builtinPath?: string,
  ) {}

  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    const base = await this.readFile(this.builtinPath);
    const user = await this.readFile(this.path);
    this.file = { ...user, models: mergeCatalog(base.models, user.models) };
  }

  private async readFile(p?: string): Promise<CatalogFile> {
    if (!p) return { models: [] };
    try {
      const raw = (await this.runtime.fs.read(p, { limit: 2_000_000 })).content;
      return parseCatalog(JSON.parse(raw)); // 坏 JSON → parseCatalog 不抛
    } catch {
      return { models: [] }; // 不存在/读不动 → 当没有（读绝不抛）
    }
  }

  /** 同步读（出处 pi getModels 的"绝不抛"契约） */
  models(): CatalogModel[] {
    return [...this.file.models];
  }

  forProvider(providerId: string): CatalogModel[] {
    // 清单按 "<供应商>.<模型>" 命名空间；没有前缀的条目对所有供应商可见（内置条目）
    return this.file.models.filter((m) => !m.id.includes('.') || m.id.startsWith(`${providerId}.`));
  }

  checkedAt(): number | undefined {
    return this.file.checkedAt;
  }

  etag(): string | undefined {
    return this.file.etag;
  }

  /** 落盘（用户层/缓存层；合并后的结果写回去） */
  async save(file: CatalogFile = this.file): Promise<void> {
    this.file = file;
    try {
      await this.runtime.fs.writeAtomic(this.path, JSON.stringify(file, null, 2));
    } catch { /* 写不动就算了：清单是优化项，不是主流程 */ }
  }

  async refresh(opts: { baseUrl: string; providerId: string; fetchFn: Parameters<typeof refreshCatalog>[0]['fetchFn']; allowNetwork: boolean; now?: number; userAgent?: string }): Promise<RefreshResult> {
    const r = await refreshCatalog({ ...opts, stored: this.file });
    if (r.outcome === 'ok' || r.outcome === 'not-modified') {
      this.file = r.catalog;
      await this.save();
    } else if (r.outcome === 'gone') {
      this.file = r.catalog;
      await this.save();
    }
    return r;
  }
}
