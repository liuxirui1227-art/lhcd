// 渲染层 i18n（预埋）。
// 机制：页面在 [data-i18n="key"] 元素上声明 key → 启动后由主进程词表替换文本。
// 纪律：新写用户可见文案一律走 window.I18N.t('key') 或 data-i18n；原文进 locales/zh-CN.json。
// 失败/缺 key 一律保持 DOM 原文（中文）——预埋阶段零行为变化。
(function () {
  const state = { locale: 'zh-CN', dict: {}, t: (k) => k };

  /* 可翻译的**属性**：占位符/提示/无障碍标签跟正文一样是界面文案。
     写法：`data-i18n-placeholder="键"`（原文留在属性里当兜底，与 `data-i18n` 一个道理）。 */
  const ATTRS = ['placeholder', 'title', 'aria-label'];

  /* 把一段译文写进元素——**绝不碰子元素**。
     ⚠ 直接 `el.textContent = v` 会把图标/输入框/`<span>` 等子元素**一起删掉**
     （家页导航 SVG、设置页 `<input>`、出生页步骤数字都中招过，中文界面同样会踩）。
     规则：
       ① 没有子元素 → 直接 textContent（原行为，最稳）；
       ② 有子元素 → **只换最后一段非空文字节点**（图标/前缀在前，文案在后）；
       ③ 文字全在子元素里（如 `<button><svg/><span>记忆</span></button>`）→ 换那唯一一段；
       ④ 结构太复杂（多段文字）→ **不动**，控制台点名。宁可少翻一句，也不删界面。 */
  function setTextSafe(el, v) {
    if (!el.children.length) { el.textContent = v; return; }
    const direct = [...el.childNodes].filter((n) => n.nodeType === 3 && n.data.trim());
    if (direct.length) { direct[direct.length - 1].data = v; return; }
    const inner = [...el.querySelectorAll('*')]
      .flatMap((e) => [...e.childNodes])
      .filter((n) => n.nodeType === 3 && n.data.trim());
    if (inner.length === 1) { inner[0].data = v; return; }
    console.warn('[i18n] 这处没换（元素里有多段文字，硬换会把子元素删掉）：', el.getAttribute('data-i18n'));
  }

  function apply() {
    for (const el of document.querySelectorAll('[data-i18n]')) {
      const v = state.dict[el.getAttribute('data-i18n')];
      if (v !== undefined) setTextSafe(el, v);
    }
    for (const attr of ATTRS) {
      for (const el of document.querySelectorAll(`[data-i18n-${attr}]`)) {
        const v = state.dict[el.getAttribute(`data-i18n-${attr}`)];
        if (v !== undefined) el.setAttribute(attr, v);
      }
    }
    document.documentElement.lang = state.locale;
  }

  /* **JS 里的文案**也要能翻。
     `T(k)`：只翻（缺了就返回键）；`DT(k, 原文[, 参数])`：**带原文兜底**——
     调用点必须把中文原文留着，这样"词表里没有"时界面照旧显示中文（与 `data-i18n` 一个道理）。
     一处实现各页共用。 */
  window.T = (k, p) => window.I18N.t(k, p);
  window.DT = (k, fallback, p) => {
    const v = window.I18N?.t?.(k, p);
    if (v && v !== k) return v;
    return String(fallback).replace(/\{(\w+)\}/g, (m, n) => (p && n in p ? String(p[n]) : m));
  };

  window.I18N = {
    get locale() { return state.locale; },
    t: (key, params) => {
      const raw = state.dict[key];
      if (raw === undefined) return key;
      return params ? String(raw).replace(/\{(\w+)\}/g, (m, k) => (k in params ? String(params[k]) : m)) : String(raw);
    },
    ready: null,
  };

  window.I18N.ready = (async () => {
    try {
      const data = await window.api.i18nGet();
      state.locale = data.locale || state.locale;
      state.dict = data.dict || {};
      apply();
    } catch {
      /* 保持原文 */
    }
  })();
})();
