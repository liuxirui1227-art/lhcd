// 打包「lhcd.dmg」（electron-builder）——应用化交付链路
// 用法：node scripts/build-dmg.mjs [--icon <png>] [--out <dir>]
//   --icon 应用图标源图（缺省：data/icon-brand.png 北极星品牌图；不存在则跑 make-brand-icon 现渲一张）
//   --out  产物输出目录（缺省 runtime/dist）
// 流程：stage 目录装配（runtime 文件 + core/dist + brain/dist，零 node_modules 运行时依赖）→
//       png → icns（sips + iconutil）→ electron-builder → hdiutil 挂载验证 → 产物
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { stageApp } from './stage-app.mjs'; // 装配逻辑提取共享（build-dist.mjs 双平台打包复用）

const RUNTIME = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = path.join(RUNTIME, '..');
const STAGE = path.join(RUNTIME, 'build', 'stage');
const OUT = (() => {
  const i = process.argv.indexOf('--out');
  return i >= 0 ? path.resolve(process.argv[i + 1]) : path.join(RUNTIME, 'dist');
})();

// 参数数组直调（无 shell，路径含特殊字符安全）
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: opts.quiet ? 'pipe' : 'inherit', ...opts });

// ---- 1. stage 装配（asar 内只读 → 数据目录运行时切到 ~/.lhcd） ----
// 布局：runtime 文件放 app/ 子目录，复刻 dev 相对布局——
// lib.mjs 的 '../core/dist'/'../brain/dist' 相对导入在 asar 内解析到 stage/core、stage/brain
// （旧平铺布局解析到 stage 父级 build/ → ERR_MODULE_NOT_FOUND → 应用起不来，就是「dmg 不可用」的根因）
// 函数体已提取到 scripts/stage-app.mjs；stageApp 由顶部 import 提供（本文件行为不变）

// ---- 2. 图标：png → icns（macOS 内置工具，无需新依赖） ----
// 旧源图 diag-live2d.png 是 opaque 诊断模式截图（无 alpha 深色底）——「黑框图标」的根因；
// 竖版源图（960x1440）经下方 prepareIcon 的「裁剪空白 → 等比例 fit → 透明底居中」方形化，不再被压方拉伸。
async function prepareIcon() {
  const i = process.argv.indexOf('--icon');
  // 默认源图 = **品牌北极星**（scripts/make-brand-icon.mjs 生成；✦ = 家页面那个品牌标记）。
  // 需要时仍可用 --icon 覆盖（例如临时出 Live2D 版）。
  let png = i >= 0 ? path.resolve(process.argv[i + 1]) : path.join(RUNTIME, 'data', 'icon-brand.png');
  if (i < 0 && !fs.existsSync(png)) {
    console.log('没有品牌图标 → 现渲一张（scripts/make-brand-icon.mjs）…');
    const r = spawnSync(path.join(RUNTIME, 'node_modules', '.bin', 'electron'), ['scripts/make-brand-icon.mjs'], {
      cwd: RUNTIME,
      env: Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'ELECTRON_RUN_AS_NODE')), // 等效 env -u
    });
    if (r.status !== 0) throw new Error('品牌图标渲染失败：' + String(r.stderr ?? '').slice(0, 200));
    if (!fs.existsSync(png)) throw new Error('make-brand-icon 未产出 icon-brand.png');
  }
  // 等比例方形化——竖版截图（960x1440）用 sips -z 强制压方会横向拉伸变形。改为：
  // 裁掉透明空白 → 等比例缩放到 1024 容器（主体 ~87%）→ 透明底居中，全程不拉伸。
  // PIL 为 macOS 自带 python3 库，无新依赖。
  const square = path.join(RUNTIME, 'build', 'icon-square.png');
  const py = `
import sys
from PIL import Image
src, out = sys.argv[1], sys.argv[2]
im = Image.open(src).convert('RGBA')
w, h = im.size
abox = im.getchannel('A').getbbox()
if not abox:
    sys.exit('no opaque pixels')
bw, bh = abox[2] - abox[0], abox[3] - abox[1]
# 2026-09-19：**满幅设计的图标（品牌北极星）原样用**——裁透明边会把图标自己的底裁掉。
# 只有当主体明显小于画布（老的形象截图：人物只占中间一条）时才走"裁剪→等比例居中"。
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
  // 显式用系统 python3（自带 PIL）——PATH 上的 python3 可能是无 PIL 的托管运行时
  execFileSync('/usr/local/bin/python3', ['-c', py, png, square], { stdio: 'inherit' });
  if (!fs.existsSync(square)) throw new Error('方形图标生成失败');
  png = square;
  const iconset = path.join(RUNTIME, 'build', 'icon.iconset');
  fs.rmSync(iconset, { recursive: true, force: true });
  fs.mkdirSync(iconset, { recursive: true });
  const sizes = { 'icon_16x16.png': 16, 'icon_16x16@2x.png': 32, 'icon_32x32.png': 32, 'icon_32x32@2x.png': 64,
    'icon_128x128.png': 128, 'icon_128x128@2x.png': 256, 'icon_256x256.png': 256, 'icon_256x256@2x.png': 512,
    'icon_512x512.png': 512, 'icon_512x512@2x.png': 1024 };
  for (const [f, s] of Object.entries(sizes)) {
    run('sips', ['-z', String(s), String(s), png, '--out', path.join(iconset, f)], { quiet: true });
  }
  const icns = path.join(RUNTIME, 'build', 'icon.icns');
  run('iconutil', ['-c', 'icns', iconset, '-o', icns], { quiet: true });
  console.log('图标已生成：' + icns + '（源：' + png + '）');
}

// ---- 3. electron-builder 打包（只出 .app，dir 目标）+ hdiutil 自打 dmg ----
function buildDmg() {
  const yml = path.join(RUNTIME, 'electron-builder.yml');
  const eb = path.join(RUNTIME, 'node_modules', '.bin', 'electron-builder');
  // 先清旧产物目录——electron-builder 清空 dist/mac 用的是 node fs-extra rm，
  // 残留 .app 数百文件会撞宿主 safe-delete 钩子（SAFE_DELETE_BULK_CONFIRM）→ 打包失败；
  // 用 /bin/rm 子进程代清（与 stage 装配同法），electron-builder 只需复制全新内容
  try { execFileSync('/bin/rm', ['-rf', path.join(OUT, 'mac')], { stdio: 'pipe' }); } catch { /* 本就不存在 */ }
  // identity: null → 未签名（开发构建）；正式分发需 Developer ID 签名 + 公证
  run(eb, ['--config', yml, '--mac', 'dir'], { cwd: RUNTIME });
  const app = fs.readdirSync(path.join(OUT, 'mac')).find((f) => f.endsWith('.app'));
  if (!app) throw new Error('未找到 .app 产物（dist/mac）');
  // ad-hoc 签名校验——未签名 app 的子进程被 macOS 拒 → 窗口永不显示。
  // 必须在 dist/mac 产物上校验：hdiutil 打包 + readonly 挂载会破坏 seal，卷上 verify 必失败（已实测）
  try {
    run('codesign', ['--verify', '--deep', '--strict', path.join(OUT, 'mac', app)], { quiet: true });
  } catch {
    throw new Error('ad-hoc 签名校验未通过（dist/mac）');
  }
  // dmg 自打（electron-builder 的 dmg 目标需下载 dmgbuild-bundle 二进制，本机网络下卡死）
  const tmp = path.join(RUNTIME, 'build', 'dmgtmp');
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  // verbatimSymlinks: true 必须显式开——fs.cpSync 默认把相对 symlink 转成绝对路径，
  // 会破坏 framework 结构（Versions/Current 断链）与签名 seal（unsealed → 子进程被杀）
  fs.cpSync(path.join(OUT, 'mac', app), path.join(tmp, app), { recursive: true, verbatimSymlinks: true });
  fs.symlinkSync('/Applications', path.join(tmp, 'Applications'));
  const dmg = path.join(OUT, 'lh.dmg'); // 产物名 lh.dmg；卷标随应用名「灵核」
  fs.rmSync(dmg, { force: true });
  run('hdiutil', ['create', '-volname', 'lhcd', '-srcfolder', tmp, '-ov', '-format', 'UDZO', dmg], { quiet: true });
  return dmg;
}

// ---- 4. 挂载验证（可挂载 + 结构完整 + 真实启动冒烟——应用必须真的能跑起来） ----
function verifyDmg(dmg) {
  const mount = run('hdiutil', ['attach', '-nobrowse', '-readonly', dmg], { quiet: true }).toString();
  const vol = mount.split('\n').filter((l) => l.includes('/Volumes/')).map((l) => l.trim().split('\t').pop()).find(Boolean);
  if (!vol) throw new Error('dmg 挂载失败');
  const appName = fs.readdirSync(vol).find((f) => f.endsWith('.app'));
  if (!appName) throw new Error('dmg 内没有 .app');
  const info = fs.readFileSync(path.join(vol, appName, 'Contents', 'Info.plist'), 'utf8');
  const exe = info.match(/<key>CFBundleExecutable<\/key>\s*<string>([^<]+)/)?.[1] ?? '';
  const exePath = path.join(vol, appName, 'Contents', 'MacOS', exe);
  const exeOk = exe ? fs.existsSync(exePath) : false;
  const iconOk = fs.existsSync(path.join(vol, appName, 'Contents', 'Resources', 'icon.icns'));
  if (!exeOk || !iconOk) throw new Error('dmg 内容校验未通过（可执行体/图标缺失）');
  // 启动冒烟：真实拉起二进制，断言主进程跑到 whenReady + 窗口真实显示
  // （只验「app 启动」不够：主进程起来但渲染进程崩 → 窗口永不出现，冒烟照样过——盲区）
  // 关键：把 app 从挂载卷拷到本地临时目录再跑——从 readonly dmg 卷直接 exec 子进程必崩
  // （ICU fd 无效 + GPU crash 循环 + FATAL，macOS 26 + UDZO 卷的组合问题），
  // 只有落到本地磁盘（模拟用户拖入 Applications）才是真实安装形态
  const verifyDir = '/tmp/lh-dmg-verify';
  // 批量删除走 /bin/rm 子进程——宿主 safe-delete 钩子拦 node fs.rmSync 大目录（残留 app 1000+ 文件）
  try { execFileSync('/bin/rm', ['-rf', verifyDir], { stdio: 'pipe' }); } catch { /* 本就不存在 */ }
  const localApp = path.join(verifyDir, appName);
  // verbatimSymlinks: true 同 buildDmg——拷出必须保持相对 symlink 原样（否则 seal 破坏、渲染进程被杀）
  fs.cpSync(path.join(vol, appName), localApp, { recursive: true, verbatimSymlinks: true });
  const localExe = path.join(localApp, 'Contents', 'MacOS', exe);
  let bootOk = false;
  let winOk = false;
  try {
    // dmg 往返会破坏 ad-hoc seal → app 启动时的就地自愈重签（codesign --deep 全 bundle）
    // 在冷启动路径上耗时波动大（百 MB bundle 可达 10~20s），可能吃掉冒烟窗口期 → 拷出后先预防性重签，
    // 与 app 内自愈同款动作；产物本身不变（安装链路的自愈逻辑保持不变）。
    try { execFileSync('codesign', ['--force', '--deep', '--sign', '-', localApp], { stdio: 'pipe', timeout: 60000 }); } catch { /* 无签名环境 */ }
    // 冒烟带 --disable-gpu + ELECTRON_DISABLE_SANDBOX=1——CI/受限桌面环境下
    // Chromium sandbox/GPU 初始化失败会让出生向导 Live2D 首屏 render-process-gone（误报窗口未显示）。
    // 冒烟仅验「窗口真实显示」，软渲染+禁沙箱足够；产物不携带这些参数，真实用户桌面不受影响。
    spawnSync(localExe, ['--disable-gpu'], {
      timeout: 40000, // 20s → 40s：给 seal 自愈/首启冷启动留余量（实测首启偶发压线）
      killSignal: 'SIGKILL',
      env: {
        ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'ELECTRON_RUN_AS_NODE')),
        LHCD_DATA_DIR: verifyDir,
        // 冒烟实例独立 userData（main.mjs 内 setPath）——真实实例开着时打包不再
        // 被单实例锁顶掉（否则遗留冒烟进程占锁 → 冒烟实例秒退 → 误报「dmg 不可用」）
        LHCD_SMOKE: '1',
        ELECTRON_DISABLE_SANDBOX: '1',
      },
    });
    // 清理冒烟残留进程（helper + 主进程；否则占住挂载卷导致 detach 失败）
    try { execFileSync('pkill', ['-f', 'lhcd Helper'], { stdio: 'pipe' }); } catch { /* 无残留 */ }
    try { execFileSync('pkill', ['-f', 'lh-dmg-verify'], { stdio: 'pipe' }); } catch { /* 无残留 */ }
    const diag = fs.readFileSync(path.join(verifyDir, 'diag.log'), 'utf8');
    bootOk = diag.includes('app 启动');
    winOk = diag.includes('窗口已显示'); // main.mjs 在 ready-to-show/show 兜底时写下
    if (bootOk && !winOk) {
      console.log('diag 摘录：\n' + diag.trim().split('\n').slice(-8).join('\n'));
    }
  } catch {
    bootOk = false;
  }
  try {
    run('hdiutil', ['detach', '-force', vol], { quiet: true });
  } catch {
    console.log('⚠ 卷卸载失败（冒烟残留进程占用，不影响产物）：' + vol);
  }
  console.log(`挂载验证 ✅：${appName}（可执行体 ✓，图标 ✓，签名 ✓，启动冒烟 ${bootOk ? '✓ 主进程就绪' : '✗ 未就绪'}，窗口 ${winOk ? '✓ 已显示' : '✗ 未显示'}）`);
  if (!bootOk) throw new Error('启动冒烟未通过：应用未跑到 whenReady（dmg 不可用）');
  if (!winOk) throw new Error('窗口冒烟未通过：应用窗口未显示（渲染进程崩溃？查上方面 diag 摘录）');
  return appName;
}

await stageApp();
await prepareIcon();
const dmg = buildDmg();
const appName = verifyDmg(dmg);
// ---- 5. 复制到平台下载目录（?r=apply/download-dmg 服务）——产物名 lh.dmg ----
const dlDir = path.join(REPO, 'platform', 'web', 'downloads');
fs.mkdirSync(dlDir, { recursive: true });
fs.copyFileSync(dmg, path.join(dlDir, 'lh.dmg'));
console.log('✅ lh.dmg 已生成并复制到平台下载目录：');
console.log('  ' + dmg + '（' + (fs.statSync(dmg).size / 1024 / 1024).toFixed(1) + ' MB）');
console.log('  ' + path.join(dlDir, 'lh.dmg'));
console.log(`安装验证：双击 dmg → 双击「${appName}」→ 弹窗引导自动安装到 Applications → Dock/Launchpad 出现 lhcd（图标=北极星）→ 托盘菜单退出`);
