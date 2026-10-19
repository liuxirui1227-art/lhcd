import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalBirthPackage, verifyBirthPackage } from '../src/package/birth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 夹具：由 PHP 平台真实签发的出生包（应用 #3）
const pkg = JSON.parse(readFileSync(path.join(__dirname, 'fixtures/birth-3.json'), 'utf8'));

describe('出生包跨语言契约（PHP 签发 → TS 验签）', () => {
  it('canonical 与 PHP 端字节一致（签名验证通过）', () => {
    const r = verifyBirthPackage(pkg);
    expect(r.ok).toBe(true);
  });

  it('篡改选配被检出', () => {
    const bad = JSON.parse(JSON.stringify(pkg));
    bad.selections.gender = 'male';
    expect(verifyBirthPackage(bad).ok).toBe(false);
  });

  it('篡改宪法被检出', () => {
    const bad = JSON.parse(JSON.stringify(pkg));
    bad.constitution.core.traits.warmth = 0;
    expect(verifyBirthPackage(bad).ok).toBe(false);
  });

  it('错误 format 被拒绝', () => {
    const bad = JSON.parse(JSON.stringify(pkg));
    bad.format = 'evil';
    expect(verifyBirthPackage(bad).error).toContain('format');
  });

  it('canonical 输出不含 signature 字段', () => {
    const c = canonicalBirthPackage(pkg);
    expect(JSON.parse(c).signature).toBeUndefined();
    expect(Object.keys(JSON.parse(c))[0]).toBe('format');
  });
});
