// 大工具输出落盘。
//
// 为什么要它：我们现在只有"截断"——模型看到 `…（输出已截断 50KB）` 会以为**内容就这么多**，
// 于是反复重调同一个工具（最贵的失败模式之一）。落盘 = 内容一个字不丢，
// 只是从上下文里搬到了磁盘上，并明确告诉模型"别重调，去翻文件"。
//
// 出处（hermes）：
//   · `tools/tool_result_storage.py:166-181` `_build_persisted_message` —— <persisted-output> 块逐字模板
//     （大小 + 绝对路径 + 分页提示 + "do NOT re-request the same data…" + 换行边界预览）
//   · 同文件 `:149-154` `generate_preview` —— 按字符截、优先切在换行边界（且只在换行落在后半段时才用它）
//   · `tools/budget_config.py:13-15` —— `DEFAULT_RESULT_SIZE_CHARS = 100_000`、`DEFAULT_PREVIEW_SIZE_CHARS = 1_500`
//   · `tools/budget_config.py:10` —— `PINNED_THRESHOLDS = {"read_file": inf}`：
//     **read 永不落盘**，否则会"落盘 → read 读回来 → 又落盘"死循环
//
// 与它的三点不同（有意为之）：
//   ① 落点：它 `$HERMES_HOME/cache/spillover` + 24h 清理；我们放 `<logsDir>/tool-results/`。
//      清理**没做**——运行时（`runtime/types.ts` fs 端口）没有删除能力，硬删要么绕过端口、
//      要么把临时文件塞进系统回收站（更脏）。
//   ② 话术：它劝模型用 `execute_code` 处理落盘文件；我们没有这个工具，改成我们真有的 read 分页。
//   ③ 触发面：它对所有工具（除 pinned）生效；我们只对**成功**的输出落盘（失败信息本来就短，
//      再落一次盘等于给模型添一步）。

/** 触发落盘的字符数阈值（hermes `budget_config.py:13` 同值） */
export const PERSIST_THRESHOLD_CHARS = 100_000;
/** 预览长度（hermes `budget_config.py:15` 同值 1500 字符） */
export const PREVIEW_CHARS = 1_500;
/** 永不落盘的工具（hermes 把 read_file 钉成 inf，理由见文件头） */
export const PINNED_NO_PERSIST = new Set(['read']);

/** 按换行边界截预览（hermes `tool_result_storage.py:149-154`：换行落在后半段才用它，否则硬切） */
export function previewOf(content: string, max = PREVIEW_CHARS): { preview: string; hasMore: boolean } {
  if (content.length <= max) return { preview: content, hasMore: false };
  const nl = content.lastIndexOf('\n', max);
  return { preview: content.slice(0, nl > max / 2 ? nl + 1 : max), hasMore: true };
}

/** 落盘块（hermes `tool_result_storage.py:166-181` 的中文版；预览**嵌在同一个块里**，不是并列第二块） */
export function buildPersistedMessage(preview: string, hasMore: boolean, originalSize: number, filePath: string): string {
  const kb = originalSize / 1024;
  const sizeStr = kb >= 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${kb.toFixed(1)} KB`;
  return [
    '<persisted-output>',
    `这次工具输出太大了（${originalSize.toLocaleString('en-US')} 字符，${sizeStr}），整份原文已经存到磁盘上。`,
    `完整内容在：${filePath}`,
    '要看哪一段，用 read 工具带 offset/limit 翻页（这个文件也是带行号的）。',
    '**别为了同一份数据把工具再调一遍**——完整结果已经在磁盘上了，重调一遍又慢又费钱。',
    '',
    `预览（前 ${preview.length} 字符）：`,
    preview + (hasMore ? '\n...' : ''),
    '</persisted-output>',
  ].join('\n');
}

function safeName(s: string): string {
  return String(s ?? '').replace(/[^A-Za-z0-9_.-]+/g, '_').slice(0, 80) || 'out';
}

/**
 * 超阈值就落盘，返回**替换后的输出文本**；没超阈值 / 落盘失败 → 返回 null（调用方保持原样）。
 * 需要 io 能力时从 runtime 端口拿（runtime 端口的 write 会自动建父目录）。
 */
export async function maybePersistOutput(
  runtime: { fs: { write(path: string, content: string): Promise<void> }; storage: { logsDir(): string } },
  opts: { id: string; tool: string; output: string },
): Promise<string | null> {
  const { output } = opts;
  if (output.length <= PERSIST_THRESHOLD_CHARS) return null;
  if (PINNED_NO_PERSIST.has(opts.tool)) return null;
  const { preview, hasMore } = previewOf(output);
  try {
    const file = `${runtime.storage.logsDir()}/tool-results/${safeName(opts.tool)}-${safeName(opts.id)}-${Date.now().toString(36)}.txt`;
    await runtime.fs.write(file, output);
    return buildPersistedMessage(preview, hasMore, output.length, file);
  } catch {
    // 落盘失败不改变工具结果本身（调用方仍按原样拿到输出，截断标记由调用方自己决定）
    return null;
  }
}
