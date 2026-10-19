// 配置写回四件套。
//
// 设计要点（对齐同类配置系统的做法）：
//   · 乐观锁**是可选，不是必填**（不传即跳过检查）；比对的是**用户层**的 `sha256:{hex}` 指纹
//   · 稀疏合并：只把"改动的那条路径"包起来深合并 —— **不抹兄弟键**；删键走 clearPath
//   · 只写该写的层：目标固定"活跃的用户层"；写到别处 → readonly
//   · 写不进去要说清：**被更高优先级的层覆盖不算失败**，只有被锁死才是真拒绝
//
// 本实现：写 `<dataDir>/agent.json`（用户层）。**不原地改别的层**、**不抹没碰过的键**、
// **带版本号就核对**、**被覆盖了要说明是谁压住的**。

import type { Runtime } from '../runtime/types.js';

export interface LayerMeta {
  /** 文件绝对路径（审计/回显用） */
  path: string;
  /** 优先级（数字越大越强；我们目前只有用户层 20 / 会话层 30） */
  precedence: number;
  name: string;
}

export const USER_LAYER: Omit<LayerMeta, 'path'> = { precedence: 20, name: '用户配置' };

export type WriteStatus =
  | { status: 'ok'; version: string }
  | { status: 'ok-overridden'; version: string; message: string; overriddenBy: string }
  | { status: 'version-conflict'; message: string; currentVersion: string }
  | { status: 'readonly'; message: string }
  | { status: 'error'; message: string };

/** 版本指纹（sha256 前 16 位十六进制，形如 `sha256:{hex}`） */
export function fingerprint(content: string): string {
  // 这里用一个纯函数哈希（不引 node:crypto —— brain 保持零依赖；冲突检测不需要密码学强度）
  let h1 = 0x811c9dc5;
  let h2 = 0x1000193;
  for (let i = 0; i < content.length; i++) {
    const c = content.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 16777619) >>> 0;
    h2 = Math.imul(h2 + c, 2654435761) >>> 0;
  }
  return `sha256:${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}`;
}

/** 深合并（b 覆盖 a；数组与标量整体替换）——与 load.ts 的 deepMerge 同语义，单独放这里便于单测 */
function deepMergeInto(a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...a };
  for (const [k, v] of Object.entries(b)) {
    const cur = out[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && cur && typeof cur === 'object' && !Array.isArray(cur)) {
      out[k] = deepMergeInto(cur as Record<string, unknown>, v as Record<string, unknown>);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** 稀疏覆盖：把 `{a:{b:1}}` 这种点路径包成嵌套对象，只动这条路径 */
export function sparseOverlay(path: string[], value: unknown): Record<string, unknown> {
  return path.reduceRight<unknown>((acc, segment) => ({ [segment]: acc }), value) as Record<string, unknown>;
}

/** 删键 */
export function clearPath(obj: Record<string, unknown>, path: string[]): Record<string, unknown> {
  const out = deepMergeInto({}, obj);
  let cur: Record<string, unknown> = out;
  for (let i = 0; i < path.length - 1; i++) {
    const k = path[i]!;
    if (!cur[k] || typeof cur[k] !== 'object') return out; // 路径不存在 → 什么都不用做
    cur = cur[k] as Record<string, unknown>;
  }
  delete cur[path[path.length - 1]!];
  return out;
}

export interface WriteConfigInput {
  runtime: Runtime;
  /** 要写的层（只允许用户层；写别处 → readonly） */
  layer: LayerMeta;
  /** 点路径（如 ['catalog','allowNetwork']） */
  path: string[];
  /** 新值；undefined = 删掉这个键 */
  value?: unknown;
  /** **可选**乐观锁：带上就核对（不匹配 → version-conflict 且**不写**） */
  expectedVersion?: string;
  /** 更高优先级的层（用于"被谁压住"的说明；缺省空） */
  strongerLayers?: Array<{ meta: LayerMeta; hasPath: boolean }>;
}

/**
 * 写用户层配置。四件套都在这里：
 *   ① 带版本号 → 先核对（不匹配就拒绝，绝不覆盖别人的改动）
 *   ② 稀疏合并（只动 path 指的那条，兄弟键原样）
 *   ③ 只写允许的层（别的一律 readonly）
 *   ④ 被更强的层压住 → **写入成功但如实说**（不是错误）
 */
export async function writeUserConfig(input: WriteConfigInput): Promise<WriteStatus> {
  if (input.layer.precedence !== USER_LAYER.precedence) {
    return { status: 'readonly', message: `只允许写用户配置（你给的是「${input.layer.name}」）` };
  }
  let raw = '';
  try {
    raw = (await input.runtime.fs.read(input.layer.path, { limit: 2_000_000 })).content;
  } catch {
    raw = ''; // 文件不存在 = 空层
  }
  const currentVersion = fingerprint(raw || '{}');
  if (input.expectedVersion && input.expectedVersion !== currentVersion) {
    return {
      status: 'version-conflict',
      currentVersion,
      message: '配置自上次读取后已被改动（可能是你手动改了，或另一个窗口在改）。请重新读取后再试——我不会覆盖它。',
    };
  }
  let obj: Record<string, unknown> = {};
  if (raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) obj = parsed as Record<string, unknown>;
      else return { status: 'error', message: '现有配置文件不是对象，拒绝写（先修好它）' };
    } catch (e) {
      // 坏 JSON：**不覆盖**（那是用户的文件），如实报错
      return { status: 'error', message: `现有配置文件不是合法 JSON（${String((e as Error).message).slice(0, 80)}），我没动它` };
    }
  }
  // ② 稀疏合并
  const next = input.value === undefined ? clearPath(obj, input.path) : deepMergeInto(obj, sparseOverlay(input.path, input.value));
  const content = `${JSON.stringify(next, null, 2)}\n`;
  try {
    await input.runtime.fs.writeAtomic(input.layer.path, content);
  } catch (e) {
    return { status: 'error', message: `写不进去：${String((e as Error).message).slice(0, 120)}` };
  }
  const version = fingerprint(content);
  // ④ 被更强的层压住？写入成了，但要说清谁压住了
  const stronger = (input.strongerLayers ?? []).filter((l) => l.hasPath).sort((a, b) => b.meta.precedence - a.meta.precedence)[0];
  if (stronger) {
    return {
      status: 'ok-overridden',
      version,
      overriddenBy: stronger.meta.name,
      message: `写进去了，但**「${stronger.meta.name}」里也设了这项，它优先级更高——实际生效的是它**（${stronger.meta.path}）。`,
    };
  }
  return { status: 'ok', version };
}

/** 读层 + 版本（面板要先读后写时用；返回内容与指纹） */
export async function readLayer(runtime: Runtime, layer: LayerMeta): Promise<{ content: string; version: string; value: Record<string, unknown> }> {
  let raw = '';
  try {
    raw = (await runtime.fs.read(layer.path, { limit: 2_000_000 })).content;
  } catch { /* 不存在 = 空 */ }
  let value: Record<string, unknown> = {};
  try {
    const p = JSON.parse(raw || '{}');
    if (p && typeof p === 'object' && !Array.isArray(p)) value = p as Record<string, unknown>;
  } catch { /* 坏 JSON：value 留空，写的时候会被拒绝 */ }
  return { content: raw, version: fingerprint(raw || '{}'), value };
}

/** 这一层里有没有某个点路径（"被谁压住"判定用） */
export function layerHasPath(value: Record<string, unknown>, path: string[]): boolean {
  let cur: unknown = value;
  for (const seg of path) {
    if (!cur || typeof cur !== 'object') return false;
    cur = (cur as Record<string, unknown>)[seg];
    if (cur === undefined) return false;
  }
  return true;
}
