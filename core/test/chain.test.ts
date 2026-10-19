import { describe, expect, it } from 'vitest';
import { MemoryLog, type IdentitySet } from '../src/log/chain.js';
import { generateKeyPair, entryHash, signEntry } from '../src/log/signature.js';
import type { LogEntry } from '../src/log/types.js';

function makeIdentities(): IdentitySet {
  return { user: generateKeyPair(), companion: generateKeyPair(), system: generateKeyPair() };
}

const SEED = 'seed-hash-0000000000000000000000000000000000000000000000000000000000000000';

describe('MemoryLog 追加式记忆日志', () => {
  it('genesis 以 seed 哈希为 root，链条完整可校验', () => {
    const log = new MemoryLog(makeIdentities(), SEED);
    const e0 = log.append('system', 'binding', { note: '出生' });
    expect(e0.seq).toBe(0);
    expect(e0.prev_hash).toBe(SEED);
    const e1 = log.appendMemory('user', 'm1', { text: '今天去了公园' });
    expect(e1.prev_hash).toBe(entryHash(e0));
    expect(log.verifyIntegrity()).toEqual({ ok: true });
  });

  it('篡改任何条目都会被检出（签名或断链）', () => {
    const log = new MemoryLog(makeIdentities(), SEED);
    log.append('system', 'binding', {});
    log.appendMemory('user', 'm1', { text: '原文' });
    log.appendMemory('user', 'm2', { text: '第二条' });

    const entries = log.export();
    entries[1] = { ...entries[1], payload: { id: 'm1', text: '被篡改' } }; // 改内容
    const r = MemoryLog.verify(entries, (log as any).identities, SEED);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('seq 1');
  });

  it('重放派生当前状态：纠正覆盖旧版、版本递增', () => {
    const log = new MemoryLog(makeIdentities(), SEED);
    log.append('system', 'binding', {});
    log.appendMemory('user', 'm1', { text: '我们约了周三' });
    log.correctMemory('user', 'm1', { text: '我们约了周五' });
    log.appendMemory('user', 'm2', { text: '喜欢咖啡' });

    const state = log.replay();
    expect(state.memories.get('m1')?.text).toBe('我们约了周五');
    expect(state.versions.get('m1')).toBe(2);
    expect(state.memories.has('m2')).toBe(true);
    expect(log.verifyIntegrity().ok).toBe(true);
  });

  it('墓碑删除后从有效状态剔除，但历史仍可审计', () => {
    const log = new MemoryLog(makeIdentities(), SEED);
    log.append('system', 'binding', {});
    log.appendMemory('user', 'm1', { text: '秘密' });
    log.appendMemory('user', 'm2', { text: '公开' });
    log.deleteMemory('user', 'm1', 'user_request');

    const state = log.replay();
    expect(state.memories.has('m1')).toBe(false);
    expect(state.deleted.has('m1')).toBe(true);
    expect(state.memories.has('m2')).toBe(true);
    // 历史条目仍在，审计链完整
    expect(log.export().length).toBe(4);
    expect(log.verifyIntegrity().ok).toBe(true);
  });

  it('伪造作者身份签名被检出', () => {
    const identities = makeIdentities();
    const log = new MemoryLog(identities, SEED);
    log.append('system', 'binding', {});
    const fake = log.appendMemory('user', 'm1', { text: 'x' });

    // 用另一套身份重签同一条目 → 校验失败
    const other = makeIdentities();
    const forged: LogEntry = { ...fake, sig: '' };
    forged.sig = signEntry({ seq: forged.seq, hlc: forged.hlc, prev_hash: forged.prev_hash, author: forged.author, type: forged.type, target: forged.target, payload: forged.payload }, other.user.privateKey);
    const entries = log.export();
    entries[1] = forged;
    const r = MemoryLog.verify(entries, identities, SEED);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('签名无效');
  });

  it('跨会话加载：导出 → 新实例导入 → 完整性一致', () => {
    const identities = makeIdentities();
    const a = new MemoryLog(identities, SEED);
    a.append('system', 'binding', {});
    a.appendMemory('user', 'm1', { text: '持久化测试' });

    const b = new MemoryLog(identities, SEED);
    for (const e of a.export()) b.loadEntry(e);
    expect(b.verifyIntegrity().ok).toBe(true);
    expect(b.replay().memories.get('m1')?.text).toBe('持久化测试');
    // loadEntry 载入的条目签名保持原样
    expect(b.export()[1].sig).toBe(a.export()[1].sig);
  });
});
