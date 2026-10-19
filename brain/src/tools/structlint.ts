// 结构性解析自检（JSON/YAML/frontmatter 要能解析）——**纯本地、零成本**，不调外部 linter。
//
// 每个问题配一个**稳定的 key**：收尾自检要拿"改前的问题集合"和
// "改后的问题集合"求差，比消息文本可靠——`JSON.parse` 的报错里带 `position 123`，
// 文件一改位置就飘，会把老问题当成新问题报出来。
//
// 两点有意为之的口径：用"key 集合差"而不是"行集合差"；既有问题**静默不报**——
// 收尾自检是"回插一轮让模型重做"，拿老毛病去触发重做 = 白烧一轮，还会给模型"这文件本来就烂"的错觉。
// 历史噪音照旧留在文件里。

export interface StructuralProblem {
  /** 稳定标识：只由"哪类毛病"决定，不含行号/位置/动态消息 */
  key: string;
  /** 给模型/用户看的人话 */
  message: string;
}

/** 结构性毛病扫描（三类：JSON 不合法 / frontmatter 没闭合 / YAML 行首 Tab） */
export function structuralProblem(file: string, content: string): StructuralProblem | null {
  const ext = /\.([a-z0-9]+)$/i.exec(file)?.[1]?.toLowerCase();
  if (ext === 'json') {
    try {
      JSON.parse(content);
      return null;
    } catch (e) {
      return { key: 'json-invalid', message: `写出来的 ${file} 不是合法 JSON（${(e as Error).message.slice(0, 80)}）` };
    }
  }
  if (ext === 'md' && content.startsWith('---\n')) {
    const end = content.indexOf('\n---', 4);
    if (end < 0) return { key: 'md-frontmatter-unclosed', message: `${file} 的 frontmatter 没闭合（开头有 --- 但找不到结束的 ---）` };
  }
  if (ext === 'yaml' || ext === 'yml') {
    // 只查最要命的一种：行首 tab 缩进（YAML 不允许），完整解析留给专用工具
    if (/^\t/m.test(content)) return { key: 'yaml-tab', message: `${file} 里有以 Tab 开头的行——YAML 不接受 Tab 缩进` };
  }
  return null;
}
