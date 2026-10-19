// planner 任务拆解单测：DAG 校验 / 拓扑序 / 拆解协议 / 失败兜底单步。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MockProvider, mockText } from '../llm/adapters/mock.js';
import {
  decomposeTask, shouldDecompose, validatePlan, executionOrder, planToText, singleStepPlan,
  type Plan,
} from './planner.js';

const NOW = '2026-08-23T10:00:00.000Z';

function plan(partial: Partial<Plan> & Pick<Plan, 'goal' | 'steps'>): Plan {
  return { id: 'p1', goal: partial.goal, steps: partial.steps, createdAt: NOW, decomposed: true };
}

test('shouldDecompose：显式任务动词或超长请求触发；闲聊不触发', () => {
  assert.equal(shouldDecompose('帮我计划一次北京三日游'), true);
  assert.equal(shouldDecompose('把这个任务拆解成几个步骤'), true);
  assert.equal(shouldDecompose('x'.repeat(301)), true);
  assert.equal(shouldDecompose('今天好累啊，陪我聊聊'), false);
});

test('validatePlan：合法 DAG 通过', () => {
  const p = plan({
    goal: '写周报',
    steps: [
      { id: 's1', description: '收集数据', dependsOn: [], profile: { modality: 'text', depth: 'standard' } },
      { id: 's2', description: '写初稿', dependsOn: ['s1'], profile: { modality: 'text', depth: 'deep' } },
      { id: 's3', description: '校对', dependsOn: ['s2'], profile: { modality: 'text', depth: 'light' } },
    ],
  });
  assert.deepEqual(validatePlan(p), { ok: true, errors: [] });
});

test('validatePlan：缺依赖 / 自依赖 / 重复 id / 环', () => {
  const missingDep = validatePlan(plan({ goal: 'g', steps: [{ id: 's1', description: 'a', dependsOn: ['s9'], profile: { modality: 'text', depth: 'standard' } }] }));
  assert.ok(!missingDep.ok && missingDep.errors.some((e) => e.includes('s9')));

  const selfDep = validatePlan(plan({ goal: 'g', steps: [{ id: 's1', description: 'a', dependsOn: ['s1'], profile: { modality: 'text', depth: 'standard' } }] }));
  assert.ok(!selfDep.ok && selfDep.errors.some((e) => e.includes('自身')));

  const dup = validatePlan(plan({ goal: 'g', steps: [
    { id: 's1', description: 'a', dependsOn: [], profile: { modality: 'text', depth: 'standard' } },
    { id: 's1', description: 'b', dependsOn: [], profile: { modality: 'text', depth: 'standard' } },
  ] }));
  assert.ok(!dup.ok && dup.errors.some((e) => e.includes('重复')));

  const cycle = validatePlan(plan({ goal: 'g', steps: [
    { id: 's1', description: 'a', dependsOn: ['s2'], profile: { modality: 'text', depth: 'standard' } },
    { id: 's2', description: 'b', dependsOn: ['s1'], profile: { modality: 'text', depth: 'standard' } },
  ] }));
  assert.ok(!cycle.ok && cycle.errors.some((e) => e.includes('依赖环')));
});

test('executionOrder：拓扑序（依赖在前，稳定）', () => {
  const p = plan({
    goal: 'g',
    steps: [
      { id: 's3', description: '收尾', dependsOn: ['s1', 's2'], profile: { modality: 'text', depth: 'standard' } },
      { id: 's1', description: '第一步', dependsOn: [], profile: { modality: 'text', depth: 'standard' } },
      { id: 's2', description: '第二步', dependsOn: ['s1'], profile: { modality: 'text', depth: 'standard' } },
    ],
  });
  const order = executionOrder(p).map((s) => s.id);
  assert.equal(order.indexOf('s1') < order.indexOf('s2'), true);
  assert.equal(order.indexOf('s2') < order.indexOf('s3'), true);
});

test('planToText：审计渲染（含依赖与深度档标注）', () => {
  const p = plan({
    goal: '写周报',
    steps: [{ id: 's1', description: '收集数据', dependsOn: [], profile: { modality: 'text', depth: 'deep' } }],
  });
  const t = planToText(p);
  assert.ok(t.includes('写周报'));
  assert.ok(t.includes('[deep]'));
  assert.ok(t.includes('收集数据'));
});

test('decomposeTask：模型输出 JSON → 归一化 + 校验通过', async () => {
  const provider = new MockProvider({
    script: [
      mockText('```json\n{"steps":[{"id":"s1","description":"查资料","dependsOn":[],"depth":"standard"},{"id":"s2","description":"写总结","dependsOn":["s1"],"depth":"deep"}]}\n```'),
    ],
  });
  const p = await decomposeTask({ provider, goal: '帮我拆解：研究 3D 渲染并写总结', now: () => NOW });
  assert.equal(p.decomposed, true);
  assert.equal(p.steps.length, 2);
  assert.equal(p.steps[1]!.profile.depth, 'deep');
  assert.deepEqual(validatePlan(p), { ok: true, errors: [] });
});

test('decomposeTask：模型输出非法（缺步骤）→ 单步兜底不抛错', async () => {
  const provider = new MockProvider({ script: [mockText('{}')] });
  const p = await decomposeTask({ provider, goal: '帮我计划一下旅行', now: () => NOW });
  assert.equal(p.decomposed, false);
  assert.equal(p.steps.length, 1);
});

test('decomposeTask：模型输出环 → 单步兜底', async () => {
  const provider = new MockProvider({
    script: [mockText('{"steps":[{"id":"s1","description":"a","dependsOn":["s2"]},{"id":"s2","description":"b","dependsOn":["s1"]}]}')],
  });
  const p = await decomposeTask({ provider, goal: '帮我计划一下旅行', now: () => NOW });
  assert.equal(p.decomposed, false);
});

test('decomposeTask：简单请求直接单步（零模型调用）', async () => {
  const provider = new MockProvider({ script: [mockText('不应被调用')] });
  const p = await decomposeTask({ provider, goal: '你好呀', now: () => NOW });
  assert.equal(p.decomposed, false);
  assert.equal(provider.requests.length, 0);
});

test('decomposeTask：模型抛错 → 单步兜底不抛错', async () => {
  const provider = new MockProvider({ script: [] }); // 空脚本 → chat 抛错
  const p = await decomposeTask({ provider, goal: '帮我规划一次搬家', now: () => NOW });
  assert.equal(p.decomposed, false);
});

test('singleStepPlan：结构完整', () => {
  const p = singleStepPlan('写个总结', NOW);
  assert.equal(p.decomposed, false);
  assert.equal(p.steps[0]!.id, 's1');
});
