// 配置加载：CLI 参数 > <cwd>/agent.json > ~/.agent/agent.json > 内置默认。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { Config } from './schema.js';
import { DEFAULT_CONFIG } from './schema.js';

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 深合并：b 覆盖 a（对象递归；数组与标量整体替换） */
export function deepMerge<T>(a: T, b: unknown): T {
  if (!isPlainObject(a) || !isPlainObject(b)) return (b === undefined ? a : (b as T));
  const out: Record<string, unknown> = { ...a };
  for (const [k, v] of Object.entries(b)) {
    out[k] = isPlainObject(v) && isPlainObject(out[k]) ? deepMerge(out[k], v) : v;
  }
  return out as T;
}

/** 展开 ~ 与相对路径（相对 home） */
export function expandPath(p: string, home: string): string {
  if (p === '~') return home;
  if (p.startsWith('~/')) return path.join(home, p.slice(2));
  return p;
}

/** 递归展开配置中所有目录类字段的 ~ */
export function expandConfigDirs(cfg: Config, home: string): Config {
  const out = structuredClone(cfg);
  for (const name of Object.keys(out.providers)) {
    const p = out.providers[name]!;
    if (p.baseUrl) p.baseUrl = expandPath(p.baseUrl, home);
  }
  out.skills.dirs = out.skills.dirs.map((d) => expandPath(d, home));
  out.agents.dirs = out.agents.dirs.map((d) => expandPath(d, home));
  const m = out.memory;
  m.autoDir = expandPath(m.autoDir, home);
  m.semanticDir = expandPath(m.semanticDir, home);
  m.episodesDir = expandPath(m.episodesDir, home);
  // Identity 层文件（漏掉这行的话 `~` 不会被展开 → 读到一个不存在的路径，
  // 而且**不报错**——规矩全都不生效）
  if (m.identityFile) m.identityFile = expandPath(m.identityFile, home);
  // 授权目录也要展开 `~` —— 与上面 identityFile 同一个坑：
  // 不展开**不报错**，只是永远比不中，看起来像"这功能没生效"
  if (out.permissions.workspaceDirs) {
    out.permissions.workspaceDirs = out.permissions.workspaceDirs.map((d) => expandPath(d, home));
  }
  out.sessions.dir = expandPath(out.sessions.dir, home);
  out.log.dir = expandPath(out.log.dir, home);
  return out;
}

/** 自治模式兜底校验：auto 必须同时设置 maxCost 与 maxIterations */
export function validateConfig(cfg: Config): string[] {
  const errs: string[] = [];
  const b = cfg.budget;
  if (!Number.isFinite(b.maxIterations) || b.maxIterations <= 0) errs.push('budget.maxIterations 必须为正整数');
  if (b.maxCost !== null && (!Number.isFinite(b.maxCost) || b.maxCost <= 0)) errs.push('budget.maxCost 必须为正数或 null');
  if (!Number.isFinite(b.maxContextTokens) || b.maxContextTokens <= 0) errs.push('budget.maxContextTokens 必须为正数');
  if (b.compactAtTokens >= b.maxContextTokens) errs.push('budget.compactAtTokens 必须小于 maxContextTokens');
  // 派活的四道闸（给了就得是正数；maxDepth 允许 1 起）
  const sa = (b as { subagent?: Record<string, unknown> }).subagent;
  if (sa) {
    if (sa.maxDepth !== undefined && (!Number.isFinite(sa.maxDepth) || Number(sa.maxDepth) < 1)) errs.push('budget.subagent.maxDepth 必须是 ≥1 的整数');
    for (const k of ['maxChildren', 'maxCost', 'maxRuntimeMs']) {
      const v = sa[k];
      if (v !== undefined && (!Number.isFinite(v) || Number(v) <= 0)) errs.push(`budget.subagent.${k} 必须为正数`);
    }
  }
  if (!cfg.providers[cfg.provider.default]) errs.push(`provider.default 指向不存在的 provider: ${cfg.provider.default}`);
  if (cfg.permissions.autonomy === 'auto' && (b.maxCost === null || b.maxIterations <= 0)) {
    errs.push('autonomy=auto 必须同时设置 budget.maxCost 与 budget.maxIterations 兜底');
  }
  return errs;
}

export interface LoadOptions {
  cli?: unknown;
  cwd?: string;
  home?: string;
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

/**
 * **配置文件里不再接受明文密钥**——providers.*.apiKey 一律从文件层剥掉
 * （密钥进 `<dataDir>/credentials.json`，见 runtime/credentials.mjs）。
 * 剥掉而不是报错：老配置文件不至于让 App 起不来，但会在返回值里说明被剥了什么。
 */
export function stripFileSecrets(layer: unknown, where: string): { layer: unknown; stripped: string[] } {
  if (!layer || typeof layer !== 'object') return { layer, stripped: [] };
  const l = structuredClone(layer) as Record<string, unknown>;
  const providers = l.providers as Record<string, Record<string, unknown>> | undefined;
  const stripped: string[] = [];
  if (providers && typeof providers === 'object') {
    for (const [name, cfg] of Object.entries(providers)) {
      if (cfg && typeof cfg === 'object' && 'apiKey' in cfg) {
        delete (cfg as Record<string, unknown>).apiKey;
        stripped.push(`${where}: providers.${name}.apiKey`);
      }
    }
  }
  return { layer: l, stripped };
}

/**
 * 四级加载：内置默认 < ~/.agent/agent.json < <cwd>/agent.json < cli。
 * **文件层里的密钥会被剥掉**（凭据只从凭据文件/环境变量来）；cli 层不剥（宿主程序注入）。
 * 校验失败抛错（附原因列表）。
 */
export function loadConfig(opts: LoadOptions = {}): Config {
  const cwd = opts.cwd ?? process.cwd();
  const home = opts.home ?? os.homedir();

  let cfg: Config = structuredClone(DEFAULT_CONFIG);
  const homeLayer = stripFileSecrets(readJson(path.join(home, '.agent', 'agent.json')), '~/.agent/agent.json');
  const cwdLayer = stripFileSecrets(readJson(path.join(cwd, 'agent.json')), 'agent.json');
  if (homeLayer.stripped.length || cwdLayer.stripped.length) {
    // 不抛错（老配置不该让 App 起不来），但要让调用方能看见：写进一个非致命警告字段
    (cfg as unknown as Record<string, unknown>).__strippedSecrets = [...homeLayer.stripped, ...cwdLayer.stripped];
  }
  cfg = deepMerge(cfg, homeLayer.layer);
  cfg = deepMerge(cfg, cwdLayer.layer);
  cfg = deepMerge(cfg, opts.cli);

  cfg = expandConfigDirs(cfg, home);
  const errs = validateConfig(cfg);
  if (errs.length > 0) throw new Error(`配置校验失败:\n- ${errs.join('\n- ')}`);
  return cfg;
}

/** agent init：写出内置默认配置（已存在则不动） */
export function initConfigFile(file: string): { created: boolean; file: string } {
  if (fs.existsSync(file)) return { created: false, file };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(DEFAULT_CONFIG, null, 2));
  return { created: true, file };
}
