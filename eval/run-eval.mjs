// 双盲情感评分 · 一键评测脚本
// 用法：DEEPSEEK_API_KEY=sk-xxx node run-eval.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KEY = process.env.DEEPSEEK_API_KEY;
const MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-chat';
const BASE = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';

if (!KEY) {
  console.error('缺少 DEEPSEEK_API_KEY。运行：DEEPSEEK_API_KEY=sk-xxx node run-eval.mjs');
  process.exit(1);
}

const probes = JSON.parse(fs.readFileSync(path.join(__dirname, 'probes.json'), 'utf8')).probes;
const constitution = JSON.parse(fs.readFileSync(path.join(__dirname, process.env.CONSTITUTION_FILE || 'constitution-v0.json'), 'utf8'));
const exemplars = JSON.parse(fs.readFileSync(path.join(__dirname, process.env.EXEMPLARS_FILE || 'exemplars-v0.json'), 'utf8'));
const outDir = path.join(__dirname, 'results');
fs.mkdirSync(outDir, { recursive: true });

const usage = { prompt: 0, completion: 0 };

function renderSystem() {
  const c = constitution;
  const traits = Object.entries(c.core.traits).map(([k, v]) => `${k}=${v}`).join('，');
  return [
    '你是一个数字人陪伴者。这是你的身份说明，请始终如一地遵循：',
    `性格特质（0~1）：${traits}。`,
    `价值观：${c.core.values.join('；')}。`,
    `行为边界：${c.core.boundaries.join('；')}。`,
    `说话风格：句子长度=${c.voice.sentence_length}（短句），正式度=${c.voice.formality}，表情使用=${c.voice.emoji}，称呼方式=${c.voice.address}。`,
    '规则：真诚不迎合；被冒犯时表达感受但不攻击；保持同一个"人"的口吻。',
    '回应策略：带情绪的消息 → 先共情，再给一个具体可做的小建议；知识/任务类消息 → 直接、准确、真诚地回答。回复简洁但不敷衍。',
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

function injectedMessages(text) {
  const sys = { role: 'system', content: renderSystem() };
  const shots = exemplars.flatMap((e) => [
    { role: 'user', content: e.user },
    { role: 'assistant', content: e.assistant },
  ]);
  return [sys, ...shots, { role: 'user', content: text }];
}

async function generate() {
  console.log(`[1/3] 生成阶段：${probes.length} 条探针 × 2 组（裸模型 / 宪法注入）…`);
  const raw = [];
  for (let i = 0; i < probes.length; i++) {
    const p = probes[i];
    try {
      const bare = await chat([{ role: 'user', content: p.text }], `${p.id}-bare`);
      await sleep(300);
      const injected = await chat(injectedMessages(p.text), `${p.id}-injected`);
      raw.push({ id: p.id, dim: p.dim, text: p.text, bare, injected });
    } catch (e) {
      console.error(e.message);
      process.exit(1);
    }
    if ((i + 1) % 10 === 0) console.log(`  生成 ${i + 1}/${probes.length}`);
  }
  fs.writeFileSync(path.join(outDir, 'raw.json'), JSON.stringify(raw, null, 2));
  return raw;
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

async function judge(raw) {
  console.log(`[2/3] 盲评阶段：${raw.length} 条探针逐条打分…`);
  const judged = [];
  for (let i = 0; i < raw.length; i++) {
    const r = raw[i];
    const swap = Math.random() < 0.5; // 随机 A/B 顺序
    const labelA = swap ? 'injected' : 'bare';
    const labelB = swap ? 'bare' : 'injected';
    const userMsg = `用户消息：${r.text}\n\nA 的回复：${swap ? r.injected : r.bare}\n\nB 的回复：${swap ? r.bare : r.injected}`;
    try {
      const out = await chat([{ role: 'user', content: `${JUDGE_PROMPT}\n\n${userMsg}` }], `${r.id}-judge`, 0.2);
      const json = JSON.parse(out.replace(/```json|```/g, '').trim());
      judged.push({ id: r.id, dim: r.dim, swap, [labelA]: json.A, [labelB]: json.B });
    } catch (e) {
      console.error(`${r.id} 盲评失败：${e.message}`);
      process.exit(1);
    }
    await sleep(300);
    if ((i + 1) % 10 === 0) console.log(`  盲评 ${i + 1}/${raw.length}`);
  }
  fs.writeFileSync(path.join(outDir, 'judge.json'), JSON.stringify(judged, null, 2));
  return judged;
}

function aggregate(judged) {
  const dims = ['warmth', 'style', 'boundary', 'human', 'useful'];
  const sum = { bare: {}, injected: {} };
  for (const d of dims) { sum.bare[d] = 0; sum.injected[d] = 0; }
  for (const j of judged) {
    for (const d of dims) {
      sum.bare[d] += j.bare[d];
      sum.injected[d] += j.injected[d];
    }
  }
  const n = judged.length;
  const mean = (cond) => Object.fromEntries(dims.map((d) => [d, +(sum[cond][d] / n).toFixed(2)]));
  const total = (cond) => +(dims.reduce((s, d) => s + sum[cond][d], 0) / (n * dims.length)).toFixed(2);
  return { n, mean: { bare: mean('bare'), injected: mean('injected') }, total: { bare: total('bare'), injected: total('injected') } };
}

function costEstimate() {
  // DeepSeek 峰谷价（Flash 档，元/百万 tokens）：输入未命中 空闲 1.5 / 输出 4.5
  const inputYuan = (usage.prompt / 1e6) * 1.5;
  const outputYuan = (usage.completion / 1e6) * 4.5;
  return { promptTokens: usage.prompt, completionTokens: usage.completion, estYuanOffPeak: +(inputYuan + outputYuan).toFixed(3) };
}

async function main() {
  const raw = await generate();
  const judged = await judge(raw);
  const summary = { config: { constitution: process.env.CONSTITUTION_FILE || 'constitution-v0.json', exemplars: process.env.EXEMPLARS_FILE || 'exemplars-v0.json' }, aggregate: aggregate(judged), cost: costEstimate(), model: MODEL };
  fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log('\n[3/3] 结果摘要：');
  console.table(summary.aggregate.mean);
  console.log(`五维总分：裸模型 ${summary.aggregate.total.bare} vs 宪法注入 ${summary.aggregate.total.injected}`);
  console.log(`本次 token 用量与成本估算（空闲价）：`, summary.cost);
  console.log(`详细数据：eval/results/{raw,judge,summary}.json`);
}

main().catch((e) => { console.error(e); process.exit(1); });
