// edit 工具：模式A oldString 唯一替换；模式B 行号区间替换。二选一；exclusive；写前备份。
//
// 模式A 的三条设计：
//   · **降级匹配**——不再只认逐字相同：精确 → 忽略行尾空白 → 两端 trim → 标点/空格归一（见 match.ts）
//   · **回报用了哪一档**——降级命中时在成功话术里说清楚，并要求模型核对这一处
//   · **失败回显期望内容**——找不到时把它要找的原文贴回去（出处 codex `file_update.rs:209-215`）
import type { ToolEntry } from './registry.js';
import { refuseTextWrite } from './opaque.js';
import { findMatch, TIER_LABEL } from './match.js';
import { structuralProblem } from './structlint.js';

/** 失败回显上限：codex 是整段 chunk 全量回显（`file_update.rs:209-215`），中文长段落会一次烧掉上千 token，
 *  这里截断；同时补一句它没有的提示（"多给几行上下文"）——我们的唯一性检查靠上下文来消歧。 */
const ECHO_MAX = 800;

function echoExpected(old: string): string {
  return old.length > ECHO_MAX ? `${old.slice(0, ECHO_MAX)}\n…（回显已截断，你给的原文共 ${old.length} 字）` : old;
}

export function editTool(): ToolEntry {
  return {
    name: 'edit',
    permissionClass: 'write',
    exclusive: true,
    schema: {
      type: 'function',
      function: {
        name: 'edit',
        description: '修改文件局部。模式A：oldString 唯一匹配后替换为 newString；模式B：按行号区间替换。二选一。',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: '相对会话目录或绝对路径' },
            oldString: { type: 'string', description: '模式A：被替换原文本（必须唯一匹配）' },
            newString: { type: 'string', description: '模式A：替换后新文本' },
            startLine: { type: 'number', description: '模式B：起始行号' },
            endLine: { type: 'number', description: '模式B：结束行号（含）' },
            replacement: { type: 'string', description: '模式B：替换整段新内容' },
          },
          required: ['path'],
        },
      },
    },
    executor: async (args, ctx) => {
      const a = (args ?? {}) as {
        path?: unknown; oldString?: unknown; newString?: unknown;
        startLine?: unknown; endLine?: unknown; replacement?: unknown;
      };
      if (typeof a.path !== 'string' || a.path.length === 0) {
        return { ok: false, output: '', error: { code: 'BAD_ARGS', message: 'path 必须为非空字符串' } };
      }
      const refuse = refuseTextWrite(a.path); // 二进制文档不许纯文本改（同 write）
      if (refuse) return { ok: false, output: '', error: { code: 'OPAQUE_FILE', message: refuse } };
      const isA = typeof a.oldString === 'string';
      const isB = typeof a.startLine === 'number' || typeof a.endLine === 'number';
      if (isA === isB) {
        return { ok: false, output: '', error: { code: 'BAD_ARGS', message: '模式A（oldString/newString）与模式B（startLine/endLine/replacement）必须二选一' } };
      }
      let original: string;
      try {
        const r = await ctx.runtime.fs.read(a.path, { offset: 1, limit: 1_000_000 });
        original = r.content;
      } catch (err) {
        return { ok: false, output: '', error: { code: 'READ_ERROR', message: (err as Error).message } };
      }
      let next: string;
      let range: string;
      let tierNote = '';
      let matched: { oldCountBefore?: number } = {};
      if (isA) {
        const old = a.oldString as string;
        const m = findMatch(original, old);
        if (!m.found && m.count === 0) {
          // 幂等短路（hermes `is_already_applied`）：旧文字没了、而新文字已经在里面 → 这个编辑已经生效过。
          // 直接回"已经改好了"，免得模型把同一条编辑反复重发（生产里最常见的一种烧回合）。
          const nw = (a.newString as string) ?? '';
          if (nw && original.includes(nw)) {
            return { ok: true, output: `${a.path} 里已经是改后的样子了（这条编辑之前就生效过），不用重发。` };
          }
          // 回显"你要找的原文"（codex 做法）+ 我们能给的下一步
          return {
            ok: false, output: '',
            error: {
              code: 'NOT_FOUND',
              message: [
                `在 ${a.path} 里找不到你要找的这段（四档都试过了：${m.triedTiers.map((t) => TIER_LABEL[t]).join(' → ')}）：`,
                echoExpected(old),
                '对照一下文件里现在的样子：多半是内容变过、或者你记的上下文不够。先 read 一眼当前内容，再多带几行上下文重发（带得越多越不容易改错地方）。',
              ].join('\n'),
            },
          };
        }
        if (!m.found && m.count > 1) {
          const how = m.tier === 'exact' ? '' : `（在「${TIER_LABEL[m.tier]}」这一档上）`;
          return { ok: false, output: '', error: { code: 'NOT_UNIQUE', message: `oldString${how}匹配 ${m.count} 处，必须唯一；请提供更具体的文本（多带前后几行）` } };
        }
        next = original.slice(0, m.start) + ((a.newString as string) ?? '') + original.slice(m.end);
        range = `字符 ${m.start + 1}~${m.end}`;
        matched = m.tier === 'exact' ? { oldCountBefore: m.count } : {};
        if (m.tier !== 'exact') {
          // 回报档位：模型不知道自己是"蒙对的"就不会复核，这里必须说破
          tierNote = `；**这次是靠「${TIER_LABEL[m.tier]}」匹配上的**——原文的写法跟你给的不完全一样，请核对改的正是你想改的那一处`;
        }
      } else {
        const lines = original.split('\n');
        const start = typeof a.startLine === 'number' ? Math.floor(a.startLine) : 1;
        const end = typeof a.endLine === 'number' ? Math.floor(a.endLine) : start;
        if (start < 1 || end < start || start > lines.length) {
          return { ok: false, output: '', error: { code: 'BAD_RANGE', message: `行号区间非法（start=${start}, end=${end}, 总行数=${lines.length}）` } };
        }
        const head = lines.slice(0, start - 1);
        const tail = lines.slice(Math.min(end, lines.length));
        next = [...head, (a.replacement as string) ?? '', ...tail].join('\n');
        range = `行 ${start}~${end}`;
      }
      try {
        await ctx.runtime.fs.write(`${a.path}.bak`, original);
        // 回合级快照（`original` 就是改动前的全文；第一次赢，后面不再覆盖）
        await ctx.snapshots?.record(a.path, original);
        await ctx.runtime.fs.write(a.path, next);
      } catch (err) {
        return { ok: false, output: '', error: { code: 'WRITE_ERROR', message: (err as Error).message } };
      }
      // 写后验证：重读核对"替换真的落到文件上了"（不是只在内存里改过）
      // lint delta：把**改前**的结构性问题当基线记下来——收尾自检只报"这次新引入的"，
      // 免得文件本来就有毛病时，模型以为是自己改坏的（或反过来把历史噪音当耳边风）。
      const preLint = structuralProblem(a.path, original);
      ctx.mutations?.push({
        tool: 'edit', path: a.path, at: Date.now(),
        expect: isA
          // 降级命中时 oldCountBefore 不记：那种情况下"旧文字"本来就不是逐字存在的，
          // 记 0 会让收尾核对（after >= before）误判成"旧文字还在"（见 workcheck 的核对式）
          ? { newString: (a.newString as string) ?? '', oldString: a.oldString as string, ...matched, preLint: preLint ? [preLint.key] : [] }
          : { content: next, preLint: preLint ? [preLint.key] : [] },
      });
      let back: string;
      try {
        back = (await ctx.runtime.fs.read(a.path, { limit: 2_000_000 })).content;
      } catch (err) {
        return { ok: false, output: '', error: { code: 'VERIFY_FAILED', message: `改完读不回来（${(err as Error).message}）——别按"已改好"交付` } };
      }
      if (back !== next) {
        return { ok: false, output: '', error: { code: 'VERIFY_FAILED', message: '改后核对不过：文件里现在的内容和预期不一致，别说搞定了（原文件已备份为 .bak）' } };
      }
      return { ok: true, output: `已修改 ${a.path}（${range}${tierNote}；已重读核对；原文件备份于 ${a.path}.bak）` };
    },
  };
}
