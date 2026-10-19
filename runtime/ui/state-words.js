// 灵核 · 状态词**唯一真源**
//
// 为什么单独一个文件、还写成"不 export"的样子：
//   · 渲染层是**普通脚本**（`<script src>`，本项目不引前端框架与打包器）→ 必须是 classic script；
//   · 主进程是 ESM（`runtime/package.json` 是 `type: module`）→ `import` 得到的是模块作用域。
//   一份文件两种加载方式，靠 `globalThis.TaskWords` 汇合：浏览器里就是 `window.TaskWords`。
//   ⚠ 这里**不许写 `export`**——写了浏览器 classic script 会直接语法报错（整页白）。
//
// 为什么只要这一张：状态词此前散在 `ui/components.js`、`ui/home.html`、`ui/pet.html` 三处，
//   而且**一个 i18n key 都没有**，同一件事三个说法（"我正在做" / "正在干活" / "正在做"）。现在只有这一张。

/** 九个状态词（状态机流转的展示映射；detail 由调用方带具体事项，如「帮你整理下载文件夹」） */
const TASK_STATE_LABELS = {
  Idle: '我在这儿',
  Listening: '我在听',
  Thinking: '让我想一下',
  Working: '我正在做', // UI 拼接 detail:「我正在整理文件」
  Approval: 'TA 想做', // UI 拼接 detail + 允许/不允许
  Success: '搞定了',
  Error: '这次没完成', // UI 拼 detail:失败原因人话
  Cancelled: '好,先停下了',
  Quiet: '安静陪着你不打扰',
};

/** 「正在…」进行态用词——对话流里那行计时抬头用它。 */
const TASK_STATE_PENDING = {
  Idle: '这就来',
  // **这条线上不许再出现"正在听"**：回复是整包缓冲的，按下回车之后她那边就是"在想"，
  // 说"我在听"是把等待期说轻了。
  Listening: '正在思考',
  Thinking: '正在思考',
  Working: '正在动手',
  Approval: '等你批准',
  Success: '这就收尾',
  Error: '这就收拾',
  Cancelled: '这就停下',
  Quiet: '安静陪着',
};

/* ---------- 等待语三套（「等待语随人格走」）----------
   **三套（温柔 / 干脆 / 俏皮）**，按相处模式走；命中不了就回落上面那套通用词。
   ⚠ 安全词表（这条没变，改之前先读）：等待语**绝不插值**工具参数 / 命令 / 路径 / 推理内容——
     否则会出现"正在执行 rm -rf …"这种吓人话。三套词都只从固定词表里取，一个字都不拼。
   为什么要有它：同一句"正在动手"，温柔的她、干脆的她、俏皮的说出来不该一个味儿。 */
const TASK_STATE_PENDING_TONES = {
  gentle: {
    Idle: '这就来', Listening: '我在想，别急', Thinking: '我在想，别急', Working: '我在做，一会儿就好',
    Approval: '这一步得你说了算', Success: '这就收尾', Error: '这就收拾', Cancelled: '这就停下', Quiet: '安静陪着你',
  },
  crisp: {
    Idle: '来了', Listening: '在想', Thinking: '在想', Working: '做着呢',
    Approval: '等你一句话', Success: '收尾', Error: '收拾一下', Cancelled: '停了', Quiet: '不打扰',
  },
  playful: {
    Idle: '这就来～', Listening: '脑子转起来了…', Thinking: '脑子转起来了…', Working: '手上正忙，马上',
    Approval: '你点头我才敢动', Success: '马上好', Error: '我看看哪儿不对', Cancelled: '好，收手', Quiet: '悄悄陪着',
  },
};
const PENDING_TONES = ['gentle', 'crisp', 'playful'];

/**
 * 等待语（按人格那套取；不认识的人格/没设过 → 通用那套）。
 *
 * 三套**带人格味道**的等待语和通用那套各有 i18n key（`state.pending.*`），
 * 由宿主按当前语言取词。**宁可不那么有味道，也不能露中文。**
 */
function pendingWords(state, tone) {
  const s = TASK_STATES.includes(state) ? state : 'Idle';
  const set = TASK_STATE_PENDING_TONES[tone];
  return set ? set[s] : TASK_STATE_PENDING[s];
}

/** 味道词的 i18n key（`state.pending.<tone>.<state>`）——27 条已翻成五种语言。
 *  ⚠ 用**函数**而不是常量表：常量会在模块求值时就引用 `TASK_STATES`，而它声明在这下面 ——
 *  写成常量表会把整个文件 TDZ 掉（页面直接拿不到 `pendingWords`）。 */
function pendingToneKey(tone, state) {
  return PENDING_TONES.includes(tone) ? `state.pending.${tone}.${String(state).toLowerCase()}` : null;
}

const TASK_STATE_KEYS = {
  Idle: 'state.idle', Listening: 'state.listening', Thinking: 'state.thinking', Working: 'state.working',
  Approval: 'state.approval', Success: 'state.success', Error: 'state.error', Cancelled: 'state.cancelled', Quiet: 'state.quiet',
};
const TASK_STATE_PENDING_KEYS = {
  Idle: 'state.pending.idle', Listening: 'state.pending.listening', Thinking: 'state.pending.thinking', Working: 'state.pending.working',
  Approval: 'state.pending.approval', Success: 'state.pending.success', Error: 'state.pending.error', Cancelled: 'state.pending.cancelled', Quiet: 'state.pending.quiet',
};

/** 全部状态词（顺序即状态机的流转顺序） */
const TASK_STATES = ['Idle', 'Listening', 'Thinking', 'Working', 'Approval', 'Success', 'Error', 'Cancelled', 'Quiet'];

/** 活动态：正在为用户做一件事（Quiet/Idle 与收尾态不算）。 */
const BUSY_STATES = ['Listening', 'Thinking', 'Working', 'Approval'];

/** 一次给出某状态的两句话（宿主广播 task-state 时挂在事件上；页面**零表**消费）。
 *  未知状态一律按 Idle 兜底——宁可说「这就来」，也不把内部状态名甩到用户脸上。 */
function stateWords(state, tone) {
  const s = TASK_STATES.includes(state) ? state : 'Idle';
  // `tone` = 相处模式（温柔/干脆/俏皮）；不传 = 通用那套（行为不变）
  return { word: TASK_STATE_LABELS[s], pending: pendingWords(s, tone) };
}

/* ---------- 风险档的人话词 ----------
   内核唯一真源是 `brain/src/policy/risk.ts` 的 R0~R5；界面**不按工具名自己再猜一遍**
   （同一件事两个判断会打架）。
   ⚠ 用户可见文案里**不出现 `R3` 这种内部码**——档位靠**人话词 + 颜色**表达。
   放在这个文件里而不是 components.js：形象端（pet.html）**不加载 components.js**，
   而它正是审批卡住的地方——词表放共享脚本里，两边才拿得到同一份。 */
const RISK_WORDS = {
  R0: '只是看一眼', R1: '记一笔', R2: '要动文件', R3: '会删东西', R4: '会对外发生', R5: '不可逆 · 得你点头',
};
const RISK_SEV = { R0: 'low', R1: 'low', R2: 'mid', R3: 'high', R4: 'high', R5: 'high' };
/** R 档 → 人话（未知档按 R3 保守显示——别把"不知道"说成"没事"） */
function riskWord(risk) { return RISK_WORDS[risk] ?? RISK_WORDS.R3; }
/** R 档 → 严重度（给颜色用；兼容老的 high/mid/low 入参） */
function riskSeverity(risk) {
  if (risk === 'high' || risk === 'mid' || risk === 'low') return risk;
  return RISK_SEV[risk] ?? 'high';
}

globalThis.TaskWords = {
  RISK_WORDS, riskWord, riskSeverity,
  TASK_STATES, BUSY_STATES,
  TASK_STATE_LABELS, TASK_STATE_PENDING,
  TASK_STATE_KEYS, TASK_STATE_PENDING_KEYS,
  // 等待语三套 + 按人格取词
  TASK_STATE_PENDING_TONES, PENDING_TONES, pendingWords, pendingToneKey,
  stateWords,
};
