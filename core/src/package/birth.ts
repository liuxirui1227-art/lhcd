// 出生包验签：与 PHP 平台端（platform/components/BirthPackage.php）字节级一致的 canonical 契约。
// 规则见 spec/README.md：
// 1. 顶层字段顺序固定（不含 signature）；
// 2. JSON.stringify 默认不转义非 ASCII 与斜杠（等价 PHP JSON_UNESCAPED_UNICODE|JSON_UNESCAPED_SLASHES）；
// 3. 空数组/空对象一律归一化为 {}（防 PHP assoc 解码失真）。

import { createPublicKey, verify as cryptoVerify } from 'node:crypto';

const ORDER = [
  'format',
  'version',
  'application_id',
  'created_at',
  'selections',
  'constitution',
  'assets',
  'platform_public_key',
] as const;

export interface BirthPackage {
  format: string;
  version: number;
  application_id: string;
  created_at: string;
  selections: Record<string, unknown>;
  constitution: Record<string, unknown>;
  assets: Record<string, unknown>;
  platform_public_key: string;
  signature: string;
}

/** 与 PHP 端一致的 canonical 序列化（固定字段序 + 空对象归一化）。 */
export function canonicalBirthPackage(pkg: BirthPackage | Record<string, unknown>): string {
  const out: Record<string, unknown> = {};
  for (const k of ORDER) {
    let v = (pkg as Record<string, unknown>)[k] ?? null;
    if (Array.isArray(v) && v.length === 0) {
      v = {};
    }
    out[k] = v;
  }
  return JSON.stringify(out);
}

/** 校验出生包结构 + 平台 ed25519 签名（公钥为裸 32 字节的 base64，需包成 SPKI）。 */
export function verifyBirthPackage(pkg: BirthPackage | Record<string, unknown>): { ok: boolean; error?: string } {
  const p = pkg as Partial<BirthPackage>;
  if (p.format !== 'dh-birth-package') return { ok: false, error: 'format 不是 dh-birth-package' };
  if (p.version !== 1) return { ok: false, error: `不支持的版本 ${p.version}` };
  if (typeof p.signature !== 'string' || typeof p.platform_public_key !== 'string') {
    return { ok: false, error: '缺少 signature / platform_public_key' };
  }
  const rawPub = Buffer.from(p.platform_public_key, 'base64');
  if (rawPub.length !== 32) return { ok: false, error: '公钥长度非法（应为 32 字节裸 ed25519）' };
  // 裸 ed25519 公钥 → SPKI DER 前缀包装
  const spkiPrefix = Buffer.from('302a300506032b6570032100', 'hex');
  const spki = Buffer.concat([spkiPrefix, rawPub]);
  let key;
  try {
    key = createPublicKey({ key: spki, format: 'der', type: 'spki' });
  } catch {
    return { ok: false, error: '公钥解析失败' };
  }
  const ok = cryptoVerify(
    null as unknown as string, // ed25519：算法传 null
    Buffer.from(canonicalBirthPackage(pkg as BirthPackage), 'utf8'),
    key,
    Buffer.from(p.signature, 'base64'),
  );
  return ok ? { ok: true } : { ok: false, error: '签名校验失败（包被篡改或非平台签发）' };
}
