// 渲染进程被杀/崩了 → 自动重载窗口
//
// **Electron 不会自己把渲染进程拉回来** —— 窗还在、主进程还在（diag.log 一直有 social-rt 在写），
// 但窗口是**空白**的：看起来就是"她突然消失了"，而且一直不回来（直到手动重启 App）。
//
// 护栏：同一窗口 10 分钟内最多重载 3 次（页面自身有问题时别无限重载打转），超了停手并记一行。
// 正常收尾（clean-exit：关窗/退出 App）不重载。
//
// 抽成独立模块是为了**能测**：可用 webContents.forcefullyCrashRenderer() 主动崩渲染进程，
// 断言"崩了会自己回来"，以及"反复崩会停手"。
export function reviveOnRendererGone(win, tag, opts = {}) {
  const log = opts.log ?? ((msg) => console.log(`[${tag}] ${msg}`));
  const max = opts.max ?? 3;
  const windowMs = opts.windowMs ?? 10 * 60 * 1000;
  const stamps = [];
  win.webContents.on('render-process-gone', (_e, details) => {
    const reason = details?.reason ?? '?';
    log(`${tag} render-process-gone ${reason}`);
    if (reason === 'clean-exit') return;               // 正常收尾，不重载
    if (win.isDestroyed()) return;
    const now = Date.now();
    while (stamps.length && now - stamps[0] > windowMs) stamps.shift();
    if (stamps.length >= max) {
      log(`${tag} 渲染进程反复退出（${stamps.length} 次 / ${Math.round(windowMs / 60000)} 分钟内）→ 停止自动重载，请手动重启 App`);
      return;
    }
    stamps.push(now);
    setTimeout(() => {
      if (win.isDestroyed()) return;
      log(`${tag} 渲染进程已重启 → 自动重载页面（本窗口第 ${stamps.length} 次）`);
      try { win.webContents.reload(); } catch (e) { log(`${tag} 重载失败 ${String(e?.message ?? e)}`); }
    }, 400);
  });
}
