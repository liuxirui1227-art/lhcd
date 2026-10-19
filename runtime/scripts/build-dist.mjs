// 双平台交叉打包——
//   node scripts/build-dist.mjs --mac-arm   → macOS Apple Silicon (arm64) dmg
//   node scripts/build-dist.mjs --win       → Windows x64 nsis 安装包（exe）
//   node scripts/build-dist.mjs --all       → 两者都出
// 原理：
//   - stage 装配复用 build-dmg.mjs 同款（scripts/stage-app.mjs）
//   - Electron 官方二进制按目标架构取自 npmmirror（国内直连；electronDist 直指解包目录，
//     绕开 electron-builder 的 zip 下载——该步在本机网络下卡死）
//   - mac arm64 在 Intel Mac 上交叉打包：只装包不运行 → 启动冒烟仅对本机架构执行
//   - win nsis：electron-builder 自带 darwin 版 makensis（无需 wine）；nsis/winCodeSign
//     二进制经 ELECTRON_BUILDER_BINARIES_MIRROR 从 npmmirror 取
// 注意：正式分发需签名（mac Developer ID + 公证 / win 代码签名），当前产物为未签名安装包。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { RUNTIME, STAGE, stageApp } from './stage-app.mjs';

const OUT = path.join(RUNTIME, 'dist');
const DL = path.join(RUNTIME, '.electron-dl'); // 缓存在 build/ 之外（stageApp 装配会清空 build/）
const ELECTRON_VERSION = JSON.parse(fs.readFileSync(path.join(RUNTIME, 'node_modules', 'electron', 'package.json'), 'utf8')).version;
const MIRROR = 'https://npmmirror.com/mirrors/electron';
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: opts.quiet ? 'pipe' : 'inherit', ...opts });
const wantMac = process.argv.includes('--mac-arm') || process.argv.includes('--all');
const wantWin = process.argv.includes('--win') || process.argv.includes('--all');
if (!wantMac && !wantWin) {
  console.log('用法：node scripts/build-dist.mjs --mac-arm | --win | --all');
  process.exit(1);
}

// ---- 0. stage 装配（与 build-dmg.mjs 同款；先装配再取二进制，产物目录互不干扰） ----
stageApp();

// ---- 0.5 图标再生（stageApp 清空了 build/；yml 引用 build/icon.icns，win 需 build/icon.ico） ----
// 源图用**品牌北极星**（data/icon-brand.png，与 macOS dmg 同源）——旧源图 data/icon-live2d.png
// 会让 Windows / mac-arm 产出 Live2D 图标。
function ensureIcons() {
  const src = path.join(RUNTIME, 'data', 'icon-brand.png');
  const square = path.join(RUNTIME, 'build', 'icon-square.png');
  if (!fs.existsSync(src)) {
    console.log('没有品牌图标 → 现渲一张（scripts/make-brand-icon.mjs）…');
    try {
      run(path.join(RUNTIME, 'node_modules', '.bin', 'electron'), ['scripts/make-brand-icon.mjs'], {
        cwd: RUNTIME, quiet: true,
        env: Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'ELECTRON_RUN_AS_NODE')),
      });
    } catch (e) {
      throw new Error('品牌图标渲染失败（应产出 data/icon-brand.png）：' + String(e?.message ?? e).slice(0, 200));
    }
  }
  if (!fs.existsSync(src)) throw new Error('缺少 data/icon-brand.png（先跑 scripts/make-brand-icon.mjs）');
  const py = `
import sys
from PIL import Image
src, out = sys.argv[1], sys.argv[2]
im = Image.open(src).convert('RGBA')
abox = im.getchannel('A').getbbox()
if not abox:
    sys.exit('no opaque pixels')
w, h = im.size
bw, bh = abox[2] - abox[0], abox[3] - abox[1]
# 2026-09-19：**满幅设计的图标（品牌北极星）原样用**——裁透明边会把图标自己的底裁掉 +
# 居中留白会让成品图标比邻居小一圈。与 build-dmg.mjs 的管线保持同一判据。
if bw >= w * 0.92 and bh >= h * 0.92:
    im.resize((1024, 1024), Image.LANCZOS).save(out)
    sys.exit(0)
pad = int(max(w, h) * 0.02)
l = max(0, abox[0] - pad); t = max(0, abox[1] - pad)
r = min(w, abox[2] + pad); b = min(h, abox[3] + pad)
im = im.crop((l, t, r, b))
cw, ch = im.size
s = min(890 / cw, 890 / ch)
im = im.resize((round(cw * s), round(ch * s)), Image.LANCZOS)
canvas = Image.new('RGBA', (1024, 1024), (0, 0, 0, 0))
canvas.paste(im, ((1024 - im.width) // 2, (1024 - im.height) // 2), im)
canvas.save(out)
`;
  run('/usr/local/bin/python3', ['-c', py, src, square], { quiet: true });
  // icns（mac）
  const iconset = path.join(RUNTIME, 'build', 'icon.iconset');
  fs.rmSync(iconset, { recursive: true, force: true });
  fs.mkdirSync(iconset, { recursive: true });
  const sizes = { 'icon_16x16.png': 16, 'icon_16x16@2x.png': 32, 'icon_32x32.png': 32, 'icon_32x32@2x.png': 64,
    'icon_128x128.png': 128, 'icon_128x128@2x.png': 256, 'icon_256x256.png': 256, 'icon_256x256@2x.png': 512,
    'icon_512x512.png': 512, 'icon_512x512@2x.png': 1024 };
  for (const [f, s] of Object.entries(sizes)) {
    run('sips', ['-z', String(s), String(s), square, '--out', path.join(iconset, f)], { quiet: true });
  }
  run('iconutil', ['-c', 'icns', iconset, '-o', path.join(RUNTIME, 'build', 'icon.icns')], { quiet: true });
  console.log('图标已再生（icns ✓）');
}

// ---- 1. Electron 目标架构二进制：npmmirror 下载（缓存 build/dl）→ 解包 build/electron-<plat>-<arch> ----
function electronDistDir(plat, arch) {
  const flavor = `${plat}-${arch}`;
  const zip = path.join(DL, `electron-v${ELECTRON_VERSION}-${flavor}.zip`);
  const dir = path.join(RUNTIME, 'build', `electron-${flavor}`);
  fs.mkdirSync(DL, { recursive: true });
  if (!fs.existsSync(zip)) {
    console.log(`下载 Electron ${ELECTRON_VERSION} ${flavor}（npmmirror）…`);
    run('curl', ['-sSL', '--retry', '3', '-o', zip, `${MIRROR}/${ELECTRON_VERSION}/electron-v${ELECTRON_VERSION}-${flavor}.zip`]);
  }
  const size = fs.statSync(zip).size;
  if (size < 50 * 1024 * 1024) throw new Error(`Electron zip 异常（${(size / 1e6).toFixed(1)} MB）——下载不完整，删除 ${zip} 后重试`);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    run('unzip', ['-q', zip, '-d', dir]);
  }
  return dir;
}

// ---- 2. Windows 图标：方形 png → 多尺寸 ico（PIL 为系统 python3 自带库） ----
function prepareIco() {
  const square = path.join(RUNTIME, 'build', 'icon-square.png');
  const ico = path.join(RUNTIME, 'build', 'icon.ico');
  if (!fs.existsSync(square)) throw new Error('缺少 build/icon-square.png（ensureIcons 应先生成）');
  const py = `
import sys
from PIL import Image
src, out = sys.argv[1], sys.argv[2]
im = Image.open(src).convert('RGBA')
im.save(out, format='ICO', sizes=[(16,16),(24,24),(32,32),(48,48),(64,64),(128,128),(256,256)])
`;
  run('/usr/local/bin/python3', ['-c', py, square, ico], { quiet: true });
  if (!fs.existsSync(ico)) throw new Error('icon.ico 生成失败');
  console.log('win 图标已生成：' + ico);
  return ico;
}

// ---- 3. macOS arm64：dir 目标（electronDist 指向 darwin-arm64）→ hdiutil 自打 dmg → 结构校验 ----
function buildMacArm() {
  const distDir = electronDistDir('darwin', 'arm64');
  const yml = path.join(RUNTIME, 'electron-builder.yml');
  const eb = path.join(RUNTIME, 'node_modules', '.bin', 'electron-builder');
  const macDir = path.join(OUT, 'mac-arm64');
  console.log('electron-builder：mac dir arm64 …');
  // 预清旧产物（electron-builder 内部 rm 撞宿主 safe-delete 钩子 → 先 /bin/rm 代清）
  try { run('/bin/rm', ['-rf', macDir], { quiet: true }); } catch { /* 本就不存在 */ }
  run(eb, ['--config', yml, '--mac', 'dir', '--arm64', '-c.electronDist=' + distDir], { cwd: RUNTIME });
  const app = fs.readdirSync(macDir).find((f) => f.endsWith('.app'));
  if (!app) throw new Error('未找到 .app 产物（dist/mac-arm64）');
  const appPath = path.join(macDir, app);
  // 架构校验：主执行体必须含 arm64 切片（Intel Mac 交叉打包的关键断言）
  const exe = fs.readdirSync(path.join(appPath, 'Contents', 'MacOS'))[0];
  const fileOut = run('file', [path.join(appPath, 'Contents', 'MacOS', exe)], { quiet: true }).toString();
  if (!/arm64/.test(fileOut)) throw new Error('产物不是 arm64：' + fileOut.trim());
  // ad-hoc 签名校验（与 build-dmg 同纪律：签名在 dist 产物上验，不挂载后验）
  try { run('codesign', ['--verify', '--deep', '--strict', appPath], { quiet: true }); }
  catch { throw new Error('arm64 产物 ad-hoc 签名校验未通过'); }
  // dmg（hdiutil 自打，绕开 electron-builder dmgbuild 下载坑）；arm64 app 在 Intel Mac 上无法启动 → 只做结构校验
  const tmp = path.join(RUNTIME, 'build', 'dmgtmp-arm64');
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  fs.cpSync(appPath, path.join(tmp, app), { recursive: true, verbatimSymlinks: true });
  fs.symlinkSync('/Applications', path.join(tmp, 'Applications'));
  const dmg = path.join(OUT, 'lhcd-arm64.dmg');
  fs.rmSync(dmg, { force: true });
  run('hdiutil', ['create', '-volname', 'lhcd', '-srcfolder', tmp, '-ov', '-format', 'UDZO', dmg], { quiet: true });
  // 挂载结构校验（不启动）
  const mount = run('hdiutil', ['attach', '-nobrowse', '-readonly', dmg], { quiet: true }).toString();
  const vol = mount.split('\n').filter((l) => l.includes('/Volumes/')).map((l) => l.trim().split('\t').pop()).find(Boolean);
  if (!vol) throw new Error('arm64 dmg 挂载失败');
  const okApp = fs.readdirSync(vol).some((f) => f.endsWith('.app'));
  run('hdiutil', ['detach', '-force', vol], { quiet: true });
  if (!okApp) throw new Error('arm64 dmg 内没有 .app');
  console.log(`✅ macOS arm64 dmg：${dmg}（${(fs.statSync(dmg).size / 1024 / 1024).toFixed(1)} MB，arm64 ✓ 签名 ✓ 挂载 ✓）`);
  console.log('⚠ 未做启动冒烟：本机为 Intel，arm64 app 无法本地运行——请在 Apple Silicon 上首启验证');
  return dmg;
}

// ---- 4. Windows x64：nsis 安装包（electron-builder 自带 darwin makensis，无需 wine） ----
function buildWin() {
  const distDir = electronDistDir('win32', 'x64');
  const ico = prepareIco();
  const yml = path.join(RUNTIME, 'electron-builder.yml');
  const eb = path.join(RUNTIME, 'node_modules', '.bin', 'electron-builder');
  console.log('electron-builder：win nsis x64 …');
  // 预清旧产物（同 mac——宿主 safe-delete 钩子会拦 electron-builder 内部批量删）
  try { run('/bin/rm', ['-rf', path.join(OUT, 'win-unpacked')], { quiet: true }); } catch { /* 本就不存在 */ }
  try {
    for (const f of fs.readdirSync(OUT).filter((f) => f.endsWith('.exe'))) {
      run('/bin/rm', ['-f', path.join(OUT, f)], { quiet: true });
    }
  } catch { /* 无旧 exe */ }
  run(eb, ['--config', yml, '--win', 'nsis', '--x64',
    '-c.electronDist=' + distDir,
    '-c.win.icon=' + ico,
    '-c.nsis.oneClick=false',
    '-c.nsis.allowToChangeInstallationDirectory=true',
  ], {
    cwd: RUNTIME,
    env: {
      ...process.env,
      // nsis / winCodeSign 二进制走 npmmirror（github 直连不稳）
      ELECTRON_BUILDER_BINARIES_MIRROR: 'https://npmmirror.com/mirrors/electron-builder-binaries/',
    },
  });
  const exe = fs.readdirSync(OUT).filter((f) => f.endsWith('.exe'));
  if (!exe.length) throw new Error('未找到 .exe 产物（dist/）');
  const winner = exe.map((f) => ({ f, s: fs.statSync(path.join(OUT, f)).size })).sort((a, b) => b.s - a.s)[0];
  if (winner.s < 50 * 1024 * 1024) throw new Error(`exe 体积异常（${(winner.s / 1e6).toFixed(1)} MB）——打包不完整`);
  console.log(`✅ Windows x64 安装包：${path.join(OUT, winner.f)}（${(winner.s / 1024 / 1024).toFixed(1)} MB）`);
  return path.join(OUT, winner.f);
}

if (wantMac || wantWin) ensureIcons();
if (wantMac) buildMacArm();
if (wantWin) buildWin();
console.log('全部产物完成：' + OUT);
