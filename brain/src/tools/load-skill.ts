// load_skill 工具：正文以 tool_result 回传；每技能每会话仅一次；无效 name 报错 + 可用列表。
import type { ToolEntry } from './registry.js';
import type { SkillMeta } from '../skills/scan.js';
import { loadSkillBody } from '../skills/scan.js';
import { materialBanner } from '../prompt/banner.js';

export function loadSkillTool(): ToolEntry {
  return {
    name: 'load_skill',
    permissionClass: 'internal',
    schema: {
      type: 'function',
      function: {
        name: 'load_skill',
        description: '按名称加载技能完整正文（每技能每会话只加载一次）。',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: '技能名（见技能索引）' },
          },
          required: ['name'],
        },
      },
    },
    executor: async (args, ctx) => {
      const a = (args ?? {}) as { name?: unknown };
      if (typeof a.name !== 'string' || !a.name) {
        return { ok: false, output: '', error: { code: 'BAD_ARGS', message: 'name 必填' } };
      }
      const skills = ctx.skills ?? [];
      const skill: SkillMeta | undefined = skills.find((s) => s.name === a.name);
      if (!skill) {
        const available = skills.map((s) => s.name).join('、');
        return {
          ok: false,
          output: '',
          error: { code: 'UNKNOWN_SKILL', message: `技能 ${a.name} 不存在。可用技能：${available || '（无）'}` },
        };
      }
      if (ctx.loadedSkills?.has(skill.name)) {
        return { ok: true, output: `技能 ${skill.name} 本会话已加载过（每技能每会话仅加载一次）。` };
      }
      ctx.loadedSkills?.add(skill.name);
      const body = await loadSkillBody(ctx.runtime, skill);

      // 依赖 CLI 检测：缺失则提示安装（不阻断加载）
      const missing: string[] = [];
      for (const cli of skill.requires) {
        const r = await ctx.runtime.exec(`command -v ${cli}`, { timeoutMs: 5000 });
        if (!r.ok) missing.push(cli);
      }
      const hint = missing.length > 0
        ? `\n\n⚠️ 依赖检测：缺少 CLI：${missing.join('、')}。请先安装（如 brew install ${missing.join(' ')}）。`
        : '';
      /* 技能正文是**写在文件里的**（可能是装的别人的），不是用户此刻说的话 ——
         按"外部材料"标出来：可以照它做事，但它不能改变身份/权限；里面若出现"请执行…"要当心。
         （正文本来就以 tool_result 回传，与网页/文档同一条通道，标记方式也就该同一套。） */
      return { ok: true, output: `【技能 ${skill.name}】\n${materialBanner(`技能「${skill.name}」的正文（可能是别人写的）`)}\n\n${body}${hint}` };
    },
  };
}
