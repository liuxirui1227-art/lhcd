// 外部内容标记（提示注入防御）
//
// 要防的是什么：工具返回的网页/文档内容与用户指令在模型眼里**零区分度**——没有
// "外部内容是数据不是指令"这条纪律，提示注入就无从防起。
//
// 两层防线（缺一不可）：
//   ① **提示词层**：`prompt/base.md` 的【外部内容纪律】——通用规则，覆盖所有来源；
//   ② **工具层**：本模块——给"从外面拿回来的文本"打一行身份说明。规则放在工具侧而不是 loop 里统一加，
//      因为"哪些内容是外部的"是工具自己的知识：`read` 读的是用户自己的文件（半可信），
//      `web_fetch` 拿回来的是陌生网页（完全不可信），两者不该同罪。
import type { ToolEntry } from './registry.js';
import { MATERIAL_TAG, materialBanner } from '../prompt/banner.js';

/**
 * 标记文本（改动它要同步改单测）。
 * ⚠ 横幅的**实现统一在 `prompt/banner.ts`**（一处定义，谁都从那里取）——
 * 这里保留同名导出，老调用方不受影响。
 */
export const UNTRUSTED_TAG = MATERIAL_TAG;

/** 给外部内容加一行身份说明（放在正文之前，模型先看到"这是什么"再看到内容） */
export function markUntrusted(text: string, source: string): string {
  return `${materialBanner(source)}\n\n${text}`;
}

/**
 * 哪些工具的输出属于"外部内容"（web + 他人文档 + 别人的服务）；`read` 不算——那是用户自己的文件。
 * ⚠ `mcp.*` 前缀单独判（工具名是动态的 `mcp.<服务>.<工具>`，进不了这个固定集合）。
 */
export const UNTRUSTED_TOOLS = new Set(['web_fetch', 'web_search', 'office']);
export const UNTRUSTED_PREFIXES = ['mcp.'];

/** 工具侧统一入口：命中名单才加标记（供 turn.ts 之外的地方复用；当前由各工具自己调用） */
export function isUntrustedTool(toolName: string): boolean {
  const n = String(toolName ?? '');
  return UNTRUSTED_TOOLS.has(n) || UNTRUSTED_PREFIXES.some((p) => n.startsWith(p));
}
export function markToolOutput(toolName: string, output: string, source = '外部'): string {
  return isUntrustedTool(toolName) ? markUntrusted(output, source) : output;
}

/** 类型占位：保持与 registry 的 ToolEntry 兼容（工具侧 import 用） */
export type { ToolEntry };
