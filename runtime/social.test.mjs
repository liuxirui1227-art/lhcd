// 社交单元测试：身份派生 / 信封 E2EE 与防篡改 / 双签契约 / 披露策略。
// 纯协议层（不绑定、不联网、零 LLM 成本）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, sign } from 'node:crypto';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lhcd-social-test-'));
process.env.LHCD_DATA_DIR = dataDir;
process.env.LHCD_RELAY_DIR = path.join(dataDir, 'relay');
const lib = await import('./lib.mjs');

const seedA = randomBytes(32);
const seedB = randomBytes(32);

test('deriveSocialIdentity：同 seed 同地址、格式/密钥类型正确、异 seed 必异', () => {
  const a1 = lib.deriveSocialIdentity(seedA);
  const a2 = lib.deriveSocialIdentity(seedA);
  assert.equal(a1.address, a2.address);
  assert.match(a1.address, /^[0-9a-f]{64}$/);
  assert.match(a1.dhPubHex, /^[0-9a-f]{64}$/);
  assert.ok(a1.signKey.privateKey.includes('PRIVATE KEY'));
  assert.notEqual(a1.address, lib.deriveSocialIdentity(seedB).address);
});

test('信封 E2EE：收件人能开、第三方开不了、篡改密文/签名必败', () => {
  const A = lib.deriveSocialIdentity(seedA);
  const B = lib.deriveSocialIdentity(seedB);
  const C = lib.deriveSocialIdentity(randomBytes(32));
  const env = lib.sealEnvelope({
    kind: 'letter', from: A.address, to: B.address, toDhPubHex: B.dhPubHex,
    body: { text: '今晚的月亮真圆。' }, signKey: A.signKey, dhPrivKey: A.dhPrivKey, dhPubHex: A.dhPubHex,
  });
  const r = lib.openEnvelope(env, { address: B.address, dhPrivKey: B.dhPrivKey });
  assert.ok(r.ok);
  assert.equal(r.body.text, '今晚的月亮真圆。');
  assert.equal(r.from, A.address);
  // 第三方用自己的身份开 A→B 的信 → 寻址不符
  assert.equal(lib.openEnvelope(env, { address: C.address, dhPrivKey: C.dhPrivKey }).ok, false);
  // 篡改密文 → GCM 认证失败
  const tampered = JSON.parse(JSON.stringify(env));
  tampered.box.ct = 'AAAA' + tampered.box.ct.slice(4);
  assert.equal(lib.openEnvelope(tampered, { address: B.address, dhPrivKey: B.dhPrivKey }).ok, false);
  // 篡改发件人字段 → 签名不符
  const sigTampered = { ...env, from: C.address };
  assert.equal(lib.openEnvelope(sigTampered, { address: B.address, dhPrivKey: B.dhPrivKey }).ok, false);
  // 实时消息信封（rt_message）同样解密
  const rtEnv = lib.sealEnvelope({
    kind: 'rt_message', from: A.address, to: B.address, toDhPubHex: B.dhPubHex,
    body: { text: '在吗？' }, signKey: A.signKey, dhPrivKey: A.dhPrivKey, dhPubHex: A.dhPubHex,
  });
  const rrt = lib.openEnvelope(rtEnv, { address: B.address, dhPrivKey: B.dhPrivKey });
  assert.ok(rrt.ok);
  assert.equal(rrt.body.text, '在吗？');
  assert.equal(rrt.kind, 'rt_message');
});

test('礼物契约：双签互认、换内容/换键必败；场景信封验签', () => {
  const A = lib.deriveSocialIdentity(seedA);
  const B = lib.deriveSocialIdentity(seedB);
  const g = { v: 1, giver: A.address, receiver: B.address, item_id: 'shop-scarf-starry', item_name: '星河围巾', category: 'accessory', created_at: '2026-08-22T22:00:00.000Z' };
  const h = lib.giftHash(g);
  assert.match(h, /^[0-9a-f]{64}$/);
  const sigA = lib.signGift(g, A.signKey.privateKey);
  const sigB = lib.signGift(g, B.signKey.privateKey);
  assert.ok(lib.verifyGiftSig(g, sigA, A.address));
  assert.ok(lib.verifyGiftSig(g, sigB, B.address));
  assert.equal(lib.verifyGiftSig(g, sigA, B.address), false);
  assert.equal(lib.verifyGiftSig({ ...g, item_id: 'shop-hat-echo' }, sigA, A.address), false);
  // 场景信封：合法通过、篡改 action 失败、非场景 kind 拒绝
  const good = { v: 1, id: 'x1', kind: 'scene_action', from: A.address, to: 'room-1', created_at: g.created_at, dh_pub: A.dhPubHex, body: { action: 'browse' } };
  const canonical = JSON.stringify({ v: good.v, id: good.id, kind: good.kind, from: good.from, to: good.to, created_at: good.created_at, dh_pub: good.dh_pub, body: good.body });
  good.sig = sign(null, Buffer.from(canonical, 'utf8'), A.signKey.privateKey).toString('base64');
  assert.ok(lib.openSceneEnvelope(good).ok);
  const bad = JSON.parse(JSON.stringify(good));
  bad.body.action = 'gift_offer';
  assert.equal(lib.openSceneEnvelope(bad).ok, false);
  assert.equal(lib.openSceneEnvelope({ ...good, kind: 'letter' }).ok, false);
});

test('关系契约：canonical 固定字段序、双签互认、换内容/换键必败', () => {
  const A = lib.deriveSocialIdentity(seedA);
  const B = lib.deriveSocialIdentity(seedB);
  const c = { v: 1, a: A.address, b: B.address, level: 'friend', created_at: '2026-08-22T21:00:00.000Z' };
  const h = lib.contractHash(c);
  assert.match(h, /^[0-9a-f]{64}$/);
  // 键序无关（canonical 固定字段序）
  assert.equal(h, lib.contractHash({ created_at: c.created_at, b: c.b, level: c.level, a: c.a, v: c.v }));
  const sigA = lib.signContract(c, A.signKey.privateKey);
  const sigB = lib.signContract(c, B.signKey.privateKey);
  assert.ok(lib.verifyContractSig(c, sigA, A.address));
  assert.ok(lib.verifyContractSig(c, sigB, B.address));
  assert.equal(lib.verifyContractSig(c, sigA, B.address), false);
  assert.equal(lib.verifyContractSig({ ...c, level: 'partner' }, sigA, A.address), false);
  assert.notEqual(h, lib.contractHash({ ...c, created_at: '2026-08-22T21:00:01.000Z' }));
});

test('升级/婚姻契约 canonical：含 kind 与层级字段，双签互认、换内容必败', () => {
  const A = lib.deriveSocialIdentity(seedA);
  const B = lib.deriveSocialIdentity(seedB);
  const up = { v: 1, kind: 'upgrade', a: A.address, b: B.address, from_level: 'friend', to_level: 'close', created_at: '2026-08-22T23:00:00.000Z' };
  const h = lib.contractHash(up);
  assert.match(h, /^[0-9a-f]{64}$/);
  assert.notEqual(h, lib.contractHash({ ...up, kind: 'marriage' }));
  // 键序无关（canonical 固定字段序）
  assert.equal(h, lib.contractHash({ to_level: 'close', b: B.address, from_level: 'friend', kind: 'upgrade', a: A.address, v: 1, created_at: '2026-08-22T23:00:00.000Z' }));
  const sigA = lib.signContract(up, A.signKey.privateKey);
  assert.ok(lib.verifyContractSig(up, sigA, A.address));
  assert.equal(lib.verifyContractSig({ ...up, to_level: 'partner' }, sigA, A.address), false);
  // 婚姻契约双签
  const mar = { v: 1, kind: 'marriage', a: A.address, b: B.address, level: 'partner', created_at: up.created_at };
  const mA = lib.signContract(mar, A.signKey.privateKey);
  const mB = lib.signContract(mar, B.signKey.privateKey);
  assert.ok(lib.verifyContractSig(mar, mA, A.address) && lib.verifyContractSig(mar, mB, B.address));
});

test('自主社交门禁：四道门（未绑定/无好友/深夜/用户活跃/冷却）', () => {
  const base = { bound: true, friendCount: 1, lastUserAt: 0, lastRunAt: 0, now: 1000000, quiet: false, idleMs: 100, cooldownMs: 1000 };
  assert.ok(lib.autonomousGates(base).ok);
  assert.equal(lib.autonomousGates({ ...base, bound: false }).reason, '未绑定');
  assert.equal(lib.autonomousGates({ ...base, friendCount: 0 }).reason, '没有好友');
  assert.equal(lib.autonomousGates({ ...base, quiet: true }).reason, '打扰预算：深夜不主动');
  assert.equal(lib.autonomousGates({ ...base, lastUserAt: 999999 }).reason, '用户仍活跃');
  assert.equal(lib.autonomousGates({ ...base, lastRunAt: 999900 }).reason, '冷却期内');
});

test('披露策略：敏感模式 / 绝不外泄词 / 私人记忆原文片段均拦截，普通内容放行', () => {
  const semanticDir = path.join(dataDir, 'memory', 'semantic');
  fs.mkdirSync(semanticDir, { recursive: true });
  fs.writeFileSync(path.join(semanticDir, 'diary.secret.md'), [
    '---',
    'name: diary.secret',
    'scope: project',
    'description: 私人日记',
    'confidence: medium',
    'source: t',
    'tags: auto',
    'domain: private_diary',
    'updatedAt: 2026-08-22T21:00:00.000Z',
    '---',
    '我暗恋公司前台的小雨，这件事谁都不知道。',
  ].join('\n'));
  fs.writeFileSync(path.join(dataDir, 'state.json'), JSON.stringify({
    bound: true,
    social: { disclosure_policy: { default: 'minimal', levels: { never: ['家庭住址在望京'] } } },
  }));
  assert.ok(lib.disclosureCheck('今天天气不错，出去散步。').ok);
  assert.equal(lib.disclosureCheck('我的 api_key=sk-abc12345678').ok, false);
  assert.equal(lib.disclosureCheck('我家庭住址在望京，欢迎来做客').ok, false);
  assert.equal(lib.disclosureCheck('我暗恋公司前台的小雨，这件事谁都不知道。').ok, false);
  assert.ok(lib.disclosureCheck('小雨这个名字挺好听的').ok); // 短重合不算复述
});
