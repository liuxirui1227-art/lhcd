// 平台 API 客户端（App 内出生链路：账号 JWT / 模板卡 / 申请 / 轮询 / 下载出生包）
// 平台地址不写死——
//   解析优先级：面板保存（auth.json platformBase，出生向导「平台服务器」设置）> 环境变量 LHCD_PLATFORM_URL
//   （可写 dataDir/.env 或 ~/.lhcd/.env）> 默认本机 http://127.0.0.1:8080（开发态）
//   裸根地址（http://x:8080 或 https://api.xx.com）自动补 /index.php?r=（Yii 非 prettyUrl 路由）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.LHCD_DATA_DIR
  || (__dirname.includes('app.asar') ? path.join(os.homedir(), '.lhcd', 'data') : path.join(__dirname, 'data'));
const AUTH_FILE = path.join(DATA_DIR, 'auth.json');
const DEFAULT_BASE = 'http://127.0.0.1:8080/index.php?r=';

// 本模块自足读 .env（不依赖 lib.mjs 加载顺序）：dataDir/.env > ~/.lhcd/.env > __dirname/.env
function parseEnvFile(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const [k, ...rest] = t.split('=');
    if (k && process.env[k.trim()] === undefined) process.env[k.trim()] = rest.join('=').trim();
  }
}
parseEnvFile(path.join(DATA_DIR, '.env'));
parseEnvFile(path.join(os.homedir(), '.lhcd', '.env'));
parseEnvFile(path.join(__dirname, '.env'));
const ENV_BASE = process.env.LHCD_PLATFORM_URL || '';

/** 规范化：裸根 → 补 Yii 前缀；已是完整前缀 → 保持原样 */
function normalizeBase(b) {
  let s = String(b ?? '').trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) return s; // 非 http(s) 不进规范化（setPlatformBase 已拦；此处兜底原样返回）
  s = s.replace(/\/+$/, '');
  if (s.endsWith('?r=')) return s;               // 已是 Yii 前缀
  if (s.includes('index.php')) return s + 'r=';  // 已是 index.php 路由但缺 ?r= 尾
  return s + '/index.php?r=';                    // 裸根：自动补
}

function readAuth() {
  try { return JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8')); } catch { return {}; }
}
function writeAuth(a) {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(AUTH_FILE, JSON.stringify(a, null, 2)); } catch { /* 忽略 */ }
}
export function authGet() { return readAuth(); }
export function authSave(patch) { writeAuth({ ...readAuth(), ...patch }); return readAuth(); }

/** 当前生效平台前缀（含 ?r= 结尾） */
export function platformBase() {
  return normalizeBase(readAuth().platformBase) || normalizeBase(ENV_BASE) || DEFAULT_BASE;
}

/** 当前平台信息（出生向导展示用） */
export function platformInfo() {
  const saved = readAuth().platformBase;
  return {
    base: platformBase(),
    source: saved ? 'panel' : (ENV_BASE ? 'env' : 'default'),
  };
}

/** 面板保存平台地址（存 auth.json；立即生效——后续所有请求走新地址） */
export function setPlatformBase(base) {
  const b = String(base ?? '').trim();
  if (!b) return { ok: false, error: '平台地址不能为空' };
  if (!/^https?:\/\//i.test(b)) return { ok: false, error: '平台地址必须以 http:// 或 https:// 开头' };
  const saved = readAuth();
  writeAuth({ ...saved, platformBase: normalizeBase(b) });
  return { ok: true, base: platformBase() };
}

/** 连通性测试：对指定（或当前）地址发一次模板请求，10s 超时；不落盘 */
export async function testBase(base) {
  const b = normalizeBase(base) || platformBase();
  try {
    const res = await fetch(b + 'apply/templates', {
      signal: AbortSignal.timeout(10000),
      headers: { Accept: 'application/json' },
    });
    if (res.ok) return { ok: true, note: '连接正常（HTTP ' + res.status + '）' };
    const t = await res.text().catch(() => '');
    return { ok: false, error: 'HTTP ' + res.status + '：' + t.slice(0, 120) };
  } catch (e) {
    return { ok: false, error: '连不上：' + (e?.name === 'TimeoutError' ? '请求超时（10 秒）' : e.message) };
  }
}

/** 平台 API 基础调用：base 以 ?r= 结尾（Yii 非 prettyUrl 路由）。返回 {ok, status, data} */
export async function api(r, { method = 'GET', body = null, token = null, timeoutMs = 15000 } = {}) {
  const url = platformBase() + r;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      signal: ctrl.signal,
      headers: {
        ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
      },
      body: body
        ? new URLSearchParams(Object.entries(body).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)])).toString()
        : undefined,
    });
    let data = null;
    try { data = await res.json(); } catch { /* 非 JSON（如文件流） */ }
    return { ok: res.ok, status: res.status, data };
  } catch (e) {
    return { ok: false, status: 0, data: { error: '连不上平台服务器：' + (e?.name === 'AbortError' ? '请求超时' : e.message) } };
  } finally {
    clearTimeout(timer);
  }
}

export const register = (email, password) => api('auth/register', { method: 'POST', body: { email, password } });
export const login = (email, password) => api('auth/login', { method: 'POST', body: { email, password } });
export const me = (token) => api('auth/me', { token });
export const templates = () => api('apply/templates');
export const apply = (token, selections) => api('apply/create', { method: 'POST', token, body: { selections } });

/** 轮询直到 ready/failed（最长 90s；dev 队列内联一般几秒） */
export async function waitReady(token, id) {
  for (let i = 0; i < 45; i++) {
    const r = await api(`apply/status&id=${encodeURIComponent(id)}`, { token });
    if (!r.ok) return { ok: false, error: r.data?.error ?? '状态查询失败' };
    if (r.data.status === 'ready') return { ok: true, ready: true };
    if (r.data.status === 'failed') return { ok: false, error: r.data.error ?? '出生包生成失败' };
    await new Promise((res) => setTimeout(res, 2000));
  }
  return { ok: false, error: '等待出生包超时（90 秒），请稍后重试' };
}

/** 下载出生包 → 返回 JSON 对象 */
export async function downloadPackage(token, id) {
  const url = platformBase() + `apply/download&id=${encodeURIComponent(id)}`;
  try {
    const res = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
    if (!res.ok) return { ok: false, error: '下载失败 HTTP ' + res.status };
    const text = await res.text();
    try {
      return { ok: true, pkg: JSON.parse(text) };
    } catch {
      return { ok: false, error: '出生包内容不是合法 JSON' };
    }
  } catch (e) {
    return { ok: false, error: '下载失败：' + e.message };
  }
}
