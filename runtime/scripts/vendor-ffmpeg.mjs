// 随包 ffmpeg：把一份 ffmpeg/ffprobe 放进 runtime/data/bin/<平台>/，
// 打包时随 App 走 —— 无需另装（开箱即用）。
//
// ⚠️ **许可**
//   · 正式分发**必须**用 **LGPL 构建**（GPL 构建（含 libx264/libx265 等）会传染整个 App → 商业产品不能走）
//   · 本脚本会读 `ffmpeg -version` 的 configuration：**带 --enable-gpl 就打醒目警告**（自测可用，发版前必须换）
//   · 合规三件：① 附 LGPL 许可文本 ② 提供对应源码获取途径 ③ 保留版权声明
//
// 用法：
//   node scripts/vendor-ffmpeg.mjs                     # 从本机 PATH 上的 ffmpeg 取（自测用）
//   node scripts/vendor-ffmpeg.mjs --from /path/ffmpeg # 从指定文件取（将来放 LGPL 构建）
//   node scripts/vendor-ffmpeg.mjs --platform win      # 放 Windows 那份（跨平台打包用）
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const RUNTIME = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const argOf = (name, def) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
};
const platform = argOf('--platform', process.platform === 'win32' ? 'win' : 'mac');
const from = argOf('--from', null);

const destDir = path.join(RUNTIME, 'data', 'bin', platform);
fs.mkdirSync(destDir, { recursive: true });

function copyPair(srcFfmpeg) {
  const isWin = platform === 'win';
  const ffmpegDest = path.join(destDir, isWin ? 'ffmpeg.exe' : 'ffmpeg');
  const ffprobeSrc = srcFfmpeg.replace(/ffmpeg(\.exe)?$/, isWin ? 'ffprobe.exe' : 'ffprobe');
  const ffprobeDest = path.join(destDir, isWin ? 'ffprobe.exe' : 'ffprobe');
  fs.copyFileSync(srcFfmpeg, ffmpegDest);
  fs.chmodSync(ffmpegDest, 0o755);
  if (fs.existsSync(ffprobeSrc)) {
    fs.copyFileSync(ffprobeSrc, ffprobeDest);
    fs.chmodSync(ffprobeDest, 0o755);
  } else {
    console.log(`⚠ 没找到 ffprobe（${ffprobeSrc}）——元信息读取会退化，建议一并带上`);
  }
  return { ffmpegDest, size: fs.statSync(ffmpegDest).size };
}

const src = from ?? (() => {
  try {
    return execFileSync('/usr/bin/which', ['ffmpeg'], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
})();
if (!src || !fs.existsSync(src)) {
  console.error(`找不到 ffmpeg 源（--from 没给，PATH 上也没有）。
  自测：brew install ffmpeg（或系统已有）
  正式：把 LGPL 构建放到一个路径，然后 node scripts/vendor-ffmpeg.mjs --from <该路径>`);
  process.exit(1);
}

const { ffmpegDest, size } = copyPair(src);
const version = execFileSync(ffmpegDest, ['-version'], { encoding: 'utf8' }).split('\n').slice(0, 3).join('\n');
const isGpl = /--enable-gpl/.test(version);
console.log(`已放入随包目录：${ffmpegDest}（${(size / 1048576).toFixed(1)}MB）`);
console.log(version.split('\n')[0]);
if (isGpl) {
  console.log(`
⚠️⚠️  这份是 **GPL 构建**（configuration 里有 --enable-gpl / --enable-libx264）。
     自测随便用；**正式分发前必须换成 LGPL 构建**，否则整个 App 会被 GPL 传染（须开源）。
     换成 LGPL：node scripts/vendor-ffmpeg.mjs --from <lgpl-ffmpeg 路径> --platform <mac|win>
     （许可与合规见 迭代记录/迭代08_*.md 的 ⑨ 待办 D-M1）`);
} else {
  console.log('✅ 看起来是 LGPL 构建（configuration 里没有 --enable-gpl）——随包分发合规性待商务/法务最终确认');
}
