// 凭据存放与解析。
//
// 设计要点：
//   · 凭据单独一个文件（0600，目录 0700），不躺在通用配置里
//   · 值里可以写 `$环境变量` 或 `!命令`（钥匙串）——密钥不必落进任何配置文件
//   · 系统钥匙串不做内建支持：不内建 TTL / 复用 / 恢复逻辑，要用户自己配 `!security …` 一类命令
//   · 可用性检查只读、不执行命令（"认出来了"不该有副作用）
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/** 凭据文件写入选项（0600） */
export const CRED_FILE_OPTS = { encoding: 'utf-8', mode: 0o600 };
export const CRED_DIR_MODE = 0o700;

/** 「供应商 → 该看哪些环境变量」（取常见供应商）
 *  ⚠️ 顺序即优先级：同一供应商有多个候选时，靠前的先认。 */
export const ENV_KEYS = {
  deepseek: ['DEEPSEEK_API_KEY'],
  openai: ['OPENAI_API_KEY'],
  anthropic: ['ANTHROPIC_API_KEY'],
  qwen: ['DASHSCOPE_API_KEY', 'IMAGE_API_KEY'],
  moonshot: ['MOONSHOT_API_KEY'],
  zhipu: ['ZHIPUAI_API_KEY', 'GLM_API_KEY'],
  google: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
  xai: ['XAI_API_KEY'],
  siliconflow: ['SILICONFLOW_API_KEY'],
  openrouter: ['OPENROUTER_API_KEY'],
  together: ['TOGETHER_API_KEY'],
  groq: ['GROQ_API_KEY'],
};

/**
 * 允许的"凭据类"命令（白名单）。
 * **只认这些**：它们的工作就是"把一条密钥打给 stdout"，没有别的能力；
 * 传参走 argv、不经 shell，所以 `;`、`|`、`$()` 之类拿不到执行机会。
 */
export const ALLOWED_CRED_COMMANDS = new Set(['security', 'op', 'pass', 'gpg', 'secret-tool', 'keychain', 'keyctl']);
const SHELL_META = /[;&|<>$`\n\r\\]/;

/** 把 `!命令` 切成 bin + args（**自己切词、拒绝元字符**——不交给 shell 是这条防线的关键） */
export function parseCommand(cmd) {
  const raw = String(cmd ?? '').trim();
  if (!raw) return { ok: false, reason: 'empty-command' };
  if (SHELL_META.test(raw)) return { ok: false, reason: 'shell-metacharacters-rejected' };
  const tokens = [];
  let cur = '';
  let quote = null;
  for (const ch of raw) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (/\s/.test(ch)) {
      if (cur) { tokens.push(cur); cur = ''; }
    } else {
      cur += ch;
    }
  }
  if (quote) return { ok: false, reason: 'unbalanced-quote' };
  if (cur) tokens.push(cur);
  if (!tokens.length) return { ok: false, reason: 'empty-command' };
  const bin = tokens[0];
  const base = bin.split('/').pop();
  if (!ALLOWED_CRED_COMMANDS.has(base)) return { ok: false, reason: `command-not-allowed:${base}（只允许凭据类命令：${[...ALLOWED_CRED_COMMANDS].join('/')}）` };
  return { ok: true, bin, args: tokens.slice(1) };
}

/** 值里的 `!命令` 结果缓存（进程生命周期） */
const commandCache = new Map();

/** 是不是"间接引用"写法（`$ENV` / `!命令`）——**不解析内容，只看形态** */
export function isIndirect(raw) {
  const s = String(raw ?? '').trim();
  return s.startsWith('$') || s.startsWith('!');
}

/** 是不是"要执行命令"的写法（只有 `!` 前缀会执行；`$ENV` 只是读环境变量，安全） */
export function isCommand(raw) {
  return String(raw ?? '').trim().startsWith('!');
}

/**
 * 解析配置里写的值：
 *   `!命令`          → 执行并把 stdout 当值（进程内缓存；命令自己不设 TTL——那是用户的事）
 *   `$VAR`/`${VAR}`  → 取环境变量；**没设就是"没解析出来"**（不是空串）
 *   `$$` / `$!`      → 转义成字面 `$` / `!`
 *   其它             → 字面值（裸大写串如 `MY_API_KEY` 是字面值，要环境变量得写 `$MY_API_KEY`）
 */
export function resolveValue(raw, { execute = true, env = process.env, trusted = false } = {}) {
  const s = String(raw ?? '');
  if (!s) return { ok: false, reason: 'empty' };
  if (s.startsWith('$$')) return { ok: true, value: `$${s.slice(2)}` };
  if (s.startsWith('$!')) return { ok: true, value: `!${s.slice(2)}` };
  if (s.startsWith('!')) {
    if (!execute) return { ok: false, reason: 'command-not-executed' };
    // ⚠️ 安全：**自动路径（会话构建）只执行"用户明确设过的"间接值**（trusted=true 由面板写入时标记）。
    // 文件里手改/迁移来的 `!命令` 不会自动跑——要跑得先在面板里确认一次（把信任边界交回用户手里）。
    if (!trusted) return { ok: false, reason: 'command-not-trusted（这条间接引用还没经你确认，面板里保存一次即可）' };
    const cmd = s.slice(1);
    // ⚠️ 安全：**绝不把凭据里的字符串交给 shell**。
    // 威胁模型：TA 自己的 write 工具能写 credentials.json（数据目录在它的工作区里）——
    // 一旦被提示注入植入 `!任意命令`，开会话时就会以用户身份执行它（等于 RCE 口子）。
    // 防线：① 只认白名单里的"凭据类"命令；② 自己切词、**argv 直传**、显式拒绝 shell 元字符；
    // ③ 文件里凭空出现的 `!命令` 要经用户确认（trusted 标记）才会执行。
    const parsed = parseCommand(cmd);
    if (!parsed.ok) return { ok: false, reason: parsed.reason };
    if (commandCache.has(cmd)) {
      const v = commandCache.get(cmd);
      return v ? { ok: true, value: v, from: 'command' } : { ok: false, reason: 'command-empty' };
    }
    try {
      const out = execFileSync(parsed.bin, parsed.args, { timeout: 8000, encoding: 'utf8' }).trim();
      commandCache.set(cmd, out);
      return out ? { ok: true, value: out, from: 'command' } : { ok: false, reason: 'command-empty' };
    } catch (e) {
      commandCache.set(cmd, '');
      return { ok: false, reason: `command-failed:${String(e?.message ?? e).slice(0, 60)}` };
    }
  }
  if (s.startsWith('${')) {
    const m = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}/.exec(s);
    if (!m) return { ok: false, reason: 'bad-syntax' };
    const v = env[m[1]];
    return v ? { ok: true, value: v, from: `env:${m[1]}` } : { ok: false, reason: `env-unset:${m[1]}` };
  }
  if (s.startsWith('$')) {
    const name = s.slice(1);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return { ok: false, reason: 'bad-syntax' };
    const v = env[name];
    return v ? { ok: true, value: v, from: `env:${name}` } : { ok: false, reason: `env-unset:${name}` };
  }
  return { ok: true, value: s, from: 'literal' };
}

// ---------- 凭据文件（0600） ----------

export function credFile(dataDir) {
  return path.join(dataDir, 'credentials.json');
}

/** 读凭据文件（不存在/损坏 → 空对象，绝不抛） */
export function readCredentials(dataDir) {
  try {
    const raw = fs.readFileSync(credFile(dataDir), 'utf8');
    const j = JSON.parse(raw);
    return j && typeof j === 'object' ? j : {};
  } catch {
    return {};
  }
}

/** 写凭据文件（0600；目录 0700） */
export function writeCredentials(dataDir, data) {
  const file = credFile(dataDir);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: CRED_DIR_MODE });
  fs.writeFileSync(file, JSON.stringify(data, null, 2), CRED_FILE_OPTS);
  try { fs.chmodSync(file, 0o600); } catch { /* 某些文件系统不支持，忽略 */ }
  return { ok: true, file };
}

/**
 * 设置/清除某个供应商的密钥（**面板入口走这里**；空 = 清除）。
 * 间接引用（`!命令`）在这里被标记为 trusted——**只有用户明确设过的间接值才会在会话构建时执行**
 * （文件里凭空出现的 `!命令` 不自动跑）。
 */
export function setCredential(dataDir, provider, rawKey) {
  const data = readCredentials(dataDir);
  const key = String(rawKey ?? '').trim();
  const trusted = data._trusted && typeof data._trusted === 'object' ? { ...data._trusted } : {};
  if (key) {
    data[provider] = key;
    if (isCommand(key)) trusted[provider] = Date.now(); // 只有 `!命令` 需要信任标记（`$ENV` 只是读环境变量）
    else delete trusted[provider];
  } else {
    delete data[provider];
    delete trusted[provider];
  }
  data._trusted = trusted;
  writeCredentials(dataDir, data);
  return { ok: true, provider, set: !!key, indirect: isIndirect(key), trusted: !!trusted[provider] };
}

/** 这个供应商的凭据是不是"用户明确设过"的（只有它才允许自动执行 `!命令`） */
export function isTrusted(dataDir, provider) {
  const data = readCredentials(dataDir);
  return !!(data._trusted && data._trusted[provider]);
}

/** 会话内**只读**检查：这个供应商现在有没有可用凭据（不执行任何命令——无副作用纪律） */
export function detectKey(dataDir, provider, { env = process.env, apiKeyEnv } = {}) {
  const creds = readCredentials(dataDir);
  if (creds[provider]) {
    const r = resolveValue(creds[provider], { execute: false, env });
    return { found: true, source: r.ok ? '本机凭据文件' : '本机凭据文件（间接引用，用时才解析）', indirect: isIndirect(creds[provider]) };
  }
  const candidates = [apiKeyEnv, ...(ENV_KEYS[provider] ?? [])].filter(Boolean);
  for (const name of candidates) {
    if (env[name]) return { found: true, source: `环境变量 ${name}`, envName: name };
  }
  // 系统钥匙串：不做——钥匙串要用户显式配 `!security …` 命令（见文件头）
  return { found: false, source: null };
}

/** 打个掩码（面板/日志里显示用）：只露头尾 */
export function maskKey(k) {
  const s = String(k ?? '');
  if (s.length <= 8) return s ? '••••' : '';
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
}
