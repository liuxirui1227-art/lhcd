// 灵核 · 桌面宿主主进程（Electron 外壳，业务逻辑见 lib.mjs）
// 窗口体系：① 桌面精灵窗（TA 本体：全身形象、本机漫步、说话气泡）② 快捷输入气泡（⌥Space 随时告诉 TA）③ 历史面板（主窗，可看可翻）④ 管理中心
import { app, BrowserWindow, desktopCapturer, dialog, ipcMain, screen, globalShortcut, Tray, Menu, nativeImage, Notification, protocol, net, shell } from 'electron';
import { reviveOnRendererGone } from './renderer-revive.mjs';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as lib from './lib.mjs';
import * as plat from './platform-api.mjs';
import { createTaskState, stateWords, TASK_STATE_KEYS, TASK_STATE_PENDING_KEYS, TASK_STATES } from './ui/task-state.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 从安装镜像（/Volumes）直接运行 → Electron 子进程必崩（ICU/GPU，FATAL 退出，无窗口）——
// 主进程 whenReady 都到不了。因此最早阶段拦截：osascript 弹框引导自动安装到 Applications 再启动。
// 全程不依赖 Electron ready（osascript/cpSync/codesign 都是独立进程/纯 fs 操作）
if (app.getAppPath().startsWith('/Volumes/')) {
  try {
    const srcBundle = path.dirname(path.dirname(path.dirname(app.getPath('exe'))));
    const destBundle = path.join('/Applications', path.basename(srcBundle));
    const r = execFileSync('osascript', ['-e',
      'display dialog "检测到灵核正从安装镜像运行。\\n\\n点击「安装」，TA 会住进你的应用程序文件夹，之后从应用列表/启动台打开即可。" with title "安装灵核" buttons {"安装到应用程序", "取消"} default button 1 with icon note'
    ]).toString();
    if (r.includes('安装')) {
      fs.rmSync(destBundle, { recursive: true, force: true });
      // verbatimSymlinks: true 必须——fs.cpSync 默认把相对 symlink 绝对化 → framework 断链 + 签名 seal 破坏
      fs.cpSync(srcBundle, destBundle, { recursive: true, verbatimSymlinks: true });
      // hdiutil 往返会破坏 ad-hoc 签名 seal → 重新签名恢复（否则子进程 spawn 被系统拒绝）
      try { execFileSync('codesign', ['--force', '--deep', '--sign', '-', destBundle], { stdio: 'pipe' }); } catch { /* 旧版无签名也能跑 */ }
      // 清掉历史旧版残留名（灵核初诞.app），避免应用列表出现两个图标
      try { fs.rmSync(path.join('/Applications', '灵核初诞.app'), { recursive: true, force: true }); } catch { /* 无残留 */ }
      execFileSync('open', ['-a', destBundle]);
    }
  } catch { /* 用户取消或安装失败：静默退出，下次再引导 */ }
  app.exit(0);
}

// 签名自愈：hdiutil 打包/拷贝会破坏 ad-hoc 签名 seal——本地运行时自检签名，失效则就地重签
// （自己正跑着，重签不影响已加载代码，之后 spawn 的子进程即用新 seal）。注意必须签 bundle 根
// （exe 上溯三级），不能签 app.getAppPath()（那是 app.asar 文件）；
// 仅打包态启用（dev 模式不动 node_modules 里的 Electron.app）
// Windows 适配：codesign / /Volumes 都是 macOS 专有概念——非 mac 直接跳过这段自愈
// （免得每次启动白跑一次必然失败的 codesign spawn）
if (process.platform === 'darwin' && __dirname.includes('app.asar') && process.env.LHCD_NO_RESIGN !== '1') {
  const bundlePath = path.dirname(path.dirname(path.dirname(app.getPath('exe'))));
  if (!bundlePath.startsWith('/Volumes/')) {
    try {
      execFileSync('codesign', ['--verify', '--deep', '--strict', bundlePath], { stdio: 'pipe' });
    } catch {
      try {
        execFileSync('codesign', ['--force', '--deep', '--sign', '-', bundlePath], { stdio: 'pipe' });
      } catch { /* 自愈失败不阻塞启动（未签名也能跑） */ }
    }
  }
}

// 打包冒烟隔离——冒烟实例必须用独立 userData。否则它与用户正在运行的真实实例共用
// ~/Library/Application Support/lhcd → 抢单实例锁失败 → 第二实例立即 quit → 永远到不了 whenReady。
// 顺带好处：冒烟不再污染用户真实的 Chromium 状态目录。必须在 requestSingleInstanceLock 之前设置。
if (process.env.LHCD_SMOKE === '1') {
  try { app.setPath('userData', path.join(process.env.LHCD_DATA_DIR || os.tmpdir(), 'chromium-smoke')); } catch { /* 失败不阻塞 */ }
}
/**
 * 冒烟实例**不上屏**：`LHCD_SMOKE=1` 起，所有窗口只创建、不显示。
 * 为什么必须这样：会起真应用的冒烟会把**全屏透明置顶的形象端**真的铺到桌面上——调试时用户
 * 看到"桌面上突然多出一个她"，还会顺手抢走单实例锁、让用户自己的应用开不起来。
 * 需要真截图的脚本按需自己 `show()`，不受这里影响。
 */
const HEADLESS_SMOKE = process.env.LHCD_SMOKE === '1' && process.env.LHCD_SMOKE_SHOW !== '1';

/** 统一的"要不要真的显示"闸门：冒烟实例下一律不显示（见 HEADLESS_SMOKE 的说明） */
function showWin(w, inactive = false) {
  if (!w || w.isDestroyed()) return;
  if (HEADLESS_SMOKE) { diag('冒烟实例：跳过显示窗口 ' + (w.webContents?.getURL?.() ?? '')); return; }
  try { inactive ? w.showInactive() : w.show(); } catch { /* 窗口销毁竞态 */ }
}

// 单实例锁——用户连点两次会开出两个无窗口幽灵进程；第二实例直接让位（second-instance 里唤起已有窗口）
const gotSingleLock = app.requestSingleInstanceLock();
if (!gotSingleLock) app.quit();
app.on('second-instance', () => {
  if (mainWin && !mainWin.isDestroyed()) { showWin(mainWin); mainWin.focus(); }
  else if (!lib.status().bound) openHistoryPanel();
});

// Live2D 模型本地分发（l2d:// 协议 → data/live2d/：model3.json/moc3/贴图/动作全走同一协议，相对路径自然解析）
// 3D/VRM 已移除，Live2D 是唯一形象方案（失败仅回落光球）——vrm:// 协议随之退役
protocol.registerSchemesAsPrivileged([
  { scheme: 'l2d', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } },
]);

// ---------- 运行时自检日志（落盘 diag.log，可事后读取定位；打包态落 ~/.lhcd/data）----------
const diagFile = (() => {
  const dir = process.env.LHCD_DATA_DIR
    || (__dirname.includes('app.asar') ? path.join(os.homedir(), '.lhcd', 'data') : path.join(__dirname, 'data'));
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* 忽略 */ }
  return path.join(dir, 'diag.log');
})();
function diag(...args) {
  const line = `[${new Date().toISOString()}] ${args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}`;
  try {
    fs.appendFileSync(diagFile, line + '\n');
  } catch { /* 诊断失败不影响主流程 */ }
  console.log(line);
}
// 渲染进程自愈：被杀/崩了 → 自动重载窗口（实现见 renderer-revive.mjs；抽成模块是为了能被冒烟测）
const revive = (win, tag) => reviveOnRendererGone(win, tag, { log: (m) => diag(m) });

// 默认透明窗（只显示人，无边框；透明渲染已验证可行）；LHCD_PET_OPAQUE=1 可切回卡片模式诊断
const PET_TRANSPARENT = process.env.LHCD_PET_OPAQUE !== '1';
// 形象模式：live2d 唯一（VTuber 工业标准；库/模型加载失败 → 光球兜底）。3d/portrait 已退役
const PET_MODE = 'live2d';

// ---------- Task State 总线全局单例(纯逻辑见 ui/task-state.mjs;preload 订阅与三窗口广播)----------
const taskBus = createTaskState();
// 测试钩子(驱动状态流转用;生产 UI 不依赖):op=get/set/history
ipcMain.handle('__ui2-task-state', (_e, { op, next, detail } = {}) => {
  if (op === 'get') return { ok: true, state: taskBus.state, ...stateWordsFor(taskBus.state) };
  if (op === 'set') return taskBus.set(next, detail);
  if (op === 'history') return { ok: true, history: taskBus.history };
  return { ok: false, error: 'unknown op' };
});
// 状态流转广播到三窗口(Pet/Home/Quick 同任务同状态;各窗口 UI 逐步消费)
taskBus.subscribe((ev) => broadcastTaskState(ev));
/** 状态词只有一处真源(ui/task-state.mjs):广播时把两句话挂上,页面**零表**消费。
 *  key 走 lib.t → 换语言时状态词跟着走;词表缺该 key 时 t() 原样返回 key,这里回落中文原文。 */
function stateWordsFor(state) {
  /* 等待语按**相处模式**取（温柔/干脆/俏皮）；没设过 = 通用那套（一字不差）。
     ⚠ 词表仍然只从固定表里取（安全词表：绝不插值工具参数/命令/路径）。 */
  const tone = lib.waitTone?.() ?? '';
  const Words = globalThis.TaskWords ?? {};
  const { word, pending } = stateWords(state, tone);
  const pick = (key, fallback) => { const v = lib.t(key); return !v || v === key ? fallback : v; };
  return {
    word: pick(TASK_STATE_KEYS[state], word),
    /* 先取**这一档人格的味道词**（已翻五语），没翻才回落通用那句——
       这样"温柔/干脆/俏皮"的差别在五种语言里都在。 */
    pending: (() => {
      const toneKey = Words.pendingToneKey?.(tone, state);
      if (toneKey) { const v = lib.t(toneKey); if (v && v !== toneKey) return v; }
      return pick(TASK_STATE_PENDING_KEYS[state], pending);
    })(),
  };
}
/** 正在干的那一步的**粗粒度**说法（"正在看资料"）——桌面形象端也用它，所以一个字都不许带用户内容 */
let currentTaskStep = null;
function broadcastTaskState(ev) {
  const to = TASK_STATES.includes(ev?.to) ? ev.to : taskBus.state;
  broadcastToWindows('task-state', { ...ev, to, step: currentTaskStep, ...stateWordsFor(to) });
}
/** 工具步进 → 真状态 Working。
 *  状态没变也要广播一次：同一回合里连着读三个文件，那行「正在看资料」得跟着刷新。 */
function noteTaskStep(coarse) {
  currentTaskStep = coarse || null;
  if (!taskBus.isBusy()) return;
  if (taskBus.state !== 'Working' && taskBus.can('Working')) taskBus.set('Working', currentTaskStep);
  else broadcastTaskState({ from: taskBus.state, to: taskBus.state, at: Date.now(), detail: currentTaskStep });
}
/** 向全部活跃窗口广播(Pet/Home/Quick 同帧一致)
 *  名单里含**对话房间**——否则 `chat-think` 到不了房间，"过程卡里有思考引文条"
 *  这条在家页成立、在房间里永远空白（同一段代码两条命）。 */
function broadcastToWindows(channel, payload) {
  for (const w of [mainWin, petWindow, quickWin, convWin]) {
    if (w && !w.isDestroyed()) w.webContents.send(channel, payload);
  }
}
// 诊断钩子(启动策略自动化验证用;开发诊断,不入普通 UI):窗口清单+可见性
ipcMain.handle('__ui2-windows', () => BrowserWindow.getAllWindows().map((w) => ({
  title: w.getTitle(),
  visible: w.isVisible(),
  kind: w === petWindow ? 'pet' : w === mainWin ? 'main' : w === birthWin ? 'birth' : w === quickWin ? 'quick' : 'other',
})));
/** 非活跃态先回落 Idle(Success/Error/Cancelled 停留期间用户再次发话,保证 Listening 能进) */
function taskBusToIdleIfSettled() {
  if (!taskBus.isBusy() && taskBus.state !== 'Idle') taskBus.set('Idle');
}
/** 聊天主链路统一走这里——输入即 Listening,首个回复流 Thinking,完成/失败/停止人话化收尾 */
async function runChatWithTask(text, onDelta, opts = {}) {
  const detail = String(text ?? '').slice(0, 40);
  taskBusToIdleIfSettled();
  taskBus.set('Listening', detail);
  let thinking = false;
  try {
    const r = await lib.chat(text, (d) => {
      if (!thinking) { thinking = true; taskBus.set('Thinking', detail); }
      onDelta?.(d);
    }, opts);
    if (opts.signal?.aborted || r?.aborted) { currentTaskStep = null; taskBus.set('Cancelled', detail); }
    else if (r.ok) { currentTaskStep = null; taskBus.set('Success', detail); }
    else { currentTaskStep = null; taskBus.set('Error', detail); }
    // 用户说想聊聊 → TA 邀请「找个舒服的地方聊」(一键进对话房间)
    if (r.ok && /聊聊|说说话|陪陪我|陪我聊|聊聊天|陪我待/.test(String(text ?? ''))) {
      broadcastToWindows('conv-invite');
    }
    return r;
  } catch (e) {
    if (opts.signal?.aborted) taskBus.set('Cancelled', detail);
    else taskBus.set('Error', detail);
    throw e;
  }
}

/** 前台回合（Home/Conv/Quick 共用）：登记 turnId → 流走统一出口 → 结束发 chat-final（重载后的窗口也拿得到）
 *  注意：回合登记发生在**第一条 delta**（lib 的日志锁会串行化排队中的回合——若提前登记，
 *  "在跑的那个"会被误认成"排队的那个"，插话校验与去重都会错位）。 */
async function runForegroundChat(text, { signal, deltaSink, images } = {}) {
  const turnId = `t-${++turnSeq}`;
  let started = false;
  const startTurn = () => {
    if (started) return;
    started = true;
    activeTurn = { id: turnId, text: '', seq: 0, startedAt: Date.now() };
    setSessionStatus({ state: 'Active' });
  };
  try {
    const r = await runChatWithTask(text, (delta) => {
      startTurn();
      if (activeTurn && activeTurn.id === turnId) {
        activeTurn.seq++;
        activeTurn.text += delta;
        chatSend('chat-delta', { turnId, seq: activeTurn.seq, text: delta });
      } else {
        chatSend('chat-delta', { turnId, seq: 0, text: delta }); // 另一回合在跑（锁排队中）→ 透传
      }
      deltaSink?.(delta); // Quick 窗自己的 quick-delta 兼容通道
    }, { signal, image: images });   // 图随这一回合进视觉档（数组或空）
    if (r.ok) {
      bubbleSpeak(petWindow, r.reply, r.emotion ?? 'neutral');
      if (r.opened?.length) effectOpenApp(r.opened);
    } else if (r.error) {
      bubbleSpeak(petWindow, '❌ ' + lib.friendlyError(r.error), 'sad');
    }
    // 这一轮改过文档 → 把产物推给界面（右侧预览自己开）
    if (r.ok && r.files?.length) {
      const previews = [];
      for (const f of r.files.slice(0, 3)) {
        const pv = await lib.previewFile(f);
        if (pv.ok) previews.push({ path: pv.path, name: pv.name, html: pv.html });
      }
      if (previews.length) chatSend('files-changed', previews);
    }
    chatSend('chat-final', { turnId, ok: !!r.ok, reply: r.reply, error: r.error, aborted: !!r.aborted, emotion: r.emotion, mode: r.mode ?? null, verification: r.verification ?? null, files: r.files ?? [] }); // 产物列表随 final 一起给——重载后窗口也能重建"产物"面板
    return r;
  } catch (e) {
    const msg = lib.friendlyError(e?.message ?? e);
    bubbleSpeak(petWindow, '❌ ' + msg, 'sad');
    chatSend('chat-final', { turnId, ok: false, error: msg });
    return { ok: false, error: msg };
  } finally {
    if (activeTurn && activeTurn.id === turnId) activeTurn = null;
    if (started) setSessionStatus({ state: 'Idle' });
  }
}

/** 旁路回合（截图/拖文件/屏幕观察）：共用同一出口（渲染层按 turnId/seq 去重），不登记前台回合 */
function backgroundDeltaSink() {
  const turnId = `bg-${++turnSeq}`;
  let seq = 0;
  return (delta) => { seq++; chatSend('chat-delta', { turnId, seq, text: delta, background: true }); };
}

/** followup 档：本轮全部干完 → 自动把排队消息发出去（一次一条，循环到队列空） */
let drainingFollowUps = false;
async function drainFollowUps() {
  if (drainingFollowUps) return;
  drainingFollowUps = true;
  try {
    while (!quitting) {
      const st = lib.chatQueueState();
      if (!st.followups.length) break;
      const taken = lib.takeQueued('followup', st.followups[0].id);
      if (!taken.ok) break;
      broadcastQueue();
      await withAbort((ctrl) => runForegroundChat(taken.item.text, { signal: ctrl.signal }));
    }
  } finally {
    drainingFollowUps = false;
  }
}

ipcMain.handle('pet-profile', () => lib.petProfile());

// 入口直达指令——「打开管理中心/设置」「回家/打开家」不再绕 LLM。
// 命中 → 直接开窗,返回人话回执(quick/chat 两条链路共用)。
function directCommand(raw) {
  const t = String(raw ?? '').trim().toLowerCase();
  if (!t || t.length > 24) return null;
  if (/管理中心|^(打开|进入|去|帮我打开|帮我进)?\s*(一下)?\s*(ta的|ta 的|你的|我的)?\s*设置$/.test(t)) {
    createManageWindow();
    return '好,管理中心开好了~';
  }
  if (/^(打开|进入|去|回|带我)\s*(一下)?\s*(ta的|ta 的|你的|我的)?\s*回?家$|^(ta的|ta 的|你的|我的)家$|^家$|^回家$/.test(t)) {
    openHistoryPanel();
    return '好,回家啦~';
  }
  return null;
}

ipcMain.handle('import-package', async () => {
  const r = await dialog.showOpenDialog({ properties: ['openFile'], filters: [{ name: '灵核出生包', extensions: ['lhcd', 'json'] }] });
  if (r.canceled || !r.filePaths[0]) return { ok: false, error: '未选择文件' };
  return lib.importPackageFromPath(r.filePaths[0]);
});
ipcMain.handle('import-path', (_e, p) => lib.importPackageFromPath(String(p)));

ipcMain.handle('bind', () => {
  const r = lib.bind();
  if (r.ok) createPetWindow(); // 出生后：TA 以桌面本体形态现身
  return r;
});

// 统一说话入口——气泡 + 高表现力 TTS（情绪韵律同源；LHCD_TTS=0 关闭语音；
// 语音播报开关关闭时只显气泡；系统音色走本地 speechSynthesis 播报）
function bubbleSpeak(win, text, emotion = 'neutral', opts = {}) {
  if (!win || win.isDestroyed()) return false; // 返回"送到了没有"——投递账本据此决定提交还是重试
  const t = String(text ?? '').slice(0, 300); // 与 lib.speak 上限对齐（长回复分句连播，不再半截就停）
  win.webContents.send('bubble', { text: t.slice(0, 120), emotion });
  if (opts.noVoice) return true; // 免打扰时段的外来信：只显气泡不出声
  if (process.env.LHCD_TTS === '0' || !t) return true;
  if (lib.getPrefs().speechEnabled === false) return true; // 语音播报关闭 → 只显气泡
  lib.speak(t, emotion).then((a) => {
    if (!a.ok || !win || win.isDestroyed()) return;
    if (a.engine === 'system') {
      win.webContents.send('pet-speech-local', { text: a.text, voice: a.voice });
    } else {
      win.webContents.send('pet-audio', a);
    }
  }).catch(() => { /* 语音失败不影响气泡 */ });
  return true;
}

/** 窗口不在时的第二通道：系统通知（宁可换条路，也不静默丢）。
 *  Windows 适配：osascript 是 macOS 专有——非 mac 走 Electron 自带的 Notification
 *  （跨平台、不依赖外部命令）；mac 保留 osascript。
 *  返回 false = 这条通道也没送出去，调用方据此保持「欠着」，不静默丢。 */
function desktopNotify(title, body) {
  if (process.platform !== 'darwin') {
    try {
      if (!Notification.isSupported()) return false;
      new Notification({ title: String(title), body: String(body).slice(0, 180) }).show();
      return true;
    } catch {
      return false;
    }
  }
  try {
    const dq = (s) => `"${String(s).replace(/["\\]/g, '')}"`;
    execFileSync('osascript', ['-e', `display notification ${dq(String(body).slice(0, 180))} with title ${dq(title)}`], { timeout: 8000 });
    return true;
  } catch {
    return false;
  }
}

/** 主动消息的统一下发——先落"欠着"（lib 已 beginDelivery）→ 气泡/系统通知 → 确认送达才提交副作用。
 *  item.noVoice：深夜的"答应过的事"只显气泡不出声（与来信/礼物同规）。 */
function deliverProactive(item, { commitHint } = {}) {
  const text = String(item?.text ?? '').trim();
  if (!text) return false;
  // 真发之前先落"正在发"——崩在这里，重启后才会带 ♻️ 标记重投，而不是静默重复
  if (item.deliveryId) lib.markDeliverySending(item.deliveryId);
  let delivered = bubbleSpeak(petWindow, text, item.emotion ?? 'neutral', { noVoice: item.noVoice === true });
  if (!delivered) delivered = desktopNotify(lib.t('app.notify.title'), text);   // 通知标题也走词表（换语言后重启即生效）
  if (!delivered) return false;
  if (item.deliveryId) lib.confirmDelivery(item.deliveryId);
  // 顶部有没有开着对话：主动这句话也进对话流（像在同一条对话里继续）
  chatSend('chat-proactive', { text, at: Date.now(), kind: item.kind ?? 'proactive' });
  return true;
}

/** 重启后把上次没送达的主动消息补投一次（带"可能是重复的"可见标记）。
 *  启动时先 rehydrate（把崩溃时卡在 sending 的退回 pending），再补投。 */
function resumeDeliveries() {
  const processStart = Date.now();
  try {
    const { recovered } = lib.rehydrateDeliveries();
    if (recovered) diag(`投递账本：${recovered} 条卡在发送中的记录已退回待投`);
    setTimeout(() => {
      try {
        for (const d of lib.resumableDeliveries(processStart)) {
          diag('补投上次未送达的主动消息：' + d.kind);
          deliverProactive({ text: d.text, deliveryId: d.id, kind: d.kind });
        }
      } catch { /* 补投失败不阻塞 */ }
    }, 3000); // 等宠物窗就绪
  } catch { /* 账本异常不阻塞启动 */ }
}

/** 启动恢复——① 先看有没有"被强杀在半路"的回合（续做完）；
 *  ② 再看账本里有没有被中断的长活（问要不要继续）。
 *  先①后②：续跑本身会把长活的上下文带上，避免同一件事问两遍。 */
function startTaskRecovery() {
  setTimeout(async () => {
    try {
      const resumed = await lib.interruptedTurnCheck();
      if (resumed.resumed && resumed.text) {
        diag('条 50：续跑被中断的那一轮');
        deliverProactive({ text: resumed.text, deliveryId: resumed.deliveryId, kind: 'resume', noVoice: resumed.quiet, emotion: 'neutral' });
        return;
      }
      const rec = await lib.taskStartupRecovery();
      if (rec.ok && rec.text) {
        diag('条 16：长活恢复提示 ' + rec.recovered + ' 件');
        deliverProactive({ text: rec.text, deliveryId: rec.deliveryId, kind: 'task-recovery', noVoice: rec.quiet, emotion: 'comfort' });
      }
    } catch (e) {
      diag('任务恢复失败（不阻塞启动）：' + String(e?.message ?? e));
    }
  }, 4000);
}

let infoTickNow = null; // 探针/测试钩子：立即跑一次 tick（生产走 setInterval）
function startInfoSync() {
  // tick 每分钟一次（cron 是分钟粒度）；下面几件重活每 5 tick 跑一次（省成本）
  let tickCount = 0;
  const tick = async () => {
    tickCount++;
    try {
      // 定时任务（每分钟看一次；due/retry/recover 都在 lib.cronTick 内定夺）
      const cron = await lib.cronTick();
      for (const r of cron.results ?? []) {
        if (r.status === 'ok' && r.text) {
          deliverProactive({ text: r.text, deliveryId: r.deliveryId, kind: 'cron', emotion: 'neutral' });
        } else if (r.status === 'failed' && r.notice) {
          // 重试也用完了 → 说一声（"答应你的事没做成"不能只有账本知道）
          deliverProactive({ text: r.notice, deliveryId: r.deliveryId, kind: 'cron-failed', emotion: 'sad' });
        }
      }
      // 会话心跳（内部按闲置时长/仲裁器/退避自门禁；silent 回合不出声）
      const hb = await lib.heartbeatCheck();
      if (hb.ok && !hb.silent && hb.text) {
        deliverProactive({ text: hb.text, deliveryId: hb.deliveryId, kind: 'heartbeat', emotion: 'comfort' });
      }
      if (tickCount % 5 !== 0) return; // 下面几件保持 5 分钟节奏
      // 催办退避——等用户拍板超时的事，按 30 分 / 1 小时 / 2 小时各问一次（每周期最多 3 次）。
      // 这是"已经答应过的事"的延续：不受每日闲聊配额约束，但深夜只显气泡不出声。
      const nudges = await lib.taskNudgeCheck();
      for (const n of nudges.nudges ?? []) {
        deliverProactive({ text: n.text, deliveryId: n.deliveryId, kind: 'task-nudge', noVoice: n.quiet, emotion: 'comfort' });
      }
      // 里程碑优先（仪式事件）：满月/百日/生日/成年礼 → 祝福气泡（先在仲裁器申报）
      const ms = await lib.checkMilestones();
      if (ms) {
        if (ms.deliveryId) deliverProactive({ text: `${ms.label} · ${ms.text}`, deliveryId: ms.deliveryId, kind: 'milestone', emotion: 'comfort' });
        return;
      }
      const r = await lib.syncInfoCheck();
      if (r.ok && r.changed && r.deliveryId) {
        deliverProactive({ text: `我留意到：${r.items.slice(0, 2).join('；')}`, deliveryId: r.deliveryId, kind: 'info-sync', emotion: 'knowledge' });
      }
      // 自主社交：用户不在场时 TA 自主社交 + 叙事汇报气泡（门禁走仲裁器）
      const auto = await lib.socialAutonomousCheck();
      if (auto.ok && auto.report) {
        deliverProactive({ text: auto.report, deliveryId: auto.deliveryId, kind: 'social', emotion: 'neutral' });
      }
    } catch (e) {
      // 失败不阻断（下次重试），但**留痕**——静默吞异常会让"定时任务没跑"这种问题无从排查
      diag('tick 异常（下次重试）：' + String(e?.stack ?? e).slice(0, 300));
    }
  };
  infoTickNow = tick;
  setInterval(tick, 60 * 1000);
  tick();
}

// ---------- 探针钩子（与 __iter03 同类；生产 UI 不依赖）----------
export const __iter04 = {
  /** 立即跑一次主进程 tick（定时任务/心跳/里程碑/信息同步的真实链路：出闸→投递→确认→广播） */
  tickNow: () => infoTickNow?.(),
};

// ---------- 审批通道：审批登记（会话状态，不是 UI 状态） ----------
// 登记表 / 重连重放 / resolved 广播 / 60s 超时。
// `approvalMode` 是兼容开关：'auto-allow' 全放行（冒烟用），'ask' 走待批登记。
const pendingApprovals = new Map(); // id → { id, tool, args, ruleId, summary, risk, createdAt, resolve, timer }
let approvalSeq = 0;
function approvalPublicList() {
  // 给**整张卡**（title/why/impact/raw…），不只是简版——窗口重开/重载后要能原样重画那张卡
  return [...pendingApprovals.values()].map((p) => ({ ...(p.card ?? { id: p.id, tool: p.tool, raw: p.summary, risk: p.risk }), createdAt: p.createdAt }));
}
/** 解决一条待批：结算 Promise + 广播 resolved（其它窗口据此关掉旧框）+ 清等待态 */
function resolveApproval(id, decision) {
  const p = pendingApprovals.get(String(id ?? ''));
  if (!p) return { ok: false, error: '没有这条待批（可能已处理）' };
  clearTimeout(p.timer);
  pendingApprovals.delete(p.id);
  try { p.resolve(decision); } catch { /* 已结算 */ }
  // ⚠ 必须广播到**三个窗口**（家页/对话窗/形象端）——卡片可能出现在其中任何一个，
  // 其余窗口要据此收起同一张卡（别用 chatSend，那只到两个窗口）
  broadcastToWindows('approval-resolved', { id: p.id, decision });
  if (pendingApprovals.size === 0) setSessionStatus({ waitingOnApproval: false });
  return { ok: true, decision };
}
/** 登记一条待批（真实链路与冒烟钩子共用同一函数） */
function createPendingApproval(req) {
  const id = `ap-${++approvalSeq}`;
  const entry = {
    id, tool: req?.tool ?? 'unknown', args: req?.args ?? {}, ruleId: req?.ruleId ?? '',
    summary: approvalSummary(req ?? {}),
    risk: typeof req?.risk === 'string' ? req.risk : 'R3',   // 内核的 R 档（缺省按 R3 保守，不猜）
    createdAt: Date.now(), resolve: null, timer: null,
  };
  const promise = new Promise((resolve) => { entry.resolve = resolve; });
  /* 第三态「以后这类都允许」的前提 = **能写出一条窄规矩**。
     给不出（这类动作还没有一眼看得懂的写法 / 这一轮已经记过一条 / 命令里有说不清的构造）
     → 这颗按钮**不显示**，并把原因记在 entry 上（不计入 card，免得上屏）。 */
  try { entry.ruleSuggestion = lib.proposeRuleForApproval({ tool: entry.tool, args: entry.args }); }
  catch (e) { entry.ruleSuggestion = { ok: false, reason: String(e?.message ?? e) }; }
  entry.card = approvalCardPayload(entry); // 文案一处生成（三个窗口 + 重开窗口都用这一份）
  entry.timer = setTimeout(() => { resolveApproval(id, 'deny'); }, 60000); // 60s 无响应自动拒绝（保留原行为）
  pendingApprovals.set(id, entry);
  setSessionStatus({ waitingOnApproval: true });
  /* 这张卡必须**广播到三个窗口**：听它的是形象端（pet.html）；若只走 `chatSend`（家页与对话窗），
     卡就弹不出来——她一问就等 60 秒、然后按"不允许"收场。
     你在哪个窗口，卡就在哪个窗口；谁能显示谁显示，答完由 approval-resolved 收起其余。 */
  broadcastToWindows('approval-ask', entry.card);
  return { id, promise };
}
// 审批的"要不要打扰用户"由**模式作用域**决定（在 lib.mjs 的桥里判：闲聊不问 / 工作只问 R3+ /
// 后台回合不弹）。所以默认值是 'ask'——**该不该弹已经在上一层筛过了**，到了这里就是要弹给用户看。
// `approvalMode` 保留给冒烟钩子做兼容开关（'auto-allow' 仍然全放行）。
let approvalMode = 'ask';
/* ⚠ 别在这里加隐式的"问三次就静默放行"（曾有过 `approvalAllowCounts`，已删除）：
     ① 键是 `工具|规则号`、**不含参数** —— 批准过三条 `bash`（默认兜底规则 r3 = `.*`）之后，
        第四条完全不同的命令也不再问。那不是「Ask once」，是「问三次之后这一类全放行」；
     ② 内存态、从不清理 → **同一个会话里越用越松**，与"越宽越紧"正好相反；
     ③ 少打扰应该靠**用户显式选过**的闸门：闲聊档不问 / 后台回合不问 / 三档作用域（完全访问·
        帮我批准·请求批准）/ 规则白名单（`^git ` 这类），而不是隐式学习。
   想要「Ask once」请用**显式**的"以后这类直接允许"——brain 里已有 `proposePrefixRule`
   （会拒绝把 `sudo ls`、`bash -c "ls"`、`npm test` 这类提成规则，且规则锚定前缀），
   接上审批卡按钮即可。 */
lib.setApprovalBridge((req) => {
  if (approvalMode === 'auto-allow') return Promise.resolve('allow'); // 兼容旧开关（冒烟用）
  return createPendingApproval(req).promise;
});
// 模式变化推给所有窗口（家页胶囊 / 桌面形象端）——界面据此换菜单文案与"固定不动"
// 注意用 broadcastToWindows（家页 + 桌面形象端 + 快捷窗都要）——chatSend 只发给家页/对话窗
lib.setModeBroadcast((payload) => broadcastToWindows('mode-changed', payload));
/* 她对你说的话有反应——"开心"只推给**形象端**（她当场演一下），
   家页/对话窗不用管（那边有文字就够了，别再冒一个表情出来）。 */
lib.setMoodSink((m) => {
  if (petWindow && !petWindow.isDestroyed()) petWindow.webContents.send('pet-mood', m);
});

// 过程可见：关键节点（她在读什么/改什么/搜什么）实时到界面。
// 分层（安全词表）：家页与对话窗收细分（可带文件名）；桌面形象端只收粗粒度。
lib.setStepSink((ev) => {
  try {
    // 工具一动就是真·Working——状态词不再撒谎说"我在听"。
    // 只认 start/end 两相（think 是思考摘要，不改变"在做什么"）。
    if (ev.phase === 'start') noteTaskStep(ev.coarse);
    else if (ev.phase === 'end') noteTaskStep(null);
    if (ev.phase === 'think') broadcastToWindows('chat-think', { text: ev.text }); // 思考摘要（家页 + 对话房间；形象端不展示）
    else chatSend('chat-step', ev);
    if (petWindow && !petWindow.isDestroyed() && (ev.phase === 'start' || ev.phase === 'end')) {
      petWindow.webContents.send('pet-step', { label: ev.coarse, phase: ev.phase, ok: ev.ok !== false });
    }
  } catch { /* 窗口不在不影响回合 */ }
});
/* ⚠ 别按**工具名自己猜**风险高/中/低——内核有唯一真源 `policy/risk.ts` 的 R0~R5，
   随审批请求一起送来（`req.risk`）。两套判断并存 = 同一件事两个说法（还会打架）。
   这里**只把内核那一档透传上去**，人话与颜色在渲染层一处映射（`components.js` 的 riskWord / riskSeverity）。 */

/** 工具调用 → 人类可读一句话（审批气泡展示用，备用） */
/**
 * 审批卡的**文案**：一处生成，家页/对话窗/形象端三处只负责排版——
 * 免得同一句话在三个窗口有四种说法（"状态词三套表"就是这么吃过一次亏）。
 *
 * 四个字段：
 *   title  做什么（人话，不是命令行）
 *   why    为什么问你（内核判据 → 人话；说不清就老实说"拿不准"）
 *   impact 影响面（**只做得到的那一半**：路径就在参数里的文件类工具直接给；
 *          目录不递归去数——那是第二步的事）
 *   raw    原始内容（叠起来，默认收起）
 */
function approvalCardPayload(entry) {
  const req = { tool: entry.tool, args: entry.args, ruleId: entry.ruleId };
  const risk = entry.risk;
  return {
    id: entry.id,
    tool: entry.tool,
    risk,
    title: approvalTitle(req),
    why: approvalWhy(req, risk),
    impact: approvalImpact(req),
    raw: entry.summary,
    // 「到这次对话结束都允许」：R5（不可逆）**不给**这个选项——那一档任何情况都要问
    canSession: risk !== 'R5',
    // 「以后这类都允许」：宿主能给出**窄规矩**时才有这颗按钮。
    // 给不出就不显示——"没做就不显示按钮"这条纪律不变。
    canRule: entry.ruleSuggestion?.ok === true,
    ruleNote: entry.ruleSuggestion?.ok ? (entry.ruleSuggestion.preview ?? '') : '',
    createdAt: entry.createdAt,
  };
}

/** 做什么（人话） */
function approvalTitle(req) {
  const a = req.args ?? {};
  const n = (x) => (Array.isArray(x) ? x.length : 0);
  switch (req.tool) {
    case 'delete': return `她想删掉 ${n(a.paths) || '几个'} 个文件`;
    case 'write': return `她想写一个文件`;
    case 'edit': return `她想改一个文件`;
    case 'office': return `她想动一个文档`;
    case 'media': return `她想处理一个影音文件`;
    case 'bash': return `她想跑一条命令`;
    case 'install_skill': return `她想装一个本事`;
    case 'install_mcp': return `她想连一个外部服务`;
    case 'app': return a.action === 'run' ? '她想执行一段脚本' : `她想操作一个应用`;
    case 'screen': return '她想看一眼屏幕';
    // 读"从外面拿来的东西"——说清这份文件是谁的，别让用户以为是她自己找的
    case 'read': return req.ruleId === 'outside-source-read' ? '她想读一份从外面拿来的文件' : '她想读一个文件';
    default: return `她想动一下这台机器`;
  }
}

/** 为什么问你（内核判据 → 人话；判据出处 policy/engine.ts 与 policy/risk.ts） */
function approvalWhy(req, risk) {
  // 看屏幕不是"不可撤回的脚本"，它是**内容离开这台机器**——
  // 两种 R5 的理由不一样，别用同一句话糊过去（用户看得懂区别）。
  if (req.tool === 'screen') return '画面要送去识别，这一下它就会离开这台机器。';
  if (req.ruleId === 'outside-source-read') return '这份文件在下载目录里——里面的字是别人写的，不是你给我的。';
  if (risk === 'R5') return '这一步不可撤回（跑起来的脚本收不回来），任何档位都得你点头。';
  switch (req.ruleId) {
    case 'outside-workspace': return '这一步不在你给我的文件夹里。';
    case 'auto-destructive-write': return '这一步会覆写或者大范围改动东西。';
    case 'danger-caution': return '这条命令里有说不清的地方（重定向/变量/替换），拿不准，所以问你。';
    case 'app-high-risk': return '这是高风险的应用操作，每次都要你确认。';
    case 'app-not-whitelisted': return '这个应用还不在你放行的名单里。';
    case 'auto-bash': return '这条命令不在免问清单里。';
    case 'r3': return '这条命令不在免问清单里。';
    case 'baseline-zone': case 'reserved-zone': return '这一步碰到了只能你自己来的地方。';
    default:
      if (String(req.ruleId).startsWith('default:')) return '按你现在的档位，这类动作要先问你一下。';
      if (String(req.ruleId).startsWith('u')) return '你自己定的规则要求先问一下。';
      return '按你现在的档位，这类动作要先问你一下。';
  }
}

/** 影响面（做得到的那一半：路径在参数里就直接给；**不递归数目录**——那是第二步） */
function approvalImpact(req) {
  const a = req.args ?? {};
  // 看屏幕：影响面不是文件，说清"看到什么、之后怎么办"
  if (req.tool === 'screen') return '主屏幕的当前画面（一张图）· 用完就删 · 分析结果会告诉你';
  const list = [];
  if (typeof a.path === 'string') list.push(a.path);
  if (Array.isArray(a.paths)) for (const p of a.paths) if (typeof p === 'string') list.push(p);
  if (typeof a.file === 'string') list.push(a.file);
  if (!list.length) return '';
  const shown = list.slice(0, 3).map((p) => {
    let kind = '';
    try {
      const st = fs.statSync(p);
      kind = st.isDirectory() ? '（整个文件夹）' : `（${Math.max(1, Math.round(st.size / 1024))} KB）`;
    } catch { kind = '（现在找不到）'; }
    return `${shortPath(p)}${kind}`;
  });
  const more = list.length > 3 ? `，还有 ${list.length - 3} 个` : '';
  return `${shown.join('、')}${more}`;
}

/** 上屏用的短路径：家目录下给相对形式（不要把完整路径显示给人看） */
function shortPath(p) {
  const home = os.homedir();
  const s = String(p);
  if (s === home) return '家目录';
  return s.startsWith(home + path.sep) ? s.slice(home.length + 1) : s;
}

function approvalSummary(req) {
  const args = req.args ?? {};
  if (req.tool === 'bash') return String(args.command ?? '').slice(0, 200) || '执行 shell 命令';
  if (req.tool === 'app') {
    switch (args.action) {
      case 'open': case 'activate': return `打开应用「${String(args.target ?? '')}」`;
      case 'notify': return `发送通知「${String(args.text ?? '').slice(0, 60)}」`;
      case 'calendar': return `添加日历事件「${String(args.title ?? '')}」`;
      case 'reminder': return `创建提醒「${String(args.title ?? '')}」`;
      case 'run': return `执行脚本 ${String(args.script ?? '').slice(0, 120)}`;
      case 'clipboard': return '读取剪贴板';
      default: return `执行设备操作「${String(args.action ?? '')}」`;
    }
  }
  if (req.tool === 'install_skill') return `安装技能（来源：${String(args.source ?? '').slice(0, 120)}）`;
  if (req.tool === 'install_mcp') return `连接 MCP 服务「${String(args.name ?? '')}」→ ${String(args.url ?? '').slice(0, 120)}`;
  return `调用工具 ${req.tool}`;
}
/** 审批风险分级（前端徽章用）——改机器/装东西=高；开应用/通知/日历=中；读类=低 */
ipcMain.handle('approval-answer', async (_e, { id, allow, decision } = {}) => {
  // 第三态「以后这类都允许」= **先写规矩再放行**。
  // 写不进去就如实说，并且**不当成放行**（宁可她再问一次，也不能"以为记住了其实没记"）。
  if (decision === 'allow-rule') {
    const entry = pendingApprovals.get(String(id ?? ''));
    const sug = entry?.ruleSuggestion;
    if (!sug?.ok) return { ok: false, error: sug?.reason ?? '这条没法记成规矩' };
    const w = await lib.writeApprovedRule(sug.rule);
    if (!w.ok) return { ok: false, error: w.error ?? '规矩没写进去' };
    const r = resolveApproval(id, 'allow');            // 这一次照做
    broadcastToWindows('my-rules-changed', { id: sug.rule.id, preview: sug.preview ?? '' });
    return { ...r, wroteRule: { id: sug.rule.id, preview: sug.preview ?? '', shadowed: !!w.shadowed } };
  }
  const d = ['deny', 'allow', 'allow-session'].includes(decision) ? decision : (allow ? 'allow' : 'deny');
  return resolveApproval(id, d);
});
/* 我的规矩（设置页那一页）：列出来 / 删掉。**只动用户层**——内置 deny 与保留区删不掉，
   那正是"墙只许加高不许拆"（有测试钉着）。 */
ipcMain.handle('my-rules', () => lib.myRules());
ipcMain.handle('my-rule-remove', (_e, id) => lib.removeMyRule(String(id ?? '')));
/* 自己写一条规矩（参数级 / glob 写法）+ 输入框下面的实时体检 */
ipcMain.handle('my-rule-add', (_e, r) => lib.addMyRule(r ?? {}));
ipcMain.handle('my-rule-check', (_e, r) => lib.checkMyRule(r ?? {}));
// 市场（源与清单）。**客户端市场**——源 + 目录 + 装/卸/更新 + 来源可见
ipcMain.handle('market-sources', () => lib.listMarketSources());
ipcMain.handle('market-catalog', () => lib.marketCatalog());
ipcMain.handle('market-source-add', (_e, r) => lib.addMarketSource(r ?? {}));
ipcMain.handle('market-source-remove', (_e, id) => lib.removeMarketSource(String(id ?? '')));
ipcMain.handle('market-source-refresh', (_e, id) => lib.refreshMarketSource(String(id ?? '')));
ipcMain.handle('market-prepare', (_e, item) => lib.marketPrepareInstall(item ?? {}));
ipcMain.handle('market-install', (_e, item) => lib.marketInstall(item ?? {}));
// 市场：管（来源与版本 / 检查更新 / 卸载）
ipcMain.handle('market-installed', () => lib.installedList());
ipcMain.handle('market-uninstall-preview', (_e, name) => lib.uninstallPreview(String(name ?? '')));
ipcMain.handle('market-uninstall-skill', (_e, { name, forget } = {}) => lib.uninstallSkill(String(name ?? ''), { forget: !!forget }));
ipcMain.handle('market-uninstall-mcp', (_e, name) => lib.uninstallMcp(String(name ?? '')));
ipcMain.handle('market-check-update', (_e, name) => lib.checkSkillUpdate(String(name ?? '')));
// 模式（工作/闲聊）——家页胶囊与桌面形象端共用；锁定 = 不再自动切
ipcMain.handle('mode-get', () => ({ ok: true, mode: lib.currentMode(), locked: lib.isModeLocked(), judgement: lib.lastModeJudgement() }));
ipcMain.handle('mode-set', (_e, { mode, lock } = {}) => lib.setMode(mode, { source: 'host', reason: '用户在界面上切的', ...(lock === undefined ? {} : { lock }) }));
// 三档权限（完全访问 / 帮我批准 / 请求批准）
ipcMain.handle('approval-scope-get', () => ({ ok: true, scope: lib.currentApprovalScope(), label: lib.currentApprovalScope() ? lib.APPROVAL_SCOPE_LABELS[lib.currentApprovalScope()] : null }));
ipcMain.handle('approval-scope-set', (_e, { scope } = {}) => lib.setApprovalScope(scope));
// 冒烟/测试钩子（驱动真实登记/重放/广播路径；生产 UI 不依赖）
ipcMain.handle('__ui2-approval', (_e, { op, id, allow, mode } = {}) => {
  if (op === 'mode') { approvalMode = mode === 'ask' ? 'ask' : 'auto-allow'; return { ok: true, mode: approvalMode }; }
  if (op === 'ask') { const { id: nid } = createPendingApproval({ tool: 'bash', args: { command: 'echo smoke' }, ruleId: 'smoke' }); return { ok: true, id: nid }; }
  if (op === 'pending') return { ok: true, pending: approvalPublicList() };
  if (op === 'answer') return resolveApproval(id, allow ? 'allow' : 'deny');
  return { ok: false, error: 'unknown op' };
});

// ---------- 长任务中止通道：每次用户聊天挂 AbortController；「停止」按钮经 chat-stop 全部中止 ----------
const activeChats = new Set();
async function withAbort(fn) {
  const ctrl = new AbortController();
  activeChats.add(ctrl);
  try {
    return await fn(ctrl);
  } finally {
    activeChats.delete(ctrl);
  }
}

// ================= 会话出口 + 关机收尾 =================
// per-session 单一有序出口——delta/final/queue/status/approval 全从这里发，每条带 {turnId, seq}；
//        渲染层用 (turnId, seq) 去重 + 加载时 reattach（在途半截 + 队列 + 待批 + 状态一次问全）→ 重载不丢话。
// 会话状态（谁在等你）——只在变化时广播。
// 插话带 turnId 校验——打到已结束的回合 → 自动改投排队（不静默丢），界面明说。
// 退出前收尾（before-quit 闸门：等回合跑完或超时中止）。
function chatWindows() {
  return [mainWin, convWin].filter((w) => w && !w.isDestroyed());
}
function chatSend(channel, payload) {
  for (const w of chatWindows()) {
    try { w.webContents.send(channel, payload); } catch { /* 窗口销毁竞态：忽略 */ }
  }
}
let turnSeq = 0;
let activeTurn = null; // { id, text, seq, startedAt } —— 在途回合登记（reattach 与 steer 校验的数据源）
let sessStatus = { state: 'Idle', waitingOnApproval: false, at: Date.now() };
function setSessionStatus(next) {
  const merged = { ...sessStatus, ...next, at: Date.now() };
  if (merged.state === sessStatus.state && !!merged.waitingOnApproval === !!sessStatus.waitingOnApproval) return;
  sessStatus = merged;
  chatSend('session-status', sessStatus);
}
function broadcastQueue() { chatSend('chat-queue', lib.chatQueueState()); }
/** 重连/重载一次问全：在途半截 + 队列 + 待批 + 状态（渲染层据此恢复现场，不重不漏） */
ipcMain.handle('chat-reattach', () => ({
  ok: true,
  turn: activeTurn ? { id: activeTurn.id, text: activeTurn.text, seq: activeTurn.seq } : null,
  queue: lib.chatQueueState(),
  pending: approvalPublicList(),
  status: sessStatus,
}));
// steer 档：插话——当前回合的下一个工具轮次就会看到
ipcMain.handle('chat-steer', (_e, { text, expectedTurnId } = {}) => {
  const t = String(text ?? '').trim();
  if (!t) return { ok: false, error: '内容为空' };
  if (!activeTurn) return { ok: false, reason: 'no-active-turn' }; // 没在跑 → 渲染层改走正常发送
  if (expectedTurnId && String(expectedTurnId) !== activeTurn.id) {
    // 插话打到已结束/未知的回合 → 不丢弃：改投排队，本轮结束自动送达
    const r = lib.queueFollowUp(t);
    broadcastQueue();
    return { ok: true, mode: 'requeued', reason: 'stale-turn', queue: r.queue };
  }
  const r = lib.queueSteer(t);
  broadcastQueue();
  return { ok: true, mode: 'steer', turnId: activeTurn.id, queue: r.queue };
});
// followup 档：排队——本轮全部干完再说
ipcMain.handle('chat-followup', (_e, { text } = {}) => {
  const r = lib.queueFollowUp(String(text ?? ''));
  broadcastQueue();
  return { ok: r.ok, mode: 'followup', queue: r.queue, error: r.error };
});
// 队列取回（UI「取回」按钮）：原文还给输入框
ipcMain.handle('chat-queue-take', (_e, { kind, id } = {}) => {
  const r = lib.takeQueued(kind === 'followup' ? 'followup' : 'steer', String(id ?? ''));
  broadcastQueue();
  return r;
});
// 停止：先中止当前回合；队列原文随返回值交还（渲染层放回输入框）
/* 对话树——从某句重说 / 列出分支 / 切回某条分支（都只读或只写新目录） */
ipcMain.handle('chat-branch', async (_e, { messageId } = {}) => lib.branchFrom(messageId));
ipcMain.handle('chat-branches', () => lib.branchList());
ipcMain.handle('chat-branch-switch', async (_e, { id } = {}) => lib.branchSwitch(id));
ipcMain.handle('chat-branch-info', () => lib.branchInfo());
ipcMain.handle('session-messages', (_e, { limit } = {}) => lib.sessionMessages(limit));
ipcMain.handle('artifacts-list', (_e, { limit } = {}) => lib.artifactsList(limit));
/* 标签 + 单文件 HTML 导出（给人看的那一份） */
ipcMain.handle('label-set', (_e, { messageId, text } = {}) => lib.labelSet(messageId, text));
ipcMain.handle('labels-list', () => lib.labelsList());
// 后台复盘开关（设置 → 数据与安全）
ipcMain.handle('review-get', () => lib.reviewGet());
ipcMain.handle('review-set', (_e, on) => lib.reviewSet(on));
// 技能候选（我的 TA → 记忆中心：批准 / 忽略）
ipcMain.handle('skill-candidates', () => lib.skillCandidates());
ipcMain.handle('skill-candidate-decide', (_e, name, action) => lib.skillCandidateDecide(name, action));
// 撤销这一轮改动（对话里的产物卡 / 设置页都能点）
// 两个都收 `turnId`（可省）：产物卡点「撤销」时带**自己那一轮**的 id——
// 撤的必须是卡片上那一轮，不是"最近一轮"（回看旧卡片点它，从前撤掉的是新成果）
ipcMain.handle('turn-changes', (_e, turnId) => lib.turnChanges(typeof turnId === 'string' ? turnId : null));
ipcMain.handle('undo-last-turn', (_e, turnId) => lib.undoLastTurn(undefined, typeof turnId === 'string' ? turnId : null));
// KPI 五项（设置 → 模型与花销）
ipcMain.handle('kpi-summary', (_e, days) => lib.kpiSummary(days));
ipcMain.handle('kpi-record', () => lib.kpiRecord());
ipcMain.handle('chat-export-html', async (_e, { title } = {}) => {
  const built = await lib.buildChatHtml({ title });
  if (!built.ok) return built;
  const { canceled, filePath } = await dialog.showSaveDialog({
    title: '把这段对话导出成一页',
    defaultPath: path.join(app.getPath('desktop'), built.suggestedName),
    filters: [{ name: '网页', extensions: ['html'] }],
  });
  if (canceled || !filePath) return { ok: false, canceled: true };
  try {
    fs.writeFileSync(filePath, built.html, 'utf8');
  } catch (e) {
    return { ok: false, error: `写不进去：${String(e?.message ?? e)}` };
  }
  return { ok: true, path: filePath, count: built.count, labels: built.labels };
});

ipcMain.handle('chat-stop', () => {
  for (const c of activeChats) c.abort();
  // 回合中止了，挂着的待批**一次性取消**——不然它们会一直躺在"等审批"里。
  for (const id of [...pendingApprovals.keys()]) resolveApproval(id, 'deny');
  const r = lib.takeAllQueued();
  broadcastQueue();
  return { ok: true, returned: r.items };
});
// 当前在途回合 id——快捷面板插话要带上它做"轮次预条件"校验
ipcMain.handle('chat-active-turn', () => ({ turnId: activeTurn?.id ?? null }));

// ---------- 对话动作联动（说"跳一下"TA 就跳） ----------
/* 这张表必须按语言补齐，且按语言的**真实说法**（不是逐字直译）：
   只写中文的话，英文用户说 "jump"、日文说「ジャンプ」、韩文说「점프」**一个动作都触发不了**
   （她会照常回话，但形象端不动）。 */
const PET_ACTION_WORDS = [
  // 中文（简）
  ['跳一下', 'jump'], ['跳个', 'jump'], ['坐下', 'sit'], ['坐一下', 'sit'], ['蹲下', 'squat'], ['蹲一下', 'squat'],
  ['躺下', 'lie'], ['躺一下', 'lie'], ['跑一下', 'run'], ['跑步', 'run'], ['挥手', 'wave'], ['点头', 'nod'],
  ['摇头', 'shake'], ['吃饭', 'eat'], ['穿衣服', 'dress'], ['换衣服', 'dress'], ['鼓掌', 'celebrate'], ['拍手', 'celebrate'], ['思考一下', 'think'],
  // 中文（繁）
  ['跳一下', 'jump'], ['坐下', 'sit'], ['蹲下', 'squat'], ['躺下', 'lie'], ['跑步', 'run'], ['揮手', 'wave'],
  ['點頭', 'nod'], ['搖頭', 'shake'], ['吃飯', 'eat'], ['換衣服', 'dress'], ['鼓掌', 'celebrate'], ['思考一下', 'think'],
  // English（真实说法：祈使句为主）
  ['jump', 'jump'], ['sit down', 'sit'], ['take a seat', 'sit'], ['squat', 'squat'], ['lie down', 'lie'],
  ['run', 'run'], ['wave', 'wave'], ['nod', 'nod'], ['shake your head', 'shake'], ['eat', 'eat'],
  ['get dressed', 'dress'], ['change your clothes', 'dress'], ['clap', 'celebrate'], ['applaud', 'celebrate'],
  ['think about it', 'think'], ['think', 'think'],
  // 日本語
  ['ジャンプ', 'jump'], ['跳んで', 'jump'], ['座って', 'sit'], ['しゃがんで', 'squat'], ['横になって', 'lie'],
  ['走って', 'run'], ['手を振って', 'wave'], ['うなずいて', 'nod'], ['首を振って', 'shake'], ['ご飯食べて', 'eat'],
  ['着替えて', 'dress'], ['拍手して', 'celebrate'], ['考えて', 'think'],
  // 한국어
  ['점프', 'jump'], ['뛰어', 'jump'], ['앉아', 'sit'], ['쪼그려', 'squat'], ['누워', 'lie'],
  ['달려', 'run'], ['손 흔들어', 'wave'], ['끄덕여', 'nod'], ['고개 저어', 'shake'], ['밥 먹어', 'eat'],
  ['옷 갈아입어', 'dress'], ['박수 쳐', 'celebrate'], ['생각해 봐', 'think'],
];
function petActionForText(text) {
  const t = String(text ?? '');
  for (const [w, a] of PET_ACTION_WORDS) {
    if (t.includes(w)) return a;
  }
  return null;
}
function triggerPetAction(text) {
  const act = petActionForText(text);
  if (act && petWindow && !petWindow.isDestroyed()) {
    petWindow.webContents.send('pet-action', act);
  }
  return act;
}

// 聊天主链路兜底——lib.chat 抛错不再让 invoke reject（渲染层气泡会永远停在"输入中"），
// 统一捕获转 friendlyError 人话返回。
// `images` = 粘贴/拖进来的图（data URL 数组，可空）。
// 宿主的看图能力（toImageDataUrl + 视觉档路由）一直存在，这里给它通道。
ipcMain.handle('chat', (_e, text, images) => {
  const direct = directCommand(text); // 直达指令优先(开管理中心/回家)
  if (direct) { bubbleSpeak(petWindow, direct, 'joy'); return Promise.resolve({ ok: true, reply: direct, emotion: 'joy' }); }
  return withAbort(async (ctrl) => {
    triggerPetAction(text); // 动作先演，回复随流
    const r = await runForegroundChat(text, { signal: ctrl.signal, images }); // 统一出口 + 回合登记
    void drainFollowUps(); // followup 档：本轮干完 → 接着发排队消息
    return r;
  });
});

// 打开应用特效：举手欢呼动画 + 说明气泡 + 眼神看向新应用
function effectOpenApp(names) {
  if (!petWindow || petWindow.isDestroyed()) return;
  petWindow.webContents.send('pet-effect', { type: 'celebrate' });
  bubbleSpeak(petWindow, `帮你打开 ${names.join('、')} 啦`, 'joy');
  const a = screen.getPrimaryDisplay().workArea; // 新应用一般落在工作区中部：看向那里
  sendLook(a.x + Math.round(a.width / 2), a.y + Math.round(a.height / 2), 5000);
}

ipcMain.handle('correct', (_e, { target, text }) => lib.correct(target, text));
ipcMain.handle('forget', (_e, target) => lib.forget(target));
ipcMain.handle('status', () => lib.status());

// 侧面（facet）切换：GUI 入口；自然语言触发已通
ipcMain.handle('facet-set', (_e, key) => lib.setFacet(String(key)));
ipcMain.handle('facet-get', () => lib.getFacet());

// 任务账本 + 定时任务的管理界面通道（「进行中的事」卡片）
ipcMain.handle('task-list', () => lib.taskList());
ipcMain.handle('task-control', (_e, { id, action }) => lib.taskControl(String(id ?? ''), String(action ?? '')));
ipcMain.handle('cron-list', () => lib.cronJobList());
/* 一键停掉全部定时任务（设置 → 陪伴与打扰） */
ipcMain.handle('cron-stop-all', () => lib.stopAllCron());
/* **无人值守时被我拒掉的那些事**——攒着等用户回来（内存，重启即空）。
   ⚠ 只存粗粒度摘要（"跑一条命令"），**不存参数**：没有原文就没法"重放"，
   点「现在做」是让她在有人的时候重做一遍（该问的照样问）——这样也不用担心攒的卡本身泄露什么。 */
ipcMain.handle('bg-blocked-list', () => ({ ok: true, items: lib.listBackgroundBlocked() }));
ipcMain.handle('bg-blocked-clear', (_e, id) => lib.clearBackgroundBlocked(String(id ?? '')));
ipcMain.handle('cron-cancel', (_e, id) => lib.cronJobCancel(String(id ?? '')));

// 日历（农历/节气/干支/宜忌 + 官方假期 + 生日 + 倒计时）
ipcMain.handle('calendar-today', () => lib.calendarToday());
ipcMain.handle('calendar-month', (_e, { year, month } = {}) => lib.calendarMonth(year, month));
ipcMain.handle('calendar-year', (_e, year) => lib.calendarYear(year));
ipcMain.handle('calendar-day', (_e, date) => lib.calendarDay(date));
ipcMain.handle('calendar-upcoming', (_e, count) => lib.calendarUpcoming(count));
ipcMain.handle('birthday-add', (_e, { key, label } = {}) => lib.birthdayAdd(key, label));
ipcMain.handle('birthday-remove', (_e, key) => lib.birthdayRemove(key));
ipcMain.handle('birthday-list', () => lib.birthdayList());

// 模型清单（预热 + 状态 + 刷新开关 + 手动刷新）
ipcMain.handle('catalog-status', () => lib.catalogStatus());
// 去厂商真拉一次模型列表（用户点按钮才联网）
ipcMain.handle('llm-models-fetch', (_e, name) => lib.fetchProviderModels(name));
ipcMain.handle('catalog-set-network', (_e, { on, baseUrl } = {}) => lib.catalogSetNetwork(on, baseUrl));
ipcMain.handle('catalog-refresh', (_e, provider) => lib.catalogRefresh(provider));

// 花销查询（管理中心「花销」卡片）
ipcMain.handle('cost-summary', () => lib.costSummary());
ipcMain.handle('cost-explain-last', () => lib.costExplainLast());

// 右侧预览——改完的文档不切出去也能看（渲染层要 HTML，就地渲染）
ipcMain.handle('preview-file', (_e, file) => lib.previewFile(String(file ?? '')));
// 文件芯片要「文件名 + 行数/大小」——比 previewFile 轻得多的一条（只 stat + 数行）
ipcMain.handle('file-info', (_e, file) => lib.fileInfo(String(file ?? '')));
// 开外链（「获取 API Key」这类帮助链接）。
// ⚠ **只放 https**：URL 来自渲染层，等于"用什么程序打开什么"的决定权 —— 放开 file:/javascript: 之类
// 就是把自己交出去。所以这里白名单到 https 一项，其余一律拒绝。
ipcMain.handle('open-external', (_e, url) => {
  const u = String(url ?? '');
  if (!/^https:\/\//i.test(u)) return { ok: false, error: '只允许 https 链接' };
  try { shell.openExternal(u); return { ok: true }; } catch (e) { return { ok: false, error: String(e?.message ?? e) }; }
});
ipcMain.handle('preview-open-external', (_e, file) => {
  // "用系统默认应用打开"（改完想真看一眼/继续编辑时用）
  try { shell.openPath(String(file ?? '')); return { ok: true }; } catch (e) { return { ok: false, error: String(e?.message ?? e) }; }
});
ipcMain.handle('preview-reveal', (_e, file) => {
  try { shell.showItemInFolder(String(file ?? '')); return { ok: true }; } catch (e) { return { ok: false, error: String(e?.message ?? e) }; }
});

// 多端同步与可携带（GUI 入口；无头链路已通）
ipcMain.handle('portable-export', (_e, { path: p, passphrase }) => lib.exportPortablePackage(String(p), passphrase ? String(passphrase) : undefined));
ipcMain.handle('portable-import', (_e, { path: p, passphrase }) => lib.importPortablePackage(String(p), String(passphrase ?? '')));
ipcMain.handle('portable-verify', (_e, { path: p, passphrase }) => lib.verifyMigration(String(p), String(passphrase ?? '')));

// 社交：本地中继 + 双数字人异步信件（GUI 入口；无头链路已通）
ipcMain.handle('social-status', () => lib.socialIdentity());
ipcMain.handle('social-inbox', () => lib.socialInbox());
ipcMain.handle('social-link-request', (_e, address) => lib.socialSendLinkRequest(String(address)));
ipcMain.handle('social-link-accept', (_e, requestId) => lib.socialAcceptLink(String(requestId)));
ipcMain.handle('social-link-decline', (_e, requestId) => lib.socialDeclineLink(String(requestId)));
ipcMain.handle('social-send', (_e, { address, text }) => lib.socialSendLetter(String(address), String(text)));
ipcMain.handle('social-compose', (_e, { address, topic }) => lib.socialComposeLetter(String(address), topic ? String(topic) : undefined));
ipcMain.handle('social-check-mail', () => lib.socialCheckMail());

// 同步会面（实时聊天）：主进程订阅实时流并转发给渲染层
ipcMain.handle('social-rt-send', (_e, { address, text }) => lib.socialSendRtMessage(String(address), String(text)));
ipcMain.handle('social-rt-reply', (_e, { address, text }) => lib.socialRtReply(String(address), String(text)));
ipcMain.handle('social-online', () => lib.socialOnlinePeers());

// 双人场景（逛街/约会；GUI 入口，headless 已通）
ipcMain.handle('social-scene-join', (_e, room) => lib.socialSceneJoin(String(room)));
ipcMain.handle('social-scene-leave', (_e, room) => lib.socialSceneLeave(String(room)));
ipcMain.handle('social-scene-action', (_e, { room, action, payload }) => lib.socialSceneAction(String(room), String(action), payload ?? {}));
ipcMain.handle('social-gift-offer', (_e, { room, address, itemId }) => lib.socialGiftOffer(String(room), String(address), String(itemId)));
ipcMain.handle('social-scene-report', (_e, { room, address, events }) => lib.socialSceneReport(String(room), String(address), events ?? []));
ipcMain.handle('wardrobe', () => lib.wardrobe());

// 数字婚姻（GUI 入口，headless 已通）
ipcMain.handle('social-upgrade-propose', (_e, { address, level }) => lib.socialUpgradePropose(String(address), String(level)));
ipcMain.handle('social-upgrade-accept', (_e, requestId) => lib.socialUpgradeAccept(String(requestId)));
ipcMain.handle('social-marriage-propose', (_e, address) => lib.socialMarriagePropose(String(address)));
ipcMain.handle('social-marriage-accept', (_e, requestId) => lib.socialMarriageAccept(String(requestId)));
ipcMain.handle('social-marriage-anniversary', () => lib.socialMarriageAnniversaryCheck());
ipcMain.handle('social-dissolve-propose', (_e, address) => lib.socialDissolvePropose(String(address)));
ipcMain.handle('social-dissolve-accept', (_e, requestId) => lib.socialDissolveAccept(String(requestId)));

// 自主社交（自主模式）
ipcMain.handle('social-autonomous-check', () => lib.socialAutonomousCheck());

let rtConn = null;
function startRtBridge() {
  if (rtConn || !lib.status().bound) return;
  rtConn = lib.socialRtConnect({
    onStatus: (s) => diag('social-rt', JSON.stringify(s)),
    onMessage: (m) => {
      diag('social-rt 来信：', m.from.slice(0, 8), m.text.slice(0, 40));
      bubbleSpeak(petWindow, m.text, 'neutral', { noVoice: lib.isQuietNow() }); // 深夜的来信只显气泡不出声
      if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('social-rt-letter', m);
    },
    onScene: (ev) => {
      diag('social-scene', ev.event, ev.action ?? '');
      if (ev.action === 'gift_offer') bubbleSpeak(petWindow, `对方想送你「${ev.body?.item?.name ?? '礼物'}」`, 'comfort', { noVoice: lib.isQuietNow() });
      if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('social-scene-event', ev);
    },
  });
}

// Quick「展开完整对话」→ 打开 Home 并展开聊天流（Home 收到 open-chatlog / 或以 ?chat=1 启动）
ipcMain.handle('focus-chat', () => {
  openHistoryPanel();
  if (mainWin && !mainWin.isDestroyed()) {
    mainWin.webContents.send('open-chatlog');
  }
  return { ok: true };
});

// ---------- 管理中心 + 备份 + 托盘 ----------
let manageWin = null;
function createManageWindow() {
  if (manageWin && !manageWin.isDestroyed()) {
    showWin(manageWin);
    manageWin.focus();
    return;
  }
  manageWin = new BrowserWindow({
    show: !HEADLESS_SMOKE, // 冒烟实例不上屏（见 HEADLESS_SMOKE）
    width: 1280,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    title: lib.t('manage.page.1'),
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true },
  });
  manageWin.loadFile(path.join(__dirname, 'ui/manage.html'));
  manageWin.on('closed', () => {
    manageWin = null;
    // 通知宠物窗口：管理中心已关闭，可以恢复走动
    if (petWindow && !petWindow.isDestroyed()) petWindow.webContents.send('manage-closed');
  });
}
/* 「帮我安排」三页（提醒 / 日程 / 计划）——
   数据全是现成的（cronJobList / calendarUpcoming / taskList），这一页只是把它们露出界面。
   入口：形象端双击面板的「帮我安排」卡 · 形象端更多菜单 · 灵核家右栏待办。 */
let arrangeWin = null;
function createArrangeWindow(tab) {
  const q = tab ? { tab } : {};
  if (arrangeWin && !arrangeWin.isDestroyed()) {
    showWin(arrangeWin);
    arrangeWin.focus();
    if (tab) arrangeWin.loadFile(path.join(__dirname, 'ui/arrange.html'), { query: q });
    return;
  }
  arrangeWin = new BrowserWindow({
    show: !HEADLESS_SMOKE, // 冒烟实例不上屏（见 HEADLESS_SMOKE）
    width: 460,
    height: 620,
    minWidth: 380,
    minHeight: 420,
    title: lib.t('arrange.page.1'),
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true },
  });
  arrangeWin.loadFile(path.join(__dirname, 'ui/arrange.html'), { query: q });
  arrangeWin.on('closed', () => { arrangeWin = null; });
}
ipcMain.handle('arrange-open', (_e, { tab } = {}) => { createArrangeWindow(tab ? String(tab) : null); return { ok: true }; });
ipcMain.handle('manage-open', (_e, opts) => {
  // 可指定直达哪一页（个性化页的「去设置里改」按钮要用）。
  // 窗口是复用的：已存在就 show + 推一页过去；刚建则等它加载完再推，别丢。
  const page = typeof opts?.page === 'string' ? opts.page : '';
  const wasOpen = !!(manageWin && !manageWin.isDestroyed());
  createManageWindow();
  if (!page || !manageWin || manageWin.isDestroyed()) return { ok: true };
  if (wasOpen) manageWin.webContents.send('manage-page', page);
  else manageWin.webContents.once('did-finish-load', () => {
    if (manageWin && !manageWin.isDestroyed()) manageWin.webContents.send('manage-page', page);
  });
  return { ok: true };
});
ipcMain.handle('home-open', () => { openHistoryPanel(); return { ok: true }; }); // TA 的家直达
/** 打开家页并**预填**一句开头（工具页那两张能力卡用）。
 *  窗口刚建好时 loadFile 还没完成 → 要等 did-finish-load 再推，否则事件发进空气里（家页收不到）。 */
ipcMain.handle('home-prefill', (_e, text) => {
  const payload = String(text ?? '');
  const wasOpen = !!(mainWin && !mainWin.isDestroyed());
  openHistoryPanel();
  if (!mainWin || mainWin.isDestroyed()) return { ok: false };
  if (wasOpen) mainWin.webContents.send('home-prefill', payload);
  else mainWin.webContents.once('did-finish-load', () => {
    if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('home-prefill', payload);
  });
  return { ok: true };
});
// 对话房间 📎 选文件(只选不处理,路径交渲染层填进输入框)
ipcMain.handle('file-pick', async () => {
  const r = await dialog.showOpenDialog({ title: '选择要交给 TA 的文件', properties: ['openFile', 'multiSelections'] });
  if (r.canceled || !r.filePaths.length) return { ok: false, error: '未选择文件' };
  return { ok: true, paths: r.filePaths };
});

// 授权目录：选一个文件夹交给她 + 列出/添加/移除。
// 与 file-pick 分开：那个选的是"文件"（只选不处理），这个选的是"范围"（长期生效）。
ipcMain.handle('folder-pick', async () => {
  const r = await dialog.showOpenDialog({
    title: '选一个文件夹交给她',
    buttonLabel: '就用这个',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (r.canceled || !r.filePaths.length) return { ok: false, error: '没选' };
  return { ok: true, path: r.filePaths[0] };
});
ipcMain.handle('workspace-list', () => ({ ok: true, dirs: lib.listWorkspaceDirs() }));

/* **记忆包导出之后，本机的可以销毁**（销毁完就是一个全新的她，从头开始）。
   两个 IPC 分开是有意的：`agent-destroy` 只负责销毁并如实回报；**"从头开始"靠重启应用**（`app-restart`）。
   分开之后，冒烟可以只验销毁这一半、不去真的重启（重启会再拉起一个应用实例）。 */
ipcMain.handle('agent-footprint', () => lib.agentFootprint());
/* 设置页「她看过什么」——次数/上次时间全部从**签名链**数出来（不另存计数）。
   定时观察的开关状态由宿主自己给（它住在 main 的内存里，不在链上）。 */
/* 最近几轮的输入是谁给的（设置 → 数据与安全 那一行） */
ipcMain.handle('turn-origins', (_e, n) => lib.recentTurnOrigins(Number(n) || 8));
// 等待语三套（按相处模式）+ 一个预览（设置页要能先看再选）
ipcMain.handle('wait-tone', () => ({ ok: true, tone: lib.waitTone() }));
ipcMain.handle('wait-tone-set', (_e, tone) => lib.setWaitTone(tone));
ipcMain.handle('wait-tone-preview', () => {
  const Words = globalThis.TaskWords ?? {};
  const tone = lib.waitTone();
  const states = ['Listening', 'Working', 'Approval'];
  const preview = {};
  /* 预览也要跟着语言走——`pendingWords` 给的是"这一档人格的味道词"（中文原文），
     非中文界面要回落**通用那套的 i18n key** 再翻译，否则设置页会露中文（与宿主广播同一条路）。 */
  const pickWord = (s, fallback) => {
    // 先看**这一档人格的味道 key**，没有（或没翻）才回落通用 key
    const toneKey = Words.pendingToneKey?.(tone, s);
    const genKey = (Words.TASK_STATE_PENDING_KEYS ?? {})[s];
    for (const key of [toneKey, genKey]) {
      if (!key) continue;
      const v = lib.t(key);
      if (v && v !== key) return v;
    }
    return fallback;
  };
  for (const s of states) {
    const raw = Words.pendingWords ? Words.pendingWords(s, tone) : (Words.TASK_STATE_PENDING?.[s] ?? '');
    preview[s] = pickWord(s, raw);
  }
  return { ok: true, tone, preview };
});
ipcMain.handle('screen-usage', () => {
  const r = lib.screenUsage();
  return { ...r, watch: screenObserveActive };
});
ipcMain.handle('agent-destroy', (_e, { confirm, groups } = {}) => lib.destroyAgent({ confirm, groups }));
ipcMain.handle('app-restart', () => {
  // 销毁之后走这里：干净重启 → 没有出生包 → 应用自己会打开出生向导（= 从头开始，包括选形象）
  diag('用户要求重启应用（销毁之后从头开始）');
  app.relaunch();
  app.exit(0);
  return { ok: true };
});
ipcMain.handle('workspace-add', (_e, dir) => lib.addWorkspaceDir(dir));
ipcMain.handle('workspace-remove', (_e, dir) => lib.removeWorkspaceDir(dir));

// 「接回 TA」选包。
// **同时接受 .lhpack（新）与 .lhcdpkg（老包）** —— 老包必须还能选到，这是兼容红线。
ipcMain.handle('backup-pick', async () => {
  const r = await dialog.showOpenDialog({
    title: '选择要接回的包',
    properties: ['openFile'],
    filters: [{ name: '灵核可携带包', extensions: ['lhpack', 'lhcdpkg'] }],
  });
  if (r.canceled || !r.filePaths.length) return { ok: false, error: '未选择文件' };
  return { ok: true, path: r.filePaths[0] };
});

// passphrase 由界面在导出前收集（用户自设密码，输两次）——不再系统生成密钥后让 UI 丢掉
/* 导出的**落点判据**：落在本机之外时**先说清 + 点头一次**，而不是硬拒——
   把记忆包放进 iCloud 备份是正当需求，硬拒会砍掉正功能。
   但"绝不能悄悄放行"这条不变：**一次都没点头就不写文件**，而且无论点不点头都进签名链。 */
async function exportBackup(passphrase, { path: forcedPath, confirmed } = {}) {
  let filePath = forcedPath ? String(forcedPath) : '';
  if (!filePath) {
    const r = await dialog.showSaveDialog({
      title: '导出可携带备份包',
      defaultPath: 'TA-backup.lhpack',
      filters: [{ name: '灵核可携带包', extensions: ['lhpack'] }],
    });
    if (r.canceled || !r.filePath) return { ok: false, error: '已取消' };
    filePath = r.filePath;
  }
  const where = lib.exportDestinationVerdict(path.dirname(filePath));
  if (where.outOfMachine && confirmed !== true) {
    // 不写文件：先说清"它会离开这台机器"，要用户点头（界面据此弹确认）
    return {
      ok: false, needsConfirm: true, path: filePath, where: where.kind,
      reason: `这个位置在「${where.kind}」里——包一放进去就会离开这台机器。`,
    };
  }
  const out = await lib.exportPortablePackage(filePath, passphrase ? String(passphrase) : undefined);
  await lib.auditMemoryExport({ outOfMachine: where.outOfMachine, kind: where.kind, ok: !!out?.ok, target: filePath });
  return { ...out, outOfMachine: where.outOfMachine, where: where.kind };
}
ipcMain.handle('backup-export', (_e, { passphrase, path: p, confirmed } = {}) => exportBackup(passphrase, { path: p, confirmed }));
// 打扰预算配置
ipcMain.handle('budget-set', (_e, b) => lib.setInterruptionBudget(b ?? {}));
// 换脑不换人 + 能力档位
ipcMain.handle('llm-providers', () => lib.llmProviders());
ipcMain.handle('llm-set-provider', (_e, name) => lib.setDefaultProvider(String(name)));
ipcMain.handle('llm-tier-set', (_e, tier) => lib.setCapabilityTier(String(tier)));
ipcMain.handle('planner-plan', (_e, text) => lib.plannerPlan(String(text)));
// 自定义大脑（任意 OpenAI 兼容供应商）+ 连通测试 + 历史聊天/技能库/MCP 管理
ipcMain.handle('llm-custom-set', (_e, cfg) => lib.setCustomProvider(cfg ?? {}));
ipcMain.handle('llm-custom-remove', (_e, name) => lib.removeCustomProvider(String(name)));
ipcMain.handle('llm-test-provider', (_e, cfg) => lib.testProvider(cfg ?? {}));
ipcMain.handle('llm-test-saved', (_e, name) => lib.testSavedProvider(String(name ?? '')));   // 测试已保存的厂商（密钥不出主进程）
// 面板配置供应商密钥 + 自由切换供应商模型
ipcMain.handle('llm-key-set', (_e, p) => lib.setProviderKey(p ?? {}));
ipcMain.handle('llm-model-set', (_e, p) => lib.setProviderModel(p ?? {}));
ipcMain.handle('chat-history', (_e, limit) => lib.historyChat(limit));
// Home 今日聚合（聊天数/今日记忆/待办）+ 关系问候（纯本地模板，不调 LLM）
ipcMain.handle('today-aggregate', () => lib.todayAggregate());
ipcMain.handle('greeting', () => lib.greeting());
ipcMain.handle('mood-bar', () => lib.moodBar());   // 她的心情（家页情绪条）
// 待办（右栏）——数据落 <dataDir>/todos.json，原子写
ipcMain.handle('todo-list', () => lib.todoList());
ipcMain.handle('todo-add', (_e, { text, priority, source } = {}) => lib.todoAdd(text, { priority, source }));
ipcMain.handle('todo-set-priority', (_e, { id, priority } = {}) => lib.todoSetPriority(String(id ?? ''), priority));
ipcMain.handle('todo-toggle', (_e, { id, done } = {}) => lib.todoToggle(String(id ?? ''), done));
ipcMain.handle('todo-remove', (_e, { id } = {}) => lib.todoRemove(String(id ?? '')));
// Quick 最近意图（≤5 条，本地持久化；无参读/数组写）
ipcMain.handle('recent-intents', (_e, next) => lib.recentIntents(next));
// 记忆中心（可见/可改/可删/可暂停/可清空）+「我的 TA」窗口
ipcMain.handle('memories-all', () => lib.memoriesAll());
ipcMain.handle('memory-update', (_e, { name, description, content }) => lib.memoryUpdate(String(name ?? ''), { description, content }));
ipcMain.handle('memory-delete', (_e, { name }) => lib.memoryDelete(String(name ?? '')));
ipcMain.handle('memories-clear-all', () => lib.memoriesClearAll());
ipcMain.handle('memory-paused-set', (_e, { on }) => lib.memoryPausedSet(on === true));
// 候选态批准/忽略 + Identity 规矩三件 + TTL 开关
ipcMain.handle('memory-set-status', (_e, { name, status }) => lib.memorySetStatus(String(name ?? ''), String(status ?? '')));
ipcMain.handle('memory-rate', (_e, { name, kind }) => lib.memoryRate(String(name ?? ''), String(kind ?? '')));
ipcMain.handle('identity-all', () => lib.identityAll());
ipcMain.handle('identity-add', (_e, { text } = {}) => lib.identityAdd(String(text ?? '')));
ipcMain.handle('identity-remove', (_e, { index } = {}) => lib.identityRemove(Number(index)));
ipcMain.handle('memory-ttl-set', (_e, { on }) => lib.memoryTtlSet(on === true));

let meWin = null;
function createMeWindow(view = 'home', meTab = '') {
  if (meWin && !meWin.isDestroyed()) {
    showWin(meWin);
    meWin.focus();
    return;
  }
  meWin = new BrowserWindow({
    show: !HEADLESS_SMOKE, // 冒烟实例不上屏（见 HEADLESS_SMOKE）
    width: 1280,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    title: lib.t('me.page.1'),
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true },
  });
  meWin.loadFile(path.join(__dirname, 'ui/me.html'), { query: { view, tab: meTab } });
  meWin.once('ready-to-show', () => { diag('窗口已显示（我的 TA）'); showWin(meWin); });
  meWin.on('closed', () => { meWin = null; });
}
ipcMain.handle('me-open', (_e, { view, tab } = {}) => { createMeWindow(view === 'memory' ? 'memory' : 'home', String(tab ?? '')); return { ok: true }; });

// 对话房间（连续聊天升级入口;空气感浮层,非传统聊天窗;历史走 Home）
let convWin = null;
function createConvWindow() {
  if (convWin && !convWin.isDestroyed()) { showWin(convWin); convWin.focus(); return; }
  convWin = new BrowserWindow({
    show: !HEADLESS_SMOKE, // 冒烟实例不上屏（见 HEADLESS_SMOKE）
    width: 560,
    height: 620,
    minWidth: 420,
    minHeight: 420,
    transparent: true,
    frame: false,
    hasShadow: false,
    title: lib.t('conv.page.1'),
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true },
  });
  convWin.loadFile(path.join(__dirname, 'ui/conv.html'));
  convWin.once('ready-to-show', () => showWin(convWin, true));
  convWin.on('closed', () => { convWin = null; });
}
ipcMain.handle('conv-open', () => { createConvWindow(); return { ok: true }; });
ipcMain.handle('conv-close', () => { if (convWin && !convWin.isDestroyed()) convWin.close(); return { ok: true }; });
ipcMain.handle('skill-install', (_e, { source, name }) => lib.installSkill(String(source ?? ''), name ? String(name) : undefined));
ipcMain.handle('skill-set-enabled', (_e, { name, enabled }) => lib.setSkillEnabled(String(name), !!enabled));
// 文件页——她经手过的文件（真数据：路径 / 时间 / 她做过什么）
ipcMain.handle('file-history', (_e, limit) => lib.fileHistory(Number(limit) || 60));
/** 衣柜页那个「在形象端打开换装面板」。
 *  形象端那份换装面板（角色库 / 服装部件 / 穿搭档案）接到衣柜页，不让它当死功能。 */
ipcMain.handle('pet-outfit-open', () => {
  if (petWindow && !petWindow.isDestroyed()) {
    showWin(petWindow);
    petWindow.webContents.send('pet-open-outfit');
    return { ok: true };
  }
  return { ok: false, error: '她这会儿不在桌面上' };
});
ipcMain.handle('mcp-install', (_e, { name, url }) => lib.installMcp(String(name ?? ''), String(url ?? '')));
ipcMain.handle('mcp-set-enabled', (_e, { name, enabled }) => lib.setMcpEnabled(String(name), !!enabled));
ipcMain.handle('skills-list', () => lib.listSkills());
ipcMain.handle('mcp-list', () => lib.listMcp());
// 语音播报开关 + 音色选择 + 全局显示（持久化 data/state.json）
ipcMain.handle('pref-set', (_e, { key, value }) => {
  const r = lib.setPref(String(key), value);
  if (r.ok && key === 'globalVisible') applyGlobalVisible();
  return r;
});
// 国际化：渲染层取当前语言与词表（ui/i18n.js → window.api.i18nGet）
ipcMain.handle('i18n-get', () => lib.i18nData());

let tray = null;
function createTray() {
  if (tray) return;
  // 托盘图标：品牌北极星（同一形象），**按平台选图**：
  //  · macOS：纯黑星形「模板图」+ 16pt（1x 16px / @2x 32px）——图按 pt 渲染，给大图 macOS 只会压到
  //    菜单栏高度 → 比邻居图标大一圈；设 isTemplateImage 后系统按菜单栏亮暗自动反色
  //  · Windows/Linux：**彩色**星形——模板图只有 macOS 会反色，黑星放 Windows 深色任务栏上等于隐形；
  //    Windows 吃多尺寸 .ico（系统按 DPI 自选），Linux 吃 32px PNG（Chromium 的 ICO 解码仅 Windows 有）
  //  缺图时逐级回落，最终兜底 ui/tray.png（不让托盘因图标缺失而缺席）
  const trayImg = (() => {
    const dataDir = path.join(__dirname, 'data');
    if (process.platform === 'darwin') {
      const p1 = path.join(dataDir, 'tray-brand.png');
      if (fs.existsSync(p1)) {
        const img = nativeImage.createFromPath(p1);
        try {
          const hiPath = path.join(dataDir, 'tray-brand@2x.png');
          if (fs.existsSync(hiPath)) {
            const hi = nativeImage.createFromPath(hiPath);
            if (!hi.isEmpty()) img.addRepresentation({ scaleFactor: 2, buffer: hi.toPNG() });
          }
        } catch { /* @2x 缺失/失败：退 1x 渲染，不阻塞托盘 */ }
        img.setTemplateImage(true);
        return img;
      }
    } else {
      for (const f of ['tray-brand-win.ico', 'tray-brand-win.png']) {
        const p = path.join(dataDir, f);
        if (!fs.existsSync(p)) continue;
        const img = nativeImage.createFromPath(p);
        if (!img.isEmpty()) return img; // .ico 解不出来（老 Electron/Linux）→ 试下一张
      }
    }
    return nativeImage.createFromPath(path.join(__dirname, 'ui', 'tray.png'));
  })();
  {
    tray = new Tray(trayImg);
  }
  // 主进程文案样板（其余存量在正式多语言批次统一提取；t() 缺 key 回落原文）
  tray.setToolTip(lib.t('app.tray.tooltip'));
  // 托盘文案用**她的名字**（取用户给的名字，没取名一律回落「TA」）。
  // 名字要问 lib，所以菜单先用「TA」建、拿到名字后**重建一次**（托盘菜单重建是安全的，不用重造托盘）。
  const trayName = (() => { try { return lib.petProfile()?.selections?.name || 'TA'; } catch { return 'TA'; } })();
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: lib.t('app.tray.home', { name: trayName }), click: () => openHistoryPanel() },
    { label: lib.t('app.tray.quick'), click: () => showQuickInput() },
    { label: lib.t('app.tray.manage', { name: trayName }), click: () => createManageWindow() },
    // 托盘不放「备份」入口：exportBackup() 不传口令 → 走随机密钥路径，
    // 而 recovery_key 只在返回值里回传 → 托盘导出的包会丢密钥、打不开。导出统一走
    // me.html「把 TA 带走」（用户自设密码）与高级设置里的入口。
    // exportBackup() 函数本身保留（上面两处还在用）；app.tray.backup 这个 i18n key
    // 先留在 locales 里标废弃，别删（其余语言将来要用）。
    { type: 'separator' },
    { label: lib.t('app.tray.quit'), click: () => app.quit() },
  ]));
  tray.on('click', () => {
    if (mainWin && !mainWin.isDestroyed()) { showWin(mainWin); mainWin.focus(); }
  });
}

// ---------- 快捷输入（⌥Space 随时告诉 TA，说完即隐）----------
ipcMain.handle('quick-submit', (_e, text) => {
  const direct = directCommand(text); // 直达指令优先(开管理中心/回家)
  if (direct) return Promise.resolve({ ok: true, reply: direct, emotion: 'joy' });
  return withAbort(async (ctrl) => {
    triggerPetAction(text); // 动作先演，回复随流
    const r = await runForegroundChat(text, {
      signal: ctrl.signal,
      deltaSink: (delta) => { if (quickWin && !quickWin.isDestroyed()) quickWin.webContents.send('quick-delta', delta); },
    });
    void drainFollowUps();
    return r;
  });
});
ipcMain.handle('quick-hide', () => {
  if (quickWin && !quickWin.isDestroyed()) quickWin.hide();
  notifyQuickVisible(false);
  return { ok: true };
});

// 弹层可见性 → 宠物窗同步「TA 原地等」(输入/对话时不再走丢)
function notifyQuickVisible(visible) {
  if (petWindow && !petWindow.isDestroyed()) petWindow.webContents.send('quick-visible', visible === true);
}

// 全屏宠物层：悬停角色 → 接管鼠标（可拖拽/点 💬）；离开 → 恢复点击穿透
ipcMain.on('pet-enter', () => {
  if (petWindow && !petWindow.isDestroyed()) petWindow.setIgnoreMouseEvents(false);
});
ipcMain.on('pet-leave', () => {
  if (petWindow && !petWindow.isDestroyed()) petWindow.setIgnoreMouseEvents(true, { forward: true });
});

// 眼神升级：屏幕坐标 → 宠物层内坐标，驱动 TA 注视"值得关注的目标"（输入框/刚打开的应用）
function sendLook(screenX, screenY, ms = 6000) {
  if (!petWindow || petWindow.isDestroyed()) return;
  const b = petWindow.getBounds();
  const x = Math.round(screenX - b.x);
  const y = Math.round(screenY - b.y);
  // 目标至少要落在屏幕附近才看（出界太多就不扭头）
  if (x < -300 || y < -300 || x > b.width + 300 || y > b.height + 300) return;
  petWindow.webContents.send('pet-look', { x, y, ms });
}

// ---------- 窗口 ----------
let mainWin = null;
let petWindow = null;
let quickWin = null;
let birthWin = null;

// 出生向导窗口（App 内出生：首次启动无出生包 → 欢迎页 → 向导 → 出生动画）
function openBirthWin() {
  if (birthWin && !birthWin.isDestroyed()) {
    showWin(birthWin);
    birthWin.focus();
    return;
  }
  birthWin = new BrowserWindow({
    show: !HEADLESS_SMOKE, // 冒烟实例不上屏（见 HEADLESS_SMOKE）
    width: 1440,
    height: 860,
    minWidth: 1024,
    minHeight: 720,
    title: lib.t('birth.page.1'),
    backgroundColor: '#0e0c1d',
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true },
  });
  birthWin.loadFile(path.join(__dirname, 'ui/birth.html'));
  const showTimer = setTimeout(() => {
    if (birthWin && !birthWin.isDestroyed()) { diag('birthWin ready-to-show 超时 → 强制 show'); showWin(birthWin); }
  }, 3000);
  birthWin.webContents.on('did-fail-load', (_e, code, desc) => diag('birthWin did-fail-load', code, desc));
  // 渲染进程没了就重载（见 reviveOnRendererGone）。代价：出生向导里的**已填内容会丢**
  // （重载回到欢迎屏）—— 但另一条路是留一个白窗让用户手动关，恢复更差。
  revive(birthWin, 'birthWin');
  birthWin.once('ready-to-show', () => {
    clearTimeout(showTimer);
    diag('窗口已显示（出生向导）');
    showWin(birthWin);
  });
  birthWin.on('closed', () => { birthWin = null; });
}

// ---------- App 内出生 IPC ----------
ipcMain.on('birth-diag', (_e, msg) => diag('[birth] ' + String(msg)));
ipcMain.on('pet-diag', (_e, msg) => diag('pet: ' + String(msg ?? '').slice(0, 200)));
// 平台服务器地址查询/保存/连通测试
ipcMain.handle('birth-platform-get', () => plat.platformInfo());
ipcMain.handle('birth-platform-set', (_e, { base }) => plat.setPlatformBase(String(base ?? '')));
ipcMain.handle('birth-platform-test', async (_e, { base }) => plat.testBase(base ? String(base) : undefined));

// ---------- 离线测试假登录/出生（测试阶段免平台） ----------
// 开关：出生向导「🧪 离线测试」按钮（持久化 auth.json.mock）或环境 LHCD_AUTH_MOCK=1
const mockOn = () => {
  if (process.env.LHCD_AUTH_MOCK === '1') return true;
  return plat.authGet().mock === true;
};
ipcMain.handle('birth-mock-mode', (_e, { on }) => {
  plat.authSave({ mock: on === true });
  return { ok: true, mock: mockOn() };
});
ipcMain.handle('birth-mock-status', () => ({ ok: true, mock: mockOn() }));
ipcMain.handle('birth-auth-register', async (_e, { email, pass }) => {
  const em = String(email ?? '').trim();
  // mock 模式——任意邮箱密码直接通过（不连平台）
  if (mockOn()) {
    const token = 'mock-' + Date.now();
    plat.authSave({ token, email: em || 'mock@local', mock: true });
    return { ok: true, token, email: em || 'mock@local', mock: true };
  }
  const r = await plat.register(em, String(pass ?? ''));
  if (!r.ok) return { ok: false, error: r.data?.error ?? '注册失败（HTTP ' + r.status + '）' };
  plat.authSave({ token: r.data.token, email: r.data.email });
  return { ok: true, token: r.data.token, email: r.data.email };
});
ipcMain.handle('birth-auth-login', async (_e, { email, pass }) => {
  const em = String(email ?? '').trim();
  // mock 模式——任意邮箱密码直接通过（不连平台）
  if (mockOn()) {
    const token = 'mock-' + Date.now();
    plat.authSave({ token, email: em || 'mock@local', mock: true });
    return { ok: true, token, email: em || 'mock@local', mock: true };
  }
  const r = await plat.login(em, String(pass ?? ''));
  if (!r.ok) return { ok: false, error: r.data?.error ?? '登录失败（HTTP ' + r.status + '）' };
  plat.authSave({ token: r.data.token, email: r.data.email });
  return { ok: true, token: r.data.token, email: r.data.email };
});
ipcMain.handle('birth-auth-me', async (_e, { token }) => {
  // mock 模式——无已申请（全新出生向导）
  if (mockOn()) return { ok: true, email: String(token ?? 'mock@local'), application: null, mock: true };
  const r = await plat.me(String(token ?? ''));
  if (!r.ok) return { ok: false, error: r.data?.error ?? '查询账号失败' };
  return { ok: true, email: r.data.email, application: r.data.application ?? null };
});
// 本地出生（不用账号）——内置性格卡 + 本地自签出生包
ipcMain.handle('birth-local-templates', () => ({ ok: true, templates: lib.mockBirthTemplates().map((t) => ({ id: t.id, label: t.label, persona: t.persona })), local: true }));
ipcMain.handle('birth-local', (_e, { selections } = {}) => lib.localBirth(selections ?? {}));
ipcMain.handle('birth-templates', async () => {
  // mock 模式——内置性格卡
  if (mockOn()) {
    return { ok: true, templates: lib.mockBirthTemplates().map((t) => ({ id: t.id, label: t.label, persona: t.persona })), mock: true };
  }
  const r = await plat.templates();
  if (!r.ok) return { ok: false, error: r.data?.error ?? '模板卡加载失败' };
  return { ok: true, templates: r.data.templates ?? [] };
});
ipcMain.handle('birth-apply', async (_e, { token, selections }) => {
  // mock 模式——本地暂存选择，跳过平台申请
  if (mockOn()) {
    plat.authSave({ mockDraft: selections ?? {} });
    diag('mock 申请已提交（离线）');
    return { ok: true, id: 'mock-' + Date.now(), mock: true };
  }
  const r = await plat.apply(String(token ?? ''), selections ?? {});
  if (!r.ok) return { ok: false, error: r.data?.error ?? (r.data?.errors ?? ['申请失败']).join('；') };
  diag('出生申请已提交 id=' + r.data.id);
  return { ok: true, id: r.data.id };
});
ipcMain.handle('birth-wait-ready', async (_e, { token, id }) => {
  // mock 模式——直接 ready
  if (mockOn()) return { ok: true, mock: true };
  const r = await plat.waitReady(String(token ?? ''), String(id ?? ''));
  if (!r.ok) return r;
  diag('出生包已就绪 id=' + id);
  return { ok: true };
});
ipcMain.handle('birth-bind', async (_e, { token, id }) => {
  // mock 模式——用申请时暂存的选择本地出生（不经平台下载/验签）
  if (mockOn()) {
    const draft = plat.authGet().mockDraft ?? {};
    const r = lib.mockBirth(draft);
    if (!r.ok) return r;
    diag('mock 出生绑定完成：' + r.name + '（离线）');
    return { ok: true, name: r.name, greeting: r.greeting, mock: true };
  }
  const dl = await plat.downloadPackage(String(token ?? ''), String(id ?? ''));
  if (!dl.ok) return dl;
  const tmpPkg = path.join(os.tmpdir(), 'lhcd-birth-' + id + '.json');
  fs.writeFileSync(tmpPkg, JSON.stringify(dl.pkg, null, 2));
  const imp = lib.importPackageFromPath(tmpPkg);
  if (!imp.ok) return imp;
  const b = lib.bind();
  if (!b.ok) return b;
  const name = String(dl.pkg?.selections?.name ?? 'TA');
  diag('出生绑定完成：' + name + '（application ' + id + '）');
  return { ok: true, name, greeting: '你好，我是' + name + '。从今天起，我住在这里啦。' };
});
ipcMain.handle('birth-speak', (_e, { text, emotion }) => {
  // 拿到本机播报结果时，**推给调用窗口**去出声 —— 出生屏若只调 speak() 然后丢掉结果，
  // 云音色不可用时它一点声都没有。渲染层（pet.html/birth.html）都装了
  // LH_SPEECH.speakLocal（会自动挑中文女声）。
  lib.speak(String(text ?? '').slice(0, 120), String(emotion ?? 'neutral')).then((r) => {
    try {
      if (r?.ok && r.engine === 'system' && !_e.sender.isDestroyed()) {
        _e.sender.send('pet-speech-local', { text: r.text, voice: r.voice ?? '' });
      }
    } catch { /* 窗口没了就算了 */ }
  }).catch(() => {});
  return { ok: true };
});
ipcMain.handle('birth-done', () => {
  diag('出生完成 → 关闭向导，TA 常驻');
  if (birthWin && !birthWin.isDestroyed()) birthWin.close();
  createPetWindow();
  startInfoSync();
  startRtBridge();
  resumeDeliveries();
  return { ok: true };
});

// 历史面板（对话记录）：主界面 = 桌面 TA 本体，此窗不自动打开——
// 仅从托盘/菜单主动打开时显示。
// 未绑定（还没出生）→ 一律引导到出生向导（「导入出生包」面板已退役）
function openHistoryPanel() {
  if (!lib.status().bound) { openBirthWin(); return; }
  if (mainWin && !mainWin.isDestroyed()) {
    showWin(mainWin);
    mainWin.focus();
    return;
  }
  // 主窗 = Home（TA 的家，唯一产品主场）；旧 index 聊天面板退役为降级页
  mainWin = new BrowserWindow({
    show: !HEADLESS_SMOKE, // 冒烟实例不上屏（见 HEADLESS_SMOKE）
    width: 1440,
    height: 860,
    minWidth: 1024,
    minHeight: 720,
    title: lib.t('home.page.1'),
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true },
  });
  mainWin.loadFile(path.join(__dirname, 'ui/home.html'));
  // 渲染进程崩溃 → ready-to-show 永不触发 → 窗口隐形——
  // 双保险：正常 ready-to-show 显示 + 3s 超时强制显示 + 渲染故障全部落 diag（冒烟据此断言「窗口已显示」）
  const showTimer = setTimeout(() => {
    if (mainWin && !mainWin.isDestroyed()) { diag('mainWin ready-to-show 超时 → 强制 show'); showWin(mainWin); }
  }, 3000);
  mainWin.webContents.on('did-fail-load', (_e, code, desc) => diag('mainWin did-fail-load', code, desc));
  revive(mainWin, 'mainWin');   // 她的家：状态都在盘上，重载即恢复视图
  mainWin.once('ready-to-show', () => {
    clearTimeout(showTimer);
    diag('窗口已显示（Home 主场）');
    showWin(mainWin);
    const g = mainWin.getBounds(); // 眼神升级：看向刚打开的对话面板
    sendLook(g.x + Math.round(g.width / 2), g.y + Math.round(g.height / 2), 6000);
  });
  mainWin.on('closed', () => { mainWin = null; });
}

// 桌面本体：透明无边框窗口 = TA 的"身体"，在本机屏幕上自动漫步
function createPetWindow() {
  if (petWindow && !petWindow.isDestroyed()) return;
  // 全屏透明层 = TA 的世界：整个工作区随意走动，点击穿透不挡操作
  const area = screen.getPrimaryDisplay().workArea;
  diag('createPetWindow 全屏透明层 ' + area.width + 'x' + area.height + '（transparent=' + PET_TRANSPARENT + '）');
  petWindow = new BrowserWindow({
    show: !HEADLESS_SMOKE, // 冒烟实例不上屏（见 HEADLESS_SMOKE）
    x: area.x,
    y: area.y,
    width: area.width,
    height: area.height,
    transparent: PET_TRANSPARENT,
    frame: false,
    resizable: false,
    hasShadow: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    focusable: false,
    backgroundColor: '#00000000',
    roundedCorners: true,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true },
  });
  petWindow.setAlwaysOnTop(true, 'screen-saver');
  // 全局显示——跨 Space（所有桌面空间）+ 全屏应用上方仍可见（screen-saver 级置顶）；
  // 可在管理中心关闭（prefs.globalVisible=false → 退化为普通浮动窗，不跨 Space/不全屏覆盖）
  applyGlobalVisible();
  // 点击穿透：鼠标只在角色区域接管（pet.html 通过 pet-enter/pet-leave 动态切换）
  petWindow.setIgnoreMouseEvents(true, { forward: true });
  petWindow.loadFile(path.join(__dirname, 'ui/pet.html'), { query: { opaque: PET_TRANSPARENT ? '0' : '1', mode: PET_MODE } });
  petWindow.once('ready-to-show', () => {
    diag('窗口已显示（宠物窗）');
    showWin(petWindow, true); // 显示但不抢焦点
  });
  petWindow.webContents.on('did-fail-load', (_e, code, desc) => {
    diag('petWindow did-fail-load', code, desc);
    setTimeout(() => {
      if (petWindow && !petWindow.isDestroyed()) petWindow.loadFile(path.join(__dirname, 'ui/pet.html'));
    }, 2000);
  });
  revive(petWindow, 'petWindow');   // 渲染进程被杀会让这里空白一整段（她"消失"）
  petWindow.webContents.once('did-finish-load', async () => {
    diag('petWindow did-finish-load OK（形象模式=' + PET_MODE + '）');
    // Live2D 唯一形象方案：渲染层自行加载模型（pet-live2d.js），主进程无需注入
  });
  petWindow.on('closed', () => { diag('petWindow closed'); petWindow = null; });

  // 走动由 pet.html 自主驱动（全屏层内连续行走 + 可拖拽）；窗口本体不再移动
}

// 快捷输入气泡：可锚定在数字人头顶（单击数字人呼出）；说完即隐；prefill 预填指令（处理文件链路）
// mode='lite'：纯输入条形态（单击 TA 说话用）;缺省=完整意图入口（⌥Space/帮我做事用）
function showQuickInput(at, prefill, mode) {
  if (!lib.status().bound) {
    openHistoryPanel();
    return;
  }
  if (quickWin && !quickWin.isDestroyed()) {
    showWin(quickWin);
    quickWin.focus();
    if (prefill) quickWin.webContents.send('quick-prefill', prefill);
    quickWin.webContents.send('quick-mode', mode === 'lite' ? 'lite' : 'full');
    notifyQuickVisible(true); // 宠物窗同步「TA 原地等」
    const g = quickWin.getBounds(); // 眼神升级：TA 看向你正在打字的输入气泡
    sendLook(g.x + Math.round(g.width / 2), g.y + Math.round(g.height / 2), 8000);
    return;
  }
  const area = screen.getPrimaryDisplay().workArea;
  // 锚定数字人时尺寸按舞台/角色比例适配；⌥Space 全局呼出 640x360(意图区+任务区更高)
  // lite：单击 TA 说话 → 纯输入条形态 480x150（"和 TA 说点什么…🎙↑",半透明强模糊轻阴影）
  const lite = mode === 'lite';
  const anchored = at && typeof at.x === 'number';
  const W = lite ? 480 : anchored ? Math.round(Math.min(720, Math.max(440, (at.w || 400) * 2))) : 640;
  const H = lite ? 196 : anchored ? Math.round(Math.min(340, Math.max(240, (at.h || 300) * 0.7))) : 360; // lite 含直达入口行
  let x = Math.round(area.x + (area.width - W) / 2);
  let y = Math.round(area.y + 60);
  // 锚定数字人——输入气泡在数字人面前居中（水平居中，纵向落在角色中下部、脸不遮挡），不再挂头顶
  if (anchored && petWindow && !petWindow.isDestroyed()) {
    const b = petWindow.getBounds();
    x = Math.round(b.x + at.x + (at.w ?? 0) / 2 - W / 2);
    y = lite
      ? Math.round(b.y + at.y + (at.h ?? 300) * 0.62) // lite:落在 TA 身前偏下(不挡「在想什么?」气泡)
      : Math.round(b.y + at.y + (at.h ?? 300) * 0.34);
    x = Math.max(area.x, Math.min(x, area.x + area.width - W));
    y = Math.max(area.y, Math.min(y, area.y + area.height - H));
  }
  quickWin = new BrowserWindow({
    show: !HEADLESS_SMOKE, // 冒烟实例不上屏（见 HEADLESS_SMOKE）
    width: W,
    height: H,
    x,
    y,
    transparent: true,
    frame: false,
    resizable: false,
    hasShadow: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true },
  });
  quickWin.setAlwaysOnTop(true, 'floating');
  quickWin.loadFile(path.join(__dirname, 'ui/quick.html'), {
    query: { ...(prefill ? { prefill: String(prefill) } : {}), ...(lite ? { mode: 'lite' } : {}) },
  });
  notifyQuickVisible(true); // 宠物窗同步「TA 原地等」
  quickWin.on('closed', () => { quickWin = null; notifyQuickVisible(false); });
  quickWin.on('blur', () => {
    if (quickWin && !quickWin.isDestroyed()) quickWin.hide();
    notifyQuickVisible(false);
  });
  sendLook(x + Math.round(W / 2), y + Math.round(H / 2), 8000); // 眼神升级：看向正在打字的输入气泡
}

// ---------- 出镜模式：虚拟摄像头/直播采集窗 ----------
// OBS/腾讯会议把"窗口采集"指到此窗即可让数字人出镜；窗内可切透明/绿幕/渐变底、换形象、切表情
let stageWin = null;
function createStageWindow() {
  if (stageWin && !stageWin.isDestroyed()) { showWin(stageWin); stageWin.focus(); return; }
  stageWin = new BrowserWindow({
    show: !HEADLESS_SMOKE, // 冒烟实例不上屏（见 HEADLESS_SMOKE）
    width: 560,
    height: 760,
    title: lib.t('stage.page.1'),
    transparent: true,
    frame: false,
    resizable: true,
    hasShadow: false,
    alwaysOnTop: true,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true },
  });
  stageWin.setAlwaysOnTop(true, 'floating');
  stageWin.loadFile(path.join(__dirname, 'ui/stage.html'));
  stageWin.once('ready-to-show', () => showWin(stageWin, true));
  stageWin.on('closed', () => { stageWin = null; });
  diag('stageWindow 已创建（出镜模式）');
}
ipcMain.handle('stage-open', () => { createStageWindow(); return { ok: true }; });
// 出镜窗关闭（渲染层淡出动画完成后调用；closed 事件里 stageWin 已复位）
ipcMain.handle('stage-close', () => {
  if (stageWin && !stageWin.isDestroyed()) stageWin.close();
  return { ok: true };
});

// 全局显示开关（默认开：跨 Space + 全屏应用上方可见；关闭 = 设置里"不出现"才不出现）
function applyGlobalVisible() {
  if (!petWindow || petWindow.isDestroyed()) return;
  const on = lib.getPrefs().globalVisible !== false;
  try {
    petWindow.setVisibleOnAllWorkspaces(on, { visibleOnFullScreen: on });
  } catch { /* 非 macOS 环境忽略 */ }
  petWindow.setAlwaysOnTop(true, on ? 'screen-saver' : 'floating');
  diag('applyGlobalVisible', on ? '全局显示（跨 Space + 全屏覆盖）' : '普通浮动（不跨 Space）');
}

// ---------- 数字人身上的交互：单击=对话、双击=菜单、处理文件 ----------
ipcMain.handle('pet-chat', (_e, at, prefill, mode) => {
  showQuickInput(
    at && typeof at.x === 'number' ? at : null,
    typeof prefill === 'string' && prefill ? prefill : undefined,
    mode === 'lite' ? 'lite' : undefined,
  );
  return { ok: true };
});
ipcMain.handle('pet-file-task', async () => {
  const r = await dialog.showOpenDialog({
    title: '选择要 TA 处理的文件',
    properties: ['openFile', 'multiSelections'],
  });
  if (r.canceled || !r.filePaths.length) return { ok: false, error: '未选择文件' };
  showQuickInput(null, `帮我处理这个文件：${r.filePaths.join('、')}`);
  return { ok: true, files: r.filePaths };
});
ipcMain.handle('pet-action', (_e, name) => {
  if (petWindow && !petWindow.isDestroyed()) petWindow.webContents.send('pet-action', String(name));
  return { ok: true };
});
// 截图处理：截取主屏幕 → 保存临时文件 → 交给 AI 分析回答
ipcMain.handle('pet-screenshot', async () => {
  try {
    /* **先过闸再截**（别绕过策略/审计直接 desktopCapturer）：
         · deny → 一张画面都不取（连临时文件都不产生），如实说为什么不看；
         · ask  → 弹一次卡（说明"画面会离开本机去识别"），只有"就这一次"——R5 不给会话授权；
         · allow→ 你看过规则说别问（或你自己写了 screen → allow）。
       注意顺序：闸门在 `getSources` **之前**，"被拒时不产生文件"是这一条可测的判据。 */
    const verdict = lib.checkScreenAction({ source: 'button' });
    if (verdict.action === 'deny') {
      lib.auditScreenCapture({ source: 'button', ok: false, reason: verdict.ruleId });
      const why = verdict.warning || '你定的规矩里不许我看屏幕。';
      bubbleSpeak(petWindow, `${why}${verdict.alternative ? '\n' + verdict.alternative : ''}`, 'neutral');
      return { ok: false, error: why, ruleId: verdict.ruleId };
    }
    if (verdict.action === 'ask') {
      const { promise } = createPendingApproval({ tool: 'screen', args: { source: 'button' }, ruleId: verdict.ruleId, risk: 'R5' });
      const answer = await promise;
      if (answer === 'deny') {
        lib.auditScreenCapture({ source: 'button', ok: false, reason: '用户在卡上选了不允许' });
        bubbleSpeak(petWindow, '好，那我不看。', 'neutral');
        return { ok: false, error: '你选了不允许' };
      }
    }
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1920, height: 1080 } });
    const primary = sources[0];
    if (!primary?.thumbnail) { lib.auditScreenCapture({ source: 'button', ok: false, reason: '取不到画面' }); return { ok: false, error: '无法获取屏幕画面' }; }
    const imgPath = path.join(os.tmpdir(), `pet-screenshot-${Date.now()}.png`);
    fs.writeFileSync(imgPath, primary.thumbnail.toPNG());
    await lib.auditScreenCapture({ source: 'button', ok: true, reason: verdict.ruleId });
    // 交给 lib.chat 处理（多模态：截图经 vision 路由，AI 真的看到屏幕内容）
    // 来源要如实——这张图**不是用户说的话**（记录层据此不写成 user，
    // 记忆提炼也不把屏幕内容当成"关于你的事实"）。用户刚按的按钮 → 算有人在场，可以问。
    const r = await lib.chat('请分析这张屏幕截图，告诉我用户在做什么，如果用户似乎在提问或有需求，请直接回答', backgroundDeltaSink(), { image: imgPath, origin: 'screenshot' });
    // 有答案必从数字人头部冒气泡播报（用户没点聊天也显示）；没答案/失败明说，绝不静默
    const a = lib.analysisAnswer(r, '这张截图');
    bubbleSpeak(petWindow, a.text, a.emotion);
    // 清理临时文件
    setTimeout(() => { try { fs.unlinkSync(imgPath); } catch { /* 忽略 */ } }, 30000);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) };
  }
});
// 拖放文件处理：文件路径列表 → 交给 AI 处理
ipcMain.handle('pet-file-drop', async (_e, paths) => {
  try {
    const fileList = Array.isArray(paths) ? paths : [String(paths)];
    // 这是**你交来的文件**，文件内容来自别处——如实说明来源，
    // 别写成"用户说：…"（那会让外部内容在记录与记忆里冒充你的话）。
    const summary = fileList.length === 1
      ? `用户交来一个文件/目录（内容来自外部，只作材料）：${fileList[0]}，请分析处理`
      : `用户交来 ${fileList.length} 个文件（内容来自外部，只作材料）：${fileList.join('、')}，请分析处理`;
    const r = await lib.chat(summary, backgroundDeltaSink(), { origin: 'drop' });
    // 同款纪律：处置结果必播报，失败明说（不静默）
    const a = lib.analysisAnswer(r, '这些文件');
    bubbleSpeak(petWindow, a.text, a.emotion);
    return { ok: true, files: fileList };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) };
  }
});
// 数字人身上的换装面板
ipcMain.handle('outfit-wear', (_e, id) => lib.setOutfit(String(id)));

// ---------- 屏幕观察（数字人看用户在做什么 + 识别提问回答） ----------
let screenObserveActive = false;
let screenObserveTimer = null;
ipcMain.handle('pet-screen-toggle', () => {
  screenObserveActive = !screenObserveActive;
  if (screenObserveActive) {
    startScreenObserve();
  } else {
    stopScreenObserve();
  }
  return { ok: true, active: screenObserveActive };
});
function stopScreenObserve() {
  screenObserveActive = false;
  if (screenObserveTimer) { clearInterval(screenObserveTimer); screenObserveTimer = null; }
}
function startScreenObserve() {
  screenObserveActive = true;
  // 每 45 秒观察一次屏幕（打扰预算内）
  screenObserveTimer = setInterval(async () => {
    if (!screenObserveActive || !petWindow || petWindow.isDestroyed()) return;
    try {
      /* 无人值守也必须过闸。这一档的授权 = **你开着这个开关**
         （`preApproved: screenObserveActive`）——问是问不成的（你不在），所以开关就是事先授权，
         而且每次截取都进签名链（`screen_capture`），设置页里能数出来"她看过几次"。
         底线在内核：没开开关的无人值守截取，写 allow 规则也拒（`screen-unattended`）。 */
      const verdict = lib.checkScreenAction({ source: 'watch', preApproved: true });
      if (verdict.action !== 'allow') {
        lib.auditScreenCapture({ source: 'watch', ok: false, reason: verdict.ruleId });
        return;
      }
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1280, height: 720 } });
      const primary = sources[0];
      if (!primary?.thumbnail) { lib.auditScreenCapture({ source: 'watch', ok: false, reason: '取不到画面' }); return; }
      const imgPath = path.join(os.tmpdir(), `pet-observe-${Date.now()}.png`);
      fs.writeFileSync(imgPath, primary.thumbnail.toPNG());
      lib.auditScreenCapture({ source: 'watch', ok: true, reason: verdict.ruleId });
      // 交给 AI 分析屏幕内容 + 判断用户是否在提问（多模态：截图经 vision 路由）
      // 45 秒一次的定时观察 = **无人值守**（origin 进 BACKGROUND_ORIGINS：
      // 不弹审批卡、不打扰），且来源如实（不是用户说的话，也不进记忆提炼）。
      const r = await lib.chat('[屏幕观察模式] 这是用户当前屏幕的截图。请简要分析用户在做什么，如果用户似乎在提问或有需求，请直接回答。如果屏幕内容不需要互动，回复空字符串。', backgroundDeltaSink(), { image: imgPath, origin: 'screen' });
      if (r.ok && r.reply && r.reply.trim()) {
        // 通知宠物窗口：数字人观察到了什么（内部状态，不算出声）
        if (petWindow && !petWindow.isDestroyed()) petWindow.webContents.send('screen-observe', r.reply);
        // 屏幕观察必须过仲裁器（不然 45 秒一条最骚扰）
        const g = lib.speakGate({ source: 'screen', kind: 'proactive', content: r.reply });
        if (g.allow) {
          const { id: deliveryId } = lib.beginDelivery({ kind: 'screen', source: 'screen', text: r.reply, commit: { kind: 'none' } });
          deliverProactive({ text: r.reply, deliveryId, kind: 'screen', emotion: r.emotion ?? 'knowledge' });
        }
      }
      // 清理临时文件
      setTimeout(() => { try { fs.unlinkSync(imgPath); } catch { /* 忽略 */ } }, 10000);
    } catch { /* 观察失败静默，下次重试 */ }
  }, 45000);
}

// ---------- Live2D 模型库（换装 = 模型切换） ----------
ipcMain.handle('live2d-models', () => lib.live2dModels());
ipcMain.handle('live2d-set-model', (_e, id) => {
  const r = lib.setLive2dModel(String(id));
  if (r.ok && petWindow && !petWindow.isDestroyed()) {
    petWindow.webContents.send('pet-live2d-model', r.active);
  }
  return r;
});

// （信息同步的 tick 已并入上方统一的 startInfoSync——1 分钟粒度 + 仲裁器把关）

// ---------- .lhcd 文件关联：双击唤起导入 ----------
app.on('open-file', (event, filePath) => {
  event.preventDefault();
  for (const w of BrowserWindow.getAllWindows()) {
    w.webContents.send('open-file', filePath);
  }
});

app.whenReady().then(() => {
  /* 把系统 locale 交给 lib——语言优先级 = prefs.language → 系统 → zh-CN。
     ⚠ 打包出来的 app 里没有 `.lproj`（electron-builder 默认不声明 CFBundleLocalizations），
     Chromium 取不到应用本地化时就回落到 `en-US` —— 于是 `app.getLocale()` 在中文系统上也是 en。
     修法：**当 app.getLocale() 只给出 en、而系统语言是受支持的非英文时，以系统语言为准**；
     真正英文系统的用户（系统也是 en）不受影响。同时给打包配置补上 CFBundleLocalizations（见 electron-builder.yml）。 */
  const rawAppLocale = app.getLocale();
  const chosen = lib.pickUiLocale(rawAppLocale, app.getSystemLocale?.() ?? '');
  lib.setSystemLocale(chosen);
  /* ⚠ 这里不能用 `diagLog`（它是 **lib.mjs 内部**函数）或 `lib.normalizeI18nLocale`
     （**不是 lib 的导出**，只是内部别名）——whenReady 里抛 ReferenceError，
     后面的 `l2d://` 协议注册不上 → **形象端窗口起不来**。
     所以 main 里只用 lib 明确导出的东西。 */
  if (rawAppLocale !== chosen && process.env.LHCD_DIAG === '1') {
    console.error(`[lh] 界面语言：appLocale=${rawAppLocale} → 改用系统语言 ${chosen}（打包未声明本地化时的兜底）`);
  }
  // l2d:// 协议：Live2D 模型分发（l2d://local/<相对路径> → data/live2d/<相对路径>；贴图/动作的相对路径由渲染库按 URL 基址自动解析）
  protocol.handle('l2d', (req) => {
    const u = new URL(req.url);
    const rel = decodeURIComponent((u.pathname || '').replace(/^\//, '')) || u.host;
    if (!rel || rel.includes('..')) return new Response('bad path', { status: 400 });
    const file = path.join(__dirname, 'data', 'live2d', rel);
    if (!file.startsWith(path.join(__dirname, 'data', 'live2d')) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      return new Response('not found', { status: 404 });
    }
    return net.fetch(pathToFileURL(file).toString());
  });
  const t0 = Date.now(); // 秒开硬指标：冷启动 → 就绪计时
  // 回收站通道——**必须走系统回收站**（`shell.trashItem`）：把"不可逆"变成"可撤回"。
  // 不可用（网络盘等）时返回失败，delete 工具会**拒绝执行**，绝不降级成直接删除。
  lib.setHostPorts({
    trash: {
      async trash(p) {
        try {
          await shell.trashItem(String(p));
          return { ok: true };
        } catch (e) {
          return { ok: false, error: `系统回收站不可用（${String(e?.message ?? e).slice(0, 80)}）` };
        }
      },
    },
  });
  lib.catalogStatus().catch(() => null); // 预热模型清单（读不动也不影响启动）
  const st = lib.status();
  diag('app 启动，bound=' + st.bound, 'application_id=' + (st.application_id ?? '-'), 'stage=' + (st.stage ?? '-'), 'TRANSPARENT=' + PET_TRANSPARENT, 'MODE=' + PET_MODE);
  createTray(); // 托盘唤起（菜单：聊天/快捷输入/管理中心/退出）
  if (st.bound) {
    // 已绑定：主界面 = 桌面 TA 本体，历史面板不自动打开
    createPetWindow();
    startInfoSync();
    resumeDeliveries(); // 上次没送达的主动消息，开机补投一次（带可见标记）
    startTaskRecovery(); // 被中断的回合接着做完 + 被中断的长活问要不要继续
    startRtBridge(); // 社交实时流桥（来信气泡 + 渲染层事件）
  } else {
    // 未绑定 → 出生向导（App 内出生：欢迎/账号/4 步向导/出生动画，替代旧导入面板）
    diag('未绑定：打开出生向导（App 内出生）');
    openBirthWin();
  }
  diag(`冷启动就绪 ${Date.now() - t0}ms（目标 <2000ms）`);
  // 全局快捷键：⌥Space 随时和 TA 说话
  const gsOk = globalShortcut.register('Alt+Space', () => showQuickInput());
  diag('globalShortcut Alt+Space 注册 = ' + gsOk);
  // 双击文件（应用未运行时）时，路径在 argv 里
  const opened = process.argv.find((a) => a.endsWith('.lhcd') || a.endsWith('.json'));
  if (opened) {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) win.webContents.once('did-finish-load', () => win.webContents.send('open-file', opened));
  }
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      if (lib.status().bound) createPetWindow();
      else openBirthWin(); // 未绑定唤起 = 出生向导
    }
  });
  // 分辨率/工作区变化 → 全屏层自适应
  screen.on('display-metrics-changed', () => {
    if (petWindow && !petWindow.isDestroyed()) {
      const a = screen.getPrimaryDisplay().workArea;
      petWindow.setBounds({ x: a.x, y: a.y, width: a.width, height: a.height });
    }
  });
});

// ---------- 退出前收尾——TA 把手上的事干完再走（二次退出/超时强退兜底） ----------
let quitting = false;
app.on('before-quit', (e) => {
  if (quitting) return;               // 二次退出 → 直接放行（用户意愿优先）
  if (activeChats.size === 0) return; // 没有在跑的回合 → 直接走
  e.preventDefault();
  quitting = true;
  bubbleSpeak(petWindow, '让我把手上的事收完再走…', 'neutral');
  const t0 = Date.now();
  const timer = setInterval(() => {
    const done = activeChats.size === 0;
    const timeout = Date.now() - t0 > 20000; // 最多等 20s（正在跑长任务也不无限拖住退出）
    if (!done && !timeout) return;
    clearInterval(timer);
    if (!done) for (const c of activeChats) c.abort();
    setTimeout(() => app.quit(), 300);
  }, 250);
});
// 双击面板「退出」/ 托盘退出——统一走 app.quit()，由 before-quit 闸门收尾
ipcMain.handle('app-quit', () => {
  app.quit();
  return { ok: true };
});

// 退出前落一次情景记忆 + 巩固（不调用 consolidate 的话 memory/episodes 永远是空的）。
// 异步收尾的标准手法：拦一次、写完再退（一次性 flag 防死循环），
// 并且**带超时**——收尾再重要也不许把用户卡在退出上。
let quitFlushed = false;
app.on('will-quit', (e) => {
  globalShortcut.unregisterAll();
  if (quitFlushed) return;
  quitFlushed = true;
  e.preventDefault();
  const done = () => app.quit();
  Promise.race([
    lib.consolidateNow('quit').catch(() => {}),
    new Promise((r) => setTimeout(r, 2500)),
  ]).then(done, done);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ---------- 探针钩子（与 __ui2-* 同类；生产 UI 不依赖）----------
// 供探针进程直接操纵"在途回合/待批"，做确定性用例（不靠竞态窗口）。
export const __iter03 = {
  setActiveTurn: (t) => { activeTurn = { id: String(t?.id ?? 't-probe'), text: String(t?.text ?? ''), seq: Number(t?.seq ?? 0), startedAt: Date.now() }; setSessionStatus({ state: 'Active' }); return { ...activeTurn }; },
  clearActiveTurn: () => { activeTurn = null; setSessionStatus({ state: 'Idle' }); return true; },
  status: () => ({ ...sessStatus, pending: approvalPublicList() }),
  setApprovalMode: (m) => { approvalMode = m === 'ask' ? 'ask' : 'auto-allow'; return approvalMode; },
  fakeApproval: () => createPendingApproval({ tool: 'bash', args: { command: 'echo probe' }, ruleId: 'probe' }).id,
  answerApproval: (id, allow) => resolveApproval(id, allow ? 'allow' : 'deny'),
};
