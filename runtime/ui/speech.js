// 本机播报——**先挑一个中文女声再出声**
//
// 旧实现是 `getVoices().find(v => v.name === voice)`，**找不到就干脆不设 voice** ——
// 于是 speechSynthesis 用它自己的默认嗓音；那台机器上默认正好是男声。
// 云音色没配钥匙时走的也是这条路（见 lib.speak 的 system 分支）。
//
// 现在：优先挑一个中文女声（按 macOS 常见名字，中英文名都认）→ 退而求其次第一个中文音色 →
// 再不行才用默认。**挑不到也不静默**：把实际用的音色名报给调用方，界面/日志能看见。
(function () {
  // macOS 常见中文女声（名字可能是英文也可能是本地化中文，两种都匹配）
  const PREFER = [/ting-?ting/i, /婷婷/, /mei-?jia/i, /美佳/, /sin-?ji/i, /善怡|珊珊/, /yao-?yao/i, /姚姚/, /female|女/];
  function listVoices() {
    try { return window.speechSynthesis?.getVoices?.() ?? []; } catch { return []; }
  }
  /** 当前界面语言的前缀（zh-CN / zh-Hant → zh；en / ja / ko → en / ja / ko） */
  function wantLangPrefix() {
    try {
      const l = String(window.I18N?.locale ?? 'zh-CN').toLowerCase();
      return l.split('-')[0];
    } catch { return 'zh'; }
  }
  /**
   * 挑本机音色（**按语言挑**，不再写死中文）。
   * 顺序：本语言里符合"女声偏爱名单"的 → 本语言第一个 → null（让浏览器自己定，调用方会看到 null）。
   * 为什么仍偏爱女声：出生包的人物设定默认女声。
   */
  function pickVoiceForLang(voices, prefix) {
    const all = voices ?? listVoices();
    const want = prefix ?? wantLangPrefix();
    const mine = all.filter((v) => String(v.lang || '').toLowerCase().startsWith(want));
    if (want === 'zh') {
      for (const re of PREFER) {
        const hit = mine.find((v) => re.test(v.name) || re.test(v.voiceURI || ''));
        if (hit) return hit;
      }
    } else {
      // 非中文：优先名字里带 female/女 的，其次第一个
      const fem = mine.find((v) => /female|女/i.test(v.name));
      if (fem) return fem;
    }
    return mine[0] ?? null;
  }
  /** 兼容旧名字（旧调用点还在用） */
  function pickZhFemaleVoice(voices) { return pickVoiceForLang(voices, 'zh'); }
  // ⚠ 音色表是**异步来的**：Chromium 首次 getVoices() 返回**空数组**，要等 voiceschanged。
  //   不等它 → 挑不到中文女声 → 又落回系统默认（男声），修了等于没修。
  let voicesReady = null;
  function ensureVoices(timeoutMs = 700) {
    const now = listVoices();
    if (now.length) return Promise.resolve(now);
    if (voicesReady) return voicesReady;
    voicesReady = new Promise((resolve) => {
      let done = false;
      const finish = () => { if (done) return; done = true; try { window.speechSynthesis.onvoiceschanged = null; } catch { /* 忽略 */ } resolve(listVoices()); };
      try {
        window.speechSynthesis.onvoiceschanged = finish;
        window.speechSynthesis.getVoices();      // 这一枪会触发加载
      } catch { finish(); }
      setTimeout(finish, timeoutMs);             // 顶多等这么久，超了就按现有（可能为空）走
    });
    return voicesReady;
  }
  function warmUpVoices() { try { ensureVoices(); } catch { /* 忽略 */ } }
  if (typeof window !== 'undefined') {
    try { warmUpVoices(); } catch { /* 忽略 */ }   // 预热一把；onvoiceschanged 由 ensureVoices 自己管（别两处都设，会互相覆盖）
  }
  /**
   * 本机出声。voice 是**建议音色名**（来自设置页/出生包）：找得到就用它；
   * 找不到（或为空）→ 挑中文女声。**返回 Promise**（音色表可能要等一下）；
   * 解析出实际用了哪个音色名（挑不到就空串），调用方可据此记日志/说真话。
   */
  async function speakLocal(text, voice, opts = {}) {
    if (!text || !('speechSynthesis' in window)) return { ok: false, voice: '' };
    try {
      const voices = await ensureVoices();
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(String(text).slice(0, 300));
      u.lang = wantLangPrefix() === 'zh' ? 'zh-CN' : wantLangPrefix();
      const want = voice ? voices.find((x) => x.name === voice || x.voiceURI === voice) : null;
      const v = want ?? pickVoiceForLang(voices);
      if (v) { u.voice = v; u.lang = v.lang || 'zh-CN'; }
      u.rate = opts.rate ?? 1.02;
      if (opts.onEnd) { u.onend = opts.onEnd; u.onerror = opts.onEnd; }
      window.speechSynthesis.speak(u);
      return { ok: true, voice: v ? (v.name || v.voiceURI || '') : '', fallback: !want && !!v, voices: voices.length };
    } catch { return { ok: false, voice: '' }; }
  }
  window.LH_SPEECH = { speakLocal, pickZhFemaleVoice, pickVoiceForLang, wantLangPrefix, listVoices, ensureVoices };
})();
