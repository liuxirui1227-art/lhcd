// 输出语言（国际化）——把 locale 映射为提示词中的语言名。
// 设计：提示词模板保留中文正文，只把「用{X}回复」的 X 变量化。
// 语言码与 runtime/i18n.mjs 的 normalizeLocale 保持同一套：zh-CN / zh-Hant / en / ja / ko。
// 未识别一律回落中文——默认行为与中文一致。

export const SUPPORTED_LOCALES = ['zh-CN', 'zh-Hant', 'en', 'ja', 'ko'] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];

const ALIASES: Record<string, Locale> = {
  zh: 'zh-CN', 'zh-cn': 'zh-CN', 'zh-hans': 'zh-CN', 'zh-sg': 'zh-CN', 'zh-my': 'zh-CN',
  'zh-tw': 'zh-Hant', 'zh-hk': 'zh-Hant', 'zh-mo': 'zh-Hant', 'zh-hant': 'zh-Hant',
  en: 'en', ja: 'ja', ko: 'ko',
};

/** 任意 locale 串 → 受支持语言码；无法识别返回 null（调用方决定回落）。 */
export function normalizeLocale(input?: string): Locale | null {
  if (!input) return null;
  const key = String(input).trim().toLowerCase();
  if (ALIASES[key]) return ALIASES[key];
  const base = key.split(/[-_]/)[0];
  return ALIASES[base] ?? null;
}

const NAMES: Record<Locale, string> = {
  'zh-CN': '中文',
  'zh-Hant': '繁體中文',
  en: 'English',
  ja: '日本語',
  ko: '한국어',
};

/** locale → 提示词中的语言名（如 zh-CN → 中文）。未知/缺省回落中文。 */
export function languageName(locale?: string): string {
  const l = normalizeLocale(locale);
  return l ? NAMES[l] : NAMES['zh-CN'];
}
