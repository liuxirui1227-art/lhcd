// 灵核品牌图标（北极星设计；不再用 Live2D 图形）
//
// 图像来源：**家页面左上角那个 ✦**（`ui/home.html` 的品牌标记 `<span class="st">✦</span>灵核`）。
// 做法：离屏窗口里画一张 1024×1024 的 SVG（圆角方块 + 灵核紫渐变 + 发光北极星），截图落盘：
//   · data/icon-brand.png   1024×1024 应用图标源图（build-dmg 的 prepareIcon 用它出 icns）
//   · data/tray-brand.png    16pt 托盘图（1x 16px；配 @2x 32px，main.mjs 组合成模板图 = macOS）
//   · data/tray-brand-win.ico / .png  Windows·Linux 托盘图（**彩色**星形，多尺寸 ico + 32px png）
// 用法：env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron scripts/make-brand-icon.mjs
import { app, BrowserWindow, nativeImage } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME = path.join(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 北极星（四角星/闪光）——与家页面那个 ✦ 同形，用 SVG 路径画，边缘是矢量清晰的 */
const STAR = (cx, cy, r, fill) => {
  const d = `M ${cx} ${cy - r}
    C ${cx + r * 0.12} ${cy - r * 0.32} ${cx + r * 0.32} ${cy - r * 0.12} ${cx + r} ${cy}
    C ${cx + r * 0.32} ${cy + r * 0.12} ${cx + r * 0.12} ${cy + r * 0.32} ${cx} ${cy + r}
    C ${cx - r * 0.12} ${cy + r * 0.32} ${cx - r * 0.32} ${cy + r * 0.12} ${cx - r} ${cy}
    C ${cx - r * 0.32} ${cy - r * 0.12} ${cx - r * 0.12} ${cy - r * 0.32} ${cx} ${cy - r} Z`;
  return `<path d="${d}" fill="${fill}"/>`;
};

/** 托盘专用：**只有星形、纯色、透明底**——macOS 模板图（系统按菜单栏亮暗自动反色），带底反而难看。
 *  两条尺寸修正：
 *  ① 尺寸按 pt 出图（16pt，见下方 shoot 调用）——出 44pt 大图时 macOS 只会把它压到菜单栏高度渲染，
 *     结果比邻居图标大一圈；② 小伴星在 16px 下只是 1.5px 的灰点（糊），去掉，主星四周留白。 */
const TRAY_HTML = (size) => `<!doctype html><html><body style="margin:0;background:transparent">
<svg width="${size}" height="${size}" viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg">
  <g fill="#000000">
    ${STAR(512, 512, 400, '#000000')}
  </g>
</svg></body></html>`;

/** Windows / Linux 托盘用**彩色**星形：
 *  模板图（setTemplateImage）只有 macOS 会按菜单栏亮暗自动反色 —— 同一张黑星放到 Windows 上就是
 *  黑图标压在深色任务栏上，等于隐形。品牌紫在浅/深两种任务栏上都读得出来。 */
const TRAY_WIN_HTML = (size, color) => `<!doctype html><html><body style="margin:0;background:transparent">
<svg width="${size}" height="${size}" viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg">
  <g fill="${color}">
    ${STAR(512, 512, 400, color)}
  </g>
</svg></body></html>`;

/** 组装 ICO（PNG 内嵌，Vista+ 支持）——Windows 托盘/任务栏按 DPI 自己挑合适尺寸，
 *  只给一张 16px 在高 DPI 屏上会糊。格式：6 字节头 + 每图 16 字节目录项 + 各 PNG 数据。 */
function buildIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // 保留
  header.writeUInt16LE(1, 2); // 1 = 图标
  header.writeUInt16LE(images.length, 4);
  const dir = Buffer.alloc(16 * images.length);
  let offset = 6 + 16 * images.length;
  images.forEach((im, i) => {
    const o = i * 16;
    dir.writeUInt8(im.size >= 256 ? 0 : im.size, o); // 宽（256 记 0）
    dir.writeUInt8(im.size >= 256 ? 0 : im.size, o + 1); // 高
    dir.writeUInt8(0, o + 2); // 调色板数
    dir.writeUInt8(0, o + 3); // 保留
    dir.writeUInt16LE(1, o + 4); // 色彩平面
    dir.writeUInt16LE(32, o + 6); // 位深
    dir.writeUInt32LE(im.png.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += im.png.length;
  });
  return Buffer.concat([header, dir, ...images.map((i) => i.png)]);
}

const HTML = (size) => `<!doctype html><html><body style="margin:0;background:transparent">
<svg width="${size}" height="${size}" viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#241a44"/>
      <stop offset="55%" stop-color="#171029"/>
      <stop offset="100%" stop-color="#2b1f52"/>
    </linearGradient>
    <radialGradient id="glow" cx="50%" cy="46%" r="55%">
      <stop offset="0%" stop-color="#c9b4ff" stop-opacity=".55"/>
      <stop offset="70%" stop-color="#8f6fff" stop-opacity=".12"/>
      <stop offset="100%" stop-color="#000000" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="star" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#ffffff"/>
      <stop offset="60%" stop-color="#e8dcff"/>
      <stop offset="100%" stop-color="#b79bff"/>
    </linearGradient>
    <filter id="soft" x="-60%" y="-60%" width="220%" height="220%">
      <feGaussianBlur stdDeviation="22" result="b"/>
      <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
  </defs>
  <!-- macOS 风格圆角方块（Big Sur 圆角比例 ≈ 22.5%） -->
  <rect x="0" y="0" width="1024" height="1024" rx="230" fill="url(#bg)"/>
  <rect x="0" y="0" width="1024" height="1024" rx="230" fill="url(#glow)"/>
  <!-- 一圈淡淡的轨道，呼应"核" -->
  <circle cx="512" cy="496" r="286" fill="none" stroke="#b79bff" stroke-opacity=".22" stroke-width="6"/>
  <circle cx="512" cy="496" r="352" fill="none" stroke="#b79bff" stroke-opacity=".10" stroke-width="3"/>
  <!-- 北极星：主星 + 两颗小伴星（家页面 ✦ 的形状放大） -->
  <g filter="url(#soft)">
    ${STAR(512, 496, 262, 'url(#star)')}
  </g>
  ${STAR(792, 240, 66, '#d9c9ff')}
  ${STAR(236, 792, 46, '#c0a8ff')}
</svg></body></html>`;

async function shoot(size, out, { transparent = false, html = null } = {}) {
  const tmpFile = path.join(RUNTIME, 'build', `icon-${size}-${transparent ? 't' : 'c'}.html`);
  fs.mkdirSync(path.dirname(tmpFile), { recursive: true });
  fs.writeFileSync(tmpFile, html ?? HTML(size));
  const win = new BrowserWindow({ width: size, height: size, show: false, frame: false, transparent });
  await sleep(120); // 写完文件再读，避掉文件系统竞态
  await win.loadURL(pathToFileURL(tmpFile).href);
  await sleep(500);
  const img = await win.webContents.capturePage();
  fs.writeFileSync(out, img.toPNG());
  win.destroy();
  return out;
}

// 关键：不留这行，销毁第一个窗口后 Electron 会**直接退出应用**（默认行为），第二轮渲染根本没机会跑
app.on('window-all-closed', () => { /* 不退出：还要渲染托盘小图 */ });

/** 三个更干净的方案（减元素） */
const VARIANTS = {
  A: (full) => `<!-- 现版微调：满底 + 主星 + 伴星 -->${panel(full, `
    <circle cx="512" cy="496" r="300" fill="none" stroke="#b79bff" stroke-opacity=".18" stroke-width="5"/>
    <g filter="url(#soft)">${STAR(512, 496, 268, 'url(#star)')}</g>
    ${STAR(792, 244, 58, '#d9c9ff')}`, { full }) }`,
  B: (full) => `<!-- 简洁：满底 + 一颗大星，别的都不要 -->${panel(full, `
    <g filter="url(#soft2)">${STAR(512, 512, 320, 'url(#star)')}</g>`, { full })}`,
  C: (full) => `<!-- 居中克制：满底 + 主星 + 一圈细环 -->${panel(full, `
    <circle cx="512" cy="512" r="330" fill="none" stroke="#cbb8ff" stroke-opacity=".3" stroke-width="8"/>
    <g filter="url(#soft)">${STAR(512, 512, 236, 'url(#star)')}</g>`, { full })}`,
};

/** 画一块底（full = 铺满方形，不留圆角透明；否则 macOS 式圆角） */
function panel(full, inner) {
  return `
  <rect x="0" y="0" width="1024" height="1024" ${full ? '' : 'rx="230"'} fill="url(#bg)"/>
  <rect x="0" y="0" width="1024" height="1024" ${full ? '' : 'rx="230"'} fill="url(#glow)"/>
  ${inner}`;
}
function variantHtml(name, size, full) {
  return `<!doctype html><html><body style="margin:0;background:transparent">
<svg width="${size}" height="${size}" viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#2a1f52"/><stop offset="55%" stop-color="#1a1230"/><stop offset="100%" stop-color="#332665"/>
    </linearGradient>
    <radialGradient id="glow" cx="50%" cy="48%" r="58%">
      <stop offset="0%" stop-color="#cdbaff" stop-opacity=".48"/>
      <stop offset="75%" stop-color="#8f6fff" stop-opacity=".10"/>
      <stop offset="100%" stop-color="#000000" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="star" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#ffffff"/><stop offset="60%" stop-color="#efe6ff"/><stop offset="100%" stop-color="#bda5ff"/>
    </linearGradient>
    <filter id="soft" x="-60%" y="-60%" width="220%" height="220%">
      <feGaussianBlur stdDeviation="20" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
    <filter id="soft2" x="-60%" y="-60%" width="220%" height="220%">
      <feGaussianBlur stdDeviation="14" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
  </defs>
  ${VARIANTS[name](full)}
</svg></body></html>`;
}

app.whenReady().then(async () => {
  // 变体模式：node … --variants → 三个方案写到桌面（含"满底 vs 圆角"对照）
  if (process.argv.includes('--variants')) {
    const home = os.homedir();
    const desk = path.join(home, 'Desktop');
    for (const name of ['A', 'B', 'C']) {
      await shoot(1024, path.join(desk, `灵核图标_${name}.png`), { html: variantHtml(name, 1024, true) });
      console.log(`已出：桌面/灵核图标_${name}.png（满底、无白角）`);
    }
    await shoot(1024, path.join(desk, '灵核图标_A_圆角版.png'), { html: variantHtml('A', 1024, false) });
    console.log('已出：桌面/灵核图标_A_圆角版.png（macOS 圆角，Preview 里四角会是"白"的——那是透明）');
    app.exit(0);
    return;
  }
  // 采用**变体 A（满底 + 主星 + 两圈轨道 + 两颗伴星）**
  const icon = path.join(RUNTIME, 'data', 'icon-brand.png');
  await shoot(1024, icon, { html: variantHtml('A', 1024, true) }); // 应用图标源图（满底，无透明角）——关键产物
  const st = fs.statSync(icon);
  console.log(`品牌图标已生成：${icon}（${(st.size / 1024).toFixed(0)}KB）`);
  try {
    // 托盘：模板图（透明底纯星形）。**16pt 标准尺寸**：出 1x 16px + @2x 32px，main.mjs 组合成一张图。
    // 不能出大图让系统去压——macOS 只会压到「菜单栏高度」，成品比邻居图标大一圈（实测反馈）
    const traySrc = path.join(RUNTIME, 'build', 'tray-src.png');
    await shoot(256, traySrc, { transparent: true, html: TRAY_HTML(256) });
    const src = nativeImage.createFromPath(traySrc);
    if (src.isEmpty()) throw new Error('托盘源图渲染为空');
    const tray1x = path.join(RUNTIME, 'data', 'tray-brand.png');
    const tray2x = path.join(RUNTIME, 'data', 'tray-brand@2x.png');
    fs.writeFileSync(tray2x, src.resize({ width: 32, height: 32, quality: 'best' }).toPNG());
    fs.writeFileSync(tray1x, src.resize({ width: 16, height: 16, quality: 'best' }).toPNG());
    console.log(`托盘小图已生成：${tray1x}（16pt：16px + 32px@2x）`);

    // Windows / Linux 托盘：彩色星形（多尺寸 .ico + 32px PNG 兜底）
    const winSrc = path.join(RUNTIME, 'build', 'tray-win-src.png');
    await shoot(256, winSrc, { transparent: true, html: TRAY_WIN_HTML(256, '#8f6fff') });
    const wsrc = nativeImage.createFromPath(winSrc);
    if (wsrc.isEmpty()) throw new Error('Windows 托盘源图渲染为空');
    const winIco = path.join(RUNTIME, 'data', 'tray-brand-win.ico');
    const winPng = path.join(RUNTIME, 'data', 'tray-brand-win.png');
    const px = (s) => wsrc.resize({ width: s, height: s, quality: 'best' }).toPNG();
    fs.writeFileSync(winIco, buildIco([16, 20, 24, 32, 48].map((s) => ({ size: s, png: px(s) }))));
    fs.writeFileSync(winPng, px(32)); // Linux 托盘只吃 PNG（Chromium 的 ICO 解码仅 Windows 有）
    console.log(`托盘小图已生成：${winIco}（16/20/24/32/48）+ ${path.basename(winPng)}`);
  } catch (e) {
    console.log(`（托盘小图这次没生成：${String(e?.message ?? e).slice(0, 80)}——不影响应用图标）`);
  }
  app.exit(0);
}).catch((e) => { console.error('生成失败：' + (e?.stack ?? e)); app.exit(1); });
setTimeout(() => { console.error('超时'); app.exit(1); }, 60000);
