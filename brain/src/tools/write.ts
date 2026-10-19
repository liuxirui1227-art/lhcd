// write 工具：整文件覆盖（自动建父目录，写前备份 .bak）；exclusive 互斥。
// **写后验证**——写成功不等于写对了（截断/写串/写出非法 JSON 都曾真实发生），
// 一律重读核对（内容一致 + 结构性解析自检），不过就如实报错，绝不说"搞定了"。
import type { ToolEntry } from './registry.js';
import { refuseTextWrite, looksLikeNumberedDisplay } from './opaque.js';
import { structuralProblem } from './structlint.js';

export function writeTool(): ToolEntry {
  return {
    name: 'write',
    permissionClass: 'write',
    exclusive: true,
    schema: {
      type: 'function',
      function: {
        name: 'write',
        description: '覆盖写入整个文件（自动创建父目录，写前备份原文件为 .bak）。用于新建或整体替换；局部修改请用 edit。',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: '相对会话目录或绝对路径' },
            content: { type: 'string', description: '完整文件内容' },
          },
          required: ['path', 'content'],
        },
      },
    },
    executor: async (args, ctx) => {
      const a = (args ?? {}) as { path?: unknown; content?: unknown };
      if (typeof a.path !== 'string' || a.path.length === 0) {
        return { ok: false, output: '', error: { code: 'BAD_ARGS', message: 'path 必须为非空字符串' } };
      }
      if (typeof a.content !== 'string') {
        return { ok: false, output: '', error: { code: 'BAD_ARGS', message: 'content 必须为字符串' } };
      }
      // 加固（踩过的坑）：二进制文档**不许用纯文本写回**——你看到的是抽出来的文字，
      // 写回去会把文档结构毁掉（静默摧毁）。教学式拒绝，指明该走 office 工具。
      const refuse = refuseTextWrite(a.path);
      if (refuse) return { ok: false, output: '', error: { code: 'OPAQUE_FILE', message: refuse } };
      // 另一个坑：read 的输出带行号（`12\t内容`），
      // 模型有时会把**显示文本**当文件内容写回去——那会给文件插满行号。整段像编号行就拦下来。
      if (looksLikeNumberedDisplay(a.content)) {
        return {
          ok: false, output: '',
          error: { code: 'DISPLAY_TEXT', message: '你写进来的像是 read 带行号的**显示文本**（每行开头都是"行号+Tab"）——那不是文件本身的内容。请用不带行号的真内容；要改已有文件用 edit 更稳。' },
        };
      }
      // 改前内容的"结构性问题 key"当基线，收尾自检只报新引入的
      let preLint: string[] = [];
      try {
        // 写前备份：已存在 → 复制为 <path>.bak（就近可见，人工排障方便）
        const existed = await ctx.runtime.fs.stat(a.path).then(() => true).catch(() => false);
        let before: string | null = null;
        if (existed) {
          const prev = await ctx.runtime.fs.read(a.path, { offset: 1, limit: 1_000_000 });
          before = prev.content;
          const pre = structuralProblem(a.path, prev.content);
          preLint = pre ? [pre.key] : [];
          await ctx.runtime.fs.write(`${a.path}.bak`, prev.content);
        }
        /* **回合级快照**——`.bak` 第二次改就被覆盖，退不回这一轮开始前；快照不覆盖
           （第一次赢）。`before === null` = 这个文件当时不存在 → 还原时删掉。 */
        await ctx.snapshots?.record(a.path, before);
        await ctx.runtime.fs.write(a.path, a.content);
      } catch (err) {
        return { ok: false, output: '', error: { code: 'WRITE_ERROR', message: (err as Error).message } };
      }
      // 写后验证：重读核对（这是"不假成功"红线在文件工具上的落点）
      ctx.mutations?.push({ tool: 'write', path: a.path, at: Date.now(), expect: { content: a.content, preLint } });
      let back: string;
      try {
        back = (await ctx.runtime.fs.read(a.path, { limit: 2_000_000 })).content;
      } catch (err) {
        return { ok: false, output: '', error: { code: 'VERIFY_FAILED', message: `写完之后读不回来（${(err as Error).message}）——别按"已写好"交付` } };
      }
      if (back !== a.content) {
        return { ok: false, output: '', error: { code: 'VERIFY_FAILED', message: `写后核对不过：写进去 ${a.content.length} 字符，读回来是 ${back.length} 字符（内容不一致），别说搞定了` } };
      }
      return { ok: true, output: `已写入 ${a.path}（${a.content.length} 字符，已重读核对）` };
    },
  };
}
