// 提示词组装唯一出处（架构红线：禁止在其他模块拼接提示词）。
// buildFrozen 会话内只调用一次；此后每回合只改 messages（前缀冻结）。
// system = base.md 原文 + 项目记忆（≤4000 token）+ 语义记忆条目（≤topK 条、每条 ≤500 token）+ 技能索引。
import type { ToolDef } from '../llm/provider.js';
import type { Config } from '../config/schema.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { Runtime } from '../runtime/types.js';
import { BASE_PROMPT } from './base.js';
import { renderToolCatalog } from './tool-catalog.js';
import { languageName } from './language.js';
import { truncateToTokens } from './tokens.js';
import { CONTEXT_NOTE } from './banner.js';
import { emptyLayers, renderLayers, layerHashes, type PromptLayer, type PromptLayers } from './layers.js';

const PROJECT_MEMORY_MAX = 4000; // token
const SEMANTIC_ITEM_MAX = 500;   // token / 条

export interface AssembleContext {
  config: Config;
  registry: ToolRegistry;
  runtime: Runtime;
  /** 项目记忆原文（由宿主读入或注入；数字人 = 宪法渲染块） */
  projectMemory?: string;
  /** 语义记忆检索条目渲染文本（由 memory/recall.ts 提供；每条 ≤500 token） */
  semanticItems?: string[];
  /** Identity 层渲染文本（**用户定过的长期规矩**，一条一行；空 = 不加块） */
  identityItems?: string;
  /** 技能索引文本（由 skills/scan 提供） */
  skillsIndex?: string;
  /**
   * 时间锚点：**只在跨天时**由宿主给一行（"现在是 9 月 27 日凌晨 1 点；
   * 上次说话是 3 天前"）。**故意放在冻结前缀的最末尾**：它一变，被作废的缓存只有尾巴那一截。
   * 缺省（同一天 / 第一次对话）= 一个字都不加。
   */
  timeAnchor?: string;
  /** 分身名册：她能派哪些子代理 + 什么时候该派（渲染见 agents/scan.ts agentsIndexText） */
  agentsIndex?: string;
}

export interface Frozen {
  system: string;
  tools: ToolDef[];
  /** 分层指纹：哪一层变了，一眼看得出——同输入必同哈希 */
  layerHashes: Record<PromptLayer, string>;
}

/** base 模板变量替换：输出语言（国际化）。同一 locale 输出确定，不破坏前缀冻结不变量。 */
function renderBasePrompt(locale?: string): string {
  return BASE_PROMPT.replace('{{language}}', languageName(locale));
}

/** 组装冻结前缀。同一输入必须字节级稳定（缓存命中的前提）。
 *
 *  按四层装填（stable / context / selective / volatile）；拼接顺序是契约，
 *  见 `layers.ts` 的 LAYER_ORDER。同时给出 layerHashes（哪一层变了，说得清）。 */
export function buildFrozen(ctx: AssembleContext): Frozen {
  const layers: PromptLayers = emptyLayers();

  // ── Stable：身份与硬规则（基本不变）──
  layers.stable.push(renderBasePrompt(ctx.config.language));

  /* 注入内容的总说明挂在这儿——**只一句**，位置在 base 之后、所有注入块之前。
     没有它的时候，记忆块与工具目录看上去和系统指令一个分量（模型分不出"路标"与"规则"）。 */
  layers.stable.push(CONTEXT_NOTE);

  // ── Context：用户 / 项目 / 长期状态（变得少）──
  if (ctx.projectMemory) {
    const { text, truncated } = truncateToTokens(ctx.projectMemory, PROJECT_MEMORY_MAX);
    layers.context.push(
      '【项目记忆（AGENTS.md 等，长期上下文）】\n' +
      text +
      (truncated ? `\n…（项目记忆超过 ${PROJECT_MEMORY_MAX} token，已截断）` : ''),
    );
  }

  // Identity 层：**用户定过的规矩** —— 放在语义记忆之前，
  // 因为它管"以后怎么做事"，比"记得什么事实"更靠前（且只有用户明说的才会在这里）
  if (ctx.identityItems && ctx.identityItems.trim()) {
    layers.context.push(
      '【你给 TA 定过的长期规矩（Identity 层 —— 用户明说过的，长期有效，优先遵守）】\n' +
      ctx.identityItems.trim(),
    );
  }

  // ── Selective：按需挑的（相关记忆 / 技能 / 分身 / 能力目录）──
  if (ctx.semanticItems && ctx.semanticItems.length > 0) {
    const items = ctx.semanticItems
      .slice(0, ctx.config.memory.topK)
      .map((s) => truncateToTokens(s, SEMANTIC_ITEM_MAX).text);
    layers.selective.push('【语义记忆（长期事实/偏好/决策，可依赖；检索不到就说不记得）】\n' + items.map((s) => `- ${s}`).join('\n'));
  }

  if (ctx.skillsIndex) {
    layers.selective.push(ctx.skillsIndex);
  }

  if (ctx.agentsIndex) {
    layers.selective.push(ctx.agentsIndex);
  }

  // 能力自述目录（一句话 + 何时别用），带 token 预算。
  // 关掉的办法：config.tools.catalog = false（关掉后只靠 JSON schema）。
  if ((ctx.config.tools as { catalog?: boolean }).catalog !== false) {
    const catalog = renderToolCatalog(ctx.registry, ctx.config, ctx.runtime.capabilities as never, {
      contextWindow: ctx.config.budget.maxContextTokens,
    });
    if (catalog) layers.selective.push(catalog);
  }

  /* ── Volatile：会变的一块，放**最末尾** ──
     时间锚点——它是唯一"会变"的一块，
     放尾巴上，跨天时作废的缓存前缀最短。 */
  if (ctx.timeAnchor && String(ctx.timeAnchor).trim()) layers.volatile.push(String(ctx.timeAnchor).trim());

  return {
    system: renderLayers(layers),
    tools: ctx.registry.schemasFor(ctx.config, ctx.runtime.capabilities),
    layerHashes: layerHashes(layers, ctx.runtime.sha256),
  };
}
