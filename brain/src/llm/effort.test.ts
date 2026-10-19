// 内核自动选档（不加工件界面，按任务复杂度自动升降）。
// 三档来自 DeepSeek V4.1 服务端枚举的折叠（low/high/max）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { effortFor } from './effort.js';

test('闲聊主档 → low（省）；深任务/工作模式主档（thinking）→ max（拉满）', () => {
  assert.equal(effortFor({ role: 'main', thinking: false }), 'low');
  assert.equal(effortFor({ role: 'main', thinking: true }), 'max'); // Tier3 深任务 / 工作模式
});

test('轻活（记忆提炼/压缩/快速档）→ low：机械活不深思', () => {
  for (const role of ['compact', 'fast']) {
    assert.equal(effortFor({ role, thinking: false }), 'low');
    // 即便被标了 thinking（深档的压缩），也不该为摘要烧 max
    assert.equal(effortFor({ role, thinking: true }), 'low');
  }
});

test('子代理：普通步骤 high、深步骤 max（分身干的是真活，别太抠）', () => {
  assert.equal(effortFor({ role: 'subagent', thinking: false }), 'high');
  assert.equal(effortFor({ role: 'subagent', thinking: true }), 'max');
});

test('未知角色按主档处理（不漏发档位）', () => {
  assert.equal(effortFor({ role: 'weird', thinking: false }), 'low');
  assert.equal(effortFor({ role: 'weird', thinking: true }), 'max');
});
