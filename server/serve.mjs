import { createHmac, randomBytes, randomInt, scrypt, timingSafeEqual } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { contentEventById, contentEventIndex, contentEvents, handleContent, handlePoster, initContent } from './content.mjs';
import { createReps } from './reps.mjs';
import { createSocial } from './social.mjs';
import { createAdmin } from './admin.mjs';
import { downloadsSummary, initDownloads } from './downloads.mjs';
import { attachCors } from './cors.mjs';
import { avatarManifest, handleAvatarAsset } from './avatar.mjs';
import { checkLevelUps, deviceStats, devicesForEmail, forgetDevices, initPush, pushLive, pushStatus, registerDevice, sendPush, targetTokens, unregisterDevice, validPushToken } from './push.mjs';
import { acknowledge, explicitAvatarBase, issuedCodesFor, storedAvatarBase, codePoolStatus, crewConfig, standing, fillPending, setLoadedSheet, crewState, flushIssued, forgetCodes, initCrew, issuedQueueLength, ownedFor, setIssuedWriter, setOwnedSheet, touchDay1, validAvatarBase, validFit } from './crew.mjs';
import { eventsForEmail, exportEventsSince, finishRave, initGameEvents, postPoster, startRave } from './game-events.mjs';
import { gameXp } from './game-xp.mjs';

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
  ['the-temple-007', 'THE TEMPLE 007'],
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
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
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

const GOOGLE_SCOPES = ['https://www.googleapis.com/auth/drive', 'https://www.googleapis.com/auth/spreadsheets'];
const oauthTokenPath = () => path.join(dataDir, 'google-oauth.json');
let storedOauth;
function storedRefreshToken() {
  if (storedOauth === undefined) {
    try {
      storedOauth = JSON.parse(readFileSync(oauthTokenPath(), 'utf8'));
    } catch {
      storedOauth = null;
    }
  }
  return storedOauth?.refresh_token || '';
}
function oauthRedirectUri(req) {
  const fixed = (process.env.OAUTH_REDIRECT_URI || '').trim();
  if (fixed) return fixed;
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '');
  const proto = String(req.headers['x-forwarded-proto'] || 'https').split(',')[0];
  return `${proto}://${host}/oauth/google/callback`;
}
const oauthStates = new Map();
function adminKeyOk(given) {
  const want = (process.env.OAUTH_ADMIN_KEY || '').trim();
  if (want.length < 24 || typeof given !== 'string') return false;
  const a = Buffer.from(given);
  const b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
}
function sendPage(res, status, title, body) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
  res.end(
    `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head><body style="margin:0;background:#000;color:#fff;font-family:sans-serif;text-align:center;padding:48px 20px"><h1 style="font-size:22px">${title}</h1><p>${body}</p></body></html>`,
  );
}

/** GET /oauth/google/start?key=<OAUTH_ADMIN_KEY> → Google consent (offline, prompt=consent). */
function handleOauthStart(req, res, url) {
  const clientId = (process.env.GOOGLE_CLIENT_ID || '').trim();
  if (!adminKeyOk(url.searchParams.get('key'))) {
    sendPage(res, 403, 'Not allowed', 'This link needs the admin key.');
    return;
  }
  if (!clientId) {
    sendPage(res, 500, 'Not configured', 'GOOGLE_CLIENT_ID is not set on the server.');
    return;
  }
  const state = randomBytes(24).toString('hex');
  const now = Date.now();
  for (const [key, at] of oauthStates) if (now - at > 10 * 60 * 1000) oauthStates.delete(key);
  oauthStates.set(state, now);
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: oauthRedirectUri(req),
    response_type: 'code',
    scope: GOOGLE_SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
  });
  res.writeHead(302, { Location: `https://accounts.google.com/o/oauth2/v2/auth?${params}`, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
  res.end();
}

/** GET /oauth/google/callback → exchange the code, store the refresh token in /data (never logged). */
async function handleOauthCallback(req, res, url) {
  const state = url.searchParams.get('state') || '';
  const started = oauthStates.get(state);
  oauthStates.delete(state);
  if (!started || Date.now() - started > 10 * 60 * 1000) {
    sendPage(res, 400, 'Link expired', 'Start again from the admin link.');
    return;
  }
  if (url.searchParams.get('error')) {
    sendPage(res, 400, 'Google did not connect', 'Consent was cancelled or refused. Start again from the admin link.');
    return;
  }
  const code = url.searchParams.get('code') || '';
  try {
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: (process.env.GOOGLE_CLIENT_ID || '').trim(),
        client_secret: (process.env.GOOGLE_CLIENT_SECRET || '').trim(),
        redirect_uri: oauthRedirectUri(req),
        grant_type: 'authorization_code',
      }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.refresh_token) {
      console.error('Google OAuth exchange failed', response.status, payload.error || 'no refresh token');
      sendPage(res, 502, 'Google did not connect', 'No refresh token came back. Start again from the admin link.');
      return;
    }
    const granted = String(payload.scope || '').split(' ').filter(Boolean);
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(oauthTokenPath(), JSON.stringify({ refresh_token: payload.refresh_token, scope: granted, saved_at: new Date().toISOString() }), { mode: 0o600 });
    storedOauth = undefined;
    cachedToken = null;
    driveCheck = { at: 0, ok: false };
    const ok = await driveHealthy(true);
    void refreshLedger();
    const missing = GOOGLE_SCOPES.filter((scope) => !granted.includes(scope));
    console.log(`Google OAuth connected (scopes: ${granted.length}, missing: ${missing.length})`);
    sendPage(
      res,
      200,
      ok ? 'Google connected' : 'Saved, but the test failed',
      missing.length
        ? `Missing permission: ${missing.join(', ')}. Start again and tick every box.`
        : 'Drive and Sheets are connected. You can close this page.',
    );
  } catch (error) {
    console.error('Google OAuth exchange error', error instanceof Error ? error.message : 'unknown');
    sendPage(res, 502, 'Google did not connect', 'Try again in a minute.');
  }
}

function oauthConfig() {
  const clientId = (process.env.GOOGLE_CLIENT_ID || '').trim();
  const clientSecret = (process.env.GOOGLE_CLIENT_SECRET || '').trim();
  // A token saved by the /oauth/google flow (in /data) overrides the env var.
  const refreshToken = storedRefreshToken() || (process.env.GOOGLE_REFRESH_TOKEN || '').trim();
  if (!clientId || !clientSecret || !refreshToken || !folderId) return null;
  return { clientId, clientSecret, refreshToken };
}

let driveCheck = { at: 0, ok: false };

/** Real check: can we mint a Google access token right now? Cached for 5 minutes. */
async function driveHealthy(force = false) {
  if (!oauthConfig()) return false;
  if (!force && driveCheck.at && Date.now() - driveCheck.at < 5 * 60 * 1000) return driveCheck.ok;
  try {
    await accessToken();
    driveCheck = { at: Date.now(), ok: true };
    void flushIssued();
  } catch (error) {
    cachedToken = null;
    driveCheck = { at: Date.now(), ok: false };
    console.error('Drive health', error instanceof Error ? error.message : error);
  }
  return driveCheck.ok;
}

async function submissionStatus() {
  const configured = Boolean(oauthConfig());
  const drive = configured ? await driveHealthy() : false;
  if (drive && ledgerStatus.sheet !== 'ok' && Date.now() - (ledgerStatus.triedAt || 0) > 5 * 60 * 1000) {
    ledgerStatus.triedAt = Date.now();
    await refreshLedger().catch(() => {});
  }
  return {
    ok: true,
    drive,
    xpLedger: ledgerHealth(),
    mode: drive ? 'oauth' : configured ? 'token' : 'pending',
    checkedAt: driveCheck.at ? new Date(driveCheck.at).toISOString() : null,
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
          // url / coverUrl stay full size for the website; the app uses the lighter thumb fields.
          return {
            id: slug,
            title,
            count: photos.length,
            coverUrl: `${cover}?format=1200w`,
            coverThumb: `${cover}?format=750w`,
            images: photos.map((url) => ({ id: url.split('/').pop(), url: sized(url), thumb: `${url}?format=750w`, full: `${url}?format=1500w` })),
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
  // Public /labels form: 5 submissions per IP per hour, before the body is parsed.
  if (rateLimited(`submit:ip:${clientIp(req)}`, 5, 60 * 60 * 1000)) {
    req.resume();
    sendJson(res, 429, { ok: false, error: 'RATE_LIMIT' });
    return;
  }
  if (!(await driveHealthy())) {
    req.resume();
    sendJson(res, 503, { ok: false, error: 'PENDING', drive: false });
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
    const healthy = await driveHealthy(true);
    sendJson(res, healthy ? 502 : 503, { ok: false, error: healthy ? 'UPLOAD' : 'PENDING' });
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

const ledgerStatus = { sheet: 'off', sheetReadAt: null, sheetError: null };

function rememberLedger(map) {
  ledgerMap = map;
  ledgerAt = Date.now();
}

function loadLedgerFile() {
  try {
    const stamp = statSync(ledgerPath).mtimeMs;
    if (stamp === ledgerFileMtime) return ledgerMap;
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
    rememberLedger(map);
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
  if (ledgerStatus.sheet === 'ok' && Date.now() - ledgerAt < 45_000) return ledgerMap;
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
        ledgerStatus.sheet = 'error';
        ledgerStatus.sheetError = `HTTP ${response.status}`;
        return loadLedgerFile();
      }
      const payload = await response.json();
      // An empty Sheet is a real answer: everyone is on 0 XP (launch reset).
      const map = parseLedgerValues(payload.values);
      rememberLedger(map);
      ledgerStatus.sheet = 'ok';
      ledgerStatus.sheetReadAt = new Date().toISOString();
      ledgerStatus.sheetError = null;
      void refreshOwnedSheet(token);
      void refreshTicketsSheet(token);
      void refreshLoadedSheet(token);
      void flushIssued();
      const emails = {};
      for (const [email, xp] of map) emails[email] = xp;
      mkdirSync(path.dirname(ledgerPath), { recursive: true });
      writeFileSync(ledgerPath, JSON.stringify({ source: 'sheets', updated: new Date().toISOString(), rows: map.size, emails }));
      ledgerFileMtime = statSync(ledgerPath).mtimeMs;
      console.log(`XP ledger ${map.size} emails`);
      return map;
    } catch (error) {
      console.error('XP ledger', error instanceof Error ? error.message : error);
      ledgerStatus.sheet = 'error';
      ledgerStatus.sheetError = error instanceof Error ? error.message : 'error';
      return loadLedgerFile();
    } finally {
      ledgerRefresh = null;
    }
  })();
  return ledgerRefresh;
}

/** "Owned" tab on the XP Sheet: email | item_name (exact wardrobe name) | order_id | purchased_at. */
async function refreshOwnedSheet(token) {
  try {
    const range = encodeURIComponent('Owned!A2:D');
    const response = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${xpSheetId}/values/${range}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) return;
    const payload = await response.json();
    const map = {};
    for (const row of payload.values || []) {
      const key = normalizeEmail(row[0]);
      const name = String(row[1] || '').trim();
      if (key.includes('@') && name) (map[key] ||= []).push(name);
    }
    setOwnedSheet(map);
  } catch {
    // tab is optional
  }
}

/**
 * "Tickets" tab on the XP Sheet (optional): email | skiddle_event_id | order_id | purchased_at.
 * Used only for the VERIFIED tick on GOING lists. Missing tab = nobody is verified.
 */
async function refreshTicketsSheet(token) {
  try {
    const range = encodeURIComponent('Tickets!A2:D');
    const response = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${xpSheetId}/values/${range}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) return;
    const payload = await response.json();
    social.setTicketOrders(payload.values || []);
  } catch {
    // tab is optional
  }
}

/** "Loaded" tab on the XP Sheet: column A = a code that exists in Squarespace (row 1 is a header). */
async function refreshLoadedSheet(token) {
  try {
    const range = encodeURIComponent('Loaded!A2:A');
    const response = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${xpSheetId}/values/${range}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) return;
    const payload = await response.json();
    setLoadedSheet((payload.values || []).map((row) => row[0]));
  } catch {
    // tab is optional; CREW_CODES_LOADED env still applies
  }
}

/** Appends crew-up code rows to the "Issued" tab (columns in crew-config issuedColumns). */
async function appendIssuedRows(rows) {
  const token = await accessToken();
  const range = encodeURIComponent('Issued!A1');
  const response = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${xpSheetId}/values/${range}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: rows }),
    },
  );
  if (!response.ok) throw new Error(`Issued append ${response.status}`);
}

function ledgerHealth() {
  let fileUpdated = null;
  try {
    const raw = JSON.parse(readFileSync(ledgerPath, 'utf8'));
    fileUpdated = raw.updated || new Date(statSync(ledgerPath).mtimeMs).toISOString();
  } catch {
    fileUpdated = null;
  }
  const newest = ledgerStatus.sheetReadAt || fileUpdated;
  return {
    sheet: oauthConfig() ? ledgerStatus.sheet : 'off',
    sheetReadAt: ledgerStatus.sheetReadAt,
    sheetError: ledgerStatus.sheetError,
    fileUpdatedAt: fileUpdated,
    rows: ledgerMap.size,
    issuedQueued: issuedQueueLength(),
    crewCodes: codePoolStatus(),
    push: pushStatus(),
    stale: !newest || Date.now() - Date.parse(newest) > 24 * 60 * 60 * 1000,
  };
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

const revokedPath = path.join(dataDir, 'revoked.json');
let revoked = {};
try {
  revoked = JSON.parse(readFileSync(revokedPath, 'utf8')) || {};
} catch {
  revoked = {};
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
    const email = normalizeEmail(payload.email);
    // A token signed before the account was deleted no longer works.
    if (revoked[email] && payload.exp - sessionTtlMs <= revoked[email]) return null;
    return email;
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
  if (!accounts[key]) accounts[key] = { xp: 0, fit: emptyFit(), createdAt: new Date().toISOString() };
  accounts[key].fit = cleanFit(accounts[key].fit);
  accounts[key].xp = Math.max(0, Math.floor(Number(accounts[key].xp) || 0));
  const stored = validAvatarBase(accounts[key].avatarBase);
  if (stored) accounts[key].avatarBase = stored;
  else if (Object.prototype.hasOwnProperty.call(accounts[key], 'avatarBase')) delete accounts[key].avatarBase;
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
  // Opt-in PIN: only accounts that have set one need it. Build 6 never sends `pin`.
  const existing = existingAccount(email);
  if (existing && hasPin(existing)) {
    if (body.pin === undefined || body.pin === null || body.pin === '') {
      sendJson(res, 426, { ok: false, error: 'UPDATE_APP', message: 'UPDATE THE APP TO SIGN IN' });
      return;
    }
    const check = await checkPin(req, email, existing, body.pin);
    if (!check.ok) {
      sendJson(res, check.status, check.payload);
      return;
    }
  }
  await refreshLedger();
  touchDay1(accountFor(email));
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

function crewPayload(email, account) {
  const { payload, changed } = crewState(email, xpFor(email), account);
  if (changed) saveAccounts();
  return { ok: true, email, ...payload };
}

async function handleCrewRead(req, res) {
  const email = readSession(req.headers.authorization);
  if (!email) {
    sendJson(res, 401, { ok: false, error: 'SESSION' });
    return;
  }
  await refreshLedger();
  const account = accountFor(email);
  sendJson(res, 200, crewPayload(email, account));
}

/**
 * Deletes the Crew account: wardrobe, issued-code link and every session token.
 * The XP ledger row is kept only when it comes from the purchase ledger (Sheet);
 * a row that only exists in the local file is removed.
 */
async function handleCrewDelete(req, res) {
  const email = readSession(req.headers.authorization);
  if (!email) {
    sendJson(res, 401, { ok: false, error: 'SESSION' });
    return;
  }
  const { ledgerKept } = deleteCrewAccount(email);
  console.log(`Crew account deleted (ledger ${ledgerKept ? 'kept: purchase records' : 'clear'})`);
  sendJson(res, 200, { ok: true, deleted: true });
}

/** Removes a Crew account (also used by the admin page). Returns { ledgerKept }. */
function deleteCrewAccount(email) {
  delete accounts[email];
  saveAccounts();
  forgetCodes(email);
  social.forget(email);
  forgetDevices(email);
  revoked[email] = Date.now();
  mkdirSync(path.dirname(revokedPath), { recursive: true });
  writeFileSync(revokedPath, JSON.stringify(revoked));
  let ledgerKept = false;
  try {
    const raw = JSON.parse(readFileSync(ledgerPath, 'utf8'));
    if (raw && raw.emails && Object.prototype.hasOwnProperty.call(raw.emails, email)) {
      if (raw.source === 'sheets') {
        ledgerKept = true;
      } else {
        delete raw.emails[email];
        raw.rows = Object.keys(raw.emails).length;
        writeFileSync(ledgerPath, JSON.stringify(raw));
        ledgerMap.delete(email);
      }
    }
  } catch {
    // no ledger file
  }
  return { ledgerKept };
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
  const xp = xpFor(email);
  if (body.fit) account.fit = validFit(cleanFit(body.fit), xp, ownedFor(email));
  if (body.avatarBase !== undefined) {
    const next = validAvatarBase(body.avatarBase);
    if (!next) {
      sendJson(res, 400, { ok: false, error: 'AVATAR_BASE' });
      return;
    }
    account.avatarBase = next;
    account.avatarBaseSet = true;
  }
  acknowledge(account, xp, body.ack);
  saveAccounts();
  sendJson(res, 200, crewPayload(email, account));
}


const siteOrigins = new Set(['https://recklessraves.co.uk', 'https://www.recklessraves.co.uk']);
const writeHits = new Map();
const writeLimitMax = 30;
const writeLimitWindowMs = 60 * 1000;

function clientIp(req) {
  return String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim() || 'unknown';
}

function rateLimited(key, max = writeLimitMax, windowMs = writeLimitWindowMs) {
  const now = Date.now();
  const hits = (writeHits.get(key) || []).filter((at) => now - at < windowMs);
  if (hits.length >= max) {
    writeHits.set(key, hits);
    return true;
  }
  hits.push(now);
  writeHits.set(key, hits);
  return false;
}

function sendAvatarJson(req, res, status, payload, { open = false } = {}) {
  const body = JSON.stringify(payload);
  const origin = String(req.headers.origin || '');
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
  if (open) {
    headers['Access-Control-Allow-Origin'] = '*';
  } else if (siteOrigins.has(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Vary'] = 'Origin';
  } else if (origin) {
    headers['Vary'] = 'Origin';
  }
  res.writeHead(status, headers);
  res.end(body);
}

function existingAccount(email) {
  const key = normalizeEmail(email);
  return Object.prototype.hasOwnProperty.call(accounts, key) ? accountFor(key) : null;
}

function handleAvatarBaseOptions(req, res) {
  const origin = String(req.headers.origin || '');
  const headers = {
    'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
  const requestMethod = String(req.headers['access-control-request-method'] || '').toUpperCase();
  if (requestMethod === 'PUT') {
    if (siteOrigins.has(origin)) headers['Access-Control-Allow-Origin'] = origin;
    headers['Vary'] = 'Origin';
  } else {
    headers['Access-Control-Allow-Origin'] = '*';
  }
  res.writeHead(204, headers);
  res.end();
}

function handleAvatarBaseRead(req, res, url) {
  const email = normalizeEmail(url.searchParams.get('email'));
  if (!validEmail(email)) {
    sendAvatarJson(req, res, 400, { ok: false, error: 'EMAIL' }, { open: true });
    return;
  }
  const account = existingAccount(email);
  sendAvatarJson(req, res, 200, { avatarBase: explicitAvatarBase(account) }, { open: true });
}

async function handleAvatarBaseWrite(req, res, url) {
  const email = normalizeEmail(url.searchParams.get('email'));
  if (!validEmail(email)) {
    sendAvatarJson(req, res, 400, { ok: false, error: 'EMAIL' });
    return;
  }
  if (rateLimited(`avatar-base:ip:${clientIp(req)}`) || rateLimited(`avatar-base:email:${email}`)) {
    sendAvatarJson(req, res, 429, { ok: false, error: 'RATE' });
    return;
  }
  let body;
  try {
    body = await readJson(req);
  } catch {
    sendAvatarJson(req, res, 400, { ok: false, error: 'AVATAR_BASE' });
    return;
  }
  const next = validAvatarBase(body?.avatarBase);
  if (!next) {
    sendAvatarJson(req, res, 400, { ok: false, error: 'AVATAR_BASE' });
    return;
  }
  const existing = existingAccount(email);
  if (existing && hasPin(existing)) {
    if (body?.pin === undefined || body?.pin === null || body?.pin === '') {
      sendAvatarJson(req, res, 401, { ok: false, error: 'PIN_REQUIRED', message: 'PIN REQUIRED' });
      return;
    }
    const check = await checkPin(req, email, existing, body.pin);
    if (!check.ok) {
      sendAvatarJson(req, res, check.status, check.payload);
      return;
    }
  }
  const account = accountFor(email);
  account.avatarBase = next;
  account.avatarBaseSet = true;
  saveAccounts();
  sendAvatarJson(req, res, 200, { avatarBase: account.avatarBase });
}

/*
 * Opt-in 4-digit account PIN. Stored on the account row as `pinHash`
 * ("scrypt$<saltB64>$<hashB64>"); the PIN itself is never stored, logged or returned.
 * Wrong tries are counted per email on the row (`pinFails`, `pinLockedUntil`):
 * 5 wrong tries lock the email for 15 minutes, even for the right PIN.
 * Wrong tries are also limited per IP (20 per 15 minutes).
 */
const pinPattern = /^\d{4}$/;
const pinMaxFails = 5;
const pinLockMs = 15 * 60 * 1000;
const pinIpMax = 20;
const pinIpWindowMs = 15 * 60 * 1000;
const pinFailsByIp = new Map();

function pinSetupLive() {
  return ['1', 'true', 'yes', 'on'].includes(String(process.env.PIN_SETUP_LIVE || '').trim().toLowerCase());
}

function hasPin(account) {
  return Boolean(account && typeof account.pinHash === 'string' && account.pinHash.startsWith('scrypt$'));
}

function scryptAsync(pin, salt) {
  return new Promise((resolve, reject) => {
    scrypt(String(pin), salt, 32, { N: 16384, r: 8, p: 1 }, (error, key) => (error ? reject(error) : resolve(key)));
  });
}

async function hashPin(pin) {
  const salt = randomBytes(16);
  const key = await scryptAsync(pin, salt);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

async function pinMatches(account, pin) {
  if (!hasPin(account) || typeof pin !== 'string' || !pinPattern.test(pin)) return false;
  const [, saltB64, hashB64] = account.pinHash.split('$');
  const want = Buffer.from(hashB64 || '', 'base64');
  const got = await scryptAsync(pin, Buffer.from(saltB64 || '', 'base64'));
  return want.length === got.length && timingSafeEqual(want, got);
}

function pinLockLeftMs(account) {
  const until = Number(account.pinLockedUntil) || 0;
  return until > Date.now() ? until - Date.now() : 0;
}

function pinIpBlocked(ip) {
  const now = Date.now();
  const hits = (pinFailsByIp.get(ip) || []).filter((at) => now - at < pinIpWindowMs);
  pinFailsByIp.set(ip, hits);
  return hits.length >= pinIpMax;
}

const lockedPayload = (account) => ({
  ok: false,
  error: 'LOCKED',
  message: 'LOCKED, TRY AGAIN IN 15 MINUTES',
  retryAfterSeconds: Math.ceil(pinLockLeftMs(account) / 1000),
});

/** Checks a PIN for an account that has one, applying the per-email lockout and per-IP limit. */
async function checkPin(req, email, account, pin) {
  if (pinLockLeftMs(account)) return { ok: false, status: 429, payload: lockedPayload(account) };
  const ip = clientIp(req);
  if (pinIpBlocked(ip)) return { ok: false, status: 429, payload: { ok: false, error: 'LIMIT', message: 'TOO MANY TRIES, TRY AGAIN LATER' } };
  if (await pinMatches(account, typeof pin === 'number' ? String(pin).padStart(4, '0') : pin)) {
    if (account.pinFails || account.pinLockedUntil) {
      delete account.pinFails;
      delete account.pinLockedUntil;
      saveAccounts();
    }
    return { ok: true };
  }
  pinFailsByIp.get(ip).push(Date.now());
  // An expired lock starts a fresh count.
  if (account.pinLockedUntil) {
    delete account.pinLockedUntil;
    account.pinFails = 0;
  }
  account.pinFails = (Number(account.pinFails) || 0) + 1;
  if (account.pinFails >= pinMaxFails) {
    account.pinLockedUntil = Date.now() + pinLockMs;
    account.pinFails = 0;
    saveAccounts();
    console.log('PIN lockout (5 wrong tries)');
    return { ok: false, status: 429, payload: lockedPayload(account) };
  }
  saveAccounts();
  return { ok: false, status: 401, payload: { ok: false, error: 'WRONG_PIN', message: 'WRONG PIN', triesLeft: pinMaxFails - account.pinFails } };
}

function sendPinJson(req, res, status, payload) {
  const body = JSON.stringify(payload);
  const origin = String(req.headers.origin || '');
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    Vary: 'Origin',
  };
  if (siteOrigins.has(origin)) headers['Access-Control-Allow-Origin'] = origin;
  res.writeHead(status, headers);
  res.end(body);
}

function handlePinOptions(req, res) {
  const origin = String(req.headers.origin || '');
  const headers = {
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
  if (siteOrigins.has(origin)) headers['Access-Control-Allow-Origin'] = origin;
  res.writeHead(204, headers);
  res.end();
}

function handlePinStatus(req, res, url) {
  const email = normalizeEmail(url.searchParams.get('email'));
  if (!validEmail(email)) {
    sendPinJson(req, res, 400, { ok: false, error: 'EMAIL' });
    return;
  }
  if (rateLimited(`pin-status:ip:${clientIp(req)}`, 60)) {
    sendPinJson(req, res, 429, { ok: false, error: 'RATE' });
    return;
  }
  sendPinJson(req, res, 200, { ok: true, hasPin: hasPin(existingAccount(email)), setupLive: pinSetupLive() });
}

/** POST /api/crew/pin?email= { pin } sets a first PIN; { currentPin, pin } changes it. */
async function handlePinSet(req, res, url) {
  const email = normalizeEmail(url.searchParams.get('email'));
  if (!validEmail(email)) {
    sendPinJson(req, res, 400, { ok: false, error: 'EMAIL' });
    return;
  }
  // Dormant until PIN_SETUP_LIVE=1: only the admin key (X-Admin-Key) can set a PIN meanwhile.
  if (!pinSetupLive() && !adminKeyOk(String(req.headers['x-admin-key'] || ''))) {
    sendPinJson(req, res, 403, { ok: false, error: 'PIN_SETUP_NOT_LIVE', message: 'PIN SETUP IS NOT LIVE YET' });
    return;
  }
  if (rateLimited(`pin-set:ip:${clientIp(req)}`) || rateLimited(`pin-set:email:${email}`)) {
    sendPinJson(req, res, 429, { ok: false, error: 'RATE' });
    return;
  }
  let body;
  try {
    body = await readJson(req);
  } catch {
    sendPinJson(req, res, 400, { ok: false, error: 'PIN_FORMAT', message: 'PIN MUST BE 4 DIGITS' });
    return;
  }
  const pin = typeof body?.pin === 'string' ? body.pin : '';
  if (!pinPattern.test(pin)) {
    sendPinJson(req, res, 400, { ok: false, error: 'PIN_FORMAT', message: 'PIN MUST BE 4 DIGITS' });
    return;
  }
  const existing = existingAccount(email);
  if (existing && hasPin(existing)) {
    if (body.currentPin === undefined || body.currentPin === null || body.currentPin === '') {
      sendPinJson(req, res, 409, { ok: false, error: 'PIN_SET', message: 'PIN ALREADY SET' });
      return;
    }
    const check = await checkPin(req, email, existing, body.currentPin);
    if (!check.ok) {
      sendPinJson(req, res, check.status, check.payload);
      return;
    }
    existing.pinHash = await hashPin(pin);
    existing.pinSetAt = new Date().toISOString();
    saveAccounts();
    sendPinJson(req, res, 200, { ok: true, hasPin: true, changed: true });
    return;
  }
  const account = accountFor(email);
  account.pinHash = await hashPin(pin);
  account.pinSetAt = new Date().toISOString();
  delete account.pinFails;
  delete account.pinLockedUntil;
  saveAccounts();
  sendPinJson(req, res, 200, { ok: true, hasPin: true, changed: false });
}

/** DELETE /api/crew/pin?email= with X-Admin-Key (OAUTH_ADMIN_KEY): clears the PIN and any lockout. */
function handlePinReset(req, res, url) {
  const given = String(req.headers['x-admin-key'] || url.searchParams.get('key') || '');
  if (!adminKeyOk(given)) {
    sendJson(res, 403, { ok: false, error: 'ADMIN' });
    return;
  }
  const email = normalizeEmail(url.searchParams.get('email'));
  if (!validEmail(email)) {
    sendJson(res, 400, { ok: false, error: 'EMAIL' });
    return;
  }
  const account = existingAccount(email);
  const had = hasPin(account);
  if (account) {
    delete account.pinHash;
    delete account.pinSetAt;
    delete account.pinFails;
    delete account.pinLockedUntil;
    saveAccounts();
  }
  console.log(`PIN admin reset (${had ? 'cleared' : 'no PIN'})`);
  sendJson(res, 200, { ok: true, hasPin: false, cleared: had });
}

/* ---------- Push notifications ---------- */

/** POST /api/push/register { token, platform, deviceId, topics? }; signed-in fans send Authorization. DELETE { token } removes it. */
async function handlePushRegister(req, res) {
  if (rateLimited(`push:ip:${clientIp(req)}`)) {
    sendJson(res, 429, { ok: false, error: 'RATE' });
    return;
  }
  let body;
  try {
    body = await readJson(req);
  } catch {
    sendJson(res, 400, { ok: false, error: 'TOKEN' });
    return;
  }
  const token = String(body?.token || '');
  if (!validPushToken(token)) {
    sendJson(res, 400, { ok: false, error: 'TOKEN' });
    return;
  }
  if (req.method === 'DELETE') {
    sendJson(res, 200, { ok: true, removed: unregisterDevice(token) });
    return;
  }
  const email = req.headers.authorization ? readSession(req.headers.authorization) : null;
  const row = registerDevice({ token, email, platform: body.platform, deviceId: body.deviceId, topics: body.topics });
  sendJson(res, 200, { ok: true, signedIn: Boolean(row.email), topics: row.topics });
}

/**
 * POST /api/push/send (X-Admin-Key) { title, body, data?, tokens? | emails? | topic? | all: true, dryRun? }.
 * Fans are only reached when PUSH_LIVE=1; otherwise it is a dry run unless explicit test tokens are named
 * (or test: true with exactly one email that has 1-3 devices).
 */
async function handlePushSend(req, res) {
  if (!adminKeyOk(String(req.headers['x-admin-key'] || ''))) {
    sendJson(res, 401, { ok: false, error: 'ADMIN' });
    return;
  }
  let body;
  try {
    body = await readJson(req);
  } catch {
    sendJson(res, 400, { ok: false, error: 'BODY' });
    return;
  }
  const title = String(body?.title || '').trim().toUpperCase().slice(0, 60);
  const text = String(body?.body || '').trim().toUpperCase().slice(0, 180);
  if (!title || !text) {
    sendJson(res, 400, { ok: false, error: 'MESSAGE' });
    return;
  }
  // A test send to one named email's devices (max 3) counts as explicit, so it works while PUSH_LIVE is off.
  const testOne = body.test === true && Array.isArray(body.emails) && body.emails.length === 1 && !body.topic && body.all !== true;
  const tokens = targetTokens(body);
  const explicit = (Array.isArray(body.tokens) && body.tokens.length > 0) || (testOne && tokens.length > 0 && tokens.length <= 3);
  if (!tokens.length) {
    sendJson(res, 400, { ok: false, error: 'TARGET', message: 'NAME tokens, emails, topic OR all: true' });
    return;
  }
  const dryRun = body.dryRun !== false || (!pushLive() && !explicit);
  const result = await sendPush(tokens, { title, body: text, data: body.data && typeof body.data === 'object' ? body.data : {} }, { dryRun });
  console.log(`Admin push: ${result.dryRun ? 'dry run' : 'sent'} ${result.sent}/${result.count}`);
  sendJson(res, 200, { ok: true, live: pushLive(), ...result });
}

async function runLevelUpPushes() {
  try {
    await refreshLedger();
    await checkLevelUps({ accounts, xpFor, standing, save: saveAccounts });
  } catch (error) {
    console.error('Level-up push check', error instanceof Error ? error.message : error);
  }
}

/**
 * One-shot launch reset. Set env CREW_RESET_ID to any new value (e.g. "launch-2026-11-21")
 * and redeploy: on boot the server clears /data/xp-ledger.json and every saved outfit and
 * popup marker, then records the id so it never runs twice. Also: node server/scripts/launch-reset.mjs
 */
function sendGameJson(res, status, payload) {
  res.setHeader('Cache-Control', 'no-store');
  sendJson(res, status, payload);
}

function gameEventsOptions(res) {
  res.writeHead(204, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Admin-Key',
    'Access-Control-Max-Age': '86400',
  });
  res.end();
}

function gameIpLimited(req, res, bucket) {
  if (rateLimited(`${bucket}:ip:${clientIp(req)}`, gameXp.rate.ipMax, gameXp.rate.windowMs)) {
    sendGameJson(res, 429, { ok: false, error: 'RATE' });
    return true;
  }
  return false;
}

function gameEmailLimited(req, res, email) {
  if (rateLimited(`game-events:email:${email}`, gameXp.rate.emailMax, gameXp.rate.windowMs)) {
    sendGameJson(res, 429, { ok: false, error: 'RATE' });
    return true;
  }
  return false;
}

function gameCrewEmail(req, res) {
  const email = readSession(req.headers.authorization);
  if (!email) {
    sendGameJson(res, 401, { ok: false, error: 'SESSION' });
    return null;
  }
  return email;
}

async function readGameBody(req, res) {
  try {
    const body = await readJson(req);
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      sendGameJson(res, 400, { ok: false, error: 'BODY' });
      return null;
    }
    return body;
  } catch {
    sendGameJson(res, 400, { ok: false, error: 'BODY' });
    return null;
  }
}

function dropGameBody(req) {
  req.resume();
}

async function handleGameRaveStart(req, res) {
  try {
    if (gameIpLimited(req, res, 'game-events')) {
      dropGameBody(req);
      return;
    }
    const email = gameCrewEmail(req, res);
    if (!email || gameEmailLimited(req, res, email)) {
      dropGameBody(req);
      return;
    }
    const body = await readGameBody(req, res);
    if (!body) return;
    const result = startRave({ email, raveId: body.raveId });
    sendGameJson(res, result.status, result.body);
  } catch (error) {
    console.error('game rave start', error instanceof Error ? error.message : error);
    if (!res.headersSent) sendGameJson(res, 500, { ok: false, error: 'SERVER' });
  }
}

async function handleGameRaveFinish(req, res) {
  try {
    if (gameIpLimited(req, res, 'game-events')) {
      dropGameBody(req);
      return;
    }
    const email = gameCrewEmail(req, res);
    if (!email || gameEmailLimited(req, res, email)) {
      dropGameBody(req);
      return;
    }
    const body = await readGameBody(req, res);
    if (!body) return;
    const result = finishRave({ email, sessionId: body.sessionId });
    sendGameJson(res, result.status, result.body);
  } catch (error) {
    console.error('game rave finish', error instanceof Error ? error.message : error);
    if (!res.headersSent) sendGameJson(res, 500, { ok: false, error: 'SERVER' });
  }
}

async function handleGamePoster(req, res) {
  try {
    if (gameIpLimited(req, res, 'game-events')) {
      dropGameBody(req);
      return;
    }
    const email = gameCrewEmail(req, res);
    if (!email || gameEmailLimited(req, res, email)) {
      dropGameBody(req);
      return;
    }
    const body = await readGameBody(req, res);
    if (!body) return;
    const result = postPoster({ email, type: body.type, posterId: body.posterId });
    sendGameJson(res, result.status, result.body);
  } catch (error) {
    console.error('game poster', error instanceof Error ? error.message : error);
    if (!res.headersSent) sendGameJson(res, 500, { ok: false, error: 'SERVER' });
  }
}

function handleGameMe(req, res) {
  try {
    if (gameIpLimited(req, res, 'game-events')) return;
    const email = gameCrewEmail(req, res);
    if (!email || gameEmailLimited(req, res, email)) return;
    sendGameJson(res, 200, eventsForEmail(email));
  } catch (error) {
    console.error('game events me', error instanceof Error ? error.message : error);
    if (!res.headersSent) sendGameJson(res, 500, { ok: false, error: 'SERVER' });
  }
}

function handleGameExport(req, res, url) {
  try {
    if (gameIpLimited(req, res, 'game-export')) return;
    if (!adminKeyOk(String(req.headers['x-admin-key'] || ''))) {
      sendGameJson(res, 403, { ok: false, error: 'ADMIN' });
      return;
    }
    const sinceRaw = url.searchParams.get('since');
    let sinceMs = 0;
    if (sinceRaw) {
      sinceMs = Date.parse(sinceRaw);
      if (Number.isNaN(sinceMs)) {
        sendGameJson(res, 400, { ok: false, error: 'SINCE' });
        return;
      }
    }
    const body = exportEventsSince(sinceMs);
    res.writeHead(200, {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'no-store',
    });
    res.end(body);
  } catch (error) {
    console.error('game events export', error instanceof Error ? error.message : error);
    if (!res.headersSent) sendGameJson(res, 500, { ok: false, error: 'SERVER' });
  }
}

function launchReset() {
  const id = (process.env.CREW_RESET_ID || '').trim();
  if (!id) return;
  const markerPath = path.join(dataDir, 'crew-reset.json');
  let done = null;
  try {
    done = JSON.parse(readFileSync(markerPath, 'utf8')).id;
  } catch {
    done = null;
  }
  if (done === id) return;
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(ledgerPath, JSON.stringify({ source: 'reset', updated: new Date().toISOString(), rows: 0, emails: {} }));
  for (const account of Object.values(accounts)) {
    account.fit = emptyFit();
    delete account.fitSet;
    delete account.fitSet;
  delete account.lastLevelSeen;
    delete account.lastCrewSeen;
    account.xp = 0;
  }
  saveAccounts();
  writeFileSync(markerPath, JSON.stringify({ id, at: new Date().toISOString() }));
  console.log(`Crew launch reset ${id}: ledger cleared, outfits cleared`);
}

const social = createSocial({
  dataDir,
  accounts,
  existingAccount,
  accountFor,
  saveAccounts,
  readSession,
  normalizeEmail,
  rateLimited,
  clientIp,
  xpFor,
  refreshLedger,
  standing,
  crewConfig,
  contentEventById,
  contentEvents,
  adminKeyOk,
  sendJson,
  // Check-in QR links: https://<CHECKIN_LINK_BASE or this API's public origin>/checkin/<eventId>/<token>.
  checkinBase: (req) => (process.env.CHECKIN_LINK_BASE || '').trim().replace(/\/$/, '') || (req ? publicOrigin(req) : ''),
});

const reps = createReps({
  dataDir,
  adminKeyOk,
  sendJson,
  contentEventIndex,
  readSession,
  rateLimited,
});

const handleAdmin = createAdmin({
  dataDir,
  authSecret,
  clientIp,
  publicOrigin,
  normalizeEmail,
  validEmail,
  accounts,
  existingAccount,
  saveAccounts,
  hasPin,
  pinLockLeftMs,
  refreshLedger,
  xpFor,
  standing,
  ownedFor,
  storedAvatarBase,
  issuedCodesFor,
  crewConfig,
  deleteCrewAccount,
  pushLive,
  sendPush,
  targetTokens,
  deviceStats,
  devicesForEmail,
  contentEvents,
  exportEventsSince,
  downloadsSummary,
  social,
});

const server = createServer((req, res) => {
  try {
  const url = new URL(req.url || '/', 'http://localhost');
  // Private admin page: no public CORS headers on these responses.
  if (handleAdmin(req, res, url)) return;
  attachCors(res);
  if (social.handle(req, res, url)) return;
  if (reps.handle(req, res, url)) return;
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
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
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
  if (url.pathname === '/api/crew/config' && (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS')) {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS', 'Access-Control-Max-Age': '86400' });
      res.end();
      return;
    }
    sendJson(res, 200, { ok: true, ...crewConfig() });
    return;
  }
  if (url.pathname === '/api/crew/avatar-base') {
    if (req.method === 'OPTIONS') {
      handleAvatarBaseOptions(req, res);
      return;
    }
    if (req.method === 'GET') {
      handleAvatarBaseRead(req, res, url);
      return;
    }
    if (req.method === 'PUT') {
      void handleAvatarBaseWrite(req, res, url);
      return;
    }
    sendAvatarJson(req, res, 405, { ok: false, error: 'METHOD' }, { open: true });
    return;
  }
  if (url.pathname === '/api/crew/pin-status') {
    if (req.method === 'OPTIONS') return handlePinOptions(req, res);
    if (req.method === 'GET') return handlePinStatus(req, res, url);
    sendPinJson(req, res, 405, { ok: false, error: 'METHOD' });
    return;
  }
  if (url.pathname === '/api/crew/pin') {
    if (req.method === 'OPTIONS') return handlePinOptions(req, res);
    if (req.method === 'POST') return void handlePinSet(req, res, url);
    if (req.method === 'DELETE') return handlePinReset(req, res, url);
    sendPinJson(req, res, 405, { ok: false, error: 'METHOD' });
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
  if (url.pathname === '/api/crew' && req.method === 'DELETE') {
    void handleCrewDelete(req, res);
    return;
  }
  if (
    url.pathname === '/api/crew/events' ||
    url.pathname === '/api/crew/events/me' ||
    url.pathname === '/api/crew/events/export' ||
    url.pathname === '/api/crew/events/rave/start' ||
    url.pathname === '/api/crew/events/rave/finish'
  ) {
    if (req.method === 'OPTIONS') {
      gameEventsOptions(res);
      return;
    }
    if (url.pathname === '/api/crew/events/export' && req.method === 'GET') {
      handleGameExport(req, res, url);
      return;
    }
    if (url.pathname === '/api/crew/events/me' && req.method === 'GET') {
      handleGameMe(req, res);
      return;
    }
    if (url.pathname === '/api/crew/events/rave/start' && req.method === 'POST') {
      void handleGameRaveStart(req, res);
      return;
    }
    if (url.pathname === '/api/crew/events/rave/finish' && req.method === 'POST') {
      void handleGameRaveFinish(req, res);
      return;
    }
    if (url.pathname === '/api/crew/events' && req.method === 'POST') {
      void handleGamePoster(req, res);
      return;
    }
    sendGameJson(res, 405, { ok: false, error: 'METHOD' });
    return;
  }
  if (url.pathname === '/avatar/manifest.json') {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS', 'Access-Control-Max-Age': '86400' });
      res.end();
      return;
    }
    res.setHeader('Cache-Control', 'public, max-age=300');
    sendJson(res, 200, avatarManifest(publicOrigin(req), crewConfig().wardrobe));
    return;
  }
  if (url.pathname.startsWith('/avatar/') && (req.method === 'GET' || req.method === 'HEAD')) {
    if (handleAvatarAsset(req, res, url)) return;
  }
  if (url.pathname === '/api/push/register') {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, DELETE, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization' });
      res.end();
      return;
    }
    if (req.method === 'POST' || req.method === 'DELETE') {
      void handlePushRegister(req, res);
      return;
    }
    sendJson(res, 405, { ok: false, error: 'METHOD' });
    return;
  }
  if (url.pathname === '/api/push/send') {
    if (req.method === 'POST') {
      void handlePushSend(req, res);
      return;
    }
    sendJson(res, 405, { ok: false, error: 'METHOD' });
    return;
  }
  if (url.pathname === '/api/health') {
    void submissionStatus().then((status) => sendJson(res, 200, status));
    return;
  }
  if (url.pathname === '/oauth/google/start' && req.method === 'GET') {
    handleOauthStart(req, res, url);
    return;
  }
  if (url.pathname === '/oauth/google/callback' && req.method === 'GET') {
    void handleOauthCallback(req, res, url);
    return;
  }
  if ((url.pathname === '/spin-rules' || url.pathname === '/spin-rules/') && (req.method === 'GET' || req.method === 'HEAD')) {
    const body = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'pages', 'spin-rules.html'));
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=300', 'Access-Control-Allow-Origin': '*' });
    res.end(req.method === 'HEAD' ? undefined : body);
    return;
  }
  if (req.method === 'OPTIONS' && (url.pathname === '/api/content' || url.pathname === '/api/gallery' || url.pathname.startsWith('/api/poster/'))) {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
    });
    res.end();
    return;
  }
  if (url.pathname === '/api/content' && (req.method === 'GET' || req.method === 'HEAD')) {
    void handleContent(req, res, sendJson).catch(() => {
      if (!res.headersSent) sendJson(res, 502, { ok: false, error: 'CONTENT' });
    });
    return;
  }
  if (url.pathname.startsWith('/api/poster/') && (req.method === 'GET' || req.method === 'HEAD')) {
    handlePoster(req, res, url);
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
  } catch (error) {
    console.error('Request failed', error instanceof Error ? error.message : error);
    if (!res.headersSent) sendJson(res, 500, { ok: false, error: 'SERVER' });
  }
});

launchReset();
loadLedgerFile();
initContent(dataDir);
initCrew(dataDir);
initGameEvents(dataDir);
initPush(dataDir);
initDownloads(dataDir);
fillPending();
setInterval(() => void runLevelUpPushes(), 10 * 60 * 1000).unref?.();
setInterval(() => fillPending(), 5 * 60 * 1000).unref?.();
if (xpSheetId) setIssuedWriter(appendIssuedRows);
if (!process.env.AUTH_SECRET) console.error('AUTH_SECRET is not set: sessions use the development secret');

server.listen(port, host, () => {
  console.log(`Reckless site on http://${host}:${port}`);
  void submissionStatus().then((status) => console.log(`Drive submissions: ${status.mode}`));
  console.log(`XP ledger ${ledgerMap.size} emails`);
});
