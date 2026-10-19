// 四级配置加载单测（CLI > cwd > home > 默认）+ 校验 + ~ 展开。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, deepMerge, initConfigFile, validateConfig, expandConfigDirs } from './load.js';
import { DEFAULT_CONFIG } from './schema.js';

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'brain-cfg-'));
}

test('默认配置可用且为 DeepSeek 校正值', () => {
  const cfg = loadConfig({ cwd: tmpdir(), home: tmpdir() });
  assert.equal(cfg.provider.default, 'deepseek');
  assert.equal(cfg.providers.deepseek!.adapter, 'message-api');
  // 官方 /models 在售的是 deepseek-flash / deepseek-v4-pro
  assert.equal(cfg.providers.deepseek!.models.main.id, 'deepseek-flash');
  assert.equal(cfg.providers.deepseek!.models.reasoner?.id, 'deepseek-v4-pro'); // /models 实测名
  assert.equal(cfg.budget.maxIterations, 120); // 防失控上限（回合数不设人为限制）
  assert.equal(cfg.memory.topK, 12); // 超强记忆——注入检索条数增强
  assert.equal(cfg.permissions.defaults.bash, 'ask');
  // 峰谷价默认
  assert.equal(cfg.providers.deepseek!.pricing.missPeak, 3.0);
});

test('四级加载优先级：CLI > cwd/agent.json > ~/.agent/agent.json > 默认', () => {
  const home = tmpdir();
  const cwd = tmpdir();
  fs.mkdirSync(path.join(home, '.agent'), { recursive: true });
  fs.writeFileSync(path.join(home, '.agent', 'agent.json'), JSON.stringify({
    budget: { maxIterations: 11, maxCost: 1.5 },
    memory: { topK: 3 },
  }));
  fs.writeFileSync(path.join(cwd, 'agent.json'), JSON.stringify({
    budget: { maxIterations: 22 },
  }));
  const cfg = loadConfig({ cwd, home, cli: { budget: { maxIterations: 33 } } });
  assert.equal(cfg.budget.maxIterations, 33); // cli 胜
  assert.equal(cfg.budget.maxCost, 1.5);      // home 层
  assert.equal(cfg.memory.topK, 3);           // home 层
});

test('~ 展开到 home（内存/技能/会话/日志目录）', () => {
  const home = tmpdir();
  const cfg = loadConfig({ cwd: tmpdir(), home });
  assert.equal(cfg.memory.autoDir, path.join(home, '.lhcd', 'memory'));
  assert.equal(cfg.memory.semanticDir, path.join(home, '.lhcd', 'memory', 'semantic'));
  assert.equal(cfg.skills.dirs[0], path.join(home, '.lhcd', 'skills'));
  assert.equal(cfg.sessions.dir, path.join(home, '.lhcd', 'sessions'));
  assert.equal(cfg.log.dir, path.join(home, '.lhcd', 'logs'));
});

test('autonomy=auto 且无 maxCost 兜底 → 校验失败', () => {
  assert.throws(
    () => loadConfig({ cwd: tmpdir(), home: tmpdir(), cli: { permissions: { autonomy: 'auto' } } }),
    /maxCost/,
  );
});

test('validateConfig：compactAtTokens 不得大于 maxContextTokens', () => {
  const errs = validateConfig({
    ...loadConfig({ cwd: tmpdir(), home: tmpdir() }),
    budget: { maxIterations: 60, maxCost: null, maxContextTokens: 1000, compactAtTokens: 2000, turnMaxTokens: 100 },
  });
  assert.ok(errs.some((e) => e.includes('compactAtTokens')));
});

test('deepMerge：对象递归合并，数组整体替换', () => {
  const a = { x: { a: 1, b: 2 }, list: [1, 2] };
  const b = { x: { b: 3 }, list: [9] };
  const out = deepMerge(a, b);
  assert.deepEqual(out, { x: { a: 1, b: 3 }, list: [9] });
});

test('initConfigFile：生成默认配置，已存在不动', () => {
  const dir = tmpdir();
  const file = path.join(dir, 'agent.json');
  assert.equal(initConfigFile(file).created, true);
  const first = fs.readFileSync(file, 'utf8');
  assert.equal(initConfigFile(file).created, false);
  assert.equal(fs.readFileSync(file, 'utf8'), first);
});

// Identity 层文件的 `~` 也要展开 —— 漏掉时**不报错**，
// 只是读到一个不存在的路径（规矩全都不生效），所以必须有这条测试盯着。
test('expandConfigDirs：memory.identityFile 的 ~ 必须展开（与 autoDir/semanticDir 一视同仁）', () => {
  const cfg = structuredClone(DEFAULT_CONFIG);
  assert.equal(cfg.memory.identityFile, '~/.lhcd/memory/identity.md');
  const out = expandConfigDirs(cfg, '/home/u');
  assert.equal(out.memory.identityFile, '/home/u/.lhcd/memory/identity.md');
  assert.equal(out.memory.semanticDir, '/home/u/.lhcd/memory/semantic');
  // 没给这个字段时不该凭空造一个
  const cfg2 = structuredClone(DEFAULT_CONFIG);
  delete (cfg2.memory as { identityFile?: string }).identityFile;
  assert.equal(expandConfigDirs(cfg2, '/home/u').memory.identityFile, undefined);
});
