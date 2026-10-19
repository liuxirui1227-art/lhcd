// load_skill 工具——正文 tool_result 回传 / 每会话仅一次 / 无效名报错 / 依赖 CLI 检测提示。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createNodeRuntime } from '../runtime/node.js';
import { loadConfig } from '../config/load.js';
import { loadSkillTool } from './load-skill.js';
import type { ExecCtx } from './registry.js';
import type { SkillMeta } from '../skills/scan.js';

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'brain-loadskill-'));
}

function setup() {
  const dir = tmpdir();
  const rt = createNodeRuntime({
    cwd: dir,
    storage: { sessionsDir: `${dir}/s`, logsDir: `${dir}/l`, memoryDir: `${dir}/m`, configDir: dir },
  });
  fs.mkdirSync(path.join(dir, 'skills', 'video-edit'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'skills', 'video-edit', 'SKILL.md'), `---
name: video-edit
description: 剪辑
requires: [definitely-missing-cli-xyz]
---
# 操作手册
用 ffmpeg 剪辑。`);
  const skills: SkillMeta[] = [{ name: 'video-edit', description: '剪辑', requires: ['definitely-missing-cli-xyz'], dir: `${dir}/skills/video-edit` }];
  const loadedSkills = new Set<string>();
  const ctx: ExecCtx = {
    sessionId: 's1',
    cwd: dir,
    runtime: rt,
    config: loadConfig({ cwd: dir, home: dir }),
    skills,
    loadedSkills,
    emit: () => undefined,
  };
  return { ctx, loadedSkills };
}

test('加载：正文回传 + 标记已加载 + 依赖缺失提示', async () => {
  const { ctx, loadedSkills } = setup();
  const r = await loadSkillTool().executor({ name: 'video-edit' }, ctx);
  assert.equal(r.ok, true);
  assert.ok(r.output.includes('操作手册'));
  assert.ok(r.output.includes('ffmpeg'));
  assert.ok(r.output.includes('definitely-missing-cli-xyz')); // 依赖缺失提示
  assert.ok(loadedSkills.has('video-edit'));
});

test('每技能每会话仅加载一次', async () => {
  const { ctx } = setup();
  await loadSkillTool().executor({ name: 'video-edit' }, ctx);
  const r2 = await loadSkillTool().executor({ name: 'video-edit' }, ctx);
  assert.equal(r2.ok, true);
  assert.match(r2.output, /已加载过/);
});

test('无效技能名 → 报错 + 可用列表', async () => {
  const { ctx } = setup();
  const r = await loadSkillTool().executor({ name: 'nope' }, ctx);
  assert.equal(r.ok, false);
  assert.equal(r.error?.code, 'UNKNOWN_SKILL');
  assert.match(r.error!.message, /video-edit/);
});

test('无依赖技能：无提示段', async () => {
  const dir = tmpdir();
  const rt = createNodeRuntime({
    cwd: dir,
    storage: { sessionsDir: `${dir}/s`, logsDir: `${dir}/l`, memoryDir: `${dir}/m`, configDir: dir },
  });
  const skills: SkillMeta[] = [{ name: 'simple', description: 's', requires: [], dir: `${dir}/skills/simple` }];
  fs.mkdirSync(path.join(dir, 'skills', 'simple'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'skills', 'simple', 'SKILL.md'), '---\nname: simple\ndescription: s\n---\n正文');
  const ctx: ExecCtx = {
    sessionId: 's1',
    cwd: dir,
    runtime: rt,
    config: loadConfig({ cwd: dir, home: dir }),
    skills,
    loadedSkills: new Set(),
    emit: () => undefined,
  };
  const r = await loadSkillTool().executor({ name: 'simple' }, ctx);
  assert.ok(!r.output.includes('依赖检测'));
});
