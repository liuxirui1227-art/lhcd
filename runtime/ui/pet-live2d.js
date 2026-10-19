// 灵核 · Live2D 形象渲染器（唯一形象方案：VTuber 工业标准）
// 依赖（运行时动态加载，见 pet.html）：pixi.min.js + live2dcubismcore.min.js + pixi-live2d-display.min.js
// 能力：眼神跟随（鼠标/事件目标 lookAt）、自动眨眼/呼吸/头发物理（physics3.json）、待机动作自动轮播、
//       动作库播放（motion，含定制模型 Walk 组优先）、表情热切换（expressions，情绪直达）、
//       TTS 嘴型同步（Web Audio 分析，频谱质心近似 viseme：张/闭/圆唇）、情绪参数、步态（颠簸+摆动）、
//       HitArea 命中（摸头/戳身体分区反应）、服装部件显隐（同模型真换装，parts opacity）。
// 接口：setState/setEmotion/setFacing/playAction/celebrate/loadModel/attachAudio/resize/hasModel
//      /setExpression/expressions/hitTestAt/lookAt/costumeParts/setPartOverride/clearPartOverrides
(function () {
  'use strict';

  // 标准参数 id（Cubism 官方标准参数；模型不含该参数时 setParameterValueById 自动忽略）
  const PARAM = {
    MOUTH_OPEN: 'ParamMouthOpenY',
    MOUTH_FORM: 'ParamMouthForm',
    BODY_ANGLE_X: 'ParamBodyAngleX',
    BODY_ANGLE_Y: 'ParamBodyAngleY',
    EYE_SMILE: 'ParamEyeSmile',
    BROW_FORM: 'ParamBrowForm',
    ANGLE_Z: 'ParamAngleZ',
  };

  function create(canvas) {
    const PIXI_ = window.PIXI;
    const app = new PIXI_.Application({
      view: canvas,
      backgroundAlpha: 0,
      antialias: true,
      autoDensity: false,
      width: canvas.width,
      height: canvas.height,
    });

    const st = {
      model: null,          // Live2DModel
      baseScale: 1,         // 适配舞台后的基础缩放
      facing: 1,
      talking: false,
      mouth: 0,             // 嘴型开合 0..1（TTS 驱动或说话假动画）
      mouthForm: 0,         // 嘴型形状 -1..1（viseme 近似：张口/咧嘴/圆唇）
      emotion: 'neutral',
      focus: { x: null, y: null },  // 鼠标注视点（舞台 ±1.5）
      look: { x: null, y: null, until: 0 }, // 事件注视点（看向输入框/应用，超时回落鼠标跟随）
      audioAnalyser: null,  // TTS 嘴型分析器
      audioData: null,
      loadSeq: 0,           // 热切换竞态防护
      partOverrides: {},    // 服装部件显隐 { partId: 0|1 }（同模型真换装；每帧重放防动作覆盖）
      paramIds: new Set(),  // 模型可用参数 id 缓存（判定 ParamArmLA/ParamBreath 等是否存在）
      expressionActive: null, // 当前手动设置的表情名（非 null 时 beforeModelUpdate 跳过情绪参数覆写）
    };

    // ---- 全屏眼神跟随：窗口任意位置的鼠标都映射到模型注视点 ----
    window.addEventListener('pointermove', (e) => {
      const r = canvas.getBoundingClientRect();
      // 舞台中心为原点，注视范围 ±1.5 个舞台（出界夹紧 → 视线最多转到侧面）
      st.focus.x = ((e.clientX - (r.left + r.width / 2)) / r.width) * 1.5;
      st.focus.y = -((e.clientY - (r.top + r.height * 0.35)) / r.height) * 1.5;
    }, { passive: true });

    // ---- 情绪 → 参数目标（柔和叠加；模型缺参数自动忽略） ----
    const EMOTION_PARAMS = {
      joy: { [PARAM.EYE_SMILE]: 1, [PARAM.MOUTH_FORM]: 1, [PARAM.ANGLE_Z]: 0.08 },
      comfort: { [PARAM.EYE_SMILE]: 0.6, [PARAM.MOUTH_FORM]: 0.5 },
      knowledge: { [PARAM.BROW_FORM]: 0.4 },
      sad: { [PARAM.BROW_FORM]: -1, [PARAM.BODY_ANGLE_Y]: 0.4 },
      angry: { [PARAM.BROW_FORM]: -0.8, [PARAM.ANGLE_Z]: -0.1 },
      neutral: {},
    };

    // 情绪 → 表情文件映射（官方样例 exp_01~08 语义未知，按序固定映射保证稳定；
    // 定制模型用语义命名（如 f_joy / exp_joy）可被下方"语义优先"直接命中）
    const EMOTION_EXPRESSION = {
      joy: 'exp_04', comfort: 'exp_02', knowledge: 'exp_03',
      sad: 'exp_06', angry: 'exp_05', neutral: 'exp_01',
    };

    function core() { return st.model?.internalModel?.coreModel ?? null; }

    /** 模型的口型参数 id（官方标准 ParamMouthOpenY；Mao 等用自定义 LipSync 组，如 ParamA） */
    function lipSyncIds() {
      const ids = st.model?.internalModel?.lipSyncIds;
      return Array.isArray(ids) && ids.length ? ids : [PARAM.MOUTH_OPEN];
    }

    /** 每帧参数覆盖（在动作/物理计算之后、模型渲染之前） */
    function beforeModelUpdate() {
      const c = core();
      if (!c) return;
      // 嘴型：TTS 分析器优先（开合=音量 RMS，形状=频谱质心 → viseme 近似）；无音频时说话假动画
      let mouth = st.mouth;
      if (st.audioAnalyser && st.talking) {
        st.audioAnalyser.getByteFrequencyData(st.audioData);
        let sum = 0, weighted = 0;
        const n = Math.min(st.audioData.length, 48); // 语音能量集中在 <9kHz 频段
        for (let i = 0; i < n; i++) {
          const e = st.audioData[i] / 255;
          sum += e * e;
          weighted += e * i;
        }
        const rms = Math.sqrt(sum / n);
        mouth = Math.min(1, rms * 3.2);
        // viseme 近似（音素级口型的分析驱动版）：低频能量集中 → 张大口(a)；中频 → 咧嘴(e/i)；高频 → 圆唇(o/u)
        if (rms > 0.02) {
          const binHz = (st.audioCtx?.sampleRate ?? 44100) / 2 / st.audioData.length;
          const centroidHz = (weighted / (Math.sqrt(sum) || 1)) * binHz;
          const target = centroidHz < 900 ? -0.3 : centroidHz < 2000 ? 0.3 : 0.9;
          st.mouthForm += (target - st.mouthForm) * 0.3; // 平滑过渡，口型不跳变
        }
      } else if (st.talking) {
        mouth = 0.18 + Math.abs(Math.sin(performance.now() / 110)) * 0.5;
        st.mouthForm += (0.25 - st.mouthForm) * 0.2;
      }
      for (const id of lipSyncIds()) c.setParameterValueById(id, mouth);
      // 嘴型形状只在非表情锁定时覆写（表情可能自定义嘴型，如"惊讶"张嘴、"开心"上扬）
      if (!st.expressionActive) {
        c.setParameterValueById(PARAM.MOUTH_FORM, st.mouthForm);
      }
      // 情绪叠加（说话微笑更有亲和力）——表情锁定时跳过，避免覆写表情参数
      if (!st.expressionActive) {
        const em = { ...(EMOTION_PARAMS[st.emotion] ?? {}) };
        if (st.talking && st.emotion === 'neutral') em[PARAM.MOUTH_FORM] = 0.4;
        for (const [id, v] of Object.entries(em)) {
          const cur = c.getParameterValueById(id) ?? 0;
          c.setParameterValueById(id, cur * 0.7 + v * 0.3);
        }
      }
      // 她会自己动（眨眼/呼吸/点头/挥手）——参数驱动，见 idleTick 的注释
      idleTick(performance.now());
      // 服装部件显隐（同模型真换装）：每帧重放，防动作/物理覆盖
      for (const [id, v] of Object.entries(st.partOverrides)) {
        try { c.setPartOpacityById?.(id, v); } catch { /* 部件不存在则忽略 */ }
      }
    }

    // ---- 主循环：眼神跟随（事件目标优先）+ 模型朝向 + 步态起伏 ----
    app.ticker.add(() => {
      const m = st.model;
      if (!m) return;
      if (!st.paramIds.size) collectParamIds();   // 首帧之后才拿得到参数表（见 collectParamIds 注释）
      // 注视点：lookAt 事件目标（看向输入框/刚打开的应用，"活在电脑里"）优先，超时回落鼠标跟随
      const now = performance.now();
      if (st.look.x !== null && now < st.look.until) m.focus(st.look.x, st.look.y);
      else if (st.focus.x !== null) m.focus(st.focus.x, st.focus.y);
      m.scale.x = Math.abs(m.scale.x) * st.facing; // 朝向镜像
      m.position.y = canvas.height;
    });

    /** 按舞台尺寸适配模型（全身入画、底边对齐） */
    /** 收集模型可用参数 id（判定 ParamArmLA / ParamBreath / ParamAngleY 等是否存在）。
       ⚠ **必须等模型 update 过再收集**：在 fitModel 里（刚加载完、还没渲染过）调
       `coreModel.getParameterIds()` 拿到的是**空数组** —— 于是 st.paramIds 永远是空集，
       所有 `paramIds.has(...)` 判断全部落空（手臂摆动/呼吸/头部参数一直没生效过）。
       实测：`modelInfo().paramIds` 是 `[]`。 */
    function collectParamIds() {
      try {
        const c = core();
        if (!c) return false;
        let ids = [];
        if (typeof c.getParameterIds === 'function') ids = c.getParameterIds() ?? [];
        // ⚠ 实测：随包的 cubism 构建是**压缩过的**（coreModel 的类名是 `D`），**没有公开的
        //   `getParameterIds()`**（只有 `getParameterCount()` = 42）。参数表在私有字段里 ——
        //   这就是"参数是否存在"那套判断从来没生效过的真正原因（实测量到）。
        if (!ids.length && Array.isArray(c._parameterIds)) ids = c._parameterIds;
        if (!ids.length && Array.isArray(c._model?.parameters?.ids)) ids = c._model.parameters.ids;
        if (ids.length) { st.paramIds = new Set(ids); return true; }
      } catch { /* 忽略 */ }
      return false;
    }
    /**
     * 把模型缩放成"一个人那么高"（锚在画布底部中央）。
     *
     * ⚠ **必须幂等**：`m.height` 是**含当前缩放**的框，不是原始尺寸；而算出来的 `scale` 是
     * **绝对缩放**。直接用 `m.height` 会让每次 resize（窗口大小三档 / 切 Space 都走 `resize()`）
     * 按已缩放的 height 再乘一次，模型指数级放大（"她变得无比巨大，屏幕上只剩一只脚"）。
     * 修法两条：
     *   ① 先除 `m.scale.y` 拿**原始身高**再算（幂等：同样的画布算出同样的 scale）；
     *   ② 身高还没定下来时**不猜**（否则退化成 1 → scale = canvas.height，等于放大上千倍）：下一帧再来。
     */
    function fitModel(m) {
      const sy = Math.abs(m.scale?.y ?? 1) || 1;
      const rawH = (m.height > 0 ? m.height : 0) / sy;
      if (!(rawH > 0)) { requestAnimationFrame(() => { try { fitModel(m); } catch { /* 模型没了就算了 */ } }); return; }
      const scale = (canvas.height / rawH) * 1.06;
      st.baseScale = scale;
      m.scale.set(scale);
      m.anchor.set(0.5, 1);
      m.position.set(canvas.width / 2, canvas.height);
      collectParamIds();     // 这一枪通常是空的（模型还没 update）→ 真正的收集在首帧
    }

    /** 加载/热切换模型；已加载过则先移除旧模型 */
    async function loadModel(url, cb) {
      const seq = ++st.loadSeq;
      try {
        if (typeof window.PIXI?.live2d?.Live2DModel === 'undefined') throw new Error('pixi-live2d-display 未加载');
        const m = await window.PIXI.live2d.Live2DModel.from(url, { autoInteract: false });
        if (seq !== st.loadSeq) { try { m.destroy(); } catch { /* 竞态丢弃 */ } return; }
        if (st.model) { app.stage.removeChild(st.model); st.model.destroy(); }
        st.model = m;
        st.partOverrides = {}; // 换模型清空部件覆盖（部件 id 属于旧模型）
        fitModel(m);
        app.stage.addChild(m);
        m.internalModel?.on?.('beforeModelUpdate', beforeModelUpdate);
        // 待机动作自动轮播（pixi-live2d-display 内建：Idle 组 + 眨眼 + 物理）
        cb?.(true);
      } catch (e) {
        try { window.__l2dErr = String(e?.message ?? e); } catch { /* 忽略 */ }
        if (seq === st.loadSeq) cb?.(false);
      }
    }

    /* ---- **她自己会动**（程序化，不依赖模型的动作库）----
       为什么改成程序化：官方样例模型只有 `Idle` / `TapBody` 两组动作
       （实测 `modelInfo().motions === ['Idle','TapBody']`），**没有"挥手/点头"这种语义动作**——
       点「挥手」播出来的是一段通用 tap 动作，看着跟没生效一样。
       这四个改成直接驱动参数：任何有对应参数的模型都能动，缺参数的安静跳过（不假装）。
       参数 id 由 `collectParamIds()` 在**首帧之后**收集（见那边的注释：早收是空的）。 */
    const idle = { nextBlink: 0, blinkT: 0, nodT: 0, waveT: 0 };
    /** 她自己挑一个动作（pet.html 的调度器按心情调它） */
    function autoAction(name) {
      const now = performance.now();
      if (name === 'nod') idle.nodT = now;
      else if (name === 'wave') { if (canWave()) idle.waveT = now; }
      else if (name === 'blink') idle.blinkT = now;
    }
    /** 这个模型能不能真挥手（有手臂参数）——挑动作时据此跳过，别让她"挥手"却什么都没发生 */
    function canWave() { return st.paramIds.has('ParamArmLA') || st.paramIds.has('ParamArmRA'); }
    function idleTick(now) {
      st.idleTicks = (st.idleTicks ?? 0) + 1;
      const c = core();
      if (!c || st.expressionActive) { st.idleSkip = st.expressionActive ? 'expr' : 'nocore'; return; }
      const has = (id) => st.paramIds.has(id);
      const get = (id) => c.getParameterValueById(id) ?? 0;
      // 呼吸：5.6s 一个来回（与情绪条的 breathe 同族节奏）
      if (has('ParamBreath')) c.setParameterValueById('ParamBreath', 0.5 + 0.5 * Math.sin((now / 5600) * Math.PI * 2));
      // 眨眼：3~6 秒一次、一次 ~140ms（眼参数是标准件，官方 5 个样例都有）
      if (has('ParamEyeLOpen') && has('ParamEyeROpen')) {
        if (!idle.nextBlink) idle.nextBlink = now + 2500 + Math.random() * 2500;
        if (!idle.blinkT && now >= idle.nextBlink) { idle.blinkT = now; idle.nextBlink = now + 3000 + Math.random() * 3000; }
        if (idle.blinkT) {
          const p = (now - idle.blinkT) / 140;
          const close = p < 0.5 ? p * 2 : Math.max(0, 2 - p * 2);
          const v = 1 - close * 0.95;
          c.setParameterValueById('ParamEyeLOpen', v);
          c.setParameterValueById('ParamEyeROpen', v);
          if (p >= 1) idle.blinkT = 0;
        }
      }
      // 点头：700ms，低下去再回来
      if (idle.nodT) {
        const p = (now - idle.nodT) / 700;
        if (p >= 1) idle.nodT = 0;
        else if (has('ParamAngleY')) c.setParameterValueById('ParamAngleY', get('ParamAngleY') - Math.sin(p * Math.PI) * 10);
      }
      // 挥手：有手臂参数才挥（抬手 → 摆几下 → 放下）；没有就立刻停下
      if (idle.waveT) {
        const p = (now - idle.waveT) / 1400;
        if (p >= 1) idle.waveT = 0;
        else if (canWave()) {
          const sw = Math.sin(p * Math.PI * 6) * 0.6 * Math.sin(p * Math.PI);
          if (has('ParamArmRA')) c.setParameterValueById('ParamArmRA', get('ParamArmRA') + sw);
          if (has('ParamArmLA')) c.setParameterValueById('ParamArmLA', get('ParamArmLA') - sw * 0.2);
        } else idle.waveT = 0;
      }
    }

    // ---- 动作库映射：菜单动作 → 模型 motion（组内轮换；模型无对应语义时播放通用活人动作） ----
    const ACTION_GROUP = 'TapBody';
    let actionCursor = 0;
    function motionGroups() {
      return Object.keys(st.model?.internalModel?.motionManager?.definitions ?? {});
    }
    function playGroup(group) {
      const m = st.model;
      const defs = m?.internalModel?.motionManager?.definitions?.[group] ?? [];
      if (!defs.length) return false;
      m.motion(group, actionCursor++ % defs.length, 3 /* FORCE */).catch(() => { /* 播放失败静默 */ });
      return true;
    }
    function playAction(name) {
      const groups = motionGroups();
      if (!groups.length) return;
      const group = groups.includes(ACTION_GROUP) ? ACTION_GROUP : (groups.find((g) => /^idle$/i.test(g)) ?? groups[0]);
      if (!group) return;
      const defs = st.model.internalModel.motionManager.definitions[group] ?? [];
      if (!defs.length) return;
      // 语义近似映射（有索引就精准，没有就轮换）
      const MAP = { wave: 0, nod: 1, think: 2, celebrate: 3, jump: 4, eat: 5, dress: 6 };
      const idx = name in MAP && MAP[name] < defs.length ? MAP[name] : (actionCursor++ % defs.length);
      st.model.motion(group, idx, 3 /* FORCE */).catch(() => { /* 播放失败静默 */ });
    }

    // ---- 表情热切换（Mao 8 组 / 定制模型语义命名） ----
    function expressions() {
      const list = st.model?.internalModel?.settings?.expressions ?? [];
      return (Array.isArray(list) ? list : []).map((e) => e.Name).filter(Boolean);
    }
    function setExpression(name) {
      const m = st.model;
      if (!m) return false;
      const list = expressions();
      const idx = list.indexOf(name);
      if (idx < 0) return false;
      try {
        // 方式 1：pixi-live2d-display 标准 API（model.expression 接受名称或索引）
        if (typeof m.expression === 'function') {
          m.expression(name);
          st.expressionActive = name;
          return true;
        }
        // 方式 2：直接调用 ExpressionManager（部分版本 API 路径不同）
        const em = m.internalModel?.motionManager?.expressionManager;
        if (em && typeof em.setExpression === 'function') {
          em.setExpression(idx);
          st.expressionActive = name;
          return true;
        }
        return false;
      } catch { return false; }
    }
    function clearExpression() {
      st.expressionActive = null;
      // 恢复情绪驱动表情（如果有）
      if (st.emotion !== 'neutral') applyEmotionExpression(st.emotion);
    }
    /** 情绪直达表情：语义命名优先（定制模型），否则按固定序映射（官方样例） */
    function applyEmotionExpression(emotion) {
      const list = expressions();
      if (!list.length) return;
      const semantic = list.find((n) => new RegExp(`(^|_)${emotion}($|_)`, 'i').test(n));
      const target = semantic ?? (EMOTION_EXPRESSION[emotion] && list.includes(EMOTION_EXPRESSION[emotion]) ? EMOTION_EXPRESSION[emotion] : null);
      if (target) {
        setExpression(target); // setExpression 内部已设 expressionActive
      } else {
        st.expressionActive = null; // 无匹配表情 → 解除锁定，恢复参数自由
      }
    }

    // ---- HitArea 命中（摸头/戳身体分区反应）----
    function hitTestAt(clientX, clientY) {
      const m = st.model;
      if (!m || typeof m.hitTest !== 'function') return [];
      try {
        const r = canvas.getBoundingClientRect();
        const x = (clientX - r.left) * (canvas.width / Math.max(1, r.width));
        const y = (clientY - r.top) * (canvas.height / Math.max(1, r.height));
        return m.hitTest(x, y) ?? [];
      } catch { return []; }
    }

    // ---- 服装部件（同模型真换装：parts opacity 显隐，人不换） ----
    const COSTUME_RE = /衣|服|裙|外套|上衣|裤|帽|围巾|眼镜|coat|jacket|skirt|dress|outfit|shirt|clothes|cloth|hat|cap|ribbon|scarf|glasses|accessor|acc_|costume/i;
    function costumeParts() {
      const c = core();
      if (!c || typeof c.getPartIds !== 'function') return [];
      let ids = [];
      try { ids = c.getPartIds() ?? []; } catch { return []; }
      return ids
        .filter((id) => COSTUME_RE.test(id))
        .map((id) => {
          let opacity = 1;
          try { opacity = st.partOverrides[id] ?? c.getPartOpacityById?.(id) ?? 1; } catch { /* 默认显示 */ }
          return { id, opacity };
        });
    }
    function setPartOverride(id, v) {
      const c = core();
      if (!c) return false;
      if (v >= 1) delete st.partOverrides[id]; // 恢复默认交给模型自己（动作可再控制）
      else st.partOverrides[id] = v;
      try { c.setPartOpacityById?.(id, v); } catch { return false; }
      return true;
    }
    function clearPartOverrides() { st.partOverrides = {}; }

    // ---- 注视点（看向输入框/刚打开的应用：事件驱动，"活在电脑里"） ----
    // 入参为窗口客户区像素坐标（与 pet.html 交互层同系）；内部归一化成 ±1.5 舞台单位（与鼠标跟随同标尺）
    function lookAt(clientX, clientY, ms = 5000) {
      const r = canvas.getBoundingClientRect();
      st.look = {
        x: ((clientX - (r.left + r.width / 2)) / r.width) * 1.5,
        y: -((clientY - (r.top + r.height * 0.35)) / r.height) * 1.5,
        until: performance.now() + ms,
      };
    }
    function lookReset() { st.look = { x: null, y: null, until: 0 }; }

    function setState(patch) {
      Object.assign(st, patch);
    }
    function setEmotion(e) {
      st.emotion = e;
      applyEmotionExpression(e); // 情绪直达表情（有表情库的模型，如 Mao）
    }
    function setFacing(dir) { st.facing = dir >= 0 ? 1 : -1; }
    function celebrate() { playAction('celebrate'); }

    /** TTS 嘴型：把正在播放的 <audio> 接入 Web Audio 分析 */
    function attachAudio(audioEl) {
      try {
        if (!st.audioCtx) st.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        st.audioCtx.resume?.();
        if (st.audioSrc) { try { st.audioSrc.disconnect(); } catch { /* 已断开 */ } }
        st.audioSrc = st.audioCtx.createMediaElementSource(audioEl);
        st.audioAnalyser = st.audioCtx.createAnalyser();
        st.audioAnalyser.fftSize = 256;
        st.audioData = new Uint8Array(st.audioAnalyser.frequencyBinCount);
        st.audioSrc.connect(st.audioAnalyser);
        // 必须接到 destination：createMediaElementSource 之后音频改走 WebAudio 图，
        // 不接 destination 元素声音会被"截走"——这是语音断断续续/发不出声的根因
        st.audioAnalyser.connect(st.audioCtx.destination);
      } catch { st.audioAnalyser = null; /* 分析失败 → 假嘴型兜底 */ }
    }

    function resize(w, h) {
      app.renderer.resize(w, h);
      if (st.model) fitModel(st.model);
    }

    return {
      setState, setEmotion, setFacing, celebrate, playAction, loadModel, attachAudio, resize,
      autoAction, canWave,   // 她自己挑动作 / 这个模型能不能真挥手
      hasModel: () => !!st.model,
      setExpression, clearExpression, expressions, hitTestAt, lookAt, lookReset,
      costumeParts, setPartOverride, clearPartOverrides,
      __core: () => core(), // 调试通道：读参数（眼神跟随等）
      /** **看得见的她**占画布多少（归一化 0..1，与 dpr 无关）。
       *  为什么需要它：`fitModel` 把模型拉满画布**再放大 6%**，画布四周留了透明边距 ——
       *  按"舞台盒子"画的环其实围着一团空气（不符合大小比例）。
       *  `getBounds()` 给的是模型真实外接框（在画布坐标里），据此换算成比例。 */
      visibleBox: () => {
        const m = st.model;
        if (!m) return null;
        try {
          const b = m.getBounds();
          const W = canvas.width || 1, Hh = canvas.height || 1;
          if (!b || !(b.width > 0) || !(b.height > 0)) return null;
          return {
            topF: b.y / Hh,
            hF: b.height / Hh,      // 看得见的高度 ÷ 画布高
            wF: b.width / W,
            cxF: (b.x + b.width / 2) / W,
          };
        } catch { return null; }
      },
      modelInfo: () => ({
        loaded: !!st.model,
        motions: motionGroups(),
        expressions: expressions(),
        costumeParts: costumeParts().map((p) => p.id),
        paramIds: [...st.paramIds],
        idleTicks: st.idleTicks ?? 0, idleSkip: st.idleSkip ?? null,
      }),
      dispose() {
        try { st.model?.destroy(); } catch { /* 忽略 */ }
        try { app.destroy(); } catch { /* 忽略 */ }
        try { st.audioCtx?.close?.(); } catch { /* 忽略 */ }
      },
    };
  }

  window.PETL2D = {
    create,
    /** 预检：三方库是否就绪（pixi / cubism core / live2d-display） */
    supported: () => !!(window.PIXI && window.Live2DCubismCore && window.PIXI?.live2d?.Live2DModel),
  };
})();
