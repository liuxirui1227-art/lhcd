// Prompt 分层
//
// 为什么要分层：层与层的边界若只靠"push 的先后顺序"隐式维持，谁插错一行没人拦得住；
// 而且没有层指纹时，缓存作废查不出"是哪一层变了"（配置指纹 configHash 见 `session/store.ts:38`）。
//
// 四层的拼接顺序是契约，渲染结果由它决定（`assemble.test.ts` 的"两次构建逐字节相等"守着）：
//   stable    身份 / 安全规则 / 工具行为规则 / 核心能力说明 —— 基本不变
//   context   用户 / 项目 / 任务 / 会话 / 长期状态 —— 变得少
//   selective 相关记忆 / 技能索引 —— 按需挑
//   volatile  临时状态（时间锚点等）—— 会变，放最末尾
//
// 纪律：**稳定前缀尽可能稳定，高变化信息尽可能靠后**（为了缓存、上下文重建、debug、会话恢复）。
// 所以 LAYER_ORDER 是契约的一部分，改它等于改缓存行为。

import type { Runtime } from '../runtime/types.js';

/** 四个层名（顺序即拼接顺序，见 LAYER_ORDER） */
export type PromptLayer = 'stable' | 'context' | 'selective' | 'volatile';

/** 拼接顺序：stable → context → selective → volatile（**契约**，不是随便排的） */
export const LAYER_ORDER: readonly PromptLayer[] = ['stable', 'context', 'selective', 'volatile'];

/** 分层容器：每层若干文本块（块内已含自己的标题行） */
export interface PromptLayers {
  stable: string[];
  context: string[];
  selective: string[];
  volatile: string[];
}

export function emptyLayers(): PromptLayers {
  return { stable: [], context: [], selective: [], volatile: [] };
}

/** 把各层非空块按 LAYER_ORDER 顺序拼成 system 原文（块间用空行分隔） */
export function renderLayers(layers: PromptLayers): string {
  const parts: string[] = [];
  for (const name of LAYER_ORDER) {
    for (const block of layers[name]) {
      if (block && block.length > 0) parts.push(block);
    }
  }
  return parts.join('\n\n');
}

/** 每一层的渲染文本（调试/指纹用；空层返回空串） */
export function renderLayerText(layers: PromptLayers, name: PromptLayer): string {
  return layers[name].filter((b) => b && b.length > 0).join('\n\n');
}

/**
 * 层指纹：每层一段哈希。用途：
 *   ① 证明"稳定前缀真的稳定"（同输入 → 同哈希，可直接写测试）；
 *   ② 缓存作废时说得清"哪一层变了"（配 `cache.broken` 事件，`session/events.ts:52`）；
 *   ③ 排障时不用肉眼 diff 上千字。
 * 口径与 `session/store.ts:38` 的 configHash 一致（都用 runtime.sha256）。
 */
export function layerHashes(layers: PromptLayers, sha256: Runtime['sha256']): Record<PromptLayer, string> {
  const out = {} as Record<PromptLayer, string>;
  for (const name of LAYER_ORDER) out[name] = sha256(renderLayerText(layers, name));
  return out;
}
