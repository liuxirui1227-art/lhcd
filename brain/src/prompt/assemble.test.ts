// 提示词组装——前缀字节一致（缓存前提）/ 截断 / 原文同步 / 压缩模板。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildFrozen } from './assemble.js';
import { BASE_PROMPT } from './base.js';
import { COMPACT_PROMPT, parseCompactJson } from './compact.js';
import { truncateToTokens, estimateTokens } from './tokens.js';
import { ToolRegistry } from '../tools/registry.js';
import { readTool } from '../tools/read.js';
import { bashTool } from '../tools/bash.js';
import { createNodeRuntime } from '../runtime/node.js';
import { loadConfig } from '../config/load.js';

const here = path.dirname(fileURLToPath(import.meta.url));

function makeCtx() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-prompt-'));
  const registry = new ToolRegistry();
  registry.register(readTool());
  registry.register(bashTool());
  const rt = createNodeRuntime({
    cwd: dir,
    storage: { sessionsDir: `${dir}/s`, logsDir: `${dir}/l`, memoryDir: `${dir}/m`, configDir: `${dir}/c` },
  });
  return { registry, rt, config: loadConfig({ cwd: dir, home: dir }) };
}

test('base.ts 与 base.md 原文同步', () => {
  const md = fs.readFileSync(path.join(here, '../../src/prompt/base.md'), 'utf8').trim();
  assert.equal(BASE_PROMPT, md);
});

test('compact.ts 与 compact.md 原文同步；模板含全部键', () => {
  const md = fs.readFileSync(path.join(here, '../../src/prompt/compact.md'), 'utf8').trim();
  assert.equal(COMPACT_PROMPT, md);
  for (const key of ['goal', 'facts', 'plan', 'files', 'last_tool_results', 'warnings']) {
    assert.ok(COMPACT_PROMPT.includes(key), `缺 ${key}`);
  }
});

test('前缀冻结：同一输入两次构建逐字节相等（§7.2 最高级不变量）', () => {
  const { registry, rt, config } = makeCtx();
  const ctx = {
    config,
    registry,
    runtime: rt,
    projectMemory: 'AGENTS.md 内容：项目记忆',
    semanticItems: ['用户偏好中文回复', '用户住在杭州'],
    skillsIndex: '【技能索引】\n- video-edit: 视频剪辑',
  };
  const a = buildFrozen(ctx);
  const b = buildFrozen(ctx);
  assert.equal(a.system, b.system);
  assert.deepEqual(a.tools, b.tools);
  // system 结构：base + 项目记忆 + 语义记忆 + 技能索引
  assert.ok(a.system.includes('通用智能体'));
  assert.ok(a.system.includes('项目记忆'));
  assert.ok(a.system.includes('语义记忆'));
  assert.ok(a.system.includes('技能索引'));
});

test('项目记忆超 4000 token 截断并标注', () => {
  const { registry, rt, config } = makeCtx();
  const long = '长'.repeat(4000 * 3 + 100);
  const frozen = buildFrozen({ config, registry, runtime: rt, projectMemory: long });
  assert.ok(frozen.system.includes('已截断'));
  // 只量"项目记忆那一段"的长度（整串还含能力目录等其它小节）
  const seg = frozen.system.slice(frozen.system.indexOf('【项目记忆'), frozen.system.indexOf('【项目记忆') + 4000 * 3 + 300);
  assert.ok(seg.length < 4000 * 3 + 300, '项目记忆段应被截到 4000 token 以内');
});

test('语义记忆条目：topK 截取 + 每条 token 截断（011-A9：topK=12）', () => {
  const { registry, rt, config } = makeCtx();
  const items = Array.from({ length: 14 }, (_, i) => (i < 12 ? `条目${i}` : '超'.repeat(2000)));
  const frozen = buildFrozen({ config, registry, runtime: rt, semanticItems: items });
  const section = frozen.system.slice(frozen.system.indexOf('【语义记忆'));
  assert.ok(!section.includes('条目12')); // topK=12，只取前 12 条
  assert.ok(!section.includes('超'));      // 第 13 条被 topK 截掉；截断逻辑单测见下
});

test('truncateToTokens / estimateTokens', () => {
  const { text, truncated } = truncateToTokens('a'.repeat(1000), 100);
  assert.equal(text.length, 300);
  assert.equal(truncated, true);
  assert.equal(truncateToTokens('short', 100).truncated, false);
  assert.ok(estimateTokens('你好世界') >= 1);
});

test('parseCompactJson：剥代码围栏 / 首尾大括号 / 非法输入', () => {
  const ok = parseCompactJson('```json\n{"goal":"g","facts":["f"],"plan":["p"],"files":[],"last_tool_results":"","warnings":[]}\n```');
  assert.equal(ok?.goal, 'g');
  assert.deepEqual(ok?.facts, ['f']);
  const bare = parseCompactJson('前缀废话 {"goal":"g2"} 后缀');
  assert.equal(bare?.goal, 'g2');
  assert.equal(parseCompactJson('不是 JSON'), null);
  assert.equal(parseCompactJson('{"facts":[]}'), null); // 缺 goal
});
