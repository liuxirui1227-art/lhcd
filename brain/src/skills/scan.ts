// 技能扫描：扫描 skills 目录，解析 SKILL.md frontmatter（name/description/requires）。
// 零依赖 YAML-lite：仅支持固定键值行（name/description/requires 列表），正文原样保留。
// TODO(spec)：复杂 frontmatter 接 yaml 库。
import type { Runtime } from '../runtime/types.js';

export interface SkillMeta {
  name: string;
  description: string;
  requires: string[];
  /** 技能目录（绝对路径，加载正文用） */
  dir: string;
}

export interface ParsedSkill {
  meta: SkillMeta;
  body: string;
}

/** 解析 SKILL.md：frontmatter（name 必填，kebab-case）+ 正文 */
export function parseSkillMd(raw: string): ParsedSkill | null {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) return null;
  const fm: Record<string, string> = {};
  for (const line of m[1]!.split('\n')) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    fm[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  if (!fm.name) return null;
  const requires = (fm.requires ?? '')
    .replace(/^\[|\]$/g, '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    meta: {
      name: fm.name,
      description: fm.description ?? '',
      requires,
      dir: '',
    },
    body: m[2] ?? '',
  };
}

/** 扫描所有技能目录（每目录一层：<dir>/<skill>/SKILL.md）；name 冲突取先发现者 */
export async function scanSkills(runtime: Runtime, dirs: string[]): Promise<SkillMeta[]> {
  const byName = new Map<string, SkillMeta>();
  for (const dir of dirs) {
    let subdirs: string[] = [];
    try {
      subdirs = await runtime.fs.list(dir);
    } catch {
      continue;
    }
    for (const sub of subdirs.sort()) {
      const skillPath = `${dir}/${sub}/SKILL.md`;
      let raw: string;
      try {
        raw = (await runtime.fs.read(skillPath, { limit: 500_000 })).content;
      } catch {
        continue;
      }
      const parsed = parseSkillMd(raw);
      if (!parsed || !/^[a-z0-9-]+$/.test(parsed.meta.name)) continue;
      if (!byName.has(parsed.meta.name)) {
        byName.set(parsed.meta.name, { ...parsed.meta, dir: `${dir}/${sub}` });
      }
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** 技能索引文本（进冻结前缀；按 name 排序） */
export function skillsIndexText(skills: SkillMeta[]): string {
  if (skills.length === 0) return '';
  const sorted = [...skills].sort((a, b) => a.name.localeCompare(b.name));
  const lines = sorted.map((s) => `- ${s.name}: ${s.description || '（无描述）'}`);
  return `【技能索引】（需要时用 load_skill 加载正文）\n${lines.join('\n')}`;
}

/** 按 name 加载技能正文（含 frontmatter 剥离后的正文） */
export async function loadSkillBody(runtime: Runtime, skill: SkillMeta): Promise<string> {
  const raw = (await runtime.fs.read(`${skill.dir}/SKILL.md`, { limit: 500_000 })).content;
  return parseSkillMd(raw)?.body ?? '';
}
