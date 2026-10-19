// 二进制/文档类文件的"纯文本写回"护栏（出处 hermes `file_tools_write_guards.py:372`）。
//
// **这是最容易被忽略、但后果最严重的一条**：`read` / `office inspect` 给模型看的是**抽出来的文字**，
// 模型很自然会以为"我掌握了文件内容"，然后 `write` 把编辑后的文本写回去——
// 而纯文本永远生成不了合法的 OOXML/OLE/PDF 容器，**结果是文档被静默摧毁**（打开时报损坏）。
//
// 所以：可提取文档一律拒绝纯文本写入 + **教学式错误**（告诉它该走哪条路），
// 而不是让它写进去、让用户打开时才发现文件废了。

/** 二进制文档（要改必须走 office 工具） */
export const OPAQUE_DOC_EXT = new Set([
  'docx', 'docm', 'doc', 'dot', 'dotx',
  'xlsx', 'xlsm', 'xlsb', 'xls', 'xlt',
  'pptx', 'pptm', 'ppt', 'pps',
  'pdf', 'odt', 'ods', 'odp', 'rtf', 'epub',
  'pages', 'numbers', 'key', // macOS iWork（同样是容器格式）
]);

/** 其它二进制（图片/音视频/压缩包）——写文本进去只会毁掉它 */
export const OPAQUE_MEDIA_EXT = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'tif', 'tiff', 'heic', 'ico',
  'mp3', 'wav', 'm4a', 'aac', 'flac', 'mp4', 'mov', 'avi', 'mkv', 'webm',
  'zip', 'gz', 'tgz', 'tar', '7z', 'rar', 'dmg', 'pkg', 'exe', 'dll', 'so', 'dylib',
  'sqlite', 'db', 'woff', 'woff2', 'ttf', 'otf', 'icns',
]);

function extOf(file: string): string {
  const m = /\.([A-Za-z0-9]+)$/.exec(String(file ?? '').trim());
  return m ? m[1]!.toLowerCase() : '';
}

/**
 * 该不该拒绝"用纯文本工具写这个文件"？返回拒绝理由（null = 放行）。
 * 教学式措辞：说清「你看到的是抽出来的文字，不是文件本身」+「该走哪条路」。
 */
export function refuseTextWrite(file: string): string | null {
  const ext = extOf(file);
  if (OPAQUE_DOC_EXT.has(ext)) {
    const how = ['docx', 'docm', 'doc'].includes(ext) ? 'Word'
      : ['xlsx', 'xlsm', 'xlsb', 'xls', 'xlt'].includes(ext) ? 'Excel'
        : ['pptx', 'pptm', 'ppt', 'pps'].includes(ext) ? 'PPT'
          : ext === 'pdf' ? 'PDF' : '这份文档';
    return `${file} 是 ${how} 这类**二进制文档**——你看到的是**从里面抽出来的文字**，不是文件本身；` +
      `直接把文字写回去会把文档结构毁掉（打开就成损坏文件了）。要改它请用 **office 工具**（会另存为新文件、原件不动）。`;
  }
  if (OPAQUE_MEDIA_EXT.has(ext)) {
    return `${file} 是二进制文件（.${ext}）——纯文本工具写进去只会毁掉它，我不会这么干。`;
  }
  return null;
}

/**
 * 检测"把 read 的显示文本原样写回"（hermes `_is_internal_file_tool_content`）：
 * read 的输出是 `行号\t内容`——模型有时会把这坨显示文本当文件内容写回去，等于给文件插满行号。
 * ≥60% 的行是连续编号行 → 判定为显示文本。
 */
export function looksLikeNumberedDisplay(content: string): boolean {
  const lines = String(content ?? '').split('\n').filter((l) => l.trim() !== '');
  if (lines.length < 5) return false;
  let numbered = 0;
  let expected = -1;
  for (const l of lines) {
    const m = /^(\d+)\t/.exec(l);
    if (!m) continue;
    const n = Number(m[1]);
    if (expected === -1 || n === expected) numbered++;
    expected = n + 1;
  }
  return numbered / lines.length >= 0.6;
}

/** 读的时候给一句指路（read 读到二进制文档时，别让模型对着乱码猜） */
export function opaqueReadHint(file: string): string | null {
  const ext = extOf(file);
  if (OPAQUE_DOC_EXT.has(ext)) {
    return `（这是二进制文档，直接读会得到乱码——要看内容请用 **office 工具 action=inspect**；要改请用 office 工具，它会另存新文件）`;
  }
  if (OPAQUE_MEDIA_EXT.has(ext)) return `（二进制文件，内容不是文字——看不了，也不要用 write 去写它）`;
  return null;
}
