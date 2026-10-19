// 从官方 CubismWebSamples 拉取合规样例模型（Live2D Free Material License）扩充形象库。
// 用法：node scripts/fetch-live2d-models.mjs [Haru Natori Shizuku Hibiki ...]（缺省拉全部内置清单）
// 策略（沿用历史坑规避）：按 model3.json FileReferences 解析文件清单（不手写枚举）；并发 ≤4；每文件重试 8 轮退避；
// PNG 魔数 + moc3 最小体积 + JSON 可解析三重校验；清单与 models.json 合并（id=目录名）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LIVE2D_DIR = path.join(__dirname, '..', 'data', 'live2d');
// 注意：仓库默认分支是 develop（main 分支不存在——拉取 404 的根因）
const BASE = 'https://raw.githubusercontent.com/Live2D/CubismWebSamples/develop/Samples/Resources';
const CONCURRENCY = 4;

// 只选经典 Cubism 4 样例（与 pixi-live2d-display cubism4 子构建兼容）；
// Mark/Ren/Rice 为 Cubism 5 时代模型，moc3 版本存在运行时兼容风险，不拉
const KNOWN = {
  Haru: { label: 'Haru · 粉发双马尾少女', features: ['眼神跟随', '物理', '10 组动作', '表情库'] },
  Natori: { label: 'Natori · 白毛文静少女', features: ['眼神跟随', '物理', '10 组动作', '表情库'] },
  Wanko: { label: 'Wanko · 犬系吉祥物', features: ['眼神跟随', '物理', '表情库'] },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchBuf(url, tries = 8) {
  for (let i = 1; i <= tries; i++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 90000); // 单次尝试 90s 超时（防挂死占住并发槽）
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'lhcd-fetch' }, signal: ac.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (!buf.length) throw new Error('empty');
      return buf;
    } catch (e) {
      if (i === tries) throw new Error(`${url} 拉取失败（${tries} 轮）：${e.message}`);
      await sleep(400 * i + Math.random() * 300);
    } finally {
      clearTimeout(timer);
    }
  }
}

async function fetchJson(url) {
  const buf = await fetchBuf(url);
  return JSON.parse(buf.toString('utf8'));
}

// model3.json FileReferences → 相对文件清单（去重保序）
function refsFrom(modelJson) {
  const out = [];
  const push = (p) => { if (p && typeof p === 'string' && !out.includes(p)) out.push(p); };
  const f = modelJson?.FileReferences ?? {};
  push(f.Moc);
  push(f.Physics);
  push(f.Pose);
  push(f.DisplayInfo);
  push(f.UserData);
  (f.Textures ?? []).forEach(push);
  (f.Expressions ?? []).forEach((e) => push(e.File));
  for (const group of Object.values(f.Motions ?? {})) {
    for (const m of group) push(m.File);
  }
  return out;
}

function validate(modelName, rel, buf) {
  if (rel.endsWith('.png')) {
    if (buf.length < 5000) return 'PNG 过小';
    const isPng = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
    if (!isPng) return '非 PNG 魔数';
  } else if (rel.endsWith('.json')) {
    try { JSON.parse(buf.toString('utf8')); } catch { return 'JSON 解析失败'; }
  } else if (rel.endsWith('.moc3')) {
    if (buf.length < 100000) return 'moc3 过小（疑似截断）';
  }
  return null;
}

async function fetchModel(name) {
  const dir = path.join(LIVE2D_DIR, name);
  const modelRel = `${name}/${name}.model3.json`;
  let modelJson;
  try {
    modelJson = await fetchJson(`${BASE}/${modelRel}`);
  } catch (e) {
    return { name, ok: false, error: 'model3.json 获取失败：' + e.message };
  }
  // model3.json 本体也要落盘（FileReferences 只列它引用的文件，不含它自己——漏了它模型无法加载）
  const refs = [name + '.model3.json', ...refsFrom(modelJson)];
  if (!refs.length) return { name, ok: false, error: 'FileReferences 为空' };
  fs.mkdirSync(dir, { recursive: true });
  // 并发 ≤4：官方仓库 raw 高并发抖动失败（历史坑）
  // FileReferences 路径相对模型目录（如 Haru.2048/texture_00.png）——目标 = live2d/<name>/<rel>，别写到顶层
  let done = 0, failed = [];
  const queue = [...refs];
  const worker = async () => {
    while (queue.length) {
      const rel = queue.shift();
      const target = path.join(LIVE2D_DIR, name, rel);
      try {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        const buf = await fetchBuf(`${BASE}/${name}/${rel}`);
        const err = validate(name, rel, buf);
        if (err) throw new Error(err);
        fs.writeFileSync(target, buf);
      } catch (e) {
        failed.push(`${rel}（${e.message}）`);
      }
      done++;
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, refs.length) }, worker));
  return { name, ok: failed.length === 0, files: done, failed };
}

async function main() {
  const names = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(KNOWN);
  console.log('拉取目标：' + names.join('、'));
  const results = [];
  for (const name of names) {
    process.stdout.write(`→ ${name} … `);
    const r = await fetchModel(name);
    console.log(r.ok ? `✅ ${r.files} 文件` : `❌ ${r.error}${r.failed?.length ? '；失败：' + r.failed.join('、') : ''}`);
    results.push(r);
  }
  // models.json 合并（清单元数据优先，同名 id 以清单为准；与 runtime lib.mjs live2dManifest 约定一致）
  const manifestPath = path.join(LIVE2D_DIR, 'models.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const byId = new Map(manifest.models.map((m) => [m.id, m]));
  for (const [name, meta] of Object.entries(KNOWN)) {
    if (!names.includes(name)) continue;
    if (fs.existsSync(path.join(LIVE2D_DIR, name, `${name}.model3.json`))) {
      byId.set(name, {
        id: name,
        label: meta.label,
        file: `${name}/${name}.model3.json`,
        license: 'Live2D Free Material License Agreement（官方样例，Live2D Inc.；个人/小规模事业可自由使用）',
        source: `Live2D/CubismWebSamples 官方仓库 Samples/Resources/${name}`,
        features: meta.features,
      });
    }
  }
  manifest.models = [...byId.values()];
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  console.log('models.json 已合并：' + manifest.models.map((m) => m.id).join('、'));
  if (results.some((r) => !r.ok)) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
