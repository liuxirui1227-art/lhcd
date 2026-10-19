// 改后自检回插：改完文件、想收尾之前，真读盘核对一遍。
//
// 与既有 `selfcheck.ts` 的分工（职责写死，不许互相顶替）：
//   · `selfcheck`（本地、免费、永远开）：管"**话有没有依据**"——回答里的数字/文件名/URL 找不到出处就标【未核实】
//   · `workcheck`（本文件，按需）：管"**活有没有干对**"——这一轮改过的文件，收尾前再读一遍确认真改到了
//
// 统一 Stop 管线里的位置：**改后自检回插 → 完成判据 → 才允许结束**。
//
// 三道护栏（缺一条就从"帮手"变成"烦人"）：
//   ① **递归护栏**：一轮只回插一次（session.workChecked）——否则自检意见会自己触发自检，永远收不了尾
//   ② **只审这一轮改的**：baseline = 本回合登记的改动清单（session.mutations，回合开始清空）——
//      不重报上一轮已经报过的问题（没有这条，用户第三轮就学会无视自检意见）
//   ③ **措辞固定声明"这是补充意见，不是替代"**，并要求"处理完或确认后回到用户原本的请求上"
// lint delta：结构性毛病只报**这次新引入的**——工具在改动时把
// "改前的毛病 key"记进 mutation.expect.preLint（edit/write 都记），这里改后重扫一遍求差。
// 出处与两处有意偏离见 `tools/structlint.ts` 头部。
import type { Runtime } from '../runtime/types.js';
import { structuralProblem } from '../tools/structlint.js';

/** 一笔记下的改动（工具写完就登记；只留核对需要的最小信息） */
export interface FileMutation {
  tool: string;
  /** 改动落到的文件（office 是**新文件**） */
  path: string;
  at: number;
  /** 二进制产物（Office/PDF）：**只查在不在**，不按文本回读——回读二进制会读出乱码、误报 */
  binary?: boolean;
  expect?: {
    /** write：写进去的完整内容 */
    content?: string;
    /** edit 模式A：替换后的新串 / 被替换的旧串 */
    newString?: string;
    oldString?: string;
    /** edit 模式A：替换前旧串出现次数（核对应该少一次） */
    oldCountBefore?: number;
    /** office：改动来源文件（原件，必须还在） */
    source?: string;
    /** office：必须还在文件里的新文字 */
    contains?: string[];
    /** lint delta：**改前**就存在的结构性毛病 key（edit/write 记）——
     *  收尾只报这次新引入的，历史噪音不报（见 tools/structlint.ts 头部） */
    preLint?: string[];
  };
}

export interface WorkCheckResult {
  action: 'allow' | 'continue';
  nudge?: string;
  problems?: string[];
}

/** ③ 回插措辞（固定格式：先声明这是补充意见，再要求处理完回到原请求） */
export function workCheckNudge(problems: string[]): string {
  return [
    '（后台自检·**补充意见，不是替代**）你刚要收尾，我按你这一轮改过的文件回读核对了一遍，有不对的地方：',
    ...problems.map((p) => `· ${p}`),
    '先把这些处理掉，或者如实告诉用户哪一处没成；处理完（或确认过了没问题）之后，**回到用户原本的请求上**继续。',
  ].join('\n');
}

function countOf(text: string, needle: string): number {
  if (!needle) return 0;
  return text.split(needle).length - 1;
}

/**
 * 回读核对（真读盘，不看工具自己报的结果）。返回 action='continue' 时，调用方把 nudge 回灌进循环。
 * 只在"模型想收尾"这个点调用一次（护栏①由调用方保证）。
 */
export async function reviewMutations(mutations: FileMutation[], runtime: Runtime): Promise<WorkCheckResult> {
  if (!mutations.length) return { action: 'allow' };
  // 同一文件在一轮里改过多次 → **只核最后一次**（前面的被覆盖是正常的，不误报）
  const latest = new Map<string, FileMutation>();
  for (const m of mutations) latest.set(m.path, m);
  const problems: string[] = [];
  for (const m of latest.values()) {
    if (m.binary) {
      // 二进制产物：Office 工具在写出前已经"自证"过（改了要自证），这里只确认文件与原件都在
      try {
        await runtime.fs.stat(m.path);
        if (m.expect?.source) await runtime.fs.stat(m.expect.source);
      } catch {
        problems.push(`说改好的产物 ${m.path}（或它的原件 ${m.expect?.source ?? ''}）现在找不到了——别按"已改好"交付`);
      }
      continue;
    }
    let content: string;
    try {
      content = (await runtime.fs.read(m.path, { limit: 2_000_000 })).content;
    } catch {
      problems.push(`你说改好的 ${m.path} 现在读不出来（文件不在或没权限）——先确认这一步到底写没写成`);
      continue;
    }
    const e = m.expect ?? {};
    if (e.content !== undefined) {
      // 整文件写：重读必须和写进去的一致（防截断/写串）
      if (content !== e.content) {
        problems.push(`${m.path} 重读回来的内容和你写进去的不一致（写了 ${e.content.length} 字符，读回 ${content.length} 字符）——别按"已写好"交付`);
      }
    }
    if (e.newString !== undefined && !content.includes(e.newString)) {
      problems.push(`你说改了 ${m.path}，但新内容里找不到你替换成的那段文字`);
    }
    if (e.oldString !== undefined && e.oldCountBefore !== undefined) {
      const after = countOf(content, e.oldString);
      if (after >= e.oldCountBefore) {
        problems.push(`${m.path} 里被替换的旧文字还在（改前 ${e.oldCountBefore} 处，改后 ${after} 处）——这次替换没落到文件上`);
      }
    }
    if (e.source !== undefined) {
      // office：原件必须还在（"绝不原地覆盖"）＋ 新文件里必须能看到改动
      try {
        await runtime.fs.stat(e.source);
      } catch {
        problems.push(`原文件 ${e.source} 不见了——改文档不该动原件，先查清楚`);
      }
      for (const s of e.contains ?? []) {
        if (s && !content.includes(s)) problems.push(`改出来的 ${m.path} 里找不到新文字「${s.slice(0, 40)}」`);
      }
    }
    // lint delta：结构性问题**只报这次新引入的**——改前就有的不报（拿老毛病触发
    // "回插一轮让模型重做"是白烧钱，还会让模型误以为"这文件本来就烂"然后放弃修）
    const sp = structuralProblem(m.path, content);
    if (sp && !(e.preLint ?? []).includes(sp.key)) problems.push(sp.message);
  }
  if (!problems.length) return { action: 'allow' };
  return { action: 'continue', problems, nudge: workCheckNudge(problems) };
}
