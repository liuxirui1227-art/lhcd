// 多端日志合并：HLC 全序归并 / 冲突检测 / 收敛重写（链完整 + 签名有效）/ 重放一致。
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { MemoryLog, type IdentitySet } from './chain.js';
import { generateKeyPair } from './signature.js';
import { mergeByHlc, rewriteChain } from './merge.js';

function makeIdentities(): IdentitySet {
  return { user: generateKeyPair(), companion: generateKeyPair(), system: generateKeyPair() };
}

/** 构造两设备离线分支：共同 genesis → 各自独立追加（HLC 自动推进） */
function makeBranches() {
  const ids = makeIdentities();
  const seedHash = createHash('sha256').update('test-seed').digest('hex');
  const a = new MemoryLog(ids, seedHash);
  const b = new MemoryLog(ids, seedHash);
  const g = a.append('system', 'binding', { application_id: '3', created_at: '2026-08-22T00:00:00+08:00' });
  b.loadEntry(g);
  // 设备 A：工作日记忆
  a.appendMemory('user', 'm-work', { role: 'user', text: '明天上午开周会。', at: Date.now() });
  a.append('system', 'state_change', { field: 'facet', from: 'companion', to: 'career', at: Date.now() });
  // 设备 B：私人记忆 + 冲突版本
  b.appendMemory('user', 'm-feel', { role: 'user', text: '最近有点孤单。', at: Date.now() });
  b.appendMemory('user', 'm-work', { role: 'user', text: '明天下午开周会。', at: Date.now() });
  return { ids, seedHash, chainA: a.export(), chainB: b.export() };
}

describe('mergeByHlc', () => {
  it('两设备离线分支按 HLC 全序归并，各段内部顺序保持', () => {
    const { chainA, chainB } = makeBranches();
    const { entries, conflicts } = mergeByHlc([chainA, chainB]);
    // 全序：HLC 单调
    for (let i = 1; i < entries.length; i++) {
      const [t1, c1] = [entries[i - 1]!.hlc.t, entries[i - 1]!.hlc.c];
      const [t2, c2] = [entries[i]!.hlc.t, entries[i]!.hlc.c];
      // 非递减：跨分支可能同毫秒同计数（设备间无共享计数器），收敛重写时才规范化
      expect(t2 > t1 || (t2 === t1 && c2 >= c1)).toBe(true);
    }
    expect(entries.length).toBe(chainA.length + chainB.length - 1); // 共享 genesis 去重只留一份
    // 段内相对顺序保持：A 的 m-work 在 A 的 state_change 之前
    const idxWork = entries.findIndex((e) => e.payload?.id === 'm-work');
    const idxFacet = entries.findIndex((e) => e.type === 'state_change');
    expect(idxWork).toBeLessThan(idxFacet);
    // 冲突：m-work 两个版本
    expect(conflicts.length).toBe(1);
    expect(conflicts[0]!.id).toBe('m-work');
    expect(conflicts[0]!.branches.length).toBe(2);
  });
});

describe('rewriteChain', () => {
  it('重排重编号重签名 → 单链完整性通过、签名有效、重放状态正确', () => {
    const { ids, seedHash, chainA, chainB } = makeBranches();
    const { entries, conflicts } = mergeByHlc([chainA, chainB]);
    const rewritten = rewriteChain(entries, ids, seedHash);
    const log = new MemoryLog(ids, seedHash);
    for (const e of rewritten) log.loadEntry(e);
    expect(log.verifyIntegrity()).toEqual({ ok: true });
    // 重放：冲突取 HLC 较新者（B 的 m-work 晚于 A）
    const r = log.replay();
    expect(r.memories.get('m-work')?.text).toBe('明天下午开周会。');
    expect(r.memories.get('m-feel')?.text).toBe('最近有点孤单。');
    expect(conflicts.length).toBeGreaterThanOrEqual(1);
  });

  it('共享历史按签名去重：合并不复制共同前缀（含 genesis），重复合并幂等', () => {
    const { ids, seedHash } = makeBranches();
    // 显式共享历史：b 从 a 的中途分支（loadEntry 复制前两条）
    const a = new MemoryLog(ids, seedHash);
    a.append('system', 'binding', { application_id: '9' });
    a.appendMemory('user', 'm-shared', { role: 'user', text: '共同记忆' });
    const b = new MemoryLog(ids, seedHash);
    for (const e of a.export()) b.loadEntry(e);
    b.appendMemory('user', 'm-only-b', { role: 'user', text: 'B 独占' });
    const { entries, conflicts } = mergeByHlc([a.export(), b.export()]);
    // 共同前缀（2 条）只出现一次：2 + 1 = 3（不是 2 + 3）
    expect(entries.length).toBe(3);
    expect(conflicts.length).toBe(0);
    // 幂等：合并结果与 b 再合并，条目数不变（同一包重复导入不再膨胀）
    const r1 = rewriteChain(entries, ids, seedHash);
    const { entries: e2 } = mergeByHlc([r1, b.export()]);
    expect(e2.length).toBe(entries.length);
    const { entries: e3 } = mergeByHlc([r1, r1, b.export()]);
    expect(e3.length).toBe(entries.length);
  });

  it('三设备离线分支合并：HLC 全序 + 去重 + 链完整', () => {
    const ids = makeIdentities();
    const seedHash = createHash('sha256').update('s3').digest('hex');
    const base = new MemoryLog(ids, seedHash);
    base.append('system', 'binding', { application_id: '9' });
    const mk = () => {
      const l = new MemoryLog(ids, seedHash);
      for (const e of base.export()) l.loadEntry(e);
      return l;
    };
    const a = mk(); a.appendMemory('user', 'm-a', { text: 'a' });
    const b = mk(); b.appendMemory('user', 'm-b', { text: 'b' });
    const c = mk(); c.appendMemory('user', 'm-c', { text: 'c' });
    const { entries, conflicts } = mergeByHlc([a.export(), b.export(), c.export()]);
    expect(entries.length).toBe(4); // genesis + 3 独占（共享 genesis 不重复）
    expect(conflicts.length).toBe(0);
    const rewritten = rewriteChain(entries, ids, seedHash);
    const log = new MemoryLog(ids, seedHash);
    for (const e of rewritten) log.loadEntry(e);
    expect(log.verifyIntegrity()).toEqual({ ok: true });
  });

  it('append 与 correct 跨分支文本分歧也记为冲突（correct 与 append 同 id 文本不同）', () => {
    const ids = makeIdentities();
    const seedHash = createHash('sha256').update('s4').digest('hex');
    const a = new MemoryLog(ids, seedHash);
    a.appendMemory('user', 'm-x', { text: '原始版本' });
    const b = new MemoryLog(ids, seedHash);
    for (const e of a.export()) b.loadEntry(e);
    b.correctMemory('user', 'm-x', { text: 'B 端纠正版' });
    const { conflicts } = mergeByHlc([a.export(), b.export()]);
    expect(conflicts.length).toBe(1);
    expect(conflicts[0]!.id).toBe('m-x');
    expect(conflicts[0]!.branches.map((x) => x.text)).toEqual(['原始版本', 'B 端纠正版']);
  });

  it('收敛重写保留稳定条目 id：合并后再同步（重写链 × 原链）按 id 去重不膨胀', () => {
    const ids = makeIdentities();
    const seedHash = createHash('sha256').update('s5').digest('hex');
    const a = new MemoryLog(ids, seedHash);
    a.append('system', 'binding', { application_id: '9' });
    a.appendMemory('user', 'm-1', { role: 'user', text: '共同记忆' });
    const b = new MemoryLog(ids, seedHash);
    for (const e of a.export()) b.loadEntry(e);
    b.appendMemory('user', 'm-2', { role: 'user', text: 'B 独占' });
    // 第一次合并 → 收敛重写（重签名，sig 全变）
    const { entries: m1 } = mergeByHlc([a.export(), b.export()]);
    const r1 = rewriteChain(m1, ids, seedHash);
    expect(r1.every((e) => typeof e.id === 'string' && e.id.length > 0)).toBe(true);
    expect(r1[0]!.id).toBe(a.export()[0]!.id); // 重写保留原 id
    // 设备 A 继续追加新条目（原链 sig 不变）→ 第二次同步：重写链 × 原链（sig 全不同，靠 id 去重）
    a.appendMemory('user', 'm-3', { role: 'user', text: 'A 新记忆' });
    const { entries: m2, conflicts } = mergeByHlc([r1, a.export()]);
    // 唯一条目 = binding + m-1 + m-2 + m-3 = 4（不因重写链与原链无共同签名而复制历史）
    expect(m2.length).toBe(4);
    expect(conflicts.length).toBe(0);
    const r2 = rewriteChain(m2, ids, seedHash);
    const log = new MemoryLog(ids, seedHash);
    for (const e of r2) log.loadEntry(e);
    expect(log.verifyIntegrity()).toEqual({ ok: true });
    expect(log.replay().memories.size).toBe(3);
  });

  it('同链内 append→correct 是正常修正，不误报冲突', () => {
    const ids = makeIdentities();
    const seedHash = createHash('sha256').update('s6').digest('hex');
    const a = new MemoryLog(ids, seedHash);
    a.appendMemory('user', 'm-y', { text: '初版' });
    a.correctMemory('user', 'm-y', { text: '修正版' });
    const { conflicts } = mergeByHlc([a.export()]);
    expect(conflicts.length).toBe(0);
    // 跨分支：另一设备仍停留在初版 → 分支最终文本分歧，才记冲突
    const b = new MemoryLog(ids, seedHash);
    b.appendMemory('user', 'm-y', { text: '初版' });
    const m = mergeByHlc([a.export(), b.export()]);
    expect(m.conflicts.length).toBe(1);
    expect(m.conflicts[0]!.branches.length).toBe(2);
    expect(m.conflicts[0]!.branches.map((x) => x.text)).toContain('初版');
    expect(m.conflicts[0]!.branches.map((x) => x.text)).toContain('修正版');
  });

  it('跨设备同 id 纠正/删除按全序重放正确应用', () => {
    const ids = makeIdentities();
    const seedHash = createHash('sha256').update('s2').digest('hex');
    const a = new MemoryLog(ids, seedHash);
    a.appendMemory('user', 'm-1', { text: 'v1' });
    const b = new MemoryLog(ids, seedHash);
    for (const e of a.export()) b.loadEntry(e);
    a.correctMemory('user', 'm-1', { text: 'v2 更正' });
    b.deleteMemory('user', 'm-1');
    const { entries } = mergeByHlc([a.export(), b.export()]);
    const rewritten = rewriteChain(entries, ids, seedHash);
    const log = new MemoryLog(ids, seedHash);
    for (const e of rewritten) log.loadEntry(e);
    expect(log.verifyIntegrity()).toEqual({ ok: true });
    const r = log.replay();
    // HLC 更晚者胜出：a 的纠正（早）vs b 的删除（晚）→ 删除生效
    expect(r.memories.has('m-1')).toBe(false);
    expect(r.deleted.has('m-1')).toBe(true);
  });
});
