// 状态词**一处真源**的棘轮。
//
// 这一条防的是"三套表并存"复发——原先的状态词散在四个地方，谁也说不清哪个对：
//   ui/task-state.mjs（状态机自带一份）· ui/components.js（STATE_LABELS）
//   · ui/home.html（PENDING_TEXT）· ui/pet.html（L 表，词还不一样）
// 现在唯一真源是 ui/state-words.js（渲染层 classic script / 主进程 ESM 两种加载方式汇合到 globalThis.TaskWords）。
// 本测试把"再长出第二张表"变成**红灯**，而不是靠下次读代码时恰好想起来。
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (p) => fs.readFileSync(path.join(HERE, p), 'utf8');

// 先加载唯一真源（副作用：写 globalThis.TaskWords）
await import('./ui/state-words.js');
const Words = globalThis.TaskWords;
const { TASK_STATES, BUSY_STATES, TASK_STATE_LABELS, TASK_STATE_PENDING, TASK_STATE_KEYS, TASK_STATE_PENDING_KEYS, stateWords } = Words;

test('唯一真源齐备：9 个状态两套词 + 活动态 + i18n key', () => {
  assert.equal(TASK_STATES.length, 9);
  assert.deepEqual(BUSY_STATES, ['Listening', 'Thinking', 'Working', 'Approval']);
  for (const s of TASK_STATES) {
    assert.ok(TASK_STATE_LABELS[s]?.length > 0, `${s} 缺人话`);
    assert.ok(TASK_STATE_PENDING[s]?.length > 0, `${s} 缺进行态用词`);
    assert.ok(TASK_STATE_KEYS[s]?.startsWith('state.'), `${s} 缺 i18n key`);
    assert.ok(TASK_STATE_PENDING_KEYS[s]?.startsWith('state.pending.'), `${s} 缺进行态 i18n key`);
  }
  // 未知状态按 Idle 兜底（宁可说「这就来」，也不把内部状态名甩到脸上）
  assert.deepEqual(stateWords('不存在'), { word: TASK_STATE_LABELS.Idle, pending: TASK_STATE_PENDING.Idle });
  assert.deepEqual(stateWords('Working'), { word: '我正在做', pending: '正在动手' });
});

test('locales/zh-CN.json 与真源逐字一致（防两处漂移）', () => {
  const dict = JSON.parse(read('locales/zh-CN.json'));
  for (const s of TASK_STATES) {
    assert.equal(dict[TASK_STATE_KEYS[s]], TASK_STATE_LABELS[s], `${TASK_STATE_KEYS[s]} 与 state-words.js 不一致`);
    assert.equal(dict[TASK_STATE_PENDING_KEYS[s]], TASK_STATE_PENDING[s], `${TASK_STATE_PENDING_KEYS[s]} 与 state-words.js 不一致`);
  }
});

/** 去掉注释（只留代码）——不然"注释里提到某个词"会误报 */
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('task-state.mjs 只是重新导出，不是第二份表', () => {
  const src = read('ui/task-state.mjs');
  const code = stripComments(src);
  // 代码里不许再出现中文状态词（出现了就是又抄了一份）
  assert.ok(!/我在这儿|我正在做|正在思考/.test(code), 'task-state.mjs 的代码里又写死了状态词');
  assert.ok(!/TASK_STATE_(LABELS|PENDING)\s*=\s*\{/.test(code), 'task-state.mjs 又自带了一张表');
  assert.ok(src.includes("import './state-words.js'"), 'task-state.mjs 没有加载唯一真源');
});

test('页面/组件里不许再自带状态词表（S5 复发守卫）', () => {
  const guards = [
    ['ui/home.html', /PENDING_TEXT\s*=\s*\{/, '家页又长出了 PENDING_TEXT'],
    ['ui/pet.html', /const L = \{ Listening/, '形象端又长出了本地状态词表'],
    ['ui/components.js', /STATE_LABELS = \{/, 'components.js 又自带了一张 STATE_LABELS'],
  ];
  for (const [file, re, msg] of guards) assert.ok(!re.test(read(file)), `${msg}（${file}）`);
  // 活动态集合同样收口：页面不许硬编码那四个状态名
  for (const file of ['ui/home.html', 'ui/pet.html', 'ui/quick.html', 'ui/conv.html']) {
    assert.ok(!/\[['"]Listening['"],\s*['"]Thinking['"]/.test(read(file)), `${file} 又硬编码了活动态集合`);
  }
});

test('风险档词表也在这一处（迭代 15 · 风险分级 UI）', () => {
  const W = globalThis.TaskWords;
  // R0~R5 六档都有人话，且**人话里不许出现 R# 这种内部码**（用户可见文案纪律）
  for (const r of ['R0', 'R1', 'R2', 'R3', 'R4', 'R5']) {
    const w = W.riskWord(r);
    assert.ok(w.length > 1, `${r} 缺人话`);
    assert.ok(!/R\d/.test(w), `${r} 的人话里出现了内部码：${w}`);
    assert.ok(['low', 'mid', 'high'].includes(W.riskSeverity(r)), `${r} 的严重度不合法`);
  }
  // 未知档按 R3 保守显示（别把"不知道"说成"没事"）
  assert.equal(W.riskWord('R9'), W.riskWord('R3'));
  // 宿主不再按工具名自己猜（那条会与内核打架）：main.mjs 里不许再有 approvalRisk
  assert.ok(!/function approvalRisk/.test(read('main.mjs')), 'main.mjs 又把"按工具名猜风险"加回来了');
  assert.ok(/risk: typeof req\?\.risk === 'string' \? req\.risk : 'R3'/.test(read('main.mjs')), 'main.mjs 没有透传内核的 R 档');
  // 形象端也吃这一份（它不加载 components.js）
  assert.ok(/TaskWords/.test(read('ui/pet.html')), 'pet.html 没用共享词表');
});

test('宿主广播把词挂上事件、且页面零表消费', () => {
  const main = read('main.mjs');
  assert.ok(main.includes('stateWordsFor'), 'main.mjs 没有把状态词挂到广播上');
  assert.ok(main.includes('...stateWordsFor(to)'), 'task-state 广播没带 word/pending');
  assert.ok(main.includes('currentTaskStep'), 'main.mjs 没有跟踪"她正在做的那一步"');
  // 工具步进要真的把状态推进 Working（「我在做怎么是听呢」的真根因）
  assert.ok(/if \(ev\.phase === 'start'\) noteTaskStep\(/.test(main), '工具步进没有推进 Working');
});

/* ---------- 等待语三套（温柔 / 干脆 / 俏皮） ---------- */
test('★ 三套等待语各不相同，且都不传 = 通用那套（行为与从前一字不差）', () => {
  const W = Words;
  const states = ['Listening', 'Thinking', 'Working', 'Approval'];
  for (const s of states) {
    // ⚠ 别用中文变量名：`const通用`（少个空格）会被当成一个标识符，报 "const通用 is not defined"
    const plain = W.pendingWords(s, '');
    assert.equal(plain, W.TASK_STATE_PENDING[s], s + ' 不传 tone 必须回落通用表');
    const three = ['gentle', 'crisp', 'playful'].map((t) => W.pendingWords(s, t));
    assert.ok(three.every((x) => typeof x === 'string' && x.length > 0), s + ' 三套都要有词');
    assert.equal(new Set(three).size, 3, s + ' 三套必须真的不一样：' + JSON.stringify(three));
  }
});

test('不认识的人格 / 未知状态都兜底（宁可说通用那句，也不报错）', () => {
  const W = Words;
  assert.equal(W.pendingWords('Working', '不存在的性格'), W.TASK_STATE_PENDING.Working);
  assert.equal(W.pendingWords('不存在的状态', 'gentle'), W.TASK_STATE_PENDING_TONES.gentle.Idle);
});

test('★ 安全词表：三套等待语里不许出现路径 / 命令 / 工具名（一个字都不许插值）', () => {
  const W = Words;
  const all = [];
  for (const t of W.PENDING_TONES) for (const s of W.TASK_STATES) all.push(W.pendingWords(s, t));
  for (const w of all) {
    assert.ok(!/[/~\\]|rm |sudo|\.md|\.json|命令行/.test(w), '等待语里出现了危险内容：' + w);
    assert.ok(!/正在执行|正在运行/.test(w), '不许说"正在执行…"（那是安全词表点名的吓人话）：' + w);
  }
  assert.ok(all.length >= 27, '三套 × 九态都要有词');
});
