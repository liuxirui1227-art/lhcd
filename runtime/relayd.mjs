// 灵核 · 实时中继服务（同步会面：presence + 实时流 + 邮箱 HTTP 端点）
// 零依赖（node:http）：中继只做密文中转——信封 E2EE+签名，中继不可见内容、不可伪造身份。
// 职责：
//   GET  /v1/health                     → {ok:true}
//   GET  /v1/online                     → 在线地址列表（有活跃实时流的地址）
//   POST /v1/mailboxes/:address         → 投递异步信封（追加邮箱 + 广播给在线流）
//   GET  /v1/mailboxes/:address?after=id→ 拉取异步信封（跨设备异步信件端点；after 增量拉取）
//   POST /v1/push                       → 实时消息：对方在线→SSE 推送；letter 类离线→邮箱兜底；rt 类离线→not_online
//   GET  /v1/stream/:address?token=…    → SSE 实时流（订阅令牌 = 地址身份签名，防冒领他人在线流）
// 云端移植：同代码部署（把 mailboxes 落盘换成对象存储即可），信封/契约/订阅协议不变。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createPublicKey, verify } from 'node:crypto';

const PORT = Number(process.env.LHCD_RELAY_HTTP_PORT || 8410);
const relayRoot = process.env.LHCD_RELAY_DIR || path.join(__dirname, '..', 'relay');
const mailboxesDir = path.join(relayRoot, 'mailboxes');
const TOKEN_TTL_MS = 60_000;
const HEARTBEAT_MS = 15_000;

const streams = new Map(); // address -> Set<ServerResponse>
const rooms = new Map();   // roomId -> Map<address, joinedAt>（场景房间：临时世界状态，不落盘）

/** 场景信封 canonical（与客户端 envelopeCanonical 的握手/场景分支字节一致：签 body） */
function sceneCanonical(e) {
  return JSON.stringify({ v: e.v, id: e.id, kind: e.kind, from: e.from, to: e.to, created_at: e.created_at, dh_pub: e.dh_pub, body: e.body });
}
function verifySceneEnvelope(envelope) {
  if (!envelope || envelope.v !== 1 || typeof envelope.from !== 'string' || typeof envelope.sig !== 'string') return false;
  if (!/^(scene_join|scene_leave|scene_action)$/.test(String(envelope.kind ?? ''))) return false;
  const key = ed25519KeyFromHex(envelope.from);
  if (!key) return false;
  try {
    return verify(null, Buffer.from(sceneCanonical(envelope), 'utf8'), key, Buffer.from(envelope.sig, 'base64'));
  } catch {
    return false;
  }
}
function sceneBroadcast(room, payload) {
  const members = rooms.get(room);
  if (!members) return 0;
  let n = 0;
  for (const address of members.keys()) {
    if (sseBroadcast(address, payload)) n++;
  }
  return n;
}

function ed25519KeyFromHex(hex) {
  try {
    return createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(hex, 'hex').toString('base64url') }, format: 'jwk' });
  } catch {
    return null;
  }
}
function verifySubscribeToken(address, token) {
  // token = <ts>.<sigBase64url>，sig = ed25519(`stream-subscribe|${address}|${ts}`)；防重放（60s 窗口）
  const m = /^(\d+)\.([A-Za-z0-9_-]+)$/.exec(String(token ?? ''));
  if (!m) return false;
  const ts = Number(m[1]);
  if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > TOKEN_TTL_MS) return false;
  const key = ed25519KeyFromHex(address);
  if (!key) return false;
  try {
    return verify(null, Buffer.from(`stream-subscribe|${address}|${ts}`), key, Buffer.from(m[2], 'base64url'));
  } catch {
    return false;
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', (c) => { buf += c; if (buf.length > 2_000_000) { reject(new Error('body 过大')); req.destroy(); } });
    req.on('end', () => resolve(buf));
    req.on('error', reject);
  });
}
function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}
function mailboxFile(address) {
  return path.join(mailboxesDir, `${String(address).replace(/[^0-9a-f]/g, '')}.jsonl`);
}
function appendMailbox(address, envelope) {
  fs.mkdirSync(mailboxesDir, { recursive: true });
  fs.appendFileSync(mailboxFile(address), JSON.stringify(envelope) + '\n');
}
function readMailboxAfter(address, afterId) {
  try {
    const lines = fs.readFileSync(mailboxFile(address), 'utf8').split('\n').filter(Boolean);
    const out = [];
    let seen = !afterId;
    for (const l of lines) {
      let e = null;
      try { e = JSON.parse(l); } catch { continue; }
      if (seen) out.push(e);
      if (e && e.id === afterId) seen = true;
    }
    return out;
  } catch {
    return [];
  }
}
function sseBroadcast(address, payload) {
  const subs = streams.get(address);
  if (!subs) return false;
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of subs) {
    try { res.write(data); } catch { /* 连接已断，清理交给 close 事件 */ }
  }
  return true;
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  const p = u.pathname;
  try {
    // ---- 健康检查 / 在线列表 ----
    if (p === '/v1/health') return json(res, 200, { ok: true, port: PORT });
    if (p === '/v1/online') return json(res, 200, { ok: true, addresses: [...streams.keys()] });

    // ---- 实时流（SSE）：订阅令牌验证（地址即公钥）----
    const sm = p.match(/^\/v1\/stream\/([0-9a-f]{64})$/);
    if (sm) {
      const address = sm[1];
      if (!verifySubscribeToken(address, u.searchParams.get('token') ?? '')) {
        return json(res, 401, { ok: false, error: '订阅令牌无效或已过期' });
      }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });
      res.write(`data: ${JSON.stringify({ type: 'hello', online: true })}\n\n`);
      let subs = streams.get(address);
      if (!subs) { subs = new Set(); streams.set(address, subs); }
      subs.add(res);
      const hb = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* ignore */ } }, HEARTBEAT_MS);
      const cleanup = () => {
        clearInterval(hb);
        const s = streams.get(address);
        if (s) { s.delete(res); if (s.size === 0) streams.delete(address); }
      };
      res.on('close', cleanup);
      req.on('close', cleanup);
      return;
    }

    // ---- 邮箱：投递 / 拉取 ----
    const mm = p.match(/^\/v1\/mailboxes\/([0-9a-f]{64})$/);
    if (mm && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const envelope = body?.envelope ?? body;
      if (!envelope || envelope.v !== 1 || envelope.to !== mm[1] || !envelope.sig) {
        return json(res, 400, { ok: false, error: '信封格式不符' });
      }
      appendMailbox(mm[1], envelope);
      sseBroadcast(mm[1], { type: 'mail', envelope });
      return json(res, 200, { ok: true, delivered: 'mailbox' });
    }
    if (mm && req.method === 'GET') {
      const after = u.searchParams.get('after') ?? '';
      return json(res, 200, { ok: true, envelopes: readMailboxAfter(mm[1], after) });
    }

    // ---- 实时推送 ----
    if (p === '/v1/push' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const envelope = body?.envelope ?? null;
      if (!envelope || envelope.v !== 1 || typeof envelope.to !== 'string' || !envelope.sig) {
        return json(res, 400, { ok: false, error: '信封格式不符' });
      }
      if (streams.has(envelope.to)) {
        sseBroadcast(envelope.to, { type: 'rt', envelope });
        return json(res, 200, { ok: true, delivered: 'stream' });
      }
      if (envelope.kind === 'letter') {
        appendMailbox(envelope.to, envelope);
        return json(res, 200, { ok: true, delivered: 'mailbox', note: '对方不在线，已转信箱' });
      }
      return json(res, 200, { ok: false, error: 'not_online', delivered: 'none' });
    }

    // ---- 场景房间（轻量场景服务，现场状态临时不落盘；成员 + 事件广播） ----
    const rm = p.match(/^\/v1\/rooms\/([A-Za-z0-9_-]{1,64})\/join$/);
    if (rm && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      if (!verifySubscribeToken(String(body.address ?? ''), String(body.token ?? ''))) {
        return json(res, 401, { ok: false, error: '房间令牌无效' });
      }
      let members = rooms.get(rm[1]);
      if (!members) { members = new Map(); rooms.set(rm[1], members); }
      const joined = members.has(body.address);
      members.set(body.address, Date.now());
      if (!joined) sceneBroadcast(rm[1], { type: 'scene', event: 'member_joined', room: rm[1], address: body.address });
      return json(res, 200, { ok: true, room: rm[1], members: [...members.keys()] });
    }
    const rl = p.match(/^\/v1\/rooms\/([A-Za-z0-9_-]{1,64})\/leave$/);
    if (rl && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      if (!verifySubscribeToken(String(body.address ?? ''), String(body.token ?? ''))) {
        return json(res, 401, { ok: false, error: '房间令牌无效' });
      }
      const members = rooms.get(rl[1]);
      if (members) {
        members.delete(body.address);
        if (members.size === 0) rooms.delete(rl[1]);
        sceneBroadcast(rl[1], { type: 'scene', event: 'member_left', room: rl[1], address: body.address });
      }
      return json(res, 200, { ok: true });
    }
    const re = p.match(/^\/v1\/rooms\/([A-Za-z0-9_-]{1,64})\/event$/);
    if (re && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const envelope = body?.envelope ?? null;
      if (!verifySceneEnvelope(envelope)) {
        return json(res, 401, { ok: false, error: '场景信封签名无效' });
      }
      const members = rooms.get(re[1]);
      if (!members || !members.has(envelope.from)) {
        return json(res, 403, { ok: false, error: '发送者不在该场景房间' });
      }
      const n = sceneBroadcast(re[1], { type: 'scene', event: 'action', room: re[1], envelope });
      return json(res, 200, { ok: true, delivered: n, members: [...members.keys()] });
    }
    const rg = p.match(/^\/v1\/rooms\/([A-Za-z0-9_-]{1,64})$/);
    if (rg && req.method === 'GET') {
      const members = rooms.get(rg[1]);
      return json(res, 200, { ok: true, room: rg[1], members: members ? [...members.keys()] : [] });
    }

    return json(res, 404, { ok: false, error: '未知端点' });
  } catch (e) {
    return json(res, 500, { ok: false, error: `中继异常：${e?.message ?? e}` });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`relayd 实时中继已启动：http://127.0.0.1:${PORT}（邮箱目录 ${mailboxesDir}）`);
});
