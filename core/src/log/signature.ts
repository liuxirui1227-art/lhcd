// ed25519 签名：每条日志条目由作者身份签名。
// 身份密钥对从 seed 确定性派生（后续接入 seed 派生链），本模块提供底层原语。

import { createHash, generateKeyPairSync, sign, verify } from 'node:crypto';
import type { LogEntry } from './types.js';

export interface KeyPair {
  /** SPKI PEM */
  publicKey: string;
  /** PKCS8 PEM */
  privateKey: string;
}

export function generateKeyPair(): KeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}

/** 规范化序列化：字段顺序固定，签名与哈希都基于它。 */
export function canonical(entry: Omit<LogEntry, 'sig'>): string {
  return JSON.stringify({
    seq: entry.seq,
    id: entry.id,
    hlc: entry.hlc,
    prev_hash: entry.prev_hash,
    author: entry.author,
    type: entry.type,
    target: entry.target,
    payload: entry.payload,
  });
}

export function entryHash(entry: Omit<LogEntry, 'sig'>): string {
  return createHash('sha256').update(canonical(entry)).digest('hex');
}

export function signEntry(entry: Omit<LogEntry, 'sig'>, privateKeyPem: string): string {
  return sign(null, Buffer.from(canonical(entry), 'utf8'), privateKeyPem).toString('base64');
}

export function verifyEntry(entry: LogEntry, publicKeyPem: string): boolean {
  return verify(
    null,
    Buffer.from(canonical(entry), 'utf8'),
    publicKeyPem,
    Buffer.from(entry.sig, 'base64'),
  );
}
