// 能力自述 + 目录预算。
//
// 预算常量与裁剪规则的出处（外部项目源码）：
//   · pi `coding-agent/src/core/extensions/types.ts:451-500`：`description`（给模型）/ `label`（给人看）/
//     **`promptSnippet`**（"Optional one-line snippet for the Available tools section … **Custom tools are omitted
//     from that section when this is not provided**"）/ `promptGuidelines`（"appended … **when this tool is active**"）/
//     `executionMode: "sequential" | "parallel"`
//   · pi `core/system-prompt.ts:82-95`：目录由 snippet 拼、guidelines 去重后追加
//   · codex `ext/skills/src/render.rs:17-24` 的预算常量：默认 **上下文窗口 × 2%**；配置显式设值时夹到 **10_000 token**；
//     拿不到上下文窗口 → **8_000 字符**兜底；裁剪按**作用域优先级**（System > Admin > Repo > User > None）
//   · codex `MAX_CATALOG_SKILL_DESCRIPTION_CHARS = 1_024`（单条描述上限）
//
// 为什么值得做：工具多了（现在 20+）之后，光靠 JSON schema 让模型"自己悟"哪个该用、哪个千万别用，
// 会乱调（拿 write 去写 .docx 这种）。一句话的目录 + "何时别用"是性价比最高的一层路由信息。

import type { ToolRegistry, ToolEntry } from '../tools/registry.js';

/** 单条描述上限（出处 codex `MAX_CATALOG_SKILL_DESCRIPTION_CHARS = 1_024`，我们按字符同样处理） */
export const MAX_CATALOG_LINE_CHARS = 1024;
/** 显式配置时的 token 夹取上限（出处 codex `MAX_CONFIGURED_SKILL_METADATA_TOKEN_BUDGET = 10_000`） */
export const MAX_CONFIGURED_CATALOG_TOKENS = 10_000;
/** 拿不到上下文窗口时的字符兜底（出处 codex `DEFAULT_SKILL_METADATA_CHAR_BUDGET = 8_000`） */
export const UNKNOWN_WINDOW_CHAR_BUDGET = 8_000;
/** 默认预算 = 上下文窗口的 2%（出处 codex `SKILL_METADATA_CONTEXT_WINDOW_PERCENT = 2`） */
export const CATALOG_CONTEXT_PERCENT = 2;

export interface CatalogEntry {
  name: string;
  /** 给模型的一句话（没写就用描述首句） */
  blurb: string;
  /** 什么时候**别**用（歧义消解的关键） */
  whenNotToUse?: string;
  guidelines?: string[];
  /** 优先级（越小越先保留；内置核心工具 0，宿主注册 10，外部/MCP 20） */
  priority: number;
}

/** 工具名 → 目录条目（没列到的工具用 description 首句兜底） */
export const TOOL_CATALOG: Record<string, Omit<CatalogEntry, 'name'>> = {
  bash: { blurb: '跑命令行（查状态、构建、跑测试）。删除类命令会被拦下来（改走 delete 工具）。', whenNotToUse: '别拿它删文件、别拿它改 .docx/.xlsx/.pdf 这类二进制文档', priority: 0 },
  read: { blurb: '读文本文件（带行号分页）。', whenNotToUse: 'Word/Excel/PPT/PDF 用 office 工具看，别用 read（会读到乱码）', priority: 0 },
  write: { blurb: '整文件写入（新建或整体替换）。', whenNotToUse: '二进制文档禁止纯文本写回（会毁文件）；局部改动用 edit 更稳', priority: 0 },
  edit: { blurb: '改文件局部：给旧文字→新文字（唯一匹配）或按行号区间替换。', whenNotToUse: '二进制文档用 office 工具改', priority: 0 },
  grep: { blurb: '按内容搜文件。', priority: 0 },
  glob: { blurb: '按文件名/路径找文件。', priority: 0 },
  remember: { blurb: '把值得长期记住的事写进记忆（偏好/事实/承诺）。', priority: 0 },
  recall: { blurb: '检索记忆（"上次那个…"就用它）。', priority: 0 },
  forget: { blurb: '删掉一条记错的记忆。', priority: 0 },
  session_search: { blurb: '翻历史原文（压缩过的旧对话在这里能找回来）。', priority: 0 },
  load_skill: { blurb: '加载一份技能说明书（操作步骤/领域知识）。', priority: 0 },
  web_search: { blurb: '联网搜索。', priority: 0 },
  web_fetch: { blurb: '抓一个网页的正文。', priority: 0 },
  app: { blurb: '操作本机应用（打开/激活/剪贴板/通知）。', priority: 0 },
  office: { blurb: 'Word/Excel/PPT/PDF 的看与改（改一律另存新文件，原件不动）。', whenNotToUse: '纯文本文件（md/txt/json/csv）用 read/write/edit 就行，不必走它', priority: 10 },
  delete: { blurb: '删文件/文件夹（进系统回收站，可撤回）。', whenNotToUse: 'rm 命令会被拦；删东西一律走这里', priority: 10 },
  media: { blurb: '图片/视频：合并、截取、转格式、压缩、缩放、裁剪、旋转、加水印、拼图、抽帧、转 GIF、抽音轨。改一律另存新文件。', whenNotToUse: '改 Word/Excel/PPT/PDF 用 office 工具；改纯文本用 edit', priority: 10 },
  task: { blurb: '长活记账本：交代了"没弄完别停"的事记在这，跨重启继续。', priority: 10 },
  schedule: { blurb: '定时提醒/定时任务（关掉软件也算数）。', whenNotToUse: '一次性的"现在做"不要建任务，直接做', priority: 10 },
  plan_task: { blurb: '把复杂目标拆成步骤再逐个做（步骤多、有依赖时用）。', whenNotToUse: '一句话能答完的事不要拆', priority: 10 },
  run_agent: { blurb: '派一个分身去独立干一件子任务。', whenNotToUse: '缺上下文的小事自己做更快', priority: 10 },
  install_skill: { blurb: '安装技能（从仓库/直链）。', priority: 20 },
  save_skill: { blurb: '把这次学到的方法沉淀成技能。', priority: 20 },
  install_mcp: { blurb: '接一个外部工具服务（MCP）。', priority: 20 },
};

/** 预算（token）→ 字符（宽松按 4 字符/token 估，与 codex 的 APPROX_BYTES_PER_TOKEN 同源） */
export function catalogBudgetChars(opts: { contextWindow?: number; configuredTokens?: number }): { chars: number; why: string } {
  if (opts.configuredTokens && opts.configuredTokens > 0) {
    const clamped = Math.min(opts.configuredTokens, MAX_CONFIGURED_CATALOG_TOKENS);
    return { chars: clamped * 4, why: `显式配置 ${opts.configuredTokens} token（夹取上限 ${MAX_CONFIGURED_CATALOG_TOKENS}）` };
  }
  if (opts.contextWindow && opts.contextWindow > 0) {
    return { chars: Math.floor((opts.contextWindow * CATALOG_CONTEXT_PERCENT) / 100) * 4, why: `上下文窗口的 ${CATALOG_CONTEXT_PERCENT}%` };
  }
  return { chars: UNKNOWN_WINDOW_CHAR_BUDGET, why: '不知道窗口大小 → 字符兜底' };
}

/** 一条渲染成一行 */
export function renderCatalogLine(e: CatalogEntry): string {
  const parts = [`- ${e.name}: ${e.blurb}`];
  if (e.whenNotToUse) parts.push(`（别用：${e.whenNotToUse}）`);
  return parts.join('').slice(0, MAX_CATALOG_LINE_CHARS);
}

/**
 * 从注册表渲染目录（按优先级排序，超预算就**先丢低优先级**，并在结尾说明丢了多少）。
 * 出处 codex render.rs:48-67 的裁剪顺序（作用域优先），我们映射成 priority 数字。
 */
export function renderToolCatalog(registry: ToolRegistry, config: { tools: { enabled: string[] } }, caps: Record<string, boolean>, opts: { contextWindow?: number; configuredTokens?: number } = {}): string {
  const enabled = registry.listEnabled(config as never, caps as never);
  const entries: CatalogEntry[] = [];
  for (const e of enabled) {
    const known = TOOL_CATALOG[e.name];
    if (known) entries.push({ name: e.name, ...known });
    else {
      const desc = String(e.schema?.function?.description ?? '').split(/[。；\n]/)[0] ?? '';
      entries.push({ name: e.name, blurb: desc.slice(0, 120), priority: 20 });
    }
  }
  entries.sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name));

  const { chars: budget, why } = catalogBudgetChars(opts);
  const lines: string[] = [];
  let used = 0;
  let dropped = 0;
  for (const e of entries) {
    const line = renderCatalogLine(e);
    if (used + line.length + 1 > budget) { dropped++; continue; }
    lines.push(line);
    used += line.length + 1;
  }
  const head = '【手上有什么本事】（一句话目录；具体参数看工具定义）';
  const tail = dropped > 0 ? `\n…（还有 ${dropped} 个不常用的没列出来，需要时它们照样可调用；目录预算：${why}）` : '';
  return `${head}\n${lines.join('\n')}${tail}`;
}

/** 激活的工具才追加的守则（出处 pi `promptGuidelines` 的"when this tool is active"语义） */
export function activeGuidelines(registry: ToolRegistry): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const e of registry.all() as ToolEntry[]) {
    for (const g of TOOL_CATALOG[e.name]?.guidelines ?? []) {
      if (!seen.has(g)) { seen.add(g); out.push(g); }
    }
  }
  return out;
}
