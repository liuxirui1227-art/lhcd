// 模型注册表 + 任务路由单测：能力门 / 打分公式 / 回退链 / 缺省派生。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  routeTask, scoreProfile, qualityScore, latencyScore, costScore, supportsCapability, deriveProfiles,
  type ModelProfile, type TaskProfile,
} from './registry.js';

const chat: ModelProfile = { id: 'ds.chat', provider: 'deepseek', model: 'deepseek-chat', capabilities: ['text'], tier: 'standard', latency: 2, costPerMOut: 4.5 };
const reasoner: ModelProfile = { id: 'ds.reasoner', provider: 'deepseek', model: 'deepseek-reasoner', capabilities: ['text', 'reasoning'], tier: 'deep', thinking: true, latency: 4, costPerMOut: 13.5 };
const vision: ModelProfile = { id: 'qw.vl', provider: 'qwen', model: 'qwen-vl-plus', capabilities: ['text', 'vision'], tier: 'standard', latency: 3, costPerMOut: 8 };
const local: ModelProfile = { id: 'local.q4', provider: 'llama', model: 'qwen2.5-0.5b', capabilities: ['text'], tier: 'light', latency: 1, costPerMOut: 0 };

test('supportsCapability：能力门（reasoning 是附加能力，非路由门）', () => {
  assert.equal(supportsCapability(chat, 'text'), true);
  assert.equal(supportsCapability(chat, 'vision'), false);
  assert.equal(supportsCapability(reasoner, 'text'), true);
  assert.equal(supportsCapability(chat, 'audio'), false);
});

test('qualityScore：档位差 0→1，差 2→0', () => {
  assert.equal(qualityScore(chat, 'standard'), 1);
  assert.equal(qualityScore(chat, 'deep'), 0.5);
  assert.equal(qualityScore(local, 'deep'), 0);
});

test('latencyScore：latency 1→1，5→0，缺省 3→0.5', () => {
  assert.equal(latencyScore(local), 1);
  assert.equal(latencyScore(reasoner), 0.25);
  assert.equal(latencyScore({ ...chat, latency: undefined }), 0.5);
});

test('costScore：价格档（未知 0.6；≤4→1；≤8→0.8；≤15→0.5；>15→0.2）', () => {
  assert.equal(costScore({ ...chat, costPerMOut: undefined }), 0.6);
  assert.equal(costScore({ ...chat, costPerMOut: 3 }), 1);
  assert.equal(costScore(chat), 0.8); // 4.5 元/M → ≤8 档
  assert.equal(costScore(vision), 0.8);
  assert.equal(costScore(reasoner), 0.5);
  assert.equal(costScore({ ...chat, costPerMOut: 30 }), 0.2);
});

test('routeTask：能力门过滤 + 降序回退链', () => {
  const profiles = [local, chat, reasoner];
  const r = routeTask(profiles, { modality: 'text', depth: 'deep', qualityNeed: 0.9 });
  // 深度任务：质量需求高 → reasoner 应排最前；local（档位差 2）垫底
  assert.equal(r[0]!.id, 'ds.reasoner');
  assert.equal(r[r.length - 1]!.id, 'local.q4');
});

test('routeTask：vision 任务只留含 vision 能力的条目', () => {
  const r = routeTask([chat, reasoner, vision], { modality: 'vision', depth: 'standard' });
  assert.deepEqual(r.map((p) => p.id), ['qw.vl']);
});

test('routeTask：延迟敏感任务 → 同深度下低延迟模型占优；轻量深度需求下快模型胜出', () => {
  // 标准深度 + 高延迟敏感：chat（latency 2）应胜过 reasoner（latency 4，深度档质量分相同）
  const r1 = routeTask([reasoner, chat], { modality: 'text', depth: 'standard', latencySensitive: 1, costSensitive: 0, qualityNeed: 0.5 });
  assert.equal(r1[0]!.id, 'ds.chat');
  // 轻量深度需求（招呼/轻闲聊）：local 快模型胜出
  const r2 = routeTask([chat, local], { modality: 'text', depth: 'light', latencySensitive: 1, costSensitive: 0, qualityNeed: 0.5 });
  assert.equal(r2[0]!.id, 'local.q4');
});

test('routeTask：成本敏感任务 → 零成本本地模型占优', () => {
  const r = routeTask([reasoner, chat, local], { modality: 'text', depth: 'light', costSensitive: 1, latencySensitive: 0, qualityNeed: 0.2 });
  assert.equal(r[0]!.id, 'local.q4');
});

test('scoreProfile：确定性分数（同输入同输出）', () => {
  const task: TaskProfile = { modality: 'text', depth: 'standard' };
  const a = scoreProfile(chat, task);
  const b = scoreProfile(chat, task);
  assert.equal(a.score, b.score);
  assert.ok(a.score > 0 && a.score <= 1);
});

test('deriveProfiles：缺省派生（main→standard/text；reasoner→deep/text+reasoning）', () => {
  const profiles = deriveProfiles({
    deepseek: { models: { main: { id: 'deepseek-chat' }, reasoner: { id: 'deepseek-reasoner' } } },
    qwen: { models: { main: { id: 'qwen-plus' } } },
  });
  assert.equal(profiles.length, 3);
  const ds = profiles.find((p) => p.id === 'deepseek.main')!;
  assert.deepEqual(ds.capabilities, ['text']);
  assert.equal(ds.tier, 'standard');
  const dsr = profiles.find((p) => p.id === 'deepseek.reasoner')!;
  assert.equal(dsr.thinking, true);
  assert.deepEqual(dsr.capabilities, ['text', 'reasoning']);
  assert.equal(dsr.tier, 'deep');
});
