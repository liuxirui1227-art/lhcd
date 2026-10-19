import { describe, expect, it } from 'vitest';
import { validateLogEntryObject, validateSpecObject } from '../src/spec/validate.js';
import type { LogEntry } from '../src/log/types.js';

function validSpec() {
  return {
    spec_version: 1,
    identity: {
      genesis: { seed_hash: 'h', birth_timestamp: '2026-08-20T12:00:00Z', spec_version: 1 },
      traits_locked: {
        gender: 'female',
        face_params: { jaw: 0.5 },
        body_params: { height_curve: 0.6 },
        voice_params: { pitch: 0.5 },
      },
    },
    persona: {
      version: 0,
      core: { traits: { warmth: 0.7 }, values: [{ text: '真诚', weight: 1 }], boundaries: ['不伤害'], attachment_style: 'secure' },
      voice: { sentence_length: 'short', formality: 0.3, emoji: 0.4, address: '直呼名字' },
    },
    memory: { log: { entries: [] } },
    capability: { runtime_profile: 'cloud' },
    life: { birth_anchor: '2026-08-20T12:00:00Z' },
  };
}

function validLogEntry(): LogEntry {
  return {
    seq: 0,
    hlc: { t: 1000, c: 0 },
    prev_hash: 'seed',
    author: 'system',
    type: 'binding',
    target: null,
    payload: {},
    sig: 'base64sig',
  };
}

describe('Spec 校验器（spec.schema.json）', () => {
  it('完整合法 Spec 通过', () => {
    expect(validateSpecObject(validSpec()).ok).toBe(true);
  });

  it('缺失必填字段被检出', () => {
    const s: any = validSpec();
    delete s.identity.genesis;
    const r = validateSpecObject(s);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('genesis'))).toBe(true);
  });

  it('非法枚举值（性别）被检出', () => {
    const s: any = validSpec();
    s.identity.traits_locked.gender = 'alien';
    expect(validateSpecObject(s).ok).toBe(false);
  });

  it('合法日志条目通过 $defs.logEntry', () => {
    expect(validateLogEntryObject(validLogEntry()).ok).toBe(true);
  });

  it('非法事件类型被检出', () => {
    const e: any = validLogEntry();
    e.type = 'evil_type';
    const r = validateLogEntryObject(e);
    expect(r.ok).toBe(false);
    expect(r.errors.join()).toContain('allowed values');
  });

  it('缺少签名的条目被检出', () => {
    const e: any = validLogEntry();
    delete e.sig;
    expect(validateLogEntryObject(e).ok).toBe(false);
  });
});
