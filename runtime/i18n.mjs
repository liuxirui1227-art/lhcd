// 国际化（i18n）骨架。
// 纪律：新增的用户可见文案一律走 t('key')，中文原文进 locales/zh-CN.json。
// 全量存量提取（≈1260 条）在正式出多语言版本时批量做。
// 纯模块（不依赖 Electron），可被 GUI / 无头测试共用；语言码与 brain/src/prompt/language.ts 同一套。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOCALES_DIR = path.join(__dirname, 'locales');

export const SUPPORTED = ['zh-CN', 'zh-Hant', 'en', 'ja', 'ko'];
export const FALLBACK = 'zh-CN';

const ALIASES = {
  zh: 'zh-CN', 'zh-cn': 'zh-CN', 'zh-hans': 'zh-CN', 'zh-sg': 'zh-CN', 'zh-my': 'zh-CN',
  'zh-tw': 'zh-Hant', 'zh-hk': 'zh-Hant', 'zh-mo': 'zh-Hant', 'zh-hant': 'zh-Hant',
  en: 'en', ja: 'ja', ko: 'ko',
};

/** 任意 locale 串 → 受支持语言码；无法识别返回 null（调用方决定回落）。 */
export function normalizeLocale(input) {
  if (!input) return null;
  const key = String(input).trim().toLowerCase();
  if (ALIASES[key]) return ALIASES[key];
  const base = key.split(/[-_]/)[0];
  return ALIASES[base] ?? null;
}

/** 读语言资源文件；不存在/损坏返回 null（由调用方回落 zh-CN）。 */
export function loadDict(locale) {
  try {
    return JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, `${locale}.json`), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * 构造 t(key, params)：目标语言 → zh-CN 兜底 → 原样返回 key（缺 key 可见、可测）。
 * params 形如 { name: 'X' }，模板里写 {name}。
 */
export function makeT(dict, fallbackDict) {
  return function t(key, params) {
    const raw = dict?.[key] ?? fallbackDict?.[key];
    if (raw === undefined) return key;
    const s = String(raw);
    if (!params) return s;
    return s.replace(/\{(\w+)\}/g, (m, k) => (k in params ? String(params[k]) : m));
  };
}
