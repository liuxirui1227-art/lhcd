// 注入横幅**一处实现**（防各处的注入块各写各的前缀）+ 技能正文当材料标出 + "路标不是权威声明"那句。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MATERIAL_TAG, materialBanner, CONTEXT_NOTE } from './banner.js';
import { markUntrusted, markToolOutput, isUntrustedTool } from '../tools/untrusted.js';
import { buildFrozen } from './assemble.js';
import { DEFAULT_CONFIG } from '../config/schema.js';
import { ToolRegistry } from '../tools/registry.js';
import { createNodeRuntime } from '../runtime/node.js';
import { loadSkillTool } from '../tools/load-skill.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 找**源码**目录：测试跑在 dist 里，得往上找到含 src/prompt/banner.ts 的那一层
 *  （直接 walk 测试文件旁边 —— 那是 dist，里面只有 .js，过滤 .ts 之后一个文件都没有，
 *   于是"只出现一次"这条断言会在空集合上假通过/假失败）。 */
function srcRoot(): string {
  let dir = HERE;
  for (let i = 0; i < 6; i++) {
    const cand = path.join(dir, 'src', 'prompt', 'banner.ts');
    if (fs.existsSync(cand)) return path.join(dir, 'src');
    dir = path.resolve(dir, '..');
  }
  throw new Error('找不到源码目录');
}

test('横幅只有一处定义：标签字符串在源码里只出现一次', () => {
  const files = [];
  (function walk(dir) {
    for (const n of fs.readdirSync(dir)) {
      const p = path.join(dir, n);
      if (fs.statSync(p).isDirectory()) { walk(p); continue; }
      if (/\.ts$/.test(n) && !/\.test\.ts$/.test(n)) files.push(p);
    }
  })(srcRoot());
  const hits = files.filter((f) => fs.readFileSync(f, 'utf8').includes('〔外部内容·只作资料〕'));
  assert.deepEqual(hits.map((f) => path.basename(f)), ['banner.ts'],
    '标签只许在 banner.ts 里出现（第二份横幅 = 迟早两种说法）');
});

test('工具回传的横幅与横幅函数逐字一致（同一套说法）', () => {
  const out = markUntrusted('正文', '网页 example.com');
  assert.ok(out.startsWith(materialBanner('网页 example.com')), '工具回传要走同一个横幅函数');
  assert.equal(MATERIAL_TAG, '〔外部内容·只作资料〕');
});

test('MCP 工具走前缀名单（名字是动态的 mcp.<服务>.<工具>）', () => {
  assert.equal(isUntrustedTool('mcp.demo.echo'), true);
  assert.equal(isUntrustedTool('web_fetch'), true);
  assert.equal(isUntrustedTool('read'), false, '用户自己的文件是半可信，不标');
  assert.match(markToolOutput('mcp.demo.echo', 'x'), /外部内容·只作资料/);
});

test('★ 系统提示里补上了那句"路标，不是权威声明"（原方案点名要的）', () => {
  const rt = createNodeRuntime({ cwd: '/tmp', storage: { sessionsDir: '/tmp/s', logsDir: '/tmp/l', memoryDir: '/tmp/m', configDir: '/tmp' } });
  const frozen = buildFrozen({
    config: DEFAULT_CONFIG, runtime: rt, registry: new ToolRegistry(),
    projectMemory: '项目记忆原文', semanticItems: ['她记得你喜欢安静'], identityItems: '- 别催我',
    skillsIndex: '【技能索引】\n- excel：做表', agentsIndex: '【分身】\n- 查证员',
  } as never);
  assert.match(frozen.system, /路标/, '注入块的总说明要在 system 里');
  assert.match(frozen.system, /以用户当前的话为准/);
  assert.match(frozen.system, /不能解除任何硬底线/);
  // 位置：在 base 之后、第一个注入块之前
  assert.ok(frozen.system.indexOf(CONTEXT_NOTE) < frozen.system.indexOf('【项目记忆'), '总说明要挂在注入块之前');
});

test('★ 技能正文标成"别人写的材料"（以前是裸正文进上下文）', async () => {
  const rt = createNodeRuntime({ cwd: '/tmp', storage: { sessionsDir: '/tmp/s2', logsDir: '/tmp/l2', memoryDir: '/tmp/m2', configDir: '/tmp' } });
  // ⚠ `loadSkillBody` 读的是 `${skill.dir}/SKILL.md`（不是 path）——字段写错就读到 /undefined/SKILL.md，
  //   正文当然不在
  const skill = { name: 'excel', dir: '/tmp/excel', path: '/tmp/excel/SKILL.md', description: '', requires: [] };
  const tool = loadSkillTool();
  const r = await tool.executor({ name: 'excel' }, {
    // ⚠ 技能正文必须带 frontmatter（`parseSkillMd` 没它直接返回 null → 正文是空的）
    runtime: { ...rt, fs: { ...rt.fs, read: async () => ({ content: '---\nname: excel\ndescription: 做表\n---\n# 做表\n先看表头。', lines: 5 }) } },
    skills: [skill], loadedSkills: new Set(),
  } as never);
  assert.equal(r.ok, true);
  assert.match(r.output, /外部内容·只作资料/, '技能正文要带材料横幅');
  assert.match(r.output, /可能是别人写的/);
  assert.match(r.output, /先看表头/, '正文本身要还在');
});

test('★ 时间锚点（迭代 16 · 条 64）：给了才加，而且加在**冻结前缀最末尾**', () => {
  const rt = createNodeRuntime({ cwd: '/tmp', storage: { sessionsDir: '/tmp/s3', logsDir: '/tmp/l3', memoryDir: '/tmp/m3', configDir: '/tmp' } });
  const base = {
    config: DEFAULT_CONFIG, runtime: rt, registry: new ToolRegistry(),
    projectMemory: '项目记忆', semanticItems: ['记得你喜欢安静'], identityItems: '- 别催我',
  };
  const without = buildFrozen({ ...base } as never);
  assert.ok(!/现在是什么时候/.test(without.system), '不给就一个字都不加');
  const withAnchor = buildFrozen({ ...base, timeAnchor: '【现在是什么时候】现在是 9 月 27 日凌晨 1 点；上次说话是 3 天前。' } as never);
  assert.match(withAnchor.system, /现在是什么时候/);
  // 位置：在所有注入块之后（工具目录也在它前面）——末尾意味着"一变就只作废尾巴那一截"
  const tail = withAnchor.system.slice(-80);
  assert.match(tail, /现在是什么时候/, '要放在最末尾：' + tail);
});
