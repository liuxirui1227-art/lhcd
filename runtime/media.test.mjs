// 媒体能力单测（真 ffmpeg：现造图片/视频，逐操作验行为 + 三条硬规矩）。
// 用法：node media.test.mjs（零成本；只需本机有 ffmpeg）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createMediaPort, defaultSaveAs, verifyExpect, kindOf, engineCandidates } from './media.mjs';

const port = createMediaPort({});
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lh-media-'));
const eng = await port.available();
const hasFfmpeg = eng.ffmpeg;

/** 造夹具：图片 + 两段视频（同编码，便于测秒合） */
async function fixtures(dir) {
  const { execFileSync } = await import('node:child_process');
  // 取候选链里第一个**真的存在**的（老写法 resolveEngine 现在只返回首个候选，不查存在性）
  const e = engineCandidates({}).find((c) => !c.ffmpeg.includes('/') || fs.existsSync(c.ffmpeg)) ?? { ffmpeg: 'ffmpeg' };
  const img = path.join(dir, '图.png');
  const v1 = path.join(dir, '一段.mp4');
  const v2 = path.join(dir, '二段.mp4');
  const run = (args) => execFileSync(e.ffmpeg, ['-y', ...args], { stdio: 'pipe' });
  run(['-f', 'lavfi', '-i', 'color=c=red:s=320x240', '-frames:v', '1', img]);
  run(['-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=10', '-t', '3', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', v1]);
  run(['-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=10', '-t', '2', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', v2]);
  return { img, v1, v2 };
}

test('引擎探针：找得到 ffmpeg 并报版本；找不到时如实说没有', async () => {
  if (!hasFfmpeg) {
    assert.equal(eng.ffmpeg, false, '没 ffmpeg 时应如实报 false');
    return;
  }
  assert.ok(eng.version, '要有版本号');
  const broken = createMediaPort({ bundledDir: '/nonexistent', env: { LHCD_FFMPEG: '/nonexistent/ffmpeg' } });
  const b = await broken.available();
  assert.equal(typeof b.ffmpeg, 'boolean', '引擎缺失不该抛，只会报 false');
});

test('info：读得出尺寸/时长/编码（人话输出）', { skip: !hasFfmpeg }, async () => {
  const dir = tmp();
  const { img, v1 } = await fixtures(dir);
  const ri = await port.info({ file: img });
  assert.equal(ri.ok, true, ri.error?.message);
  assert.equal(ri.info.width, 320);
  assert.match(ri.output, /图片/);
  const rv = await port.info({ file: v1 });
  assert.equal(rv.ok, true);
  assert.match(rv.output, /视频/);
  assert.ok(rv.info.durationSec > 2.5 && rv.info.durationSec < 3.5, JSON.stringify(rv.info));
  const bad = await port.info({ file: path.join(dir, '没有这个.png') });
  assert.equal(bad.ok, false);
  assert.equal(bad.error.code, 'NOT_FOUND');
});

test('硬规矩①：改一律**另存新文件**，原件一字不动', { skip: !hasFfmpeg }, async () => {
  const dir = tmp();
  const { img } = await fixtures(dir);
  const before = fs.readFileSync(img);
  const r = await port.run({ kind: 'resize', input: img, width: 160 });
  assert.equal(r.ok, true, r.error?.message);
  assert.notEqual(r.path, img, '产物必须是新文件');
  assert.match(path.basename(r.path), /_改|_160/);
  assert.deepEqual(fs.readFileSync(img), before, '原件必须不变');
  assert.equal((await port.info({ file: r.path })).info.width, 160);
});

test('硬规矩②③：改不成/对不上 → 报错**且不留半成品**', { skip: !hasFfmpeg }, async () => {
  const dir = tmp();
  const { img } = await fixtures(dir);
  // 故意给一个不可能满足的预期：裁到 9999 宽（源图只有 320）
  const r = await port.run({ kind: 'crop', input: img, width: 9999, height: 9999, x: 0, y: 0 });
  assert.equal(r.ok, false);
  // ffmpeg 自己就会拒绝（尺寸越界），或产出后被自检拦下——两种都算"没产出"
  assert.ok(['SELF_CHECK_FAILED', 'FFMPEG_FAILED'].includes(r.error.code), JSON.stringify(r.error));
  assert.match(r.error.message, /对不上|没有产出|没做成/);
  const files = fs.readdirSync(dir).filter((f) => f.includes('_改'));
  assert.equal(files.length, 0, '不该留下半成品：' + JSON.stringify(files));
});

test('图片：缩放 / 裁剪 / 旋转 / 压缩 / 转格式', { skip: !hasFfmpeg }, async () => {
  const dir = tmp();
  const { img } = await fixtures(dir);
  const crop = await port.run({ kind: 'crop', input: img, width: 100, height: 80, x: 10, y: 10 });
  assert.equal(crop.ok, true, crop.error?.message);
  assert.deepEqual([crop.info.width, crop.info.height], [100, 80]);
  const rot = await port.run({ kind: 'rotate', input: img, degrees: 90 });
  assert.equal(rot.ok, true, rot.error?.message);
  const comp = await port.run({ kind: 'compress', input: img, level: 'strong' });
  assert.equal(comp.ok, true, comp.error?.message);
  const conv = await port.run({ kind: 'convert', input: img, saveAs: path.join(dir, '图.jpg') });
  assert.equal(conv.ok, true, conv.error?.message);
  assert.ok(fs.existsSync(path.join(dir, '图.jpg')));
});

test('视频：合并（默认秒合不重编码）/ 截取 / 抽帧 / 抽音轨', { skip: !hasFfmpeg }, async () => {
  const dir = tmp();
  const { v1, v2, img } = await fixtures(dir);
  const merged = await port.run({ kind: 'merge', inputs: [v1, v2], saveAs: path.join(dir, '合并.mp4') });
  assert.equal(merged.ok, true, merged.error?.message);
  const mi = await port.info({ file: merged.path });
  assert.ok(mi.info.durationSec > 4 && mi.info.durationSec < 6, '合并后应约 5 秒：' + JSON.stringify(mi.info));
  const trimmed = await port.run({ kind: 'trim', input: v1, from: 1, to: 2, saveAs: path.join(dir, '剪.mp4') });
  assert.equal(trimmed.ok, true, trimmed.error?.message);
  const thumb = await port.run({ kind: 'thumbnail', input: v1, atSec: 1, saveAs: path.join(dir, '封面.jpg') });
  assert.equal(thumb.ok, true, thumb.error?.message);
  // 无音轨的视频抽音轨 → 应报"没有声音"而不是假装成功
  const ea = await port.run({ kind: 'extract_audio', input: v1, saveAs: path.join(dir, '音轨.m4a') });
  assert.equal(ea.ok, false, '没声音的视频抽音轨应如实报错');
});

test('水印（文字）：支持就画上；构建缺 drawtext 就**如实拒绝**（不硬跑报英文）', { skip: !hasFfmpeg }, async () => {
  const dir = tmp();
  const { img } = await fixtures(dir);
  const r = await port.run({ kind: 'watermark', input: img, text: '灵核测试', position: 'br' });
  if (r.ok) {
    assert.ok(fs.existsSync(r.path));
  } else {
    assert.equal(r.error.code, 'FILTER_MISSING', '缺滤镜要报 FILTER_MISSING，而不是 ffmpeg 的英文堆栈：' + JSON.stringify(r.error));
    assert.match(r.error.message, /文字水印|图片水印/);
  }
});

test('参数守卫：坏参数直接拒绝（不跑 ffmpeg）', { skip: !hasFfmpeg }, async () => {
  const r = await port.run({ kind: 'resize', input: '/tmp/不存在.png', width: 100 });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'NOT_FOUND');
  const r2 = await port.run({ kind: 'trim', input: '/tmp/x.mp4', from: 5, to: 1, saveAs: '/tmp/y.mp4' });
  assert.equal(r2.ok, false, 'from > to 应被拒');
});

test('纯函数：默认另存名避开已存在文件；kindOf；verifyExpect 的人话', () => {
  const dir = tmp();
  const f = path.join(dir, 'a.mp4');
  fs.writeFileSync(f, 'x');
  const s1 = defaultSaveAs(f, '_改');
  assert.match(s1, /a_改\.mp4$/);
  fs.writeFileSync(s1, 'x');
  const s2 = defaultSaveAs(f, '_改');
  assert.match(s2, /a_改2\.mp4$/, '重名要加序号（不覆盖任何已有文件）');
  assert.equal(kindOf('a.JPG'), 'image');
  assert.equal(kindOf('a.mp4'), 'video');
  assert.equal(kindOf('a.mp3'), 'audio');
  assert.equal(kindOf('a.txt'), null);
  assert.match(verifyExpect({ width: 10, height: 10 }, { width: 20 }), /宽度期望 20/);
  assert.equal(verifyExpect({ width: 20, height: 10, durationSec: 3.02 }, { width: 20, durationSec: 3, toleranceSec: 1 }), null);
});
