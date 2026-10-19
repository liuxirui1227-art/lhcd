// **传图通道**的两条硬规矩。
//
// 这条通道以前根本不存在（`preload.chat(text)` 只有一个参数），而宿主侧的看图能力一直都在
// （`toImageDataUrl` + 视觉档路由）。补齐之后最容易出的两种问题是：
//   ① 没配视觉模型却"假装看懂了" —— 要求"如实说看不懂"；
//   ② 多图（输入条能连粘几张）把内核压垮 —— 单图时代的老代码只认一个字符串。
// 这个测试把这两条钉住（零成本：不调 LLM、不写用户数据）。
import fs from 'node:fs';
import path from 'node:path';

const dir = '/tmp/lhcd-vision-paste-test';
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ bound: true, intimacy: 0 }));
process.env.LHCD_DATA_DIR = dir;

const lib = await import('./lib.mjs');
// 要先"出生"才有一条对话链路（`chat()` 在未绑定时直接返回"尚未绑定"）——
// 用 mock 出生（零成本、不落用户数据目录）
lib.mockBirth({ name: '测试体' });

// ⚠⚠ 必须在 **import 之后**再清视觉 key：`lib.mjs` 在 import 时会读 `runtime/.env` / `~/.lhcd/.env`
//    并把 key 塞进 `process.env`。若在 import 之前清，这个"零成本"测试**真的会发两次
//    视觉请求**（1×1 的图被服务端 400 拒了 `image ... must be larger than 10`，因此没有计费，
//    但这是运气好）。下面这行断言就是护栏：key 还在就当场炸，绝不再花钱。
delete process.env.IMAGE_API_KEY;
delete process.env.DASHSCOPE_API_KEY;
if (process.env.IMAGE_API_KEY || process.env.DASHSCOPE_API_KEY) {
  throw new Error('视觉 key 没清干净：这个测试会发真请求（花钱）——先修测试再跑');
}

let n = 0;
const ok = (cond, label) => { n++; if (!cond) throw new Error(label); };

const IMG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

// ① 单图 + 没配视觉模型 → 如实说"看不了"，**不许**编一个"我看到了"
const one = await lib.chat('这张图里的报错是什么意思', () => {}, { image: IMG });
ok(one.ok === false && one.error === 'NO_VISION_KEY', `单图缺 key 应如实拒绝（拿到 ${JSON.stringify(one.error)}）`);
ok(/看图能力/.test(one.reply ?? ''), `拒绝的话要说人话（拿到「${one.reply}」）`);

// ② 多图（输入条能连粘几张）也要走同一条路：不抛、不静默吞、同样如实说
const many = await lib.chat('这两张图对一下', () => {}, { image: [IMG, IMG, IMG] });
ok(many.ok === false && many.error === 'NO_VISION_KEY', '多图缺 key 同样如实拒绝（数组不许把它弄崩）');

// ③ 上限 4 张：给 9 张也不该抛（截断发生在 lib 里，UI 那边还有一层提示）
const lots = await lib.chat('看这些', () => {}, { image: Array.from({ length: 9 }, () => IMG) });
ok(lots.ok === false && lots.error === 'NO_VISION_KEY', '给 9 张也不许抛（先截到 4 张再走视觉链路）');

// ④ 不带图的行为一个字没变（回归）：这条通道是**加法**，不是改造
const plain = await lib.chat('你好', () => {}, {});
ok(plain.ok === false || plain.ok === true, '不带图照旧走原文路径（这里只断言没被传图逻辑带崩）');

console.log(`传图通道 ${n} 项断言通过 ✓（缺视觉模型时如实说 / 多图不崩 / 不带图不受影响）`);
process.exit(0);
