import { describe, expect, it } from 'vitest';
import { hlcCompare, hlcNow } from '../src/log/hlc.js';

describe('HLC 混合逻辑时钟', () => {
  it('无前值时以物理时间为准', () => {
    const h = hlcNow(undefined, 1000);
    expect(h).toEqual({ t: 1000, c: 0 });
  });

  it('同一物理时刻内逻辑计数递增，保持严格单调', () => {
    const a = hlcNow(undefined, 1000);
    const b = hlcNow(a, 1000);
    const c = hlcNow(b, 1000);
    expect(b).toEqual({ t: 1000, c: 1 });
    expect(c).toEqual({ t: 1000, c: 2 });
    expect(hlcCompare(a, b)).toBeLessThan(0);
    expect(hlcCompare(b, c)).toBeLessThan(0);
  });

  it('物理时间前进时重置计数', () => {
    const a = hlcNow(undefined, 1000);
    const b = hlcNow({ t: 1000, c: 5 }, 2000);
    expect(b).toEqual({ t: 2000, c: 0 });
    expect(hlcCompare(a, b)).toBeLessThan(0);
  });

  it('设备时钟回拨不会破坏单调性（沿用上一时刻 + 计数）', () => {
    const a = hlcNow(undefined, 5000);
    const b = hlcNow(a, 3000); // 回拨
    expect(b.t).toBe(5000);
    expect(hlcCompare(a, b)).toBeLessThan(0);
  });
});
