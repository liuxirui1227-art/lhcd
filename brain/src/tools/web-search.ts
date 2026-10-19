// web_search 工具：搜索返回标题/摘要/URL（≤8 条）。
// 后端链（全部零 key，依次降级）：DuckDuckGo HTML → DDG lite → Mojeek；单后端 8s 超时；
// 全部失败/零命中 → 明确话术「没搜到，不代表不存在」，防止模型误判「查无此事」。
import type { ToolEntry } from './registry.js';
import { markUntrusted } from './untrusted.js';

export interface SearchHit {
  title: string;
  snippet: string;
  url: string;
}

/** DDG HTML 结果解析（result__a / result__snippet / uddg 重定向剥离） */
export function parseSearchResults(html: string, max: number): SearchHit[] {
  const out: SearchHit[] = [];
  const re = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?class="result__snippet"[^>]*>([\s\S]*?)<\//g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null && out.length < max) {
    const url = decodeURIComponent(stripWrapping(m[1]!));
    const title = stripTags(m[2]!).trim();
    const snippet = stripTags(m[3]!).trim();
    if (title) out.push({ title, snippet, url });
  }
  return out;
}

/** DDG lite 结果解析（result-link / result-snippet；真实页面 href 在 class 之前） */
export function parseLiteResults(html: string, max: number): SearchHit[] {
  const out: SearchHit[] = [];
  const re = /<a[^>]*href=['"]([^'"]+)['"][^>]*class=['"]result-link['"][^>]*>([\s\S]*?)<\/a>[\s\S]*?class=['"]result-snippet['"][^>]*>([\s\S]*?)<\//g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null && out.length < max) {
    const title = stripTags(m[2]!).trim();
    const snippet = stripTags(m[3]!).trim();
    if (title) out.push({ title, snippet, url: m[1]! });
  }
  return out;
}

/** Mojeek 结果解析（h2>a.ob + p.s） */
export function parseMojeekResults(html: string, max: number): SearchHit[] {
  const out: SearchHit[] = [];
  const re = /<h2>\s*<a[^>]*href=['"]([^'"]+)['"][^>]*>([\s\S]*?)<\/a>\s*<\/h2>[\s\S]*?<p class=['"]s['"]>([\s\S]*?)<\/p>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null && out.length < max) {
    const title = stripTags(m[2]!).trim();
    const snippet = stripTags(m[3]!).trim();
    if (title) out.push({ title, snippet, url: m[1]! });
  }
  return out;
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, ' ').replace(/&amp;/gi, '&').replace(/\s+/g, ' ').trim();
}

function stripWrapping(url: string): string {
  const m = url.match(/uddg=([^&]+)/);
  return m ? m[1]! : url;
}

/** 单后端定义：构造 URL + 对应解析器 */
interface Backend {
  buildUrl: (q: string) => string;
  parse: (html: string, max: number) => SearchHit[];
}

/** 超时 signal（AbortSignal.timeout 不支持的环境无超时兜底） */
function timeoutSignal(ms: number): AbortSignal | undefined {
  try {
    return AbortSignal.timeout(ms);
  } catch {
    return undefined;
  }
}

/** 空结果/全失败的统一话术（诚实，不暗示「确实没有」） */
export const SEARCH_EMPTY_TEXT = '（搜索没得到结果——搜索引擎可能暂时不可用或改版。没搜到不代表不存在，可换个关键词或稍后再试。）';

export function webSearchTool(): ToolEntry {
  return {
    name: 'web_search',
    permissionClass: 'net',
    capabilityRequirement: 'net',
    schema: {
      type: 'function',
      function: {
        name: 'web_search',
        description: '搜索网络，返回标题/摘要/URL（最多 8 条）。用于查实时信息、事实核验。',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '搜索关键词' },
            max: { type: 'number', description: '最多返回条数（默认 8）' },
          },
          required: ['query'],
        },
      },
    },
    executor: async (args, ctx) => {
      const a = (args ?? {}) as { query?: unknown; max?: unknown };
      if (typeof a.query !== 'string' || !a.query.trim()) {
        return { ok: false, output: '', error: { code: 'BAD_ARGS', message: 'query 必填' } };
      }
      const max = typeof a.max === 'number' && a.max >= 1 ? Math.floor(a.max) : 8;
      const ua = ctx.config.net?.userAgent ?? 'lhcd-agent/0.1';
      const base = ctx.config.net?.searchBase ?? 'https://html.duckduckgo.com/html';
      // 后端链：主源 → lite 备胎 → Mojeek 备胎；任一命中即返回
      const backends: Backend[] = [
        { buildUrl: (q) => `${base}/?q=${encodeURIComponent(q)}`, parse: parseSearchResults },
        { buildUrl: (q) => `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(q)}`, parse: parseLiteResults },
        { buildUrl: (q) => `https://www.mojeek.com/search?q=${encodeURIComponent(q)}`, parse: parseMojeekResults },
      ];
      for (const be of backends) {
        const signal = timeoutSignal(8000);
        let res;
        try {
          res = await ctx.runtime.net.fetch(be.buildUrl(a.query), {
            headers: { 'User-Agent': ua },
            ...(signal ? { signal } : {}),
          });
        } catch {
          continue; // 网络错误/超时 → 下一个后端
        }
        if (!res.ok) continue;
        const hits = be.parse(await res.text(), max);
        if (hits.length === 0) continue; // 页面改版解析 0 条 → 下一个后端
        return {
          ok: true,
          // 搜索结果同样是"外部内容"（标题/摘要可能是别人写的诱导话术）
          output: markUntrusted(hits.map((h) => `- ${h.title}\n  ${h.snippet}\n  ${h.url}`).join('\n'), '网络搜索'),
        };
      }
      return { ok: true, output: SEARCH_EMPTY_TEXT };
    },
  };
}
