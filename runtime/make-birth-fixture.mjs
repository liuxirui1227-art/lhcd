// 冒烟夹具生成器：/tmp/birth-3.json（**平台签名合法的出生包**）
//
// 用法：cd runtime && node make-birth-fixture.mjs
//
// 为什么要单独有这个脚本：
//   · 夹具放在 `/tmp`，而 **macOS 会清 /tmp**（跨天 / 重启后）→ 依赖它的冒烟会静默失败
//     （症状：人物卡断言全空 / `Cannot read properties of undefined`）。
//   · 只**消费**夹具的脚本不会自动产出它——这个脚本才是那个"首次生成"。
//
// 夹具必须是**真签名的包**（`verifyBirthPackage` 要验 ed25519）：`lib.mockBirth()` 造出来的
// 本地包 `platform_public_key='mock-offline'` **过不了验签**，只能走"本地出生"那条路，
// 当不了夹具。所以这里现场生成一对 ed25519 密钥、按 `canonicalBirthPackage()` 的规范签名。
import fs from 'node:fs';
import { generateKeyPairSync, sign as edSign } from 'node:crypto';
import { canonicalBirthPackage } from '../core/dist/package/birth.js';

const OUT = process.env.BIRTH_FIXTURE || '/tmp/birth-3.json';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
// verifyBirthPackage 要的是**裸 32 字节**公钥的 base64（它自己包成 SPKI）
const rawPub = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);

const pkg = {
  format: 'dh-birth-package',
  version: 1,
  application_id: 'fixture-' + Date.now().toString(36),
  created_at: new Date().toISOString(),
  selections: {
    name: '小核',
    live2d_model_id: '',
    personality_template: 'steady-guardian',
    voice: { voice_name: 'Cherry' },
  },
  // 宪法：字段与线上出生包同形（冒烟只读 name/age/facet，不主张这里的内容）
  constitution: {
    version: 0,
    core: {
      traits: { warmth: 0.8, curiosity: 0.85, humor: 0.7, assertiveness: 0.55 },
      values: [
        { text: '把日子过得有劲头，陪你一起冲', weight: 1 },
        { text: '把安全感稳稳地放在你身边，不煽情但有行动力', weight: 0.95 },
      ],
      boundaries: ['不强迫你立刻振作', '不轻视你的烦恼'],
      attachment_style: 'secure',
    },
    voice: { sentence_length: 'short', formality: 0.15, emoji: 0.7, address: '直呼名字' },
    meta: { template: 'steady-guardian', fixture: true },
  },
  assets: {},
  platform_public_key: rawPub.toString('base64'),
};
// 签名：对"不含 signature 字段"的规范化 JSON 签（与 core 的 canonicalBirthPackage 同一套）
pkg.signature = edSign(null, Buffer.from(canonicalBirthPackage(pkg), 'utf8'), privateKey).toString('base64');

fs.writeFileSync(OUT, JSON.stringify(pkg, null, 2));
console.log('已生成夹具：', OUT, `（${fs.statSync(OUT).size} 字节，application_id=${pkg.application_id}）`);

// 自证：生成的东西必须真的能过验签（不然又是一个"看着像"的夹具）
const { verifyBirthPackage } = await import('../core/dist/package/birth.js');
const v = verifyBirthPackage(JSON.parse(fs.readFileSync(OUT, 'utf8')));
console.log('自证验签：', v.ok ? '✅ 通过' : `❌ ${v.error}`);
if (!v.ok) process.exit(1);
