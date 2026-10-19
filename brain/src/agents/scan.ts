// subagent 定义扫描：<dir>/<name>/AGENT.md，frontmatter 声明
// name/description/tools（白名单）/model（fast 默认）/maxIterations（默认 20）。
import type { Runtime } from '../runtime/types.js';
import type { ModelRole } from '../llm/provider.js';

export interface AgentSpec {
  name: string;
  description: string;
  tools: string[];
  model: ModelRole;
  maxIterations: number;
  /** 这个分身自己声明的成本上限（元）——只能比宿主闸更小，不能更大 */
  maxCost?: number;
  /** 这个分身自己声明的时长上限（**秒**，写起来顺手；内部换算成 ms） */
  maxRuntimeSec?: number;
  dir: string;
  /** AGENT.md 正文（角色设定） */
  body: string;
}

export interface ParsedAgent {
  spec: AgentSpec;
  body: string;
}

export function parseAgentMd(raw: string): ParsedAgent | null {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) return null;
  // 键名归一：`maxIterations` / `max_iterations` / `max-iterations` 都认（手写格式，别让人猜）
  const fm: Record<string, string> = {};
  for (const line of m[1]!.split('\n')) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    fm[line.slice(0, idx).trim().replace(/[_-]/g, '').toLowerCase()] = line.slice(idx + 1).trim();
  }
  const num = (v: string | undefined): number | undefined => {
    const n = Number(String(v ?? '').trim());
    return Number.isFinite(n) && n > 0 ? n : undefined;
  };
  if (!fm.name) return null;
  const tools = (fm.tools ?? '')
    .replace(/^\[|\]$/g, '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const model: ModelRole = fm.model === 'compact' || fm.model === 'subagent' || fm.model === 'main' ? fm.model : 'fast';
  const maxCost = num(fm.maxcost);
  const maxRuntimeSec = num(fm.maxruntime);
  const maxIterations = Number.isFinite(Number(fm.maxiterations)) ? Math.max(1, Math.floor(Number(fm.maxiterations))) : 20;
  return {
    spec: {
      name: fm.name,
      description: fm.description ?? '',
      tools,
      model,
      maxIterations,
      ...(maxCost !== undefined ? { maxCost } : {}),
      ...(maxRuntimeSec !== undefined ? { maxRuntimeSec } : {}),
      dir: '',
      body: m[2] ?? '',
    },
    body: m[2] ?? '',
  };
}

/**
 * 分身名册 → 冻结前缀里的一段（**她得知道"有活可以派"**）。
 * 只列名字与一句话能力，外加"什么时候派/什么时候别派"的纪律（多 Agent 不是越多越好）。
 */
export function agentsIndexText(agents: AgentSpec[]): string {
  if (!agents.length) return '';
  const lines = agents.map((a) => `- ${a.name}：${a.description}`);
  return [
    '【可以派出去的分身（工作模式可用，用 run_agent 派）】',
    ...lines,
    '什么时候派：活能独立做完（不用中途问你）、要读一堆文件但只要你带结论回来、或者几路各查一块可以并行。',
    '什么时候别派：一句话能答完的、离了当前上下文干不了的、以及需要你拍板的事——那些自己做。',
  ].join('\n');
}

/** 扫描所有 agents 目录；name 冲突取先发现者 */
export async function scanAgents(runtime: Runtime, dirs: string[]): Promise<AgentSpec[]> {
  const byName = new Map<string, AgentSpec>();
  for (const dir of dirs) {
    let subdirs: string[] = [];
    try {
      subdirs = await runtime.fs.list(dir);
    } catch {
      continue;
    }
    for (const sub of subdirs.sort()) {
      let raw: string;
      try {
        raw = (await runtime.fs.read(`${dir}/${sub}/AGENT.md`, { limit: 500_000 })).content;
      } catch {
        continue;
      }
      const parsed = parseAgentMd(raw);
      // 分身名允许中文（内置的「查证员/资料员/整理员」——名字是她和用户都看得见的东西，
      // 用拼音/英文反而别扭）。仍禁止路径分隔符与空白，并限长（名字要进工具参数与日志）。
      // 注意：skills/scan.ts 的同名校验**不跟着放宽**——技能名对应加载路径，保持 ASCII。
      if (!parsed || !/^[\p{L}\p{N}_-]{1,24}$/u.test(parsed.spec.name)) continue;
      if (!byName.has(parsed.spec.name)) {
        byName.set(parsed.spec.name, { ...parsed.spec, dir: `${dir}/${sub}`, body: parsed.body });
      }
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}
