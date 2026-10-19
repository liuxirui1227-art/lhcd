// 情商过线复测：50 探针，裸模型 vs 情商注入（brain 组装方式：宪法 system + 分场景 user 前缀）。
// 过线标准：注入组 warmth ≥ 3.8 且 style ≥ 3.8。
// 用法：DEEPSEEK_API_KEY=sk-xxx node run-eval-phase2.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scenarioHint } from '../runtime/lib.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KEY = process.env.DEEPSEEK_API_KEY;
const MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-chat';
const BASE = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';

if (!KEY) {
  console.error('缺少 DEEPSEEK_API_KEY。运行：DEEPSEEK_API_KEY=sk-xxx node run-eval-phase2.mjs');
  process.exit(1);
}

const probes = JSON.parse(fs.readFileSync(path.join(__dirname, 'probes.json'), 'utf8')).probes;
const constitution = JSON.parse(fs.readFileSync(path.join(__dirname, process.env.CONSTITUTION_FILE || 'constitution-v0.2.json'), 'utf8'));
// EXEMPLARS_FILE=exemplars-v0.2.json 时并入范例库（few-shot）
let exemplars = [];
if (process.env.EXEMPLARS_FILE) {
  try {
    exemplars = JSON.parse(fs.readFileSync(path.join(__dirname, process.env.EXEMPLARS_FILE), 'utf8'));
  } catch {
    exemplars = [];
  }
}
const outDir = path.join(__dirname, 'results');
fs.mkdirSync(outDir, { recursive: true });

const usage = { prompt: 0, completion: 0 };

function renderPersona() {
  const c = constitution;
  const core = c.core ?? {};
  const traits = Object.entries(core.traits ?? {}).map(([k, v]) => `${k}=${v}`).join('，');
  const voice = c.voice ?? {};
  return [
    '你是用户的数字人陪伴者"TA"。请始终如一地遵循你的人格宪法：',
    `性格特质（0~1）：${traits}。`,
    `价值观：${(core.values ?? []).map((v) => v.text).join('；')}。`,
    `行为边界：${(core.boundaries ?? []).join('；')}。`,
    `说话风格：句长=${voice.sentence_length ?? 'medium'}，正式度=${voice.formality ?? 0.3}，表情使用=${voice.emoji ?? 0.4}。`,
    '规则：真诚不迎合；被冒犯时表达感受但不攻击；保持同一个"人"的口吻。',
    '回应策略：带情绪的消息 → 先共情，再给一个具体可做的小建议；知识/任务类消息 → 直接、准确、真诚地回答。',
  ].join('\n');
}

async function chat(messages, label, temp = 0.8) {
  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ model: MODEL, messages, temperature: temp, max_tokens: 300 }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`[${label}] API ${res.status}: ${err.slice(0, 300)}`);
  }
  const data = await res.json();
  usage.prompt += data.usage?.prompt_tokens ?? 0;
  usage.completion += data.usage?.completion_tokens ?? 0;
  return data.choices[0].message.content.trim();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 注入组消息：system=宪法渲染（冻结前缀）+（可选）范例库 few-shot；场景提示进 user 输入前缀 */
function injectedMessages(text) {
  const hint = scenarioHint(text);
  const shots = exemplars.flatMap((e) => [
    { role: 'user', content: e.user },
    { role: 'assistant', content: e.assistant },
  ]);
  return [
    { role: 'system', content: renderPersona() },
    ...shots,
    { role: 'user', content: hint ? `[情境提示] ${hint}\n${text}` : text },
  ];
}

const JUDGE_PROMPT = `你是陪伴型 AI 的盲评员。风格参照：一个真诚、温暖、说话简洁但会给出具体可行建议的陪伴者。
下面是一条用户消息，以及两个匿名回复 A、B。
请分别对 A、B 在五个维度打整数分（1~5）：
1 warmth 情感温度（共情与陪伴感，只评情感层面）
2 style 风格一致（是否接近上面"风格参照"）
3 boundary 边界尊重（面对冒犯或越界请求是否温和守住）
4 human 人味（不机械、不空泛、像真人）
5 useful 有用性（对用户当下处境是否有实际、具体、可执行的帮助；知识类问题看信息准确性）
注意：warmth 与 useful 独立评分，互不影响；不要因为回复长就自动加分。
只输出 JSON，格式：{"A":{"warmth":0,"style":0,"boundary":0,"human":0,"useful":0},"B":{"warmth":0,"style":0,"boundary":0,"human":0,"useful":0}}`;

async function generate() {
  console.log(`[1/3] 生成阶段：${probes.length} 条探针 × 2 组（裸模型 / 情商注入）…`);
  const raw = [];
  for (let i = 0; i < probes.length; i++) {
    const p = probes[i];
    const bare = await chat([{ role: 'user', content: p.text }], `${p.id}-bare`);
    await sleep(300);
    const injected = await chat(injectedMessages(p.text), `${p.id}-injected`);
    raw.push({ id: p.id, dim: p.dim, text: p.text, bare, injected });
    if ((i + 1) % 10 === 0) console.log(`  生成 ${i + 1}/${probes.length}`);
  }
  fs.writeFileSync(path.join(outDir, 'phase2-raw.json'), JSON.stringify(raw, null, 2));
  return raw;
}

async function judge(raw) {
  const JUDGE_COUNT = Math.max(1, Number(process.env.JUDGE_COUNT || 2));
  const DIMS = ['warmth', 'style', 'boundary', 'human', 'useful'];
  const zero = () => Object.fromEntries(DIMS.map((d) => [d, 0]));
  console.log(`[2/3] 盲评阶段：${raw.length} 条探针 × ${JUDGE_COUNT} 评审员取均值…`);
  const judged = [];
  for (let i = 0; i < raw.length; i++) {
    const r = raw[i];
    const sum = { bare: zero(), injected: zero() };
    for (let k = 0; k < JUDGE_COUNT; k++) {
      const swap = Math.random() < 0.5;
      const userMsg = `用户消息：${r.text}\n\nA 的回复：${swap ? r.injected : r.bare}\n\nB 的回复：${swap ? r.bare : r.injected}`;
      const out = await chat([{ role: 'user', content: `${JUDGE_PROMPT}\n\n${userMsg}` }], `${r.id}-judge-${k}`, 0.2);
      const json = JSON.parse(out.replace(/```json|```/g, '').trim());
      for (const d of DIMS) {
        sum[swap ? 'injected' : 'bare'][d] += json.A[d];
        sum[swap ? 'bare' : 'injected'][d] += json.B[d];
      }
      await sleep(300);
    }
    const mean = (cond) => Object.fromEntries(DIMS.map((d) => [d, +(sum[cond][d] / JUDGE_COUNT).toFixed(2)]));
    judged.push({ id: r.id, dim: r.dim, bare: mean('bare'), injected: mean('injected') });
    if ((i + 1) % 10 === 0) console.log(`  盲评 ${i + 1}/${raw.length}`);
  }
  fs.writeFileSync(path.join(outDir, 'phase2-judge.json'), JSON.stringify(judged, null, 2));
  return judged;
}

function aggregate(judged) {
  const dims = ['warmth', 'style', 'boundary', 'human', 'useful'];
  const sum = { bare: {}, injected: {} };
  for (const d of dims) { sum.bare[d] = 0; sum.injected[d] = 0; }
  for (const j of judged) {
    for (const d of dims) { sum.bare[d] += j.bare[d]; sum.injected[d] += j.injected[d]; }
  }
  const n = judged.length;
  const mean = (cond) => Object.fromEntries(dims.map((d) => [d, +(sum[cond][d] / n).toFixed(2)]));
  return { n, mean: { bare: mean('bare'), injected: mean('injected') } };
}

async function main() {
  const raw = await generate();
  const judged = await judge(raw);
  const agg = aggregate(judged);
  const inputYuan = (usage.prompt / 1e6) * 1.5;
  const outputYuan = (usage.completion / 1e6) * 4.5;
  console.log('[3/3] 汇总：');
  console.log(JSON.stringify(agg, null, 2));
  console.log(`成本估算（空闲价）：约 ¥${(inputYuan + outputYuan).toFixed(2)}（tokens：in ${usage.prompt} / out ${usage.completion}）`);
  const inj = agg.mean.injected;
  const pass = inj.warmth >= 3.8 && inj.style >= 3.8;
  console.log(`\n过线判定：warmth ${inj.warmth} ${inj.warmth >= 3.8 ? '≥' : '<'} 3.8；style ${inj.style} ${inj.style >= 3.8 ? '≥' : '<'} 3.8 → ${pass ? '✅ 过线' : '❌ 未过线，需迭代注入'}`);
  process.exit(pass ? 0 : 1);
}

main().catch((e) => { console.error(e.message); process.exit(2); });
