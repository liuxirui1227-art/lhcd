// 配置写回四件套单测（乐观锁可选 / 稀疏合并 / 只写用户层 / 被覆盖要说明）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createNodeRuntime } from '../runtime/node.js';
import { writeUserConfig, readLayer, sparseOverlay, clearPath, fingerprint, layerHasPath, USER_LAYER } from './write.js';

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-cfgwrite-'));
  const rt = createNodeRuntime({ cwd: dir, storage: { sessionsDir: `${dir}/s`, logsDir: `${dir}/l`, memoryDir: `${dir}/m`, configDir: `${dir}/c` } });
  const file = path.join(dir, 'agent.json');
  return { rt, file, layer: { ...USER_LAYER, path: file } };
}

test('① 乐观锁是**可选**的：不传就直接写（对齐 codex 的 Option<String> 语义）', async () => {
  const { rt, layer } = setup();
  const r = await writeUserConfig({ runtime: rt, layer, path: ['catalog', 'allowNetwork'], value: true });
  assert.equal(r.status, 'ok');
  assert.ok(fs.readFileSync(layer.path, 'utf8').includes('"allowNetwork": true'));
});

test('① 带了版本号 → 不匹配就拒绝，**绝不覆盖别人的改动**；匹配才写', async () => {
  const { rt, layer } = setup();
  fs.writeFileSync(layer.path, JSON.stringify({ a: 1 }, null, 2));
  const cur = await readLayer(rt, layer);
  // 有人抢先改了文件
  fs.writeFileSync(layer.path, JSON.stringify({ a: 2 }, null, 2));
  const stale = await writeUserConfig({ runtime: rt, layer, path: ['b'], value: 9, expectedVersion: cur.version });
  assert.equal(stale.status, 'version-conflict');
  assert.match(stale.message, /自上次读取后已被改动/);
  assert.equal(JSON.parse(fs.readFileSync(layer.path, 'utf8')).b, undefined, '冲突时一个字都不该写');
  // 重新读 → 版本对了 → 写成功
  const fresh = await readLayer(rt, layer);
  const ok = await writeUserConfig({ runtime: rt, layer, path: ['b'], value: 9, expectedVersion: fresh.version });
  assert.equal(ok.status, 'ok');
  const after = JSON.parse(fs.readFileSync(layer.path, 'utf8'));
  assert.equal(after.a, 2, '别人的改动还在（稀疏合并）');
  assert.equal(after.b, 9);
});

test('② 稀疏合并：只动那条路径，兄弟键原样（不抹）', async () => {
  const { rt, layer } = setup();
  fs.writeFileSync(layer.path, JSON.stringify({ providers: { deepseek: { temperature: 0.8 } }, other: [1, 2] }, null, 2));
  await writeUserConfig({ runtime: rt, layer, path: ['providers', 'deepseek', 'temperature'], value: 0.5 });
  const after = JSON.parse(fs.readFileSync(layer.path, 'utf8'));
  assert.equal(after.providers.deepseek.temperature, 0.5);
  assert.deepEqual(after.other, [1, 2], '没碰的键必须原样');
  // 删键（value 缺省）
  await writeUserConfig({ runtime: rt, layer, path: ['providers', 'deepseek', 'temperature'] });
  const after2 = JSON.parse(fs.readFileSync(layer.path, 'utf8'));
  assert.equal(after2.providers.deepseek.temperature, undefined);
  assert.deepEqual(after2.providers.deepseek, {});
});

test('③ 只写允许的层：别的一律 readonly', async () => {
  const { rt, layer } = setup();
  const other = { path: layer.path, name: '项目配置', precedence: 25 };
  const r = await writeUserConfig({ runtime: rt, layer: other, path: ['x'], value: 1 });
  assert.equal(r.status, 'readonly');
  assert.match(r.message, /只允许写用户配置/);
});

test('④ 被更强的层压住：写入成功但如实说明（不是失败）', async () => {
  const { rt, layer } = setup();
  const r = await writeUserConfig({
    runtime: rt, layer, path: ['catalog', 'allowNetwork'], value: true,
    strongerLayers: [{ meta: { path: '/etc/lhcd/managed.json', name: '平台下发配置', precedence: 40 }, hasPath: true }],
  });
  assert.equal(r.status, 'ok-overridden');
  assert.match(r.message, /平台下发配置/);
  assert.match(r.message, /实际生效的是它/);
  assert.ok(fs.readFileSync(layer.path, 'utf8').includes('allowNetwork'), '写还是写进去了');
});

test('坏 JSON 的现有配置：**不覆盖**，如实报错（用户的文件不该被我们重写）', async () => {
  const { rt, layer } = setup();
  fs.writeFileSync(layer.path, '{ 这不是 JSON');
  const r = await writeUserConfig({ runtime: rt, layer, path: ['a'], value: 1 });
  assert.equal(r.status, 'error');
  assert.match(r.message, /不是合法 JSON/);
  assert.equal(fs.readFileSync(layer.path, 'utf8'), '{ 这不是 JSON', '原样不动');
});

test('纯函数：sparseOverlay / clearPath / fingerprint / layerHasPath', () => {
  assert.deepEqual(sparseOverlay(['a', 'b'], 1), { a: { b: 1 } });
  assert.deepEqual(clearPath({ a: { b: 1, c: 2 } }, ['a', 'b']), { a: { c: 2 } });
  assert.deepEqual(clearPath({ a: 1 }, ['x', 'y']), { a: 1 }, '路径不存在 → 不多不少');
  assert.equal(fingerprint('{}'), fingerprint('{}'));
  assert.notEqual(fingerprint('{}'), fingerprint('{"a":1}'));
  assert.ok(fingerprint('{}').startsWith('sha256:'));
  assert.equal(layerHasPath({ a: { b: 1 } }, ['a', 'b']), true);
  assert.equal(layerHasPath({ a: {} }, ['a', 'b']), false);
});
