// 灵核 · 回归门槛（`npm run gate`）
//
// 一条命令跑完：brain 全量测试 → runtime 测试 → `agent eval` → 冒烟；第一处红就停。
//
// 用法：
//   npm run gate                 # 全跑，第一处红就停（红了要立刻看见，别埋在末尾）
//   npm run gate -- --keep-going # 红也继续跑完（想知道一共坏了几处时用）
//   npm run gate -- --fast       # 跳过最慢的几步（改文档/小改时自用，别拿来交付）
//
// **零成本**：全程 mock，不调真 LLM、不联网、不读用户数据目录。
// 不覆盖的（故意留在这儿说明白，免得被当成"全绿 = 全对"）：
//   · 界面冒烟必须用 electron——需要起真窗口，不进这条门槛；
//   · 真钥匙相关的（视觉验证等）要花钱，永远不进门槛。
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const keepGoing = process.argv.includes('--keep-going');
const fast = process.argv.includes('--fast');

/** 每一步：名字 + 在哪个目录跑 + 命令。`fast: true` 的步骤会被 --fast 跳过。 */
const STEPS = [
  // 语法护栏：所有 runtime/*.mjs 与三个界面的内联脚本（模板串里写反引号那类错，这里当场红）
  { name: '语法护栏（可解析性）', cwd: '.', cmd: ['node', 'scripts/check-syntax.mjs'] },
  // 国际化完整性：用了但没有的键 / 重复键 / 空值 / 别的语言的孤儿键
  { name: '国际化完整性（词表）', cwd: '.', cmd: ['node', 'scripts/check-i18n.mjs'] },
  // 覆盖层 token 供给同源（pet/birth/stage 三页不引 ui.css，靠生成物供给；
  // 手改生成物 / 新引用没补 / 拼错名 = 当场红）
  { name: '覆盖层 token 供给（同源）', cwd: '.', cmd: ['node', 'scripts/check-overlay-tokens.mjs'] },
  // CSS 变量引用完整性（引用了不存在的 token = 整条声明静默失效；
  // 硬编码色值棘轮数不到这一类）
  { name: 'CSS 变量引用完整性', cwd: '.', cmd: ['node', 'scripts/check-css-vars.mjs'] },
  // 简繁归一表与映射/语料同源 + 回环自检（繁体归一化回来，简体原文必须在候选里）
  { name: '简繁归一表（同源 + 回环）', cwd: '.', cmd: ['node', 'scripts/make-hans-norm.mjs', '--check'] },
  // 繁体产物**逐字体检**（词表 = toHant(中文源) / 产物里不许残留简体字）
  { name: '繁体产物（同源 + 残留）', cwd: '.', cmd: ['node', 'scripts/check-hant-remnants.mjs'] },
  { name: 'core 单测', cwd: 'core', cmd: ['npm', 'test'] },
  { name: 'brain 单测（含编译）', cwd: 'brain', cmd: ['npm', 'test'] },
  { name: 'runtime 单测', cwd: 'runtime', cmd: ['npm', 'test'] },
  { name: '黄金用例 agent eval', cwd: 'brain', cmd: ['node', 'dist/bin/agent.js', 'eval'] },
  // 零成本冒烟
  { name: 'smoke：策略（墙与门）', cwd: 'runtime', cmd: ['node', 'smoke-policy.mjs'] },
  { name: 'smoke：生产守卫（hooks）', cwd: 'runtime', cmd: ['node', 'smoke-hook-guard.mjs'] },
  { name: 'smoke：来源与污染（记忆关闸）', cwd: 'runtime', cmd: ['node', 'smoke-pollution.mjs'] },
  { name: 'smoke：审批卡送达（真应用三窗口）', cwd: 'runtime', cmd: ['node', 'smoke-approval-card.mjs'] },
  // 九个页面各真加载一遍——控制台零错误 + 关键容器真渲染出内容。
  // 挡的是"调了个不存在的函数 → 整块静默白屏"。
  { name: 'smoke：页面启动（九页无静默白屏）', cwd: 'runtime', cmd: ['./node_modules/.bin/electron', 'smoke-pages-load.mjs'] },
  { name: 'smoke：销毁本机智能体（真应用→回到出生向导）', cwd: 'runtime', cmd: ['node', 'smoke-destroy-agent.mjs'] },
  { name: 'smoke：真流式', cwd: 'runtime', cmd: ['node', 'smoke-streaming.mjs'] },
  // 对话树（从某句重说 / 老分支逐字节不动 / 切回）
  { name: 'smoke：对话树（分支）', cwd: 'runtime', cmd: ['node', 'smoke-iter17-branch.mjs'] },
  // 标签（打/覆盖/摘掉）+ 单文件 HTML 导出（全转义、零外部请求）
  { name: 'smoke：标签与单文件导出', cwd: 'runtime', cmd: ['node', 'smoke-iter17-labels.mjs'] },
  // 后台复盘（节奏 / 不阻塞主回合 / 只提候选 / 工具白名单）
  { name: 'smoke：后台复盘（提候选）', cwd: 'runtime', cmd: ['node', 'smoke-iter18-review.mjs'] },
  // 技能候选态（提→批→忽略留痕；没批准不进技能表）
  { name: 'smoke：技能候选态', cwd: 'runtime', cmd: ['node', 'smoke-iter18-skillcand.mjs'] },
  // 撤销这一轮改动（回合级快照 / 新建的送回收站 / 进签名链）
  { name: 'smoke：撤销这一轮改动', cwd: 'runtime', cmd: ['node', 'smoke-iter18-undo.mjs'] },
  // KPI 五项（手工复算对得上 / 分母为 0 给「—」/ 一天一行）
  { name: 'smoke：KPI 五项', cwd: 'runtime', cmd: ['node', 'smoke-iter18-kpi.mjs'] },
  // 存量提取真的接上了（翻译生效 / 没翻的回落中文 / 不空白不泄漏键名）
  { name: 'smoke：国际化接线', cwd: 'runtime', cmd: ['./node_modules/.bin/electron', 'smoke-iter19-i18n.mjs'] },
  // 语音的语言参数（云合成带 language_type / 没核实的语言走本机并如实说明 / 分句标点按语言）
  { name: 'smoke：语音语言参数', cwd: 'runtime', cmd: ['node', 'smoke-iter19-voice.mjs'] },
  // 语言相关词表层——五种语言说同一件事，判断必须一致
  { name: 'smoke：词表层五语一致', cwd: 'runtime', cmd: ['node', 'smoke-iter19-lexicon.mjs'] },
  // 情绪词库是本地即时分类，改词库最容易悄悄改口径——用标注语料守住（macro-F1 ≥ 0.8）
  { name: '情绪识别语料（macro-F1）', cwd: 'eval', cmd: ['node', 'emotion-eval.mjs'] },
  // **中文泄漏扫描**——按非中文语言渲染每页，数可见文本里还有多少中文。
  //   只验"挂了 data-i18n 的元素翻没翻"不够："打包回落 en-US + 硬编码中文没搬"这种组合能全绿通过。
  { name: '中文泄漏扫描（i18n 棘轮）', cwd: 'runtime', cmd: ['./node_modules/.bin/electron', 'smoke-i18n-leak.mjs'] },
  // 硬编码色值**棘轮**——基线 = 当前实测，只许降不许升：
  //   接进门槛才能拦住它红回去。基线每迁完一页咬紧一格。
  { name: '硬编码色值棘轮', cwd: 'runtime', cmd: ['node', 'smoke-ui-colors.mjs'] },
  { name: 'smoke：审计链（工具动作/审批入链）', cwd: 'runtime', cmd: ['node', 'smoke-audit-chain.mjs'] },
  { name: 'smoke：设备分级 + 审批四态', cwd: 'runtime', cmd: ['node', 'smoke-device-audit.mjs'] },
  { name: '检索基线（门槛 ≥80%）', cwd: 'eval', cmd: ['node', 'retrieval-test.mjs'], fast: true },
];

const results = [];
let failed = 0;
for (const step of STEPS) {
  if (fast && step.fast) {
    results.push({ name: step.name, ok: true, ms: 0, skipped: true });
    continue;
  }
  const t0 = Date.now();
  process.stdout.write(`\n▶ ${step.name} …\n`);
  const r = spawnSync(step.cmd[0], step.cmd.slice(1), {
    cwd: path.join(ROOT, step.cwd),
    stdio: ['ignore', 'inherit', 'inherit'],
    env: { ...process.env, LH_FORCE_FLASH: '1' }, // 开发/测试期走便宜档（变量名没有 CD）
  });
  const ms = Date.now() - t0;
  const ok = r.status === 0;
  if (!ok) failed++;
  results.push({ name: step.name, ok, ms });
  if (!ok && !keepGoing) break;
}

console.log('\n──────── 门槛结果 ────────');
for (const r of results) {
  const mark = r.skipped ? '⏭ ' : r.ok ? '✅' : '❌';
  console.log(`${mark} ${r.name}${r.skipped ? '（--fast 跳过）' : `  ${(r.ms / 1000).toFixed(1)}s`}`);
}
const ran = results.filter((r) => !r.skipped).length;
if (failed > 0) {
  console.log(`\n❌ 门槛未过：${failed} 处红（共跑 ${ran} 步）——**先修再进下一轮**。`);
  process.exit(1);
}
if (results.length < STEPS.length) console.log(`\n⚠ 有步骤因为前面红了没跑（共跑 ${ran} 步）。`);
console.log(`\n✅ 门槛通过：${ran} 步全绿。`);
