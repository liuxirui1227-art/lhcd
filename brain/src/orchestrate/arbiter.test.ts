// 出声仲裁器（唯一"能不能出声"闸门）单测。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { arbitrate, noteDelivered, inQuietHours, contentHash, dayKey, remainingQuota, type ArbiterState } from './arbiter.js';

const at = (h: number, m = 0) => new Date(2026, 8, 18, h, m, 0); // 2026-09-18（本地时区）

test('免打扰时段：跨午夜 23–8 判定正确；起止相同=关闭', () => {
  assert.equal(inQuietHours(at(23, 30), 23, 8), true);
  assert.equal(inQuietHours(at(3), 23, 8), true);
  assert.equal(inQuietHours(at(7, 59), 23, 8), true);
  assert.equal(inQuietHours(at(8), 23, 8), false);
  assert.equal(inQuietHours(at(12), 23, 8), false);
  assert.equal(inQuietHours(at(3), 8, 8), false); // 关闭
  assert.equal(inQuietHours(at(10), 9, 12), true); // 非跨午夜
  assert.equal(inQuietHours(at(8, 59), 9, 12), false);
});

test('条 45①：用户设的提醒（reminder）不受免打扰与配额约束——该响必须响', () => {
  const st: ArbiterState = { day: dayKey(at(3)), count: 99, backoff: {} };
  const d = arbitrate({ source: 'cron', kind: 'reminder', now: at(3), quietStart: 23, quietEnd: 8, maxPerDay: 3 }, st);
  assert.equal(d.allow, true);
  assert.equal(d.channel, 'bubble');
});

test('条 45①：TA 自发（proactive）——免打扰时段拒绝 / 配额用尽拒绝', () => {
  const quiet = arbitrate({ source: 'heartbeat', kind: 'proactive', now: at(2), quietStart: 23, quietEnd: 8 }, undefined);
  assert.deepEqual([quiet.allow, quiet.reason, quiet.channel], [false, 'quiet', 'silent']);

  const spent: ArbiterState = { day: dayKey(at(15)), count: 3, backoff: {} };
  const quota = arbitrate({ source: 'heartbeat', kind: 'proactive', now: at(15), maxPerDay: 3 }, spent);
  assert.deepEqual([quota.allow, quota.reason], [false, 'quota']);
});

test('条 45③：变化门——内容没变不叫醒，且退避翻倍（封顶 15 分钟）', () => {
  let st: ArbiterState | undefined = { day: dayKey(at(10)), count: 1, backoff: {} };
  const req = { source: 'info-sync', kind: 'proactive' as const, content: '您 10:30 有个会', now: at(10), quietStart: 23, quietEnd: 8, maxPerDay: 5 };
  // 第一次：内容变了（无历史）→ 允许
  let d = arbitrate(req, st);
  assert.equal(d.allow, true);
  st = noteDelivered(d.state, 'info-sync', req.content, at(10));
  assert.equal(st.backoff['info-sync']!.intervalMs, 60 * 1000);
  assert.equal(st.count, 2);

  // 同样内容、退避窗口外 → unchanged（并翻倍到 2 分钟）
  const later = new Date(at(10).getTime() + 2 * 60 * 1000);
  d = arbitrate({ ...req, now: later }, st);
  assert.equal(d.allow, false);
  assert.equal(d.reason, 'unchanged');
  assert.equal(d.state.backoff['info-sync']!.intervalMs, 2 * 60 * 1000);

  // 继续没变 → 4 分钟 → …封顶 15
  let cur = d.state;
  for (const expect of [4, 8, 15, 15]) {
    const t = new Date(cur.backoff['info-sync']!.lastSpokeAt + cur.backoff['info-sync']!.intervalMs + 1000);
    const dd = arbitrate({ ...req, now: t }, cur);
    assert.equal(dd.reason, 'unchanged');
    assert.equal(dd.state.backoff['info-sync']!.intervalMs, expect * 60 * 1000);
    cur = dd.state;
  }

  // 内容一变 → 立刻回到最小间隔并允许
  const changed = { ...req, content: '您 14:00 有个评审', now: new Date(cur.backoff['info-sync']!.lastSpokeAt + 16 * 60 * 1000) };
  const dc = arbitrate(changed, cur);
  assert.equal(dc.allow, true);
});

test('条 45④：退避窗口内内容变了也要等（notBefore 给出最早时刻）', () => {
  const spokeAt = at(10).getTime();
  const st: ArbiterState = { day: dayKey(at(10)), count: 1, backoff: { social: { intervalMs: 4 * 60 * 1000, lastHash: 'x', lastSpokeAt: spokeAt } } };
  const d = arbitrate({ source: 'social', kind: 'proactive', content: '换了个话题', now: at(10, 1), quietStart: 23, quietEnd: 8, maxPerDay: 5 }, st);
  assert.equal(d.allow, false);
  assert.equal(d.reason, 'backoff');
  assert.equal(d.notBefore, spokeAt + 4 * 60 * 1000);

  const ok = arbitrate({ source: 'social', kind: 'proactive', content: '换了个话题', now: new Date(spokeAt + 5 * 60 * 1000), quietStart: 23, quietEnd: 8, maxPerDay: 5 }, st);
  assert.equal(ok.allow, true);
});

test('跨日自动归零：昨天的配额不算今天的', () => {
  const st: ArbiterState = { day: '2026-09-17', count: 99, backoff: {} };
  const d = arbitrate({ source: 'heartbeat', kind: 'proactive', now: at(10), maxPerDay: 3 }, st);
  assert.equal(d.allow, true);
  assert.equal(d.state.count, 0);
  assert.equal(remainingQuota(st, 3, at(10)), 3);
});

test('contentHash：剥掉时间戳/日期，否则退避形同虚设', () => {
  assert.equal(contentHash('您 10:30 有个会') === contentHash('您 14:00 有个会'), true);
  assert.equal(contentHash('2026-09-18 的日报已生成') === contentHash('2026-09-19 的日报已生成'), true);
  assert.equal(contentHash('会议改到明天'), contentHash(' 会议改到明天 '));
  assert.notEqual(contentHash('会议改到明天'), contentHash('会议取消了'));
});
