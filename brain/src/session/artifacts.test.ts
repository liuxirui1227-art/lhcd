// 产物登记：只登记"她做出来的"，只追加，读得回来。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ArtifactLog, classifyArtifact, artifactFromMutation, PRODUCING_TOOLS } from './artifacts.js';
import { createNodeRuntime } from '../runtime/node.js';

function mk() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-artifacts-'));
  const rt = createNodeRuntime({
    cwd: dir,
    storage: { sessionsDir: `${dir}/s`, logsDir: `${dir}/l`, memoryDir: `${dir}/m`, configDir: `${dir}/c` },
  });
  return { dir, rt };
}

test('归类：按扩展名给类型与 mime；认不出就是 other（不猜）', () => {
  assert.equal(classifyArtifact('/a/月报.xlsx').type, 'sheet');
  assert.equal(classifyArtifact('/a/汇报.md').type, 'text');
  assert.equal(classifyArtifact('/a/图表.png').type, 'image');
  assert.equal(classifyArtifact('/a/x.docx').type, 'document');
  assert.equal(classifyArtifact('/a/怪东西.zzz').type, 'other');
  assert.equal(classifyArtifact('/a/怪东西.zzz').mimeType, 'application/octet-stream');
});

test('只有"做出来"的工具算产物：read/grep 这类不算', () => {
  assert.ok(PRODUCING_TOOLS.has('write') && PRODUCING_TOOLS.has('office'));
  assert.equal(artifactFromMutation({ tool: 'read', path: '/a.txt', at: 1 }, 's1', '2026-09-26T00:00:00.000Z'), null);
  const a = artifactFromMutation({ tool: 'write', path: '/a/月报.xlsx', at: 1 }, 's1', '2026-09-26T00:00:00.000Z', 3);
  assert.ok(a);
  assert.equal(a!.type, 'sheet');
  assert.equal(a!.createdBy, 'write');
  assert.equal(a!.sessionId, 's1');
  assert.equal(a!.turnSeq, 3);
});

test('台账：只追加、读得回来、带稳定 id；没有台账不算错', async () => {
  const { rt } = mk();
  const log = new ArtifactLog(rt, 'main');
  assert.deepEqual(await log.list(), [], '还没做出过东西 → 空数组，不抛');
  const a1 = await log.append({ type: 'text', mimeType: 'text/plain', path: '/a/汇报.md', createdBy: 'write', createdAt: '2026-09-26T00:00:00.000Z', sessionId: 'main' });
  const a2 = await log.append({ type: 'image', mimeType: 'image/*', path: '/a/图表.png', createdBy: 'media', createdAt: '2026-09-26T00:01:00.000Z', sessionId: 'main' });
  assert.notEqual(a1.id, a2.id);
  assert.match(a1.id, /^art-/);
  const list = await log.list();
  assert.equal(list.length, 2);
  assert.equal(list[1]!.path, '/a/图表.png');
  // 只追加：文件行数 = 条数，重开一个实例还能读到（不是内存态）
  const again = await new ArtifactLog(rt, 'main').list();
  assert.equal(again.length, 2);
});
