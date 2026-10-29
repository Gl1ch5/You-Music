// You Music server: optional account, cloud sync, AI recommendations with a daily limit, a free proxy,
// import from Telegram (bot), shared track pages and a public site with stats.
// No dependencies: Node 22+. All secrets (AI key, upstream) come from the environment, never from the repo.
import { createServer } from 'node:http';
import net from 'node:net';
import dns from 'node:dns/promises';
import { randomBytes, scrypt as scryptCb, timingSafeEqual, createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile, rm, stat } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
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
/** Quick model for "fast" recommendations; the main one when unset. */
const AI_MODEL_FAST = env.AI_MODEL_FAST || AI_MODEL;
const TG_TOKEN = env.TELEGRAM_BOT_TOKEN ?? '';
const TG_BOT = env.TELEGRAM_BOT_NAME ?? 'Youmusikks_bot';
const TG_MAX_FILES = Number(env.TELEGRAM_MAX_FILES ?? 500);
const AI_DAILY = Number(env.AI_DAILY_LIMIT ?? 50);
const PROXY_MAX_CONN = Number(env.PROXY_MAX_CONNECTIONS ?? 48);
const SYNC_MAX = 25 * 1024 * 1024;
const TOKEN_TTL = 365 * 24 * 3600 * 1000;

/* ───────── Storage: one JSON file for accounts, one file per user for the library ───────── */

const dbFile = path.join(DATA, 'db.json');
let db = { users: {}, tokens: {}, usage: {}, tg: { chats: {}, codes: {}, tracks: {}, offset: 0 }, stats: { aiDays: {} } };
let saving = Promise.resolve();

async function load() {
  await mkdir(path.join(DATA, 'sync'), { recursive: true, mode: 0o700 });
  await mkdir(path.join(DATA, 'tg'), { recursive: true, mode: 0o700 });
  try {
    db = { ...db, ...JSON.parse(await readFile(dbFile, 'utf8')) };
    db.tg = { chats: {}, codes: {}, tracks: {}, offset: 0, ...db.tg };
    db.stats = { aiDays: {}, ...db.stats };
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
  // Day precision is enough for the "active this week" number on the site.
  if (Date.now() - (user.seenAt ?? 0) > 3600_000) user.seenAt = Date.now();
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
    const { messages, temperature, tier } = await readBody(req, 64 * 1024);
    const model = tier === 'deep' ? AI_MODEL : AI_MODEL_FAST;
    if (!Array.isArray(messages) || !messages.length || messages.length > 20) throw new HttpError(400, 'bad_request', 'Неверный запрос');
    const clean = messages.map((m) => ({ role: ['system', 'user', 'assistant'].includes(m?.role) ? m.role : 'user', content: String(m?.content ?? '').slice(0, 16000) }));
    const day = today();
    const usage = db.usage[user.id]?.day === day ? db.usage[user.id] : { day, count: 0 };
    if (usage.count >= AI_DAILY) throw new HttpError(429, 'ai_limit', `На сегодня запросы к нейросети закончились (${AI_DAILY} в день). Завтра лимит обновится, а рекомендации пока подбираются без неё.`);
    usage.count++;
    db.usage[user.id] = usage;
    save();
    try {
      const r = await fetch(`${AI_BASE}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(AI_KEY ? { authorization: `Bearer ${AI_KEY}` } : {}) },
        body: JSON.stringify({ model, messages: clean, temperature: Math.min(1.5, Math.max(0, Number(temperature ?? 0.9))) }),
        signal: AbortSignal.timeout(90_000),
      });
      const json = await r.json().catch(() => null);
      const content = json?.choices?.[0]?.message?.content;
      if (!r.ok || typeof content !== 'string') throw new Error(`upstream ${r.status}`);
      db.stats.aiDays[day] = (db.stats.aiDays[day] ?? 0) + 1;
      return { content, left: AI_DAILY - usage.count };
    } catch (e) {
      // A failed request does not count.
      usage.count = Math.max(0, usage.count - 1);
      save();
      console.error('ai failed', e.message);
      throw new HttpError(502, 'ai_failed', 'Нейросеть не ответила, попробуйте ещё раз');
    }
  },

  /** Public numbers for the site: nothing about any single person. */
  'GET /api/stats': async () => stats(),

  /** A one-time code that links a Telegram chat to this account: t.me/<bot>?start=<code>. */
  'POST /api/tg/link': async (req) => {
    const { user } = auth(req);
    if (!TG_TOKEN) throw new HttpError(503, 'tg_off', 'Импорт из Telegram сейчас выключен');
    rateLimit(`tglink:${user.id}`, 20, 3600_000);
    for (const [c, v] of Object.entries(db.tg.codes)) if (v.userId === user.id || v.until < Date.now()) delete db.tg.codes[c];
    const code = randomBytes(9).toString('base64url');
    db.tg.codes[code] = { userId: user.id, until: Date.now() + 15 * 60_000 };
    await save();
    return { code, url: `https://t.me/${TG_BOT}?start=${code}`, linked: Object.values(db.tg.chats).includes(user.id) };
  },

  'GET /api/tg/tracks': async (req) => {
    const { user } = auth(req);
    return { linked: Object.values(db.tg.chats).includes(user.id), bot: TG_BOT, tracks: (db.tg.tracks[user.id] ?? []).map(publicTgTrack) };
  },
};

/** Routes with an id in the path. Files and covers are addressed by long random ids. */
const paramRoutes = [
  [/^GET \/api\/tg\/file\/([\w-]{16,40})$/, async (req, res, id) => {
    const { user } = auth(req);
    const t = (db.tg.tracks[user.id] ?? []).find((x) => x.id === id);
    if (!t) throw new HttpError(404, 'not_found', 'Файл не найден');
    await sendFile(res, tgPath(user.id, t.file), t.mime || 'audio/mpeg');
  }],
  [/^GET \/api\/tg\/cover\/([\w-]{16,40})$/, async (req, res, id) => {
    for (const [userId, list] of Object.entries(db.tg.tracks)) {
      const t = list.find((x) => x.id === id && x.cover);
      if (t) return sendFile(res, tgPath(userId, t.cover), 'image/jpeg', 'public, max-age=604800');
    }
    throw new HttpError(404, 'not_found', 'Обложки нет');
  }],
  [/^DELETE \/api\/tg\/tracks\/([\w-]{16,40})$/, async (req, res, id) => {
    const { user } = auth(req);
    const list = db.tg.tracks[user.id] ?? [];
    const t = list.find((x) => x.id === id);
    if (!t) throw new HttpError(404, 'not_found', 'Трек не найден');
    db.tg.tracks[user.id] = list.filter((x) => x !== t);
    await rm(tgPath(user.id, t.file), { force: true });
    if (t.cover) await rm(tgPath(user.id, t.cover), { force: true });
    await save();
    send(res, 200, { ok: true });
  }],
  [/^GET \/t\/([\w-]{6,20})$/, async (req, res, id) => sendHtml(res, trackPage(id))],
  [/^GET \/(?:index\.html)?$/, async (req, res) => sendHtml(res, sitePage(stats()))],
  [/^GET \/terms$/, async (req, res) => sendHtml(res, termsPage())],
];

/* ───────── Stats and pages ───────── */

function stats() {
  const day = today();
  const users = Object.values(db.users);
  const now = Date.now();
  const since = (ms) => (t) => (t ?? 0) > now - ms;
  // Accounts at the end of each of the last 30 days, for the growth chart.
  const growth = [];
  const start = new Date(); start.setHours(0, 0, 0, 0);
  for (let i = 29; i >= 0; i--) {
    const end = start.getTime() - (i - 1) * 86400_000;
    growth.push(users.filter((u) => (u.createdAt ?? 0) < end).length);
  }
  return {
    users: users.length,
    newToday: users.filter((u) => since(86400_000)(u.createdAt)).length,
    newWeek: users.filter((u) => since(7 * 86400_000)(u.createdAt)).length,
    activeDay: users.filter((u) => since(86400_000)(u.seenAt)).length,
    activeWeek: users.filter((u) => since(7 * 86400_000)(u.seenAt)).length,
    synced: users.filter((u) => u.syncedAt).length,
    aiToday: db.stats.aiDays[day] ?? 0,
    aiTotal: Object.values(db.stats.aiDays).reduce((a, b) => a + b, 0),
    tgTracks: Object.values(db.tg.tracks).reduce((a, l) => a + l.length, 0),
    growth,
    ai: !!(AI_BASE && AI_MODEL),
    proxy: !!PROXY_HOST,
    telegram: !!TG_TOKEN,
  };
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function sendHtml(res, html) {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache', 'content-security-policy': "default-src 'none'; img-src 'self' https://i.ytimg.com; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'" });
  res.end(html);
}

const RELEASES = 'https://github.com/Gl1ch5/You-Music/releases/latest';
const NIGHTLY = 'https://github.com/Gl1ch5/You-Music/releases/download/nightly';

/** Inline SVG icons for the site (24px grid, stroke 1.5, currentColor — like the app). */
const ICONS = {
  play: '<path d="M8 5.5v13l10.5-6.5z"/>',
  android: '<path d="M7 10h10v7.5a1.5 1.5 0 0 1-1.5 1.5h-7A1.5 1.5 0 0 1 7 17.5zM7 9a5 5 0 0 1 10 0M9.5 6.5 8 4.5m6.5 2 1.5-2M4.5 11v4.5m15-4.5v4.5"/>',
  windows: '<path d="M4 6.5 10.5 5.6v5.9H4zm0 11L10.5 18.4v-5.9H4zm7.5-12 8.5-1.2v7.2h-8.5zm0 13 8.5 1.2v-7.2h-8.5z"/>',
  linux: '<path d="M12 3.5c-2 0-3 1.7-3 4 0 1.5-.6 2.6-1.6 4.1C6.3 13.2 5.5 15 6 16.6M12 3.5c2 0 3 1.7 3 4 0 1.5.6 2.6 1.6 4.1 1.1 1.6 1.9 3.4 1.4 5M8 20.5c1.2-.6 2.6-.9 4-.9s2.8.3 4 .9M10.5 8h.01M13.5 8h.01M11 10.5h2"/>',
  telegram: '<path d="M20.5 4.5 3.5 11l5.5 2 2 6 3-3.5 4.5 3.5zM9 13l8-5.5"/>',
  wave: '<path d="M3 12h2m2-4v8m4-11v14m4-10v6m4-3h2"/>',
  lyrics: '<path d="M4 6h11M4 10h16M4 14h9M4 18h13"/>',
  download: '<path d="M12 4v11m-4.5-4.5L12 15l4.5-4.5M5 19.5h14"/>',
  swap: '<path d="M7 7h12l-3.5-3.5M17 17H5l3.5 3.5"/>',
  palette: '<path d="M12 3.5a8.5 8.5 0 1 0 0 17c1 0 1.5-.7 1.5-1.5s-.6-1.2-.6-2 .6-1.5 1.6-1.5h2a4 4 0 0 0 4-4c0-4.4-3.8-8-8.5-8z"/><circle cx="8" cy="11" r="1"/><circle cx="11" cy="7.5" r="1"/><circle cx="15.5" cy="8.5" r="1"/>',
  cloud: '<path d="M7 18.5a4.5 4.5 0 0 1-.6-9 6 6 0 0 1 11.5 1.5 3.75 3.75 0 0 1-.4 7.5z"/>',
};
const ico = (name) => `<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`;

function page(title, body, { head = '', wide = false } = {}) {
  const icon = `${PREFIX}/app/icons/icon-192.png`;
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<link rel="icon" type="image/png" sizes="32x32" href="${PREFIX}/app/icons/icon-32.png"><link rel="icon" type="image/png" sizes="192x192" href="${icon}"><link rel="apple-touch-icon" href="${PREFIX}/app/icons/apple-touch.png">
<meta name="theme-color" content="#0b0c10"><meta property="og:title" content="${esc(title)}"><meta property="og:image" content="https://grzxk.ru${PREFIX}/app/icons/icon-512.png">${head}
<style>
:root{--bg:#0b0c10;--surface:#14161c;--surface-2:#1b1e26;--text:#eef0f4;--text-2:#9aa1ad;--accent:#7ea6ff;--accent-2:#b48cff;--on-accent:#0b0c10;--line:#262a33;--glow:rgba(110,140,255,.22);color-scheme:dark}
@media (prefers-color-scheme:light){:root{--bg:#f6f6f9;--surface:#fff;--surface-2:#f0f1f6;--text:#14161b;--text-2:#5c6370;--accent:#3d6bff;--accent-2:#8a4dff;--on-accent:#fff;--line:#e3e5ec;--glow:rgba(70,110,255,.16);color-scheme:light}}
*{box-sizing:border-box}html{scroll-behavior:smooth}
body{margin:0;background:var(--bg);color:var(--text);font:16px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased;overflow-x:hidden}
body::before{content:"";position:fixed;inset:-20vh -20vw auto;height:80vh;background:radial-gradient(40% 50% at 30% 30%,var(--glow),transparent 70%),radial-gradient(35% 45% at 75% 20%,rgba(180,140,255,.14),transparent 70%);pointer-events:none;z-index:-1}
main{max-width:${wide ? 1040 : 720}px;margin:0 auto;padding:32px 16px 64px}
h1{font-size:clamp(34px,6vw,56px);line-height:1.05;margin:0 0 14px;letter-spacing:-.03em}h2{font-size:24px;letter-spacing:-.01em;margin:56px 0 16px}
p{color:var(--text-2);margin:0 0 12px}a{color:var(--text)}
.i{width:20px;height:20px;fill:none;stroke:currentColor;stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round;flex:none}
.brand{display:flex;align-items:center;gap:10px;font-weight:700;text-decoration:none;margin-bottom:48px}.brand img{width:36px;height:36px;border-radius:10px}
.grad{background:linear-gradient(90deg,var(--accent),var(--accent-2));-webkit-background-clip:text;background-clip:text;color:transparent}
.lead{font-size:clamp(17px,2.2vw,20px);max-width:620px}
.hero{display:grid;grid-template-columns:1.2fr .8fr;gap:32px;align-items:center}
.hero-art{justify-self:center;width:min(280px,70vw);aspect-ratio:1;border-radius:22.5%;box-shadow:0 30px 80px var(--glow),0 0 0 1px var(--line);animation:float 6s ease-in-out infinite}
@keyframes float{50%{transform:translateY(-10px) rotate(-2deg)}}
@media (prefers-reduced-motion:reduce){.hero-art{animation:none}}
@media (max-width:760px){.hero{grid-template-columns:1fr}.hero-art{grid-row:1;width:140px}.brand{margin-bottom:28px}}
.actions{display:flex;flex-wrap:wrap;gap:10px;margin-top:24px}
.btn{display:inline-flex;align-items:center;gap:8px;padding:12px 20px;border-radius:999px;background:var(--accent);color:var(--on-accent);text-decoration:none;font-weight:600;transition:transform .12s,opacity .12s}
.btn:hover{transform:translateY(-1px)}.btn:active{transform:scale(.97)}
.btn.ghost{background:var(--surface);color:var(--text);border:1px solid var(--line)}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px}
.card{background:var(--surface);border:1px solid var(--line);border-radius:20px;padding:18px}
.stat b{display:block;font-size:34px;line-height:1.1;font-variant-numeric:tabular-nums;letter-spacing:-.02em}.stat span{color:var(--text-2);font-size:14px}
.stat small{display:inline-block;margin-top:6px;font-size:13px;color:var(--accent);font-weight:600}
.chart{margin-top:12px;padding:18px 18px 10px}.chart svg{display:block;width:100%;height:160px}.chart .row{display:flex;justify-content:space-between;color:var(--text-2);font-size:13px}
.feat .i{width:28px;height:28px;color:var(--accent);margin-bottom:10px}.feat h3{margin:0 0 4px;font-size:17px}.feat p{margin:0;font-size:15px}
.dl{display:grid;grid-template-columns:repeat(auto-fit,minmax(185px,1fr));gap:12px}.grid.three{grid-template-columns:repeat(auto-fit,minmax(260px,1fr))}
.dl a{display:flex;align-items:center;gap:14px;text-decoration:none}.dl .i{width:30px;height:30px;color:var(--accent)}.dl b{display:block}.dl span{color:var(--text-2);font-size:14px}
.dl a:hover{border-color:var(--accent)}
img.cover{width:100%;max-width:360px;aspect-ratio:1;object-fit:cover;border-radius:20px;display:block;margin:0 0 20px}li{color:var(--text-2);margin-bottom:6px}
footer{margin-top:64px;padding-top:20px;border-top:1px solid var(--line);font-size:14px;color:var(--text-2)}footer a{color:var(--text-2)}
</style></head><body><main><a class="brand" href="${PREFIX}/"><img src="${icon}" alt="">You Music</a>${body}
<footer><a href="${PREFIX}/">You Music</a> · <a href="${PREFIX}/app/">Веб-плеер</a> · <a href="${PREFIX}/terms">Соглашение</a> · <a href="https://github.com/Gl1ch5/You-Music">Исходный код</a></footer></main></body></html>`;
}

function growthChart(series) {
  const w = 600, h = 160, pad = 6;
  const max = Math.max(1, ...series), min = Math.min(...series);
  const span = Math.max(1, max - min);
  const pts = series.map((v, i) => [pad + (i * (w - 2 * pad)) / (series.length - 1), h - pad - ((v - min) / span) * (h - 2 * pad - 10)]);
  const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join('');
  const area = `${line}L${pts.at(-1)[0].toFixed(1)} ${h}L${pts[0][0].toFixed(1)} ${h}Z`;
  const [lx, ly] = pts.at(-1);
  return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="Рост аккаунтов за 30 дней">
<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--accent)" stop-opacity=".35"/><stop offset="1" stop-color="var(--accent)" stop-opacity="0"/></linearGradient></defs>
<path d="${area}" fill="url(#g)"/><path d="${line}" fill="none" stroke="var(--accent)" stroke-width="2.5" vector-effect="non-scaling-stroke" stroke-linejoin="round"/>
<circle cx="${lx.toFixed(1)}" cy="${ly.toFixed(1)}" r="4" fill="var(--accent)"/></svg>`;
}

function sitePage(s) {
  const n = (v) => Number(v).toLocaleString('ru-RU');
  const stat = (v, label, extra = '') => `<div class="card stat"><b data-n="${v}">${n(v)}</b><span>${label}</span>${extra ? `<br><small>${extra}</small>` : ''}</div>`;
  const feat = (icon, title, text) => `<div class="card feat">${ico(icon)}<h3>${title}</h3><p>${text}</p></div>`;
  const dl = (href, icon, title, sub) => `<a class="card" href="${href}">${ico(icon)}<div><b>${title}</b><span>${sub}</span></div></a>`;
  return page('You Music — музыка с YouTube без рекламы', `
<section class="hero"><div>
<h1>Вся музыка YouTube.<br><span class="grad">Без рекламы.</span></h1>
<p class="lead">Плеер для Android, браузера, Windows и Linux: поиск и воспроизведение без аккаунта, бесконечные рекомендации под ваш вкус, тексты песен, офлайн и перенос из Spotify, Яндекс Музыки и Telegram.</p>
<div class="actions"><a class="btn" href="${PREFIX}/app/">${ico('play')}Открыть веб-плеер</a><a class="btn ghost" href="#download">${ico('download')}Скачать</a></div>
</div><img class="hero-art" src="${PREFIX}/app/icons/icon-512.png" alt="Иконка You Music"></section>

<h2>Статистика</h2>
<div class="grid">
${stat(s.users, 'аккаунтов', s.newWeek ? `+${n(s.newWeek)} за неделю` : '')}
${stat(s.activeDay, 'заходили за сутки', `${n(s.activeWeek)} за неделю`)}
${stat(s.synced, 'синхронизируют библиотеку')}
${stat(s.aiTotal, 'подборок нейросети', s.aiToday ? `${n(s.aiToday)} сегодня` : '')}
${stat(s.tgTracks, 'треков из Telegram')}
</div>
<div class="card chart"><div class="row"><span>Аккаунты за 30 дней</span><span>${s.newToday ? `+${n(s.newToday)} сегодня` : ''}</span></div>${growthChart(s.growth)}</div>
<p style="margin-top:10px;font-size:13px">Считаются только аккаунты на сервере — приложением можно пользоваться и без них. Аналитики и трекинга нет.</p>

<h2>Что умеет</h2>
<div class="grid three">
${feat('wave', 'Рекомендации', 'Бесконечный поток по лайкам, треку или плейлисту. Фильтры: популярное, новинки, русское, без слов — и свои пожелания словами.')}
${feat('lyrics', 'Тексты песен', 'Синхронный текст на месте обложки, тап — перемотка, перевод на русский.')}
${feat('download', 'Офлайн', 'Скачивание треков и целых плейлистов, кэш, плавные переходы между песнями.')}
${feat('swap', 'Перенос', 'Плейлисты и лайки из Spotify, Яндекс Музыки, списка или CSV и файлы из Telegram-бота.')}
${feat('palette', 'Темы и моды', 'Graphite, AMOLED, Liquid Glass, Catppuccin, Nord, Synthwave, наборы значков и моды.')}
${feat('cloud', 'Аккаунт по желанию', 'Синхронизация между телефоном и компьютером, нейросеть без настройки, бесплатный прокси.')}
</div>

<h2 id="download">Скачать</h2>
<div class="dl">
${dl(`${PREFIX}/app/`, 'play', 'Веб-плеер', 'Прямо в браузере, без установки')}
${dl(RELEASES, 'android', 'Android', 'APK, обновляется сам')}
${dl(`${NIGHTLY}/YouMusic-windows.exe`, 'windows', 'Windows', 'YouMusic-windows.exe')}
${dl(`${NIGHTLY}/YouMusic-linux.tar.gz`, 'linux', 'Linux', 'Архив, запуск — ./YouMusic')}
${dl(`https://t.me/${esc(TG_BOT)}`, 'telegram', 'Бот в Telegram', 'Пришлите файлы — они появятся в приложении')}
</div>
<script>
// Count the numbers up once the page opens.
if(!matchMedia('(prefers-reduced-motion:reduce)').matches)document.querySelectorAll('[data-n]').forEach(function(el){var to=+el.dataset.n,t0=performance.now();if(to<2)return;(function f(t){var k=Math.min(1,(t-t0)/900);el.textContent=Math.round(to*(1-Math.pow(1-k,3))).toLocaleString('ru-RU');if(k<1)requestAnimationFrame(f)})(t0)})
</script>`, { wide: true });
}

function trackPage(id) {
  const yt = `https://music.youtube.com/watch?v=${id}`;
  const app = `youmusic://track?id=${id}`;
  return page('Трек в You Music', `
<img class="cover" src="https://i.ytimg.com/vi/${id}/hqdefault.jpg" alt="">
<h1>Послушать в You Music</h1>
<p>С вами поделились треком. Если приложение установлено, он откроется в нём.</p>
<div class="actions"><a class="btn" href="${app}">Открыть в приложении</a><a class="btn ghost" href="${PREFIX}/app/?open=${encodeURIComponent(app)}">${ico('play')}В веб-плеере</a><a class="btn ghost" href="${yt}">Открыть на YouTube</a></div>
<script>setTimeout(function(){location.href=${JSON.stringify(app)}},300)</script>`);
}

function termsPage() {
  return page('Пользовательское соглашение — You Music', `
<h1>Пользовательское соглашение</h1>
<p>You Music — некоммерческий проект с открытым исходным кодом. Пользуясь приложением, сайтом или ботом, вы соглашаетесь с условиями ниже.</p>
<h2>Контент</h2>
<p>Приложение не размещает музыку: оно воспроизводит общедоступные материалы YouTube и файлы, которые вы добавили сами. Права на произведения принадлежат их правообладателям. Вы отвечаете за то, чтобы ваше использование, в том числе скачивание и загрузка файлов в бот, не нарушало законодательство вашей страны и права третьих лиц.</p>
<h2>Аккаунт и данные</h2>
<p>Аккаунт необязателен. На сервере хранится логин, хэш пароля, зашифрованная копия вашей библиотеки (если включена синхронизация), счётчик запросов к нейросети и файлы, которые вы сами отправили боту. Аналитики и рекламы нет, данные не передаются третьим лицам. Для рекомендаций нейросети отправляются только названия и исполнители треков. Удалить аккаунт и все данные можно в приложении.</p>
<h2>Без гарантий</h2>
<p>Сервис предоставляется «как есть», без гарантий доступности и работоспособности. Бесплатный прокси, нейросеть и импорт из Telegram могут быть ограничены или отключены. Злоупотребление (спам, обход лимитов, незаконный контент) — основание для блокировки аккаунта.</p>
<h2>Изменения</h2>
<p>Условия могут обновляться; актуальная версия всегда на этой странице.</p>`);
}

async function sendFile(res, file, type, cache = 'private, max-age=86400') {
  const info = await stat(file).catch(() => null);
  if (!info) throw new HttpError(404, 'not_found', 'Файл не найден');
  res.writeHead(200, { 'content-type': type, 'content-length': info.size, 'cache-control': cache });
  await pipeline(createReadStream(file), res);
}

/* ───────── Telegram bot: link a chat to an account, then every audio sent to the bot is stored for import ───────── */

const tgPath = (userId, name) => path.join(DATA, 'tg', userId, name);
const publicTgTrack = (t) => ({ id: t.id, title: t.title, artist: t.artist, durationMs: t.durationMs, size: t.size, mime: t.mime, cover: t.cover ? `/api/tg/cover/${t.id}` : null, at: t.at });

async function tg(method, body) {
  const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(60_000),
  });
  const json = await r.json().catch(() => null);
  if (!json?.ok) throw new Error(`telegram ${method}: ${json?.description ?? r.status}`);
  return json.result;
}

const reply = (chat, text) => tg('sendMessage', { chat_id: chat, text, disable_web_page_preview: true }).catch((e) => console.error(e.message));

async function tgDownload(fileId, dest) {
  const f = await tg('getFile', { file_id: fileId });
  const r = await fetch(`https://api.telegram.org/file/bot${TG_TOKEN}/${f.file_path}`, { signal: AbortSignal.timeout(120_000) });
  if (!r.ok || !r.body) throw new Error(`telegram file ${r.status}`);
  await mkdir(path.dirname(dest), { recursive: true, mode: 0o700 });
  await pipeline(Readable.fromWeb(r.body), createWriteStream(dest, { mode: 0o600 }));
}

const EXT = { 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/ogg': 'ogg', 'audio/flac': 'flac', 'audio/x-flac': 'flac', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/aac': 'aac', 'audio/opus': 'opus' };

async function onTgMessage(m) {
  const chat = m.chat?.id;
  if (!chat || m.chat.type !== 'private') return;
  const text = m.text ?? '';
  const start = text.match(/^\/start(?:\s+([\w-]+))?/);
  if (start) {
    const code = start[1] && db.tg.codes[start[1]];
    if (code && code.until > Date.now()) {
      delete db.tg.codes[start[1]];
      db.tg.chats[chat] = code.userId;
      await save();
      return reply(chat, 'Готово, Telegram привязан к аккаунту You Music. Присылайте или пересылайте сюда аудиофайлы — они появятся в приложении: Настройки → Перенос музыки → Telegram.');
    }
    return reply(chat, db.tg.chats[chat]
      ? 'Telegram уже привязан. Присылайте аудиофайлы — они появятся в приложении в разделе «Перенос музыки → Telegram».'
      : 'Привет! Это бот You Music. Чтобы переносить музыку, откройте в приложении «Перенос музыки → Telegram» и нажмите «Привязать Telegram».');
  }
  if (text === '/unlink') {
    delete db.tg.chats[chat];
    await save();
    return reply(chat, 'Telegram отвязан от аккаунта. Уже перенесённые треки остались в приложении.');
  }
  const audio = m.audio ?? (m.document?.mime_type?.startsWith('audio/') ? m.document : null);
  if (!audio) {
    if (m.voice || m.video || m.photo || m.document) return reply(chat, 'Я принимаю только музыку: аудиофайлы (mp3, m4a, flac, ogg…).');
    return;
  }
  const userId = db.tg.chats[chat];
  if (!userId) return reply(chat, 'Сначала привяжите аккаунт: в приложении «Перенос музыки → Telegram» → «Привязать Telegram».');
  const list = (db.tg.tracks[userId] ??= []);
  if (list.length >= TG_MAX_FILES) return reply(chat, `Достигнут предел — ${TG_MAX_FILES} файлов. Удалите перенесённые в приложении.`);
  if (list.some((t) => t.uniq === audio.file_unique_id)) return reply(chat, 'Этот трек уже есть.');
  if ((audio.file_size ?? 0) > 20 * 1024 * 1024) return reply(chat, 'Файл больше 20 МБ — Telegram не отдаёт ботам такие файлы.');
  const id = randomBytes(15).toString('base64url');
  const ext = EXT[audio.mime_type] ?? (audio.file_name?.match(/\.(\w{2,4})$/)?.[1]?.toLowerCase() ?? 'mp3');
  const named = cleanFileTrack(audio.title || audio.file_name || '', audio.performer || '');
  try {
    await tgDownload(audio.file_id, tgPath(userId, `${id}.${ext}`));
    let cover = null;
    const thumb = audio.thumbnail ?? audio.thumb;
    if (thumb) cover = await tgDownload(thumb.file_id, tgPath(userId, `${id}.jpg`)).then(() => `${id}.jpg`, () => null);
    const track = {
      id, uniq: audio.file_unique_id,
      title: named.title,
      artist: named.artist,
      durationMs: (audio.duration ?? 0) * 1000,
      size: audio.file_size ?? 0, mime: audio.mime_type ?? 'audio/mpeg',
      file: `${id}.${ext}`, cover, at: Date.now(),
    };
    list.push(track);
    await save();
    reply(chat, `Добавлено: ${track.artist ? `${track.artist} — ` : ''}${track.title}`);
  } catch (e) {
    console.error('tg import failed', e.message);
    reply(chat, 'Не получилось сохранить файл, попробуйте ещё раз.');
  }
}

const SITE_RE = /[([{]?\s*(?:https?:\/\/)?(?:www\.)?[\w-]+(?:\.[\w-]+)*\.(?:ru|com|net|fm|org|me|su|info|cc|io|to|top|club|pro|online|xyz|biz|ws|tv|by|ua|kz|site|music|mobi)(?:\/\S*)?\s*[)\]}]?/gi;
const FILE_NOISE_RE = /[([{]?\s*(?:\d{2,3}\s*kbps|mp3|flac|m4a|ogg|скачать|бесплатно|free\s+download|@[\w.]+)\s*[)\]}]?/gi;

/** Same cleaning as web/src/logic/match.ts cleanFileTrack: tags often hold "01._Artist_-_Song_(site.ru).mp3". */
function cleanFileTrack(rawTitle, rawArtist) {
  const tidy = (s) => s
    .replace(/\.(?:mp3|m4a|flac|ogg|opus|wav|aac)$/i, '')
    .replace(/_+/g, ' ').replace(/%20/g, ' ')
    .replace(SITE_RE, ' ').replace(FILE_NOISE_RE, ' ')
    .replace(/[([{]\s*[)\]}]/g, ' ').replace(/\s{2,}/g, ' ')
    .replace(/^[\s|\-–—:.,]+|[\s|\-–—:,]+$/g, '').trim();
  let title = tidy(rawTitle).replace(/^\d{1,3}(?:[.)]\s*|\s+[-–—]\s+)/, '');
  let artist = tidy(rawArtist);
  const parts = title.split(/\s+[-–—]\s+/);
  if (parts.length >= 2) {
    const head = parts[0].trim();
    if (!artist) { artist = head; title = parts.slice(1).join(' - '); }
    else if (head.toLowerCase() === artist.toLowerCase()) title = parts.slice(1).join(' - ');
  }
  if (/^(?:unknown|неизвестен|неизвестный|various artists?|va)$/i.test(artist)) artist = '';
  return { title: title || 'Без названия', artist };
}

async function tgLoop() {
  if (!TG_TOKEN) return;
  await tg('setMyCommands', { commands: [{ command: 'start', description: 'Как перенести музыку' }, { command: 'unlink', description: 'Отвязать аккаунт' }] }).catch((e) => console.error(e.message));
  for (;;) {
    try {
      const updates = await tg('getUpdates', { offset: db.tg.offset, timeout: 50, allowed_updates: ['message'] });
      for (const u of updates) {
        db.tg.offset = u.update_id + 1;
        if (u.message) await onTgMessage(u.message).catch((e) => console.error('tg message', e));
      }
      if (updates.length) save();
    } catch (e) {
      console.error('tg poll', e.message);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

const PREFIX = env.BASE_PATH ?? '';

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  let p = url.pathname;
  if (PREFIX && p.startsWith(PREFIX)) p = p.slice(PREFIX.length) || '/';
  const handler = routes[`${req.method} ${p}`];
  try {
    if (!handler) {
      const key = `${req.method} ${p}`;
      for (const [re, fn] of paramRoutes) {
        const m = key.match(re);
        if (m) return void (await fn(req, res, m[1]));
      }
      throw new HttpError(404, 'not_found', 'Нет такого адреса');
    }
    send(res, 200, await handler(req));
  } catch (e) {
    if (res.headersSent) res.destroy();
    else if (e instanceof HttpError) send(res, e.status, { error: e.code, message: e.message });
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
tgLoop();
if (PROXY_HOST) proxy.listen(PROXY_PORT, '0.0.0.0', () => console.log(`proxy on :${PROXY_PORT}`));
