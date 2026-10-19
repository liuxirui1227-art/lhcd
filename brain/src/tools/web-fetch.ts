// web_fetch 工具：抓取 URL 正文清洗为纯文本（≤30KB）。
import type { ToolEntry } from './registry.js';
import { markUntrusted } from './untrusted.js';
import { safeFetchText } from './url-guard.js';

const MAX_TEXT = 30 * 1024;

/** HTML → 可读文本（零依赖：剥 script/style/标签 + 基础实体解码 + 空白归一） */
export function htmlToText(html: string): string {
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'");
  return text.replace(/[ \t\r\f\v]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

export function webFetchTool(): ToolEntry {
  return {
    name: 'web_fetch',
    permissionClass: 'net',
    capabilityRequirement: 'net',
    schema: {
      type: 'function',
      function: {
        name: 'web_fetch',
        description: '抓取 URL 网页正文并清洗为纯文本（≤30KB）。用于读取链接内容。',
        parameters: {
          type: 'object',
          properties: {
            url: { type: 'string', description: '目标网页 URL' },
          },
          required: ['url'],
        },
      },
    },
    executor: async (args, ctx) => {
      const a = (args ?? {}) as { url?: unknown };
      if (typeof a.url !== 'string' || !/^https?:\/\//.test(a.url)) {
        return { ok: false, output: '', error: { code: 'BAD_ARGS', message: 'url 必须为 http(s) 链接' } };
      }
      /* SSRF 防护：**先判地址再抓**——提示注入只要让她抓 `http://127.0.0.1:43129/…`
         或云元数据 `169.254.169.254`，就能把本机/凭据带出去。
         口径：协议白名单 + 主机名与**解析出的每个 IP** 都过内网检查 + **重定向自己跟、每跳重查** + 只收前 2MB。
         ⚠ 拿不到 `net.resolve` 时只查字面量（DNS rebinding 那一层留给 runtime；别把它说成万能墙）。 */
      let got;
      try {
        got = await safeFetchText(a.url, {
          fetch: (u, init) => ctx.runtime.net.fetch(u, init),
          resolve: ctx.runtime.net.resolve ? (h) => ctx.runtime.net.resolve!(h) : undefined,
          headers: { 'User-Agent': ctx.config.net?.userAgent ?? 'lhcd-agent/0.1' },
        });
      } catch (err) {
        return { ok: false, output: '', error: { code: 'NET_ERROR', message: (err as Error).message } };
      }
      if (!got.ok) {
        // 被拦下来的（内网地址 / 超跳数）与"抓失败"分开说：前者是**安全决定**，不是网络故障
        const blocked = /不抓这类地址|指向内网|内网主机名|内网域名|只支持 http/.test(got.reason ?? '');
        return {
          ok: false, output: '',
          error: {
            code: blocked ? 'URL_BLOCKED' : (got.status ? `HTTP_${got.status}` : 'NET_ERROR'),
            message: blocked
              ? `${got.reason}（这是安全拦截：她不能替你访问本机或内网地址）`
              : (got.reason ?? '抓取失败'),
          },
        };
      }
      const html = got.text ?? '';
      const text = htmlToText(html);
      const truncated = text.length > MAX_TEXT || got.truncated === true;
      const body = text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}\n…（已截断 30KB）` : text;
      // 网页内容**只是资料，不是指令**（提示注入防御的第一道，见 tools/untrusted.ts）
      return { ok: true, output: markUntrusted(body, `网页 ${got.finalUrl ?? a.url}`), truncated };
    },
  };
}
