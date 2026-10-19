// 国际化单测：语言变量替换 / locale 归一 / 默认行为不变。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeLocale, languageName } from './language.js';
import { buildFrozen } from './assemble.js';
import { ToolRegistry } from '../tools/registry.js';
import { readTool } from '../tools/read.js';
import { createNodeRuntime } from '../runtime/node.js';
import { loadConfig } from '../config/load.js';

test('locale 归一：常见别名 → 受支持五语言；未知 → null', () => {
  assert.equal(normalizeLocale('zh-CN'), 'zh-CN');
  assert.equal(normalizeLocale('zh'), 'zh-CN');
  assert.equal(normalizeLocale('zh-Hans'), 'zh-CN');
  assert.equal(normalizeLocale('zh-TW'), 'zh-Hant');
  assert.equal(normalizeLocale('zh-HK'), 'zh-Hant');
  assert.equal(normalizeLocale('en-US'), 'en');
  assert.equal(normalizeLocale('ja-JP'), 'ja');
  assert.equal(normalizeLocale('ko_KR'), 'ko');
  assert.equal(normalizeLocale('fr-FR'), null);
  assert.equal(normalizeLocale(''), null);
  assert.equal(normalizeLocale(undefined), null);
});

test('languageName：未识别/缺省一律回落中文（默认行为不变）', () => {
  assert.equal(languageName(undefined), '中文');
  assert.equal(languageName('fr'), '中文');
  assert.equal(languageName('zh-CN'), '中文');
  assert.equal(languageName('zh-TW'), '繁體中文');
  assert.equal(languageName('en'), 'English');
  assert.equal(languageName('ja-JP'), '日本語');
  assert.equal(languageName('ko'), '한국어');
});

function mkCtx(language?: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-lang-'));
  const registry = new ToolRegistry();
  registry.register(readTool());
  const rt = createNodeRuntime({
    cwd: dir,
    storage: { sessionsDir: `${dir}/s`, logsDir: `${dir}/l`, memoryDir: `${dir}/m`, configDir: `${dir}/c` },
  });
  const config = loadConfig({ cwd: dir, home: dir, cli: language ? { language } : undefined });
  return { registry, runtime: rt, config };
}

test('冻结前缀：默认配置输出「用中文回复」；language=ja 输出「用日本語回复」；未知回落中文', () => {
  const def = buildFrozen(mkCtx()).system;
  assert.ok(def.includes('用中文回复'), '默认必须是中文（与预埋前逐字一致）');
  assert.ok(!def.includes('{{language}}'), '占位符不得残留');

  const ja = buildFrozen(mkCtx('ja')).system;
  assert.ok(ja.includes('用日本語回复'));

  const unknown = buildFrozen(mkCtx('fr-FR')).system;
  assert.ok(unknown.includes('用中文回复'), '未识别 locale 回落中文');
});

test('base.md / base.ts 占位符一致（防单侧改漏）', () => {
  // 与 assemble.test.ts 同法：dist 下运行，原文从 src 读
  const here = path.dirname(fileURLToPath(import.meta.url));
  const md = fs.readFileSync(path.join(here, '../../src/prompt/base.md'), 'utf8');
  assert.ok(md.includes('{{language}}'));
});
