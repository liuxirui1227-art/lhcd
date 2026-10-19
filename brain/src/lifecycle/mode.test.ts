// 工作/闲聊模式（显式意图 / 规则判定 / 行为档 / 策略表）单测。
// 纪律：模式与「侧面」（facets.ts）正交——本文件不测也不该影响侧面。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseModeIntent, detectMode, behaviorUpgrade, modePolicyOf, MODE_POLICIES } from './mode.js';

test('显式切换：进入/退出/锁定三种说法都认得', () => {
  assert.deepEqual(parseModeIntent('进入工作模式'), { mode: 'work' });
  assert.deepEqual(parseModeIntent('开始干活'), { mode: 'work' });
  assert.deepEqual(parseModeIntent('切到工作模式'), { mode: 'work' });
  assert.deepEqual(parseModeIntent('退出工作模式'), { mode: 'chat' });
  assert.deepEqual(parseModeIntent('回到闲聊'), { mode: 'chat' });
  assert.deepEqual(parseModeIntent('锁定工作模式'), { mode: 'work', lock: true });
});

test('显式切换：否定句不切、长消息不猜、侧面的话不归模式管（N1 名字错开）', () => {
  assert.equal(parseModeIntent('别进入工作模式'), null);
  assert.equal(parseModeIntent('先不用退出工作模式'), null);
  assert.equal(parseModeIntent('我切到职场侧面'), null); // 侧面的话不该被模式解析器抢走
  assert.equal(parseModeIntent('x'.repeat(80) + '工作模式'), null);
});

test('规则档：带文件 / 有活跃任务 / 深度任务 → 工作模式', () => {
  assert.equal(detectMode('随便说点什么', { hasAttachment: true }).mode, 'work');
  assert.equal(detectMode('随便说点什么', { hasActiveTask: true }).mode, 'work');
  assert.equal(detectMode('随便说点什么', { deepThinking: true }).mode, 'work');
  assert.equal(detectMode('把那份报告.docx 改一下').mode, 'work'); // 点了具体文件
  assert.equal(detectMode('帮我整理一下下载文件夹').mode, 'work');
  assert.equal(detectMode('帮我改一下那份周报').mode, 'work');
});

test('规则档：闲聊不误伤（"帮我查一下天气"不是活）', () => {
  for (const t of ['今天天气怎么样', '帮我查一下天气', '我有点累', '晚上吃什么好呢', '讲个笑话']) {
    const d = detectMode(t);
    assert.equal(d.mode, 'chat', `应判闲聊: ${t}`);
    assert.equal(d.source, 'default');
  }
});

test('行为档：她真动手了才升级，只读工具不算', () => {
  assert.equal(behaviorUpgrade('chat', 'write')?.mode, 'work');
  assert.equal(behaviorUpgrade('chat', 'office')?.mode, 'work');
  assert.equal(behaviorUpgrade('chat', 'bash')?.mode, 'work');
  assert.equal(behaviorUpgrade('chat', 'read'), null); // 读文件不算"干活"
  assert.equal(behaviorUpgrade('chat', 'grep'), null);
  assert.equal(behaviorUpgrade('work', 'write'), null); // 已经是工作模式 → 不用升
});

test('策略表：两种模式的差别落在"资源/审批/验证/形象"四项（总纲 §46）', () => {
  const chat = modePolicyOf('chat');
  const work = modePolicyOf('work');
  assert.equal(chat.model, 'standard');
  assert.equal(work.model, 'strong');       // 质量第一
  assert.equal(chat.approval, 'silent');    // 闲聊绝不打断（不二次确认）
  assert.equal(work.approval, 'askR3');     // 工作模式只问 R3+
  assert.equal(chat.presence, 'free');
  assert.equal(work.presence, 'fixed');     // 干活时形象固定
  assert.equal(chat.voice, 'normal');
  assert.equal(work.voice, 'quiet');        // 静默为主
  assert.equal(work.subagents, true);       // 只有工作模式能派子代理
  assert.equal(chat.subagents, false);
  assert.ok(work.maxIterations > chat.maxIterations);
  assert.equal(work.verify, true);          // 验证契约位
  assert.equal(chat.verify, false);
  assert.deepEqual(Object.keys(MODE_POLICIES).sort(), ['chat', 'work']);
});
