import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const Busboy = require('busboy');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distDir = path.resolve(process.env.DIST_DIR || path.join(root, 'dist'));
const port = Number(process.env.PORT || 43131);
const host = process.env.HOST || '0.0.0.0';
const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID || '';
const folderUrl = `https://drive.google.com/drive/folders/${folderId}`;
const photoAlbums = [
  ['the-warehouse-xl-halloween-special', 'THE WARE-HOUSE XL HALLOWEEN SPECIAL'],
  ['the-ignition', 'THE IGNITION'],
  ['the-temple-006', 'THE TEMPLE 006'],
  ['the-temple-008', 'THE TEMPLE 007'],
  ['terminus', 'TERMINUS'],
  ['the-cage-of-chaos', 'THE CAGE OF CHAOS'],
  ['project-one-f5w4d-7r8zz', 'THE WAREHOUSE XL 003'],
  ['the-covenant', 'THE COVENANT'],
  ['the-reckoning', 'THE RECKONING'],
  ['the-ascension', 'THE ASCENSION'],
  ['the-initiation', 'THE INITIATION'],
];
const maxBytes = 50 * 1024 * 1024;
const wheelOrigin = 'https://reckless-wheel.onrender.com';
const wheelApiPaths = new Set([
  '/api/create-checkout-session',
  '/api/claim-prize',
  '/api/free-spin',
  '/api/spin-result',
]);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
};

const AUDIO = new Set(['audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/x-wav', 'audio/wave', 'audio/vnd.wave']);

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  });
  res.end(body);
}

function driveBaseName(artist, title) {
  const clean = (value) =>
    String(value || '')
      .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80);
  return `${clean(artist) || 'Artist'} - ${clean(title) || 'Title'}`;
}

function extensionOf(filename, mime) {
  const match = /\.([a-z0-9]+)$/i.exec(filename || '');
  const ext = match ? match[1].toLowerCase() : '';
  if (ext === 'mp3' || ext === 'wav') return `.${ext}`;
  if (mime === 'audio/wav' || mime === 'audio/x-wav' || mime === 'audio/wave' || mime === 'audio/vnd.wave') return '.wav';
  if (mime === 'audio/mpeg' || mime === 'audio/mp3') return '.mp3';
  return '';
}

function oauthConfig() {
  const clientId = (process.env.GOOGLE_CLIENT_ID || '').trim();
  const clientSecret = (process.env.GOOGLE_CLIENT_SECRET || '').trim();
  const refreshToken = (process.env.GOOGLE_REFRESH_TOKEN || '').trim();
  if (!clientId || !clientSecret || !refreshToken || !folderId) return null;
  return { clientId, clientSecret, refreshToken };
}

function submissionStatus() {
  const oauth = Boolean(oauthConfig());
  return {
    ok: true,
    drive: oauth,
    mode: oauth ? 'oauth' : 'pending',
    oauth,
    folderId,
    folderUrl,
  };
}

function jpegSize(buffer) {
  let offset = 2;
  while (offset < buffer.length - 8) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buffer[offset + 1];
    if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
      return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
    }
    const size = buffer.readUInt16BE(offset + 2);
    if (!size) break;
    offset += 2 + size;
  }
  return null;
}

async function albumPhotoUrls(slug) {
  const response = await fetch(`https://www.recklessraves.co.uk/gallery/${slug}`, { signal: AbortSignal.timeout(12000) });
  if (!response.ok) throw new Error(`Gallery page ${slug} failed`);
  const html = await response.text();
  const seen = new Set();
  const photos = [];
  for (const match of html.matchAll(/https:\/\/images\.squarespace-cdn\.com\/content\/v1\/[^"'\\\s]+/g)) {
    const url = match[0].split('?')[0];
    const name = decodeURIComponent(url.split('/').pop() || '');
    if (!/^[A-Z]{2,6}\d+(?:-\d+)?\.jpe?g$/i.test(name)) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    photos.push(url);
  }
  return photos;
}

function coverSample(urls) {
  if (urls.length <= 12) return urls;
  const picks = [];
  for (let index = 0; index < 12; index += 1) {
    picks.push(urls[Math.floor((index * (urls.length - 1)) / 11)]);
  }
  return [...new Set(picks)];
}

async function chooseCover(urls) {
  const sample = coverSample(urls);
  const measured = (
    await Promise.all(
      sample.map(async (url) => {
        try {
          const response = await fetch(`${url}?format=100w`, { signal: AbortSignal.timeout(8000) });
          if (!response.ok) return null;
          const size = jpegSize(Buffer.from(await response.arrayBuffer()));
          if (size?.width && size?.height) return { url, ratio: size.width / size.height };
        } catch {
          return null;
        }
        return null;
      }),
    )
  ).filter(Boolean);
  const wide = measured.filter((item) => item.ratio >= 1.15).sort((a, b) => b.ratio - a.ratio);
  return (wide[0] || measured[0] || { url: urls[0] }).url;
}

let galleryCache = { at: 0, albums: [] };

async function loadGallery() {
  if (galleryCache.albums.length && Date.now() - galleryCache.at < 30 * 60 * 1000) return galleryCache.albums;
  const albums = (
    await Promise.all(
      photoAlbums.map(async ([slug, title]) => {
        try {
          const photos = await albumPhotoUrls(slug);
          if (!photos.length) return null;
          const cover = await chooseCover(photos);
          const sized = (url) => `${url}?format=1600w`;
          return {
            id: slug,
            title,
            coverUrl: `${cover}?format=1200w`,
            images: photos.map((url) => ({ id: url.split('/').pop(), url: sized(url) })),
          };
        } catch (error) {
          console.error('Gallery album failed', slug, error instanceof Error ? error.message : error);
          return null;
        }
      }),
    )
  ).filter(Boolean);
  if (albums.length) galleryCache = { at: Date.now(), albums };
  return albums;
}

let cachedToken = null;

async function accessToken() {
  const account = oauthConfig();
  if (!account) throw new Error('Drive OAuth is not set');
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedToken.exp - 60 > now) return cachedToken.token;
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: account.clientId,
      client_secret: account.clientSecret,
      refresh_token: account.refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  const payload = await response.json();
  if (!payload.access_token) {
    throw new Error('Drive token was not issued');
  }
  cachedToken = { token: payload.access_token, exp: now + Number(payload.expires_in || 3600) };
  return cachedToken.token;
}

async function uploadToDrive({ filename, mime, buffer, description }) {
  const token = await accessToken();
  const boundary = `reckless_${randomBytes(8).toString('hex')}`;
  const meta = JSON.stringify({
    name: filename,
    parents: [folderId],
    description,
  });
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Type: ${mime}\r\n\r\n`),
    buffer,
    Buffer.from(`\r\n--${boundary}--`),
  ]);
  const response = await fetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id,name',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': `multipart/related; boundary=${boundary}`,
      },
      body,
    },
  );
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.id) {
    throw new Error(payload.error?.message || 'Drive upload failed');
  }
  return payload;
}

function parseForm(req) {
  return new Promise((resolve, reject) => {
    const fields = {};
    const files = [];
    let tooBig = false;
    const parser = Busboy({
      headers: req.headers,
      limits: { fileSize: maxBytes, files: 1, fields: 8, fieldSize: 8000 },
    });
    parser.on('field', (name, value) => {
      if (fields[name] == null) fields[name] = value;
    });
    parser.on('file', (name, stream, info) => {
      if (name !== 'file') {
        stream.resume();
        return;
      }
      const chunks = [];
      stream.on('limit', () => {
        tooBig = true;
      });
      stream.on('data', (chunk) => chunks.push(chunk));
      stream.on('end', () => {
        files.push({
          filename: info.filename || '',
          mime: info.mimeType || '',
          buffer: Buffer.concat(chunks),
        });
      });
    });
    parser.on('error', reject);
    parser.on('finish', () => resolve({ fields, files, tooBig }));
    req.pipe(parser);
  });
}

function validEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

async function handleSubmit(req, res) {
  if (!oauthConfig()) {
    req.resume();
    sendJson(res, 503, { ok: false, error: 'PENDING', drive: false, folderId });
    return;
  }
  const declared = Number(req.headers['content-length'] || 0);
  if (declared > maxBytes + 1024 * 1024) {
    sendJson(res, 413, { ok: false, error: 'FILE_SIZE' });
    return;
  }
  let form;
  try {
    form = await parseForm(req);
  } catch {
    sendJson(res, 400, { ok: false, error: 'UPLOAD' });
    return;
  }
  if (form.tooBig) {
    sendJson(res, 413, { ok: false, error: 'FILE_SIZE' });
    return;
  }
  const artist = String(form.fields.artist || '').trim();
  const title = String(form.fields.title || '').trim();
  const email = String(form.fields.email || '').trim();
  const notes = String(form.fields.notes || '').trim();
  const file = form.files[0];
  if (!artist || !title || !email || !file) {
    sendJson(res, 400, { ok: false, error: 'MISSING' });
    return;
  }
  if (!validEmail(email)) {
    sendJson(res, 400, { ok: false, error: 'EMAIL' });
    return;
  }
  const ext = extensionOf(file.filename, file.mime);
  const mimeOk = AUDIO.has(file.mime.toLowerCase()) || file.mime === '' || file.mime === 'application/octet-stream';
  if (!ext || !mimeOk) {
    sendJson(res, 400, { ok: false, error: 'FILE_TYPE' });
    return;
  }
  if (file.buffer.length > maxBytes) {
    sendJson(res, 413, { ok: false, error: 'FILE_SIZE' });
    return;
  }

  const baseName = driveBaseName(artist, title);
  const filename = `${baseName}${ext}`;
  const sidecar = [
    `Artist: ${artist}`,
    `Title: ${title}`,
    `Email: ${email}`,
    `Notes: ${notes}`,
    `File: ${filename}`,
    `Received: ${new Date().toISOString()}`,
  ].join('\n');
  try {
    const audio = await uploadToDrive({
      filename,
      mime: ext === '.wav' ? 'audio/wav' : 'audio/mpeg',
      buffer: file.buffer,
      description: sidecar.slice(0, 1000),
    });
    await uploadToDrive({
      filename: `${baseName}.txt`,
      mime: 'text/plain',
      buffer: Buffer.from(sidecar),
      description: 'Reckless track submission',
    });
    sendJson(res, 200, {
      ok: true,
      destination: 'drive',
      name: filename,
      id: audio.id,
    });
  } catch (error) {
    console.error('Drive upload failed', error instanceof Error ? error.message : error);
    sendJson(res, 502, { ok: false, error: 'UPLOAD' });
  }
}

function filePathFor(urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0]);
  const relative = decoded.replace(/^\/+/, '');
  const resolved = path.resolve(distDir, relative);
  const rootWithSep = distDir.endsWith(path.sep) ? distDir : `${distDir}${path.sep}`;
  if (resolved !== distDir && !resolved.startsWith(rootWithSep)) return null;
  return resolved;
}

function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        req.destroy();
        reject(new Error('body'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function proxyWheelApi(req, res, url) {
  const target = new URL(url.pathname + url.search, wheelOrigin);
  let body;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    try {
      body = await readBody(req);
    } catch {
      sendJson(res, 413, { ok: false, error: 'UPLOAD' });
      return;
    }
  }
  const headers = {};
  if (req.headers['content-type']) headers['content-type'] = String(req.headers['content-type']);
  const response = await fetch(target, { method: req.method, headers, body });
  const buffer = Buffer.from(await response.arrayBuffer());
  res.writeHead(response.status, {
    'Content-Type': response.headers.get('content-type') || 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(buffer);
}

function embedFailure(res) {
  res.writeHead(502, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(
    '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;background:#000;color:#fff;font-family:sans-serif;text-align:center;padding:48px 20px"><p>The live spin page did not load.</p><p><a style="color:#fff" href="https://www.recklessraves.co.uk/spin-the-wheel">Open it on recklessraves.co.uk</a></p></body></html>',
  );
}

async function serveEmbed(req, res, url) {
  const target = new URL('/', wheelOrigin);
  if (url.pathname.startsWith('/embed/wheel/')) {
    const rest = url.pathname.slice('/embed/wheel'.length);
    target.pathname = rest.startsWith('/') ? rest : `/${rest}`;
  }
  target.search = url.search;
  let response;
  try {
    response = await fetch(target, { redirect: 'follow' });
  } catch {
    embedFailure(res);
    return;
  }
  const finalHost = new URL(response.url).host;
  if (finalHost !== 'reckless-wheel.onrender.com' || !response.ok) {
    embedFailure(res);
    return;
  }
  const html = await response.text();
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "frame-ancestors *",
  });
  res.end(html);
}

function serveStatic(req, res) {
  const url = new URL(req.url || '/', 'http://localhost');
  const requested = filePathFor(url.pathname);
  if (!requested) {
    res.writeHead(400);
    res.end('Bad path');
    return;
  }
  let target = requested;
  if (existsSync(target) && statSync(target).isDirectory()) {
    target = path.join(target, 'index.html');
  }
  const ext = path.extname(target);
  if (!existsSync(target)) {
    if (!ext) {
      target = path.join(distDir, 'index.html');
    } else {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
  }
  if (!existsSync(target)) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(target)] || 'application/octet-stream' });
  createReadStream(target).pipe(res);
}

const authSecret = (process.env.AUTH_SECRET || 'reckless-dev-auth-secret').trim();
const linkTtlMs = 15 * 60 * 1000;
const sessionTtlMs = 30 * 24 * 60 * 60 * 1000;
const pendingLinks = new Map();
const dataDir = path.resolve(process.env.DATA_DIR || path.join(root, 'server', 'data'));
const accountsPath = path.join(dataDir, 'accounts.json');
const ledgerPath = path.join(dataDir, 'xp-ledger.json');
const xpSheetId = (process.env.XP_SHEET_ID || '').trim();
const accounts = loadAccounts();
let ledgerMap = new Map();
let ledgerAt = 0;
let ledgerFileMtime = 0;
let ledgerRefresh = null;

function loadAccounts() {
  try {
    const raw = JSON.parse(readFileSync(accountsPath, 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

function saveAccounts() {
  mkdirSync(path.dirname(accountsPath), { recursive: true });
  writeFileSync(accountsPath, JSON.stringify(accounts));
}

function rememberLedger(map) {
  if (!map.size) return;
  ledgerMap = map;
  ledgerAt = Date.now();
}

function loadLedgerFile() {
  try {
    const stamp = statSync(ledgerPath).mtimeMs;
    if (stamp === ledgerFileMtime && ledgerMap.size) return ledgerMap;
    const raw = JSON.parse(readFileSync(ledgerPath, 'utf8'));
    const rows = raw && typeof raw.emails === 'object' ? raw.emails : {};
    const map = new Map();
    for (const [email, value] of Object.entries(rows)) {
      const key = normalizeEmail(email);
      if (!key.includes('@')) continue;
      const xp = Math.max(0, Math.floor(Number(typeof value === 'object' && value ? value.xp : value) || 0));
      map.set(key, xp);
    }
    ledgerFileMtime = stamp;
    if (map.size) rememberLedger(map);
    return map;
  } catch {
    return ledgerMap;
  }
}

function parseLedgerValues(values) {
  const map = new Map();
  for (const row of values || []) {
    const key = normalizeEmail(row[0]);
    if (!key.includes('@')) continue;
    map.set(key, Math.max(0, Math.floor(Number(row[1]) || 0)));
  }
  return map;
}

async function refreshLedger() {
  if (!oauthConfig()) return loadLedgerFile();
  if (ledgerMap.size && Date.now() - ledgerAt < 45_000) return ledgerMap;
  if (ledgerRefresh) return ledgerRefresh;
  ledgerRefresh = (async () => {
    try {
      const token = await accessToken();
      const range = encodeURIComponent('XP Ledger!A2:B');
      const response = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${xpSheetId}/values/${range}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.ok) {
        console.error('XP ledger sheet', response.status);
        return loadLedgerFile();
      }
      const payload = await response.json();
      const map = parseLedgerValues(payload.values);
      if (!map.size) return loadLedgerFile();
      rememberLedger(map);
      const emails = {};
      for (const [email, xp] of map) emails[email] = xp;
      mkdirSync(path.dirname(ledgerPath), { recursive: true });
      writeFileSync(ledgerPath, JSON.stringify({ source: 'sheets', updated: new Date().toISOString(), rows: map.size, emails }));
      ledgerFileMtime = statSync(ledgerPath).mtimeMs;
      console.log(`XP ledger ${map.size} emails`);
      return map;
    } catch (error) {
      console.error('XP ledger', error instanceof Error ? error.message : error);
      return loadLedgerFile();
    } finally {
      ledgerRefresh = null;
    }
  })();
  return ledgerRefresh;
}

function xpFor(email) {
  const key = normalizeEmail(email);
  return ledgerMap.has(key) ? ledgerMap.get(key) : 0;
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function publicOrigin(req) {
  const configured = (process.env.PUBLIC_BASE_URL || '').trim().replace(/\/$/, '');
  if (configured) return configured;
  const forwarded = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
  const hostHeader = String(req.headers['x-forwarded-host'] || req.headers.host || `127.0.0.1:${port}`).split(',')[0].trim();
  return `${forwarded}://${hostHeader}`;
}

function signSession(email) {
  const body = Buffer.from(JSON.stringify({ email, exp: Date.now() + sessionTtlMs })).toString('base64url');
  const sig = createHmac('sha256', authSecret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function readSession(header) {
  const token = String(header || '').replace(/^Bearer\s+/i, '').trim();
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = createHmac('sha256', authSecret).update(body).digest('base64url');
  const left = Buffer.from(sig);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !timingSafeEqual(left, right)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!payload.email || payload.exp < Date.now()) return null;
    return normalizeEmail(payload.email);
  } catch {
    return null;
  }
}

function emptyFit() {
  return { top: null, outer: null, legs: null };
}

function cleanFit(fit) {
  const next = emptyFit();
  if (!fit || typeof fit !== 'object') return next;
  for (const slot of ['top', 'outer', 'legs']) {
    const id = fit[slot];
    if (typeof id === 'string' && id.length > 0 && id.length < 48) next[slot] = id;
  }
  return next;
}

function accountFor(email) {
  const key = normalizeEmail(email);
  if (!accounts[key]) accounts[key] = { xp: 0, fit: emptyFit() };
  accounts[key].fit = cleanFit(accounts[key].fit);
  accounts[key].xp = Math.max(0, Math.floor(Number(accounts[key].xp) || 0));
  return accounts[key];
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      if (!chunks.length) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function mailConfigured() {
  return Boolean(
    (process.env.RESEND_API_KEY || '').trim() ||
      (process.env.SENDGRID_API_KEY || '').trim() ||
      (process.env.SMTP_HOST || '').trim(),
  );
}

async function sendMagicMail({ to, verifyUrl, appUrl, code }) {
  const from = (process.env.MAIL_FROM || 'Reckless Raves <crew@recklessraves.co.uk>').trim();
  const subject = 'Your Reckless sign-in link';
  const text = `Sign in to Reckless Crew\n\n${verifyUrl}\n\nOr enter ${code} in the app.\n\nOpen in the app: ${appUrl}\n`;
  const html = `<p>Sign in to Reckless Crew.</p><p><a href="${verifyUrl}">Open your sign-in link</a></p><p>Or enter <strong>${code}</strong> in the app.</p><p><a href="${appUrl}">Open in the app</a></p>`;
  const resendKey = (process.env.RESEND_API_KEY || '').trim();
  if (resendKey) {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to: [to], subject, text, html }),
    });
    if (!response.ok) throw new Error(`Resend ${response.status}`);
    return 'resend';
  }
  const sendgridKey = (process.env.SENDGRID_API_KEY || '').trim();
  if (sendgridKey) {
    const response = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: { Authorization: `Bearer ${sendgridKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: to }] }],
        from: { email: from.match(/<([^>]+)>/)?.[1] || from, name: 'Reckless Raves' },
        subject,
        content: [
          { type: 'text/plain', value: text },
          { type: 'text/html', value: html },
        ],
      }),
    });
    if (!response.ok) throw new Error(`SendGrid ${response.status}`);
    return 'sendgrid';
  }
  if ((process.env.SMTP_HOST || '').trim()) {
    const nodemailer = await import('nodemailer');
    const transport = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: String(process.env.SMTP_SECURE || '') === '1',
      auth: process.env.SMTP_USER
        ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS || '' }
        : undefined,
    });
    await transport.sendMail({ from, to, subject, text, html });
    return 'smtp';
  }
  return null;
}

async function handleAuthRequest(req, res) {
  let body;
  try {
    body = await readJson(req);
  } catch {
    sendJson(res, 400, { ok: false, error: 'EMAIL' });
    return;
  }
  const email = normalizeEmail(body.email);
  if (!validEmail(email)) {
    sendJson(res, 400, { ok: false, error: 'EMAIL' });
    return;
  }
  await refreshLedger();
  accountFor(email);
  saveAccounts();
  sendJson(res, 200, { ok: true, email, token: signSession(email) });
}

async function handleAuthVerify(req, res, url) {
  let token = url.searchParams.get('token') || '';
  let email = '';
  let code = '';
  if (req.method === 'POST') {
    try {
      const body = await readJson(req);
      token = token || String(body.token || '');
      email = normalizeEmail(body.email);
      code = String(body.code || '').trim();
    } catch {
      sendJson(res, 400, { ok: false, error: 'CODE' });
      return;
    }
  }
  let match = token ? pendingLinks.get(token) : null;
  if (!match && email && code) {
    for (const [key, value] of pendingLinks) {
      if (value.email === email && value.code === code) {
        match = value;
        token = key;
        break;
      }
    }
  }
  if (!match || match.exp < Date.now()) {
    if (token) pendingLinks.delete(token);
    sendJson(res, 401, { ok: false, error: 'CODE' });
    return;
  }
  pendingLinks.delete(token);
  accountFor(match.email);
  saveAccounts();
  sendJson(res, 200, { ok: true, email: match.email, token: signSession(match.email) });
}

function handleAuthMe(req, res) {
  const email = readSession(req.headers.authorization);
  if (!email) {
    sendJson(res, 401, { ok: false, error: 'SESSION' });
    return;
  }
  sendJson(res, 200, { ok: true, email });
}

async function handleCrewRead(req, res) {
  const email = readSession(req.headers.authorization);
  if (!email) {
    sendJson(res, 401, { ok: false, error: 'SESSION' });
    return;
  }
  await refreshLedger();
  const account = accountFor(email);
  sendJson(res, 200, { ok: true, email, xp: xpFor(email), fit: account.fit });
}

async function handleCrewWrite(req, res) {
  const email = readSession(req.headers.authorization);
  if (!email) {
    sendJson(res, 401, { ok: false, error: 'SESSION' });
    return;
  }
  let body;
  try {
    body = await readJson(req);
  } catch {
    sendJson(res, 400, { ok: false, error: 'CREW' });
    return;
  }
  await refreshLedger();
  const account = accountFor(email);
  account.fit = cleanFit(body.fit);
  saveAccounts();
  sendJson(res, 200, { ok: true, email, xp: xpFor(email), fit: account.fit });
}

const server = createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://localhost');
  if (wheelApiPaths.has(url.pathname)) {
    if (req.method !== 'GET' && req.method !== 'POST' && req.method !== 'HEAD') {
      sendJson(res, 405, { ok: false, error: 'UPLOAD' });
      return;
    }
    void proxyWheelApi(req, res, url).catch(() => {
      if (!res.headersSent) sendJson(res, 502, { ok: false, error: 'UPLOAD' });
    });
    return;
  }
  if (url.pathname === '/embed/spin' || url.pathname === '/embed/wheel' || url.pathname.startsWith('/embed/wheel/')) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405);
      res.end('Method not allowed');
      return;
    }
    if (req.method === 'HEAD') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end();
      return;
    }
    void serveEmbed(req, res, url);
    return;
  }
  if (url.pathname === '/api/submit') {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      });
      res.end();
      return;
    }
    if (req.method === 'POST') {
      void handleSubmit(req, res);
      return;
    }
    sendJson(res, 405, { ok: false, error: 'UPLOAD' });
    return;
  }
  if (url.pathname === '/api/auth/request' || url.pathname === '/api/auth/verify' || url.pathname === '/api/auth/me' || url.pathname === '/api/crew') {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      });
      res.end();
      return;
    }
  }
  if (url.pathname === '/api/auth/request' && req.method === 'POST') {
    void handleAuthRequest(req, res);
    return;
  }
  if (url.pathname === '/api/auth/verify' && (req.method === 'POST' || req.method === 'GET')) {
    void handleAuthVerify(req, res, url);
    return;
  }
  if (url.pathname === '/api/auth/me' && req.method === 'GET') {
    handleAuthMe(req, res);
    return;
  }
  if (url.pathname === '/api/crew' && req.method === 'GET') {
    handleCrewRead(req, res);
    return;
  }
  if (url.pathname === '/api/crew' && req.method === 'PUT') {
    void handleCrewWrite(req, res);
    return;
  }
  if (url.pathname === '/api/health') {
    sendJson(res, 200, submissionStatus());
    return;
  }
  if (url.pathname === '/api/gallery') {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405);
      res.end('Method not allowed');
      return;
    }
    void loadGallery()
      .then((albums) => sendJson(res, 200, { ok: true, albums }))
      .catch((error) => {
        console.error('Gallery list failed', error instanceof Error ? error.message : error);
        if (!res.headersSent) sendJson(res, 502, { ok: false, error: 'GALLERY' });
      });
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405);
    res.end('Method not allowed');
    return;
  }
  if (req.method === 'HEAD') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end();
    return;
  }
  serveStatic(req, res);
});

loadLedgerFile();

server.listen(port, host, () => {
  console.log(`Reckless site on http://${host}:${port}`);
  console.log(`Drive folder ${folderId} (${submissionStatus().mode})`);
  console.log(`XP ledger ${ledgerMap.size} emails`);
});
