// Prompt 分层与层指纹。两条要守住的性质：
//   ① **字节稳定**：拼接顺序恒为 stable→context→selective→volatile，同一输入 system 字节相等；
//   ② **指纹说话**：同输入同哈希；会变的那一层（volatile）变了，前三层的哈希一个都不许动。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildFrozen } from './assemble.js';
import { LAYER_ORDER, emptyLayers, renderLayers, renderLayerText } from './layers.js';
import { ToolRegistry } from '../tools/registry.js';
import { readTool } from '../tools/read.js';
import { createNodeRuntime } from '../runtime/node.js';
import { loadConfig } from '../config/load.js';

function makeCtx() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-layers-'));
  const registry = new ToolRegistry();
  registry.register(readTool());
  const rt = createNodeRuntime({
    cwd: dir,
    storage: { sessionsDir: `${dir}/s`, logsDir: `${dir}/l`, memoryDir: `${dir}/m`, configDir: `${dir}/c` },
  });
  return { registry, rt, config: loadConfig({ cwd: dir, home: dir }) };
}

test('分层容器：空层不产出空行；顺序恒为 stable→context→selective→volatile', () => {
  const l = emptyLayers();
  l.context.push('C');
  l.stable.push('A');
  l.volatile.push('D');
  l.selective.push('B');
  assert.equal(renderLayers(l), 'A\n\nC\n\nB\n\nD');
  assert.deepEqual([...LAYER_ORDER], ['stable', 'context', 'selective', 'volatile']);
  assert.equal(renderLayerText(l, 'stable'), 'A');
  assert.equal(renderLayerText(emptyLayers(), 'selective'), '');
});

test('分层不改变顺序：各块的先后必须与旧实现一致（stable→context→selective→volatile）', () => {
  const { registry, rt, config } = makeCtx();
  const frozen = buildFrozen({
    config, registry, runtime: rt,
    projectMemory: '项目记忆原文', semanticItems: ['记得你喜欢安静'], identityItems: '- 别催我',
    skillsIndex: '【技能索引】\n- 一件', agentsIndex: '【分身名册】\n- 查证员',
    timeAnchor: '【现在是什么时候】现在是 9 月 27 日凌晨 1 点。',
  });
  const order = ['【项目记忆', '【你给 TA 定过的长期规矩', '【语义记忆', '【技能索引', '【分身名册', '【现在是什么时候'];
  let at = -1;
  for (const marker of order) {
    const i = frozen.system.indexOf(marker);
    assert.ok(i > at, `${marker} 的顺序不对（i=${i}, at=${at}）`);
    at = i;
  }
  // 时间锚点必须在**最末尾**（挪了就等于把缓存尾巴拉长）
  assert.ok(frozen.system.slice(-80).includes('现在是什么时候'), '时间锚点要在 system 末尾');
});

test('层指纹：同输入同哈希；volatile 变，前三层一个都不动（缓存作废说得清）', () => {
  const { registry, rt, config } = makeCtx();
  const base = {
    config, registry, runtime: rt,
    projectMemory: '项目记忆原文', semanticItems: ['记得你喜欢安静'], identityItems: '- 别催我',
  };
  const a = buildFrozen({ ...base, timeAnchor: '【现在是什么时候】现在是 9 月 26 日。' });
  const b = buildFrozen({ ...base, timeAnchor: '【现在是什么时候】现在是 9 月 27 日凌晨 1 点。' });
  const c = buildFrozen({ ...base, timeAnchor: '【现在是什么时候】现在是 9 月 26 日。' });

  assert.deepEqual(a.layerHashes, c.layerHashes, '同输入必须同哈希');
  assert.notEqual(a.layerHashes.volatile, b.layerHashes.volatile, 'volatile 变了，指纹要变');
  for (const layer of ['stable', 'context', 'selective'] as const) {
    assert.equal(a.layerHashes[layer], b.layerHashes[layer], `${layer} 不该被 volatile 的改动带着变`);
  }
});

test('层指纹：记忆/规矩变了 → context 或 selective 变，stable 不变', () => {
  const { registry, rt, config } = makeCtx();
  const base = { config, registry, runtime: rt };
  const a = buildFrozen({ ...base, identityItems: '- 别催我', semanticItems: ['记得 A'] });
  const b = buildFrozen({ ...base, identityItems: '- 别催我', semanticItems: ['记得 B'] });
  const d = buildFrozen({ ...base, identityItems: '- 说话短一点', semanticItems: ['记得 A'] });
  assert.equal(a.layerHashes.stable, b.layerHashes.stable);
  assert.notEqual(a.layerHashes.selective, b.layerHashes.selective, '记忆换了 → selective 变');
  assert.notEqual(a.layerHashes.context, d.layerHashes.context, '规矩换了 → context 变');
  assert.equal(a.layerHashes.selective, d.layerHashes.selective);
});
