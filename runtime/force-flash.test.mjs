// 开发侧全 Flash——宿主侧接线单测。**不是产品功能**：打包应用照旧自由切换、按实际计价。
// 覆盖面：开关读写（state / 环境变量）+ **真正的不变量**：
//   压平之后，任何 thinking=true 的请求（Tier3 深任务 / 工作模式 / 拆解）都解析到便宜档，且不再有 reasoner 条目。
// 零成本（不调 LLM）。用法：node --test force-flash.test.mjs（或 npm test）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'lhcd-force-flash-'));
process.env.LHCD_DATA_DIR = DATA;
// 假绑定态：ensureLlmState / 面板数据源都要 state.bound
fs.writeFileSync(path.join(DATA, 'state.json'), JSON.stringify({
  bound: true,
  prefs: {},
  llm: { provider: 'deepseek', modelOverride: { deepseek: 'deepseek-v4-pro' } }, // 用户手选 = Pro（测试开关要盖过它）
}));

const lib = await import('./lib.mjs');
const { createMessageApiProvider, forceCheapTier } = await import('../brain/dist/index.js');

const deepseekProvider = () => ({
  models: {
    main: { id: 'deepseek-flash', thinking: false },
    fast: { id: 'deepseek-flash', thinking: false },
    compact: { id: 'deepseek-flash', thinking: false },
    subagent: { id: 'deepseek-flash', thinking: false },
    reasoner: { id: 'deepseek-v4-pro' },
  },
  pricingReasoner: { hit: 0.15, miss: 4.5, out: 13.5 },
});

/** 用真实适配器解析模型 id（thinking=true 时适配器优先查 reasoner 条目） */
function modelFor(models, role, thinking) {
  const p = createMessageApiProvider('deepseek', { baseUrl: 'https://api.deepseek.com/v1', apiKeyEnv: 'X', caps: {}, models, pricing: { hit: 0, miss: 0, out: 0 } });
  return p.resolveModelId(models, role, thinking);
}

test('开关默认关；setForceFlash 开 → state 落盘、可再关', () => {
  // 本用例断言的是"**默认**关"——所以必须先摘掉环境变量：
  // 开发/测试期会带着 LH_FORCE_FLASH=1 跑，带着它这条必红。
  delete process.env.LH_FORCE_FLASH;
  assert.equal(lib.forceFlashOn(), false);
  const r = lib.setForceFlash({ on: true });
  assert.equal(r.ok, true);
  assert.equal(lib.forceFlashOn(), true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(DATA, 'state.json'), 'utf8')).llm.forceFlash, true);
  assert.equal(lib.setForceFlash({ on: false }).forceFlash, false);
  assert.equal(lib.forceFlashOn(), false);
});

test('环境变量 LH_FORCE_FLASH 也能开（冒烟/探针用，零落盘）+ 思考档位解析', () => {
  process.env.LH_FORCE_FLASH = '1';
  assert.equal(lib.forceFlashOn(), true);
  assert.equal(lib.forceFlashLevel(), 'max'); // "flash max 版" = 默认档
  process.env.LH_FORCE_FLASH = 'low';
  assert.equal(lib.forceFlashLevel(), 'low'); // 显式指定档位
  process.env.LH_FORCE_FLASH = 'high';
  assert.equal(lib.forceFlashLevel(), 'high');
  process.env.LH_FORCE_FLASH = '0';
  assert.equal(lib.forceFlashLevel(), false); // 显式关
  delete process.env.LH_FORCE_FLASH;
  assert.equal(lib.forceFlashOn(), false);
});

test('state.llm.forceFlash 打开 → 思考档默认 max（脚本/测试入口）', () => {
  lib.setForceFlash({ on: true });
  assert.equal(lib.forceFlashLevel(), 'max');
  // 环境变量优先于 state（显式指定说了算）
  process.env.LH_FORCE_FLASH = 'low';
  assert.equal(lib.forceFlashLevel(), 'low');
  delete process.env.LH_FORCE_FLASH;
  lib.setForceFlash({ on: false });
  assert.equal(lib.forceFlashLevel(), false);
});

test('端到端：createAgent(forceFlash: max) → 便宜档条目带 effort=max（真正发给服务端的字段）', async () => {
  const DATA2 = fs.mkdtempSync(path.join(os.tmpdir(), 'lhcd-ff-agent-'));
  const { createAgent } = await import('../brain/dist/index.js');
  const agent = await createAgent({ cwd: DATA2, home: DATA2, modelOverride: { deepseek: 'deepseek-flash' }, forceFlash: 'max' });
  const m = agent.config.providers.deepseek.models;
  assert.equal(m.main.id, 'deepseek-flash');
  assert.equal(m.main.effort, 'max');
  assert.equal(m.reasoner, undefined);
  fs.rmSync(DATA2, { recursive: true, force: true });
});

test('不变量：压平后 thinking=true（深任务/工作模式）也解析到便宜档，不再有 reasoner 条目', () => {
  const providers = { deepseek: deepseekProvider() };
  // 压平前：深任务确实走 Pro（说明这个测试盯的是真缝，不是空气）
  assert.equal(modelFor(providers.deepseek.models, 'main', true), 'deepseek-v4-pro');
  forceCheapTier(providers);
  const m = providers.deepseek.models;
  assert.equal(modelFor(m, 'main', true), 'deepseek-flash'); // Tier3 / 工作模式
  assert.equal(modelFor(m, 'subagent', true), 'deepseek-flash'); // 子代理深步骤
  assert.equal(modelFor(m, 'compact', false), 'deepseek-flash'); // 记忆提炼/压缩
  assert.equal(m.reasoner, undefined); // 适配器 isReasoner 判据恒 false → 账本按 Flash 计价
  assert.equal(providers.deepseek.pricingReasoner, undefined);
});

test('关掉开关不落盘：压平只作用在内存配置上（同一份配置重压仍是 Flash，源配置不被污染）', () => {
  const src = deepseekProvider();
  const config = { providers: { deepseek: src } };
  forceCheapTier(config.providers);
  assert.equal(src.models.reasoner, undefined);
  // 重新从"干净配置"构造（模拟下次重建会话）：分档回来
  const fresh = deepseekProvider();
  assert.equal(modelFor(fresh.models, 'main', true), 'deepseek-v4-pro');
});
