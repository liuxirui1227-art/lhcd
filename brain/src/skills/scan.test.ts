// 技能扫描——SKILL.md frontmatter 解析 / 目录扫描去重 / 索引文本 / 正文加载。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createNodeRuntime } from '../runtime/node.js';
import { parseSkillMd, scanSkills, skillsIndexText, loadSkillBody } from './scan.js';

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'brain-skills-'));
}

function makeRuntime(dir: string) {
  return createNodeRuntime({
    cwd: dir,
    storage: { sessionsDir: `${dir}/s`, logsDir: `${dir}/l`, memoryDir: `${dir}/m`, configDir: dir },
  });
}

const VIDEO_SKILL = `---
name: video-edit
description: 用 ffmpeg 剪辑/转码/截取视频
requires: [ffmpeg, ffprobe]
---
# 视频剪辑
步骤一：先 ffprobe 查看信息。
`;

test('parseSkillMd：frontmatter + 正文；缺 name 拒绝', () => {
  const p = parseSkillMd(VIDEO_SKILL);
  assert.equal(p?.meta.name, 'video-edit');
  assert.deepEqual(p?.meta.requires, ['ffmpeg', 'ffprobe']);
  assert.ok(p?.body.includes('ffprobe 查看信息'));
  assert.equal(parseSkillMd('# 无 frontmatter'), null);
  assert.equal(parseSkillMd('---\ndescription: x\n---\nbody'), null);
});

test('scanSkills：扫描目录、按 name 排序、同名取先发现者', async () => {
  const dir = tmpdir();
  const rt = makeRuntime(dir);
  fs.mkdirSync(path.join(dir, 'skills1', 'video-edit'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'skills2', 'image'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'skills2', 'audio'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'skills2', 'broken'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'skills1', 'video-edit', 'SKILL.md'), VIDEO_SKILL);
  fs.writeFileSync(path.join(dir, 'skills2', 'image', 'SKILL.md'), '---\nname: image\ndescription: 图片处理\n---\n正文A');
  fs.writeFileSync(path.join(dir, 'skills2', 'audio', 'SKILL.md'), '---\nname: audio\ndescription: 音频处理\n---\n正文B');
  fs.writeFileSync(path.join(dir, 'skills2', 'broken', 'SKILL.md'), '# 没有 frontmatter'); // 无效技能被跳过

  const skills = await scanSkills(rt, [`${dir}/skills1`, `${dir}/skills2`]);
  assert.deepEqual(skills.map((s) => s.name), ['audio', 'image', 'video-edit']);
  assert.equal(skills[2]!.requires.length, 2);
  assert.ok(skills[2]!.dir.endsWith('video-edit'));
});

test('skillsIndexText：索引进冻结前缀格式', async () => {
  const dir = tmpdir();
  const rt = makeRuntime(dir);
  const skills = await scanSkills(rt, [`${dir}/nonexist`]);
  assert.equal(skillsIndexText(skills), '');
  const idx = skillsIndexText([
    { name: 'video-edit', description: '剪辑', requires: [], dir: '/x' },
    { name: 'image', description: '图片', requires: [], dir: '/y' },
  ]);
  assert.ok(idx.includes('【技能索引】'));
  assert.ok(idx.indexOf('image') < idx.indexOf('video-edit')); // name 排序
});

test('loadSkillBody：返回剥离 frontmatter 的正文', async () => {
  const dir = tmpdir();
  const rt = makeRuntime(dir);
  fs.mkdirSync(path.join(dir, 'skills', 'video-edit'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'skills', 'video-edit', 'SKILL.md'), VIDEO_SKILL);
  const skills = await scanSkills(rt, [`${dir}/skills`]);
  const body = await loadSkillBody(rt, skills[0]!);
  assert.ok(body.includes('ffprobe 查看信息'));
  assert.ok(!body.includes('requires:'));
});
