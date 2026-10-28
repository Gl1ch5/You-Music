// You Music server: optional account, cloud sync, AI recommendations with a daily limit and a free proxy.
// No dependencies: Node 22+. All secrets (AI key, upstream) come from the environment, never from the repo.
import { createServer } from 'node:http';
import net from 'node:net';
import dns from 'node:dns/promises';
import { randomBytes, scrypt as scryptCb, timingSafeEqual, createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile, rm } from 'node:fs/promises';
import { promisify } from 'node:util';
import path from 'node:path';

const scrypt = promisify(scryptCb);
const env = process.env;
const PORT = Number(env.PORT ?? 8740);
const HOST = env.HOST ?? '127.0.0.1';
const PROXY_PORT = Number(env.PROXY_PORT ?? 20140);
const PROXY_HOST = env.PROXY_PUBLIC_HOST ?? '';
const DATA = env.DATA_DIR ?? path.resolve('data');
const AI_BASE = (env.AI_BASE_URL ?? '').replace(/\/+$/, '');
const AI_KEY = env.AI_API_KEY ?? '';
const AI_MODEL = env.AI_MODEL ?? '';
const AI_DAILY = Number(env.AI_DAILY_LIMIT ?? 50);
const PROXY_MAX_CONN = Number(env.PROXY_MAX_CONNECTIONS ?? 48);
const SYNC_MAX = 25 * 1024 * 1024;
const TOKEN_TTL = 365 * 24 * 3600 * 1000;

/* ───────── Storage: one JSON file for accounts, one file per user for the library ───────── */

const dbFile = path.join(DATA, 'db.json');
let db = { users: {}, tokens: {}, usage: {} };
let saving = Promise.resolve();

async function load() {
  await mkdir(path.join(DATA, 'sync'), { recursive: true, mode: 0o700 });
  try {
    db = { users: {}, tokens: {}, usage: {}, ...JSON.parse(await readFile(dbFile, 'utf8')) };
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
}

function save() {
  saving = saving.then(async () => {
    const tmp = `${dbFile}.tmp`;
    await writeFile(tmp, JSON.stringify(db), { mode: 0o600 });
    await rename(tmp, dbFile);
  }).catch((e) => console.error('save failed', e));
  return saving;
}

const syncFile = (user) => path.join(DATA, 'sync', `${user.id}.json`);
const hashToken = (t) => createHash('sha256').update(t).digest('hex');

/* ───────── Helpers ───────── */

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function send(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(text);
}

async function readBody(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'too_large', 'Слишком большой запрос');
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new HttpError(400, 'bad_request', 'Неверный JSON');
  }
}

function clientIp(req) {
  return String(req.headers['x-real-ip'] ?? req.socket.remoteAddress ?? '');
}

/** Moscow date, so the daily AI limit resets at local midnight for the app's users. */
const today = () => new Date(Date.now() + 3 * 3600 * 1000).toISOString().slice(0, 10);

const attempts = new Map();
function rateLimit(key, max, windowMs) {
  const now = Date.now();
  const list = (attempts.get(key) ?? []).filter((t) => now - t < windowMs);
  if (list.length >= max) throw new HttpError(429, 'rate_limited', 'Слишком много попыток, подождите немного');
  list.push(now);
  attempts.set(key, list);
}
setInterval(() => {
  const now = Date.now();
  for (const [k, list] of attempts) if (!list.some((t) => now - t < 3600_000)) attempts.delete(k);
}, 600_000).unref();

async function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  const key = await scrypt(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return { salt, hash: key.toString('hex') };
}

function publicUser(user) {
  const usage = db.usage[user.id];
  const used = usage?.day === today() ? usage.count : 0;
  return {
    login: user.login,
    createdAt: user.createdAt,
    syncedAt: user.syncedAt ?? 0,
    ai: { enabled: !!(AI_BASE && AI_MODEL), limit: AI_DAILY, left: Math.max(0, AI_DAILY - used) },
    proxy: PROXY_HOST ? { type: 'http', host: PROXY_HOST, port: PROXY_PORT, user: user.login, pass: user.proxyToken } : null,
  };
}

function issueToken(user) {
  const token = randomBytes(32).toString('base64url');
  db.tokens[hashToken(token)] = { userId: user.id, createdAt: Date.now() };
  return token;
}

function auth(req) {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? '');
  const entry = m && db.tokens[hashToken(m[1])];
  if (!entry || Date.now() - entry.createdAt > TOKEN_TTL) throw new HttpError(401, 'unauthorized', 'Войдите в аккаунт заново');
  const user = Object.values(db.users).find((u) => u.id === entry.userId);
  if (!user) throw new HttpError(401, 'unauthorized', 'Аккаунт не найден');
  return { user, tokenHash: hashToken(m[1]) };
}

const LOGIN_RE = /^[a-z0-9_.-]{3,32}$/;

/* ───────── API ───────── */

const routes = {
  'GET /api/health': async () => ({ ok: true, ai: !!(AI_BASE && AI_MODEL), proxy: !!PROXY_HOST }),

  'POST /api/register': async (req) => {
    rateLimit(`reg:${clientIp(req)}`, 5, 3600_000);
    const { login, password } = await readBody(req, 4096);
    const name = String(login ?? '').trim().toLowerCase();
    if (!LOGIN_RE.test(name)) throw new HttpError(400, 'bad_login', 'Логин: 3–32 символа, латиница, цифры, «_», «.», «-»');
    if (typeof password !== 'string' || password.length < 6 || password.length > 200) throw new HttpError(400, 'bad_password', 'Пароль — не короче 6 символов');
    if (db.users[name]) throw new HttpError(409, 'taken', 'Такой логин уже занят');
    const user = { id: randomBytes(12).toString('hex'), login: name, ...(await hashPassword(password)), createdAt: Date.now(), proxyToken: randomBytes(18).toString('base64url') };
    db.users[name] = user;
    const token = issueToken(user);
    await save();
    return { token, user: publicUser(user) };
  },

  'POST /api/login': async (req) => {
    rateLimit(`login:${clientIp(req)}`, 20, 600_000);
    const { login, password } = await readBody(req, 4096);
    const name = String(login ?? '').trim().toLowerCase();
    const user = db.users[name];
    const check = await hashPassword(String(password ?? ''), user?.salt ?? 'x'.repeat(32));
    if (!user || !timingSafeEqual(Buffer.from(check.hash, 'hex'), Buffer.from(user.hash, 'hex'))) {
      throw new HttpError(401, 'wrong_password', 'Неверный логин или пароль');
    }
    const token = issueToken(user);
    await save();
    return { token, user: publicUser(user) };
  },

  'POST /api/logout': async (req) => {
    const { tokenHash } = auth(req);
    delete db.tokens[tokenHash];
    await save();
    return { ok: true };
  },

  'GET /api/me': async (req) => publicUser(auth(req).user),

  'POST /api/password': async (req) => {
    const { user } = auth(req);
    const { password } = await readBody(req, 4096);
    if (typeof password !== 'string' || password.length < 6 || password.length > 200) throw new HttpError(400, 'bad_password', 'Пароль — не короче 6 символов');
    Object.assign(user, await hashPassword(password));
    for (const [h, t] of Object.entries(db.tokens)) if (t.userId === user.id) delete db.tokens[h];
    const token = issueToken(user);
    await save();
    return { token };
  },

  'DELETE /api/account': async (req) => {
    const { user } = auth(req);
    delete db.users[user.login];
    delete db.usage[user.id];
    for (const [h, t] of Object.entries(db.tokens)) if (t.userId === user.id) delete db.tokens[h];
    await rm(syncFile(user), { force: true });
    await save();
    return { ok: true };
  },

  /** The library is an opaque backup JSON written by the app; the server never looks inside. */
  'GET /api/sync': async (req) => {
    const { user } = auth(req);
    try {
      return { updatedAt: user.syncedAt ?? 0, data: await readFile(syncFile(user), 'utf8') };
    } catch (e) {
      if (e.code === 'ENOENT') return { updatedAt: 0, data: null };
      throw e;
    }
  },

  'PUT /api/sync': async (req) => {
    const { user } = auth(req);
    rateLimit(`sync:${user.id}`, 120, 3600_000);
    const { data } = await readBody(req, SYNC_MAX);
    if (typeof data !== 'string') throw new HttpError(400, 'bad_request', 'Нет данных');
    const tmp = `${syncFile(user)}.tmp`;
    await writeFile(tmp, data, { mode: 0o600 });
    await rename(tmp, syncFile(user));
    user.syncedAt = Date.now();
    await save();
    return { updatedAt: user.syncedAt };
  },

  /** OpenAI-compatible chat, limited per user per day. The model and key live only here. */
  'POST /api/ai/chat': async (req) => {
    const { user } = auth(req);
    if (!AI_BASE || !AI_MODEL) throw new HttpError(503, 'ai_off', 'Нейросеть на сервере выключена');
    const { messages, temperature } = await readBody(req, 64 * 1024);
    if (!Array.isArray(messages) || !messages.length || messages.length > 20) throw new HttpError(400, 'bad_request', 'Неверный запрос');
    const clean = messages.map((m) => ({ role: ['system', 'user', 'assistant'].includes(m?.role) ? m.role : 'user', content: String(m?.content ?? '').slice(0, 16000) }));
    const day = today();
    const usage = db.usage[user.id]?.day === day ? db.usage[user.id] : { day, count: 0 };
    if (usage.count >= AI_DAILY) throw new HttpError(429, 'ai_limit', `На сегодня нейро-подборки закончились (${AI_DAILY} в день). Завтра лимит обновится.`);
    usage.count++;
    db.usage[user.id] = usage;
    save();
    try {
      const r = await fetch(`${AI_BASE}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(AI_KEY ? { authorization: `Bearer ${AI_KEY}` } : {}) },
        body: JSON.stringify({ model: AI_MODEL, messages: clean, temperature: Math.min(1.5, Math.max(0, Number(temperature ?? 0.9))) }),
        signal: AbortSignal.timeout(90_000),
      });
      const json = await r.json().catch(() => null);
      const content = json?.choices?.[0]?.message?.content;
      if (!r.ok || typeof content !== 'string') throw new Error(`upstream ${r.status}`);
      return { content, left: AI_DAILY - usage.count };
    } catch (e) {
      // A failed request does not count.
      usage.count = Math.max(0, usage.count - 1);
      save();
      console.error('ai failed', e.message);
      throw new HttpError(502, 'ai_failed', 'Нейросеть не ответила, попробуйте ещё раз');
    }
  },
};

const PREFIX = env.BASE_PATH ?? '';

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  let p = url.pathname;
  if (PREFIX && p.startsWith(PREFIX)) p = p.slice(PREFIX.length) || '/';
  const handler = routes[`${req.method} ${p}`];
  try {
    if (!handler) throw new HttpError(404, 'not_found', 'Нет такого адреса');
    send(res, 200, await handler(req));
  } catch (e) {
    if (e instanceof HttpError) send(res, e.status, { error: e.code, message: e.message });
    else {
      console.error(e);
      send(res, 500, { error: 'server', message: 'Ошибка сервера' });
    }
  }
});

/* ───────── Free proxy: HTTP CONNECT, only for accounts, never to this machine or private networks ───────── */

const open = new Map();

function isPrivate(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
  }
  const v = ip.toLowerCase();
  if (v.startsWith('::ffff:')) return isPrivate(v.slice(7));
  return v === '::' || v === '::1' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80');
}

const SELF = new Set((env.SELF_IPS ?? '').split(',').map((s) => s.trim()).filter(Boolean));

function proxyUser(header) {
  const m = /^Basic (.+)$/i.exec(header ?? '');
  if (!m) return null;
  const [login, pass] = Buffer.from(m[1], 'base64').toString('utf8').split(':');
  const user = db.users[login?.toLowerCase()];
  if (!user || !pass) return null;
  const a = Buffer.from(user.proxyToken);
  const b = Buffer.from(pass);
  return a.length === b.length && timingSafeEqual(a, b) ? user : null;
}

function reject(socket, status, text) {
  socket.end(`HTTP/1.1 ${status} ${text}\r\n${status === 407 ? 'Proxy-Authenticate: Basic realm="youmusic"\r\n' : ''}Content-Length: 0\r\n\r\n`);
}

const proxy = createServer((req, res) => {
  // Plain-HTTP forwarding is not offered: everything the app needs is HTTPS through CONNECT.
  res.writeHead(405).end();
});
proxy.on('connect', async (req, socket, head) => {
  socket.on('error', () => undefined);
  const user = proxyUser(req.headers['proxy-authorization']);
  if (!user) return reject(socket, 407, 'Proxy Authentication Required');
  const [host, portText] = (req.url ?? '').split(/:(?=\d+$)/);
  const port = Number(portText);
  if (!host || !(port === 443 || port === 80)) return reject(socket, 403, 'Forbidden');
  const count = open.get(user.id) ?? 0;
  if (count >= PROXY_MAX_CONN) return reject(socket, 429, 'Too Many Connections');
  let ip;
  try {
    ip = net.isIP(host) ? host : (await dns.lookup(host)).address;
  } catch {
    return reject(socket, 502, 'Bad Gateway');
  }
  if (isPrivate(ip) || SELF.has(ip)) return reject(socket, 403, 'Forbidden');
  open.set(user.id, count + 1);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    const n = (open.get(user.id) ?? 1) - 1;
    if (n > 0) open.set(user.id, n);
    else open.delete(user.id);
  };
  const upstream = net.connect({ host: ip, port }, () => {
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head?.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  upstream.setTimeout(120_000, () => upstream.destroy());
  upstream.on('error', () => {
    if (!socket.destroyed) reject(socket, 502, 'Bad Gateway');
  });
  upstream.on('close', () => {
    release();
    socket.destroy();
  });
  socket.on('close', () => {
    release();
    upstream.destroy();
  });
});

await load();
server.listen(PORT, HOST, () => console.log(`api on ${HOST}:${PORT}`));
if (PROXY_HOST) proxy.listen(PROXY_PORT, '0.0.0.0', () => console.log(`proxy on :${PROXY_PORT}`));
