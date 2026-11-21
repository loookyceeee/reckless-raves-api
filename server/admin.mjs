// Private admin page for Luke: /admin (notifications, crew lookup, stats, game events, audit log).
// Auth: env ADMIN_PASSWORD (unset = every admin request is refused). Login sets an httpOnly,
// Secure, SameSite=Strict cookie signed with AUTH_SECRET (30 days). POSTs need a same-origin
// Origin/Referer plus a CSRF token tied to the session. No secret is ever sent to the browser.
import { createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const COOKIE = '__Host-rr_admin';
const PRE_COOKIE = '__Host-rr_admin_pre';
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_IP_MAX = 5;
const LOGIN_GLOBAL_MAX = 30;
const TITLE_MAX = 60;
const BODY_MAX = 180;
const DEFAULT_TEST_EMAIL = 'loookyceeee@gmail.com';

const SECURITY_HEADERS = {
  'Cache-Control': 'no-store, max-age=0',
  Pragma: 'no-cache',
  'X-Robots-Tag': 'noindex, nofollow, noarchive',
  // same-origin (not no-referrer): with no-referrer browsers send "Origin: null" on POSTs, which the CSRF check refuses.
  'Referrer-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy':
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
};

const flagOn = (key) => /^(1|true|yes|on)$/i.test(String(process.env[key] || '').trim());
const adminPassword = () => String(process.env.ADMIN_PASSWORD || '');
const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);

export function maskEmail(email) {
  const value = String(email || '');
  const at = value.indexOf('@');
  if (at < 1) return value ? '***' : '';
  const name = value.slice(0, at);
  return `${name.slice(0, Math.min(2, name.length))}***${value.slice(at)}`;
}

function scryptKey(value, salt) {
  return new Promise((resolve, reject) => {
    scrypt(String(value), salt, 32, { N: 16384, r: 8, p: 1 }, (error, key) => (error ? reject(error) : resolve(key)));
  });
}

function londonDay(ms) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
}

export function createAdmin(deps) {
  const {
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
  } = deps;

  const auditPath = path.join(dataDir, 'admin-audit.jsonl');
  const historyPath = path.join(dataDir, 'push-history.jsonl');
  const sessionsPath = path.join(dataDir, 'admin-sessions.json');
  const hmac = (label, value) => createHmac('sha256', authSecret).update(`${label}:${value}`).digest('base64url');
  const salt = randomBytes(16);
  const loginFails = new Map();
  let globalFails = [];

  let revoked = {};
  try {
    revoked = JSON.parse(readFileSync(sessionsPath, 'utf8')).revoked || {};
  } catch {
    revoked = {};
  }
  function saveRevoked() {
    const now = Date.now();
    for (const [nonce, exp] of Object.entries(revoked)) if (exp < now) delete revoked[nonce];
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(sessionsPath, JSON.stringify({ revoked }));
  }

  /* ---------- logs ---------- */

  function appendJsonl(file, row) {
    try {
      mkdirSync(dataDir, { recursive: true });
      appendFileSync(file, `${JSON.stringify(row)}\n`);
    } catch (error) {
      console.error('admin log write failed', error instanceof Error ? error.message : error);
    }
  }
  function readJsonl(file, limit) {
    let text = '';
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      return [];
    }
    const out = [];
    for (const line of text.split('\n')) {
      if (!line) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        // skip
      }
    }
    return out.slice(-limit).reverse();
  }
  function audit(req, action, detail = {}) {
    appendJsonl(auditPath, { at: new Date().toISOString(), action, ip: clientIp(req), ...detail });
  }

  /* ---------- responses ---------- */

  function send(res, status, body, headers = {}) {
    res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Length': Buffer.byteLength(body), ...headers });
    res.end(body);
  }
  function json(res, status, payload, headers = {}) {
    send(res, status, JSON.stringify(payload), { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  }
  function redirect(res, location, headers = {}) {
    res.writeHead(303, { ...SECURITY_HEADERS, Location: location, 'Content-Length': 0, ...headers });
    res.end();
  }

  /* ---------- session ---------- */

  function cookies(req) {
    const out = {};
    for (const part of String(req.headers.cookie || '').split(';')) {
      const eq = part.indexOf('=');
      if (eq > 0) out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
    }
    return out;
  }
  const pwFingerprint = () => hmac('rr-admin-pw', adminPassword()).slice(0, 22);

  function issueSession() {
    const nonce = randomBytes(18).toString('base64url');
    const exp = Date.now() + SESSION_MS;
    const body = Buffer.from(JSON.stringify({ v: 1, n: nonce, exp, pw: pwFingerprint() })).toString('base64url');
    return { token: `${body}.${hmac('rr-admin-session', body)}`, nonce, exp };
  }

  function readAdminSession(req) {
    if (!adminPassword()) return null;
    const token = cookies(req)[COOKIE] || '';
    const dot = token.lastIndexOf('.');
    if (dot <= 0) return null;
    const body = token.slice(0, dot);
    const left = Buffer.from(token.slice(dot + 1));
    const right = Buffer.from(hmac('rr-admin-session', body));
    if (left.length !== right.length || !timingSafeEqual(left, right)) return null;
    try {
      const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
      if (payload.v !== 1 || !payload.n || !(payload.exp > Date.now())) return null;
      if (payload.pw !== pwFingerprint()) return null; // a new ADMIN_PASSWORD signs everyone out
      if (revoked[payload.n]) return null;
      return { nonce: payload.n, exp: payload.exp };
    } catch {
      return null;
    }
  }
  const csrfFor = (session) => hmac('rr-admin-csrf', session.nonce);

  function sameOrigin(req) {
    const want = publicOrigin(req);
    const origin = String(req.headers.origin || '');
    if (origin) return origin === want;
    const referer = String(req.headers.referer || '');
    if (!referer) return false;
    try {
      return new URL(referer).origin === want;
    } catch {
      return false;
    }
  }
  function tokenOk(given, want) {
    const a = Buffer.from(String(given || ''));
    const b = Buffer.from(String(want || ''));
    return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
  }

  function readBody(req, limit = 16 * 1024) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > limit) {
          reject(new Error('TOO_LARGE'));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }

  /* ---------- login ---------- */

  function loginLimited(ip) {
    const now = Date.now();
    const mine = (loginFails.get(ip) || []).filter((at) => now - at < LOGIN_WINDOW_MS);
    loginFails.set(ip, mine);
    globalFails = globalFails.filter((at) => now - at < LOGIN_WINDOW_MS);
    return mine.length >= LOGIN_IP_MAX || globalFails.length >= LOGIN_GLOBAL_MAX;
  }
  function noteLoginFail(ip) {
    const now = Date.now();
    loginFails.get(ip).push(now);
    globalFails.push(now);
  }
  async function passwordOk(given) {
    const want = adminPassword();
    if (!want || typeof given !== 'string' || !given || given.length > 256) return false;
    const [a, b] = await Promise.all([scryptKey(given, salt), scryptKey(want, salt)]);
    return timingSafeEqual(a, b);
  }

  function page(title, bodyHtml, extraHead = '') {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="robots" content="noindex,nofollow"><meta name="referrer" content="same-origin"><meta name="theme-color" content="#000000"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-status-bar-style" content="black"><title>${esc(title)}</title><link rel="stylesheet" href="/admin/app.css">${extraHead}</head><body>${bodyHtml}</body></html>`;
  }

  function loginPage(res, status, message, extraHeaders = {}) {
    const pre = randomBytes(18).toString('base64url');
    const off = !adminPassword();
    const html = page(
      'RECKLESS ADMIN',
      `<main class="login"><h1 class="logo">RECKLESS<br>ADMIN</h1>
${off ? '<p class="msg err">ADMIN IS OFF. ADMIN_PASSWORD IS NOT SET ON THE SERVER.</p>' : ''}
${message ? `<p class="msg err">${esc(message)}</p>` : ''}
<form method="post" action="/admin/login" class="stack" autocomplete="on">
<input type="hidden" name="pre" value="${pre}">
<input type="text" name="username" value="luke" autocomplete="username" class="visually-hidden" tabindex="-1" aria-hidden="true">
<label for="pw">PASSWORD</label>
<input id="pw" name="password" type="password" autocomplete="current-password" required maxlength="256"${off ? ' disabled' : ''}>
<button type="submit" class="btn primary"${off ? ' disabled' : ''}>[ SIGN IN ]</button>
</form><p class="note">PRIVATE. RECKLESS RAVES STAFF ONLY.</p></main>`,
    );
    send(res, status, html, {
      'Content-Type': 'text/html; charset=utf-8',
      'Set-Cookie': `${PRE_COOKIE}=${pre}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=1800`,
      ...extraHeaders,
    });
  }

  async function handleLoginPost(req, res) {
    const ip = clientIp(req);
    let form;
    try {
      form = new URLSearchParams(await readBody(req, 4096));
    } catch {
      loginPage(res, 400, 'BAD REQUEST');
      return;
    }
    if (!adminPassword()) {
      audit(req, 'login_refused', { reason: 'NO_PASSWORD_SET' });
      loginPage(res, 503, 'ADMIN IS OFF');
      return;
    }
    if (!sameOrigin(req) || !tokenOk(form.get('pre'), cookies(req)[PRE_COOKIE])) {
      audit(req, 'login_refused', { reason: 'CSRF' });
      loginPage(res, 403, 'PAGE EXPIRED. TRY AGAIN.');
      return;
    }
    if (loginLimited(ip)) {
      audit(req, 'login_refused', { reason: 'RATE_LIMIT' });
      loginPage(res, 429, 'TOO MANY TRIES. WAIT 15 MINUTES.');
      return;
    }
    if (!(await passwordOk(form.get('password') || ''))) {
      noteLoginFail(ip);
      audit(req, 'login_failed');
      loginPage(res, 401, 'WRONG PASSWORD');
      return;
    }
    loginFails.delete(ip);
    const session = issueSession();
    audit(req, 'login');
    redirect(res, '/admin', {
      'Set-Cookie': [
        `${COOKIE}=${session.token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${Math.floor(SESSION_MS / 1000)}`,
        `${PRE_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`,
      ],
    });
  }

  /* ---------- data ---------- */

  function tapTargets() {
    const targets = [
      { label: 'NO TAP TARGET (OPENS APP)', path: '' },
      { label: 'HOME', path: '/' },
      { label: 'EVENTS', path: '/events' },
    ];
    for (const event of contentEvents()) {
      if (!event.id || !/^[a-z0-9_-]+$/i.test(event.id)) continue;
      const when = event.startDate ? ` (${String(event.startDate).slice(0, 10)})` : '';
      targets.push({ label: `EVENT: ${String(event.title || event.id).toUpperCase()}${event.subtitle ? ` · ${String(event.subtitle).toUpperCase()}` : ''}${when}`, path: `/event/${event.id}` });
    }
    targets.push({ label: 'SHOP', path: '/shop' }, { label: 'CREW', path: '/crew' }, { label: 'RECORDS', path: '/music' }, { label: 'GALLERY', path: '/gallery' });
    return targets;
  }

  function message(body) {
    const title = String(body?.title || '').trim().toUpperCase();
    const text = String(body?.body || '').trim().toUpperCase();
    if (!title || !text) return { error: 'MESSAGE', text: 'ADD A TITLE AND A MESSAGE' };
    if (title.length > TITLE_MAX || text.length > BODY_MAX) return { error: 'TOO_LONG', text: `TITLE MAX ${TITLE_MAX}, MESSAGE MAX ${BODY_MAX}` };
    const tapPath = String(body?.path || '');
    if (tapPath && !tapTargets().some((target) => target.path === tapPath)) return { error: 'PATH', text: 'UNKNOWN TAP TARGET' };
    const data = { type: 'admin' };
    if (tapPath) data.path = tapPath;
    return { title, text, path: tapPath || null, data };
  }

  function gameEvents() {
    const out = [];
    for (const line of exportEventsSince(0).split('\n')) {
      if (!line) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        // skip
      }
    }
    return out;
  }

  function stats() {
    const rows = Object.values(accounts);
    const today = londonDay(Date.now());
    const events = gameEvents().filter((event) => londonDay(Date.parse(event.at)) === today);
    return {
      crewAccounts: rows.length,
      withPin: rows.filter((row) => hasPin(row)).length,
      pinLocked: rows.filter((row) => pinLockLeftMs(row) > 0).length,
      devices: deviceStats(),
      gameToday: {
        recorded: events.length,
        counted: events.filter((event) => event.counted).length,
        countedLive: events.filter((event) => event.counted && !event.test).length,
      },
      flags: {
        PUSH_LIVE: flagOn('PUSH_LIVE'),
        PIN_SETUP_LIVE: flagOn('PIN_SETUP_LIVE'),
        GAME_XP_LIVE: flagOn('GAME_XP_LIVE'),
        CREW_CODES_LIVE: flagOn('CREW_CODES_LIVE'),
        SOCIAL_LIVE: flagOn('SOCIAL_LIVE'),
        CREW_RESET_ID: Boolean(String(process.env.CREW_RESET_ID || '').trim()),
      },
      downloads: { ios: downloadsSummary(), android: { connected: false, devices: deviceStats().android } },
    };
  }

  async function crewLookup(email) {
    await refreshLedger().catch(() => {});
    const account = existingAccount(email);
    const xp = xpFor(email);
    const codes = issuedCodesFor(email);
    const owned = ownedFor(email);
    const devices = devicesForEmail(email);
    if (!account && !xp && !codes.length && !owned.length && !devices) return { ok: true, found: false, email };
    const config = crewConfig() || {};
    const { level, crew } = standing(xp);
    const crews = Array.isArray(config.crews) ? config.crews : [];
    const wardrobe = Array.isArray(config.wardrobe) ? config.wardrobe : [];
    const lockMs = account ? pinLockLeftMs(account) : 0;
    const today = londonDay(Date.now());
    const mine = gameEvents().filter((event) => event.email === email);
    return {
      ok: true,
      found: true,
      email,
      hasAccount: Boolean(account),
      xp,
      level,
      crew: crews[crew]?.name || null,
      avatarBase: account ? storedAvatarBase(account) : null,
      avatarBaseChosen: Boolean(account?.avatarBaseSet),
      day1: Boolean(account?.day1),
      pin: {
        set: hasPin(account),
        setAt: account?.pinSetAt || null,
        locked: lockMs > 0,
        lockedMinutes: Math.ceil(lockMs / 60000),
        wrongTries: Number(account?.pinFails) || 0,
      },
      codes: codes.map((item) => {
        const info = crews.find((entry) => entry.id === item.crew);
        return { code: item.code, crew: info?.name || item.crew, percent: info?.merchPercent ?? null, at: item.at };
      }),
      owned: owned.map((id) => wardrobe.find((piece) => piece.id === id)?.name || id),
      devices,
      game: { total: mine.length, countedToday: mine.filter((event) => event.counted && londonDay(Date.parse(event.at)) === today).length },
      social: social ? social.adminLookup(email) : null,
    };
  }

  /* ---------- API ---------- */

  async function api(req, res, url, session) {
    const route = url.pathname.slice('/admin/api'.length);
    if (req.method === 'GET') {
      if (route === '/stats') return json(res, 200, { ok: true, ...stats() });
      if (route === '/push/targets') return json(res, 200, { ok: true, targets: tapTargets(), titleMax: TITLE_MAX, bodyMax: BODY_MAX, defaultTestEmail: DEFAULT_TEST_EMAIL, live: pushLive() });
      if (route === '/push/history') return json(res, 200, { ok: true, history: readJsonl(historyPath, 30) });
      if (route === '/audit') return json(res, 200, { ok: true, audit: readJsonl(auditPath, 20) });
      if (route === '/events') {
        const latest = gameEvents().slice(-50).reverse().map((event) => ({ type: event.type, email: maskEmail(event.email), at: event.at, counted: Boolean(event.counted), reason: event.reason || null, test: Boolean(event.test) }));
        return json(res, 200, { ok: true, events: latest });
      }
      if (route === '/events.csv') {
        const cell = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`;
        const rows = [['at', 'type', 'email', 'raveId', 'posterId', 'counted', 'reason', 'test'].join(',')];
        for (const event of gameEvents()) rows.push([event.at, event.type, maskEmail(event.email), event.raveId || '', event.posterId || '', event.counted, event.reason || '', event.test].map(cell).join(','));
        audit(req, 'events_csv');
        return send(res, 200, `${rows.join('\n')}\n`, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="game-events-${londonDay(Date.now())}.csv"` });
      }
      if (route === '/social' && social) return json(res, 200, { ok: true, ...social.adminSummary(contentEvents()) });
      if (route === '/crew') {
        const email = normalizeEmail(url.searchParams.get('email'));
        if (!validEmail(email)) return json(res, 400, { ok: false, error: 'EMAIL', message: 'ENTER A VALID EMAIL' });
        audit(req, 'crew_lookup', { email });
        return json(res, 200, await crewLookup(email));
      }
      return json(res, 404, { ok: false, error: 'NOT_FOUND' });
    }
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'METHOD' });
    if (!sameOrigin(req) || !tokenOk(req.headers['x-csrf-token'], csrfFor(session))) {
      audit(req, 'csrf_rejected', { route });
      return json(res, 403, { ok: false, error: 'CSRF', message: 'RELOAD THE PAGE AND TRY AGAIN' });
    }
    let body;
    try {
      const raw = await readBody(req);
      body = raw ? JSON.parse(raw) : {};
    } catch {
      return json(res, 400, { ok: false, error: 'BODY' });
    }

    if (route === '/push/check') {
      const count = targetTokens({ all: true }).length;
      audit(req, 'push_check', { count });
      return json(res, 200, { ok: true, count, live: pushLive() });
    }
    if (route === '/push/send' || route === '/push/test') {
      const msg = message(body);
      if (msg.error) return json(res, 400, { ok: false, error: msg.error, message: msg.text });
      let tokens;
      let dryRun;
      let kind;
      let target = 'all';
      if (route === '/push/send') {
        kind = 'all';
        tokens = targetTokens({ all: true });
        if (Number(body.expect) !== tokens.length) return json(res, 409, { ok: false, error: 'COUNT_CHANGED', count: tokens.length, message: `PHONE COUNT CHANGED TO ${tokens.length}. CHECK AGAIN.` });
        if (!tokens.length) return json(res, 400, { ok: false, error: 'NO_DEVICES', message: 'NO PHONES REGISTERED' });
        // Same rule as POST /api/push/send: fans are only reached when PUSH_LIVE=1.
        dryRun = !pushLive() || body.dryRun === true;
      } else {
        kind = 'test';
        const email = normalizeEmail(body.email || DEFAULT_TEST_EMAIL);
        if (!validEmail(email)) return json(res, 400, { ok: false, error: 'EMAIL', message: 'ENTER A VALID EMAIL' });
        target = email;
        tokens = targetTokens({ emails: [email] });
        if (!tokens.length) return json(res, 404, { ok: false, error: 'NO_DEVICES', message: 'NO PHONES SIGNED IN WITH THAT EMAIL' });
        if (tokens.length > 3) return json(res, 400, { ok: false, error: 'TOO_MANY', message: 'MORE THAN 3 PHONES ON THAT EMAIL' });
        // A test to one email's phones works while PUSH_LIVE is off (same as the API's test: true).
        dryRun = body.dryRun === true;
      }
      const result = await sendPush(tokens, { title: msg.title, body: msg.text, data: msg.data }, { dryRun });
      const errors = (result.errors || []).map((error) => error.error || error.status || 'ERROR');
      const row = { at: new Date().toISOString(), kind, target, title: msg.title, body: msg.text, path: msg.path, count: result.count, sent: result.sent, dryRun: result.dryRun, live: pushLive(), errors };
      appendJsonl(historyPath, row);
      audit(req, kind === 'all' ? 'push_send' : 'push_test', { target, title: msg.title, path: msg.path, count: result.count, sent: result.sent, dryRun: result.dryRun, errors: errors.length });
      console.log(`Admin page push (${kind}): ${result.dryRun ? 'dry run' : 'sent'} ${result.sent}/${result.count}`);
      return json(res, 200, { ok: true, ...row });
    }
    if (route === '/social/code' && social) {
      const result = social.adminNewCode(String(body.eventId || ''));
      if (result.body.ok) audit(req, 'social_checkin_code', { eventId: result.body.eventId });
      return json(res, result.status, result.body);
    }
    if (route === '/crew/action') {
      const email = normalizeEmail(body.email);
      if (!validEmail(email)) return json(res, 400, { ok: false, error: 'EMAIL', message: 'ENTER A VALID EMAIL' });
      const action = String(body.action || '');
      if (social && (action === 'remove-handle' || action === 'remove-photo' || action === 'remove-note')) {
        const result = social.adminAction(email, action, body);
        if (result.body.ok) audit(req, `social_${action.replace('-', '_')}`, { email, ...(result.audit || {}) });
        return json(res, result.status, result.body);
      }
      if (action === 'delete') {
        if (normalizeEmail(body.confirm) !== email) return json(res, 400, { ok: false, error: 'CONFIRM', message: 'TYPE THE EMAIL TO CONFIRM' });
        const result = await deleteCrewAccount(email);
        audit(req, 'crew_delete', { email, ledgerKept: Boolean(result?.ledgerKept) });
        return json(res, 200, { ok: true, deleted: true, ledgerKept: Boolean(result?.ledgerKept) });
      }
      const account = existingAccount(email);
      if (!account) return json(res, 404, { ok: false, error: 'NO_ACCOUNT', message: 'NO ACCOUNT FOR THAT EMAIL' });
      if (action === 'unlock-pin') {
        const was = pinLockLeftMs(account) > 0;
        delete account.pinFails;
        delete account.pinLockedUntil;
        saveAccounts();
        audit(req, 'pin_unlock', { email, wasLocked: was });
        return json(res, 200, { ok: true, unlocked: true, wasLocked: was });
      }
      if (action === 'reset-pin') {
        const had = hasPin(account);
        delete account.pinHash;
        delete account.pinSetAt;
        delete account.pinFails;
        delete account.pinLockedUntil;
        saveAccounts();
        audit(req, 'pin_reset', { email, hadPin: had });
        return json(res, 200, { ok: true, cleared: had });
      }
      return json(res, 400, { ok: false, error: 'ACTION' });
    }
    return json(res, 404, { ok: false, error: 'NOT_FOUND' });
  }

  function adminPage(res, session) {
    const html = page(
      'RECKLESS ADMIN',
      `<header class="top"><span class="logo-sm">RECKLESS ADMIN</span><form method="post" action="/admin/logout"><input type="hidden" name="csrf" value="${csrfFor(session)}"><button class="btn link" type="submit">[ LOG OUT ]</button></form></header>
<nav class="tabs" id="tabs"><button data-tab="notify" class="on">NOTIFY</button><button data-tab="crew">CREW</button><button data-tab="social">SOCIAL</button><button data-tab="stats">STATS</button><button data-tab="events">GAME</button><button data-tab="log">LOG</button></nav>
<main id="app"></main><script src="/admin/app.js"></script>`,
      `<meta name="csrf-token" content="${csrfFor(session)}">`,
    );
    send(res, 200, html, { 'Content-Type': 'text/html; charset=utf-8' });
  }

  function asset(res, name, type) {
    try {
      send(res, 200, readFileSync(path.join(here, 'admin', name)), { 'Content-Type': type });
    } catch {
      send(res, 404, 'Not found', { 'Content-Type': 'text/plain' });
    }
  }

  /** Returns true when the request was an /admin request (handled). */
  return function handleAdmin(req, res, url) {
    const p = url.pathname;
    if (p !== '/admin' && !p.startsWith('/admin/')) return false;
    const run = async () => {
      if (p === '/admin/app.css' && req.method === 'GET') return asset(res, 'app.css', 'text/css; charset=utf-8');
      if (p === '/admin/app.js' && req.method === 'GET') return asset(res, 'app.js', 'text/javascript; charset=utf-8');
      if (p === '/admin/login') {
        if (req.method === 'POST') return handleLoginPost(req, res);
        if (req.method !== 'GET') return send(res, 405, 'Method not allowed', { 'Content-Type': 'text/plain' });
        if (readAdminSession(req)) return redirect(res, '/admin');
        return loginPage(res, adminPassword() ? 200 : 503, '');
      }
      const session = readAdminSession(req);
      if (p === '/admin/logout' && req.method === 'POST') {
        if (session) {
          let form;
          try {
            form = new URLSearchParams(await readBody(req, 4096));
          } catch {
            form = new URLSearchParams();
          }
          if (!sameOrigin(req) || !tokenOk(form.get('csrf'), csrfFor(session))) return json(res, 403, { ok: false, error: 'CSRF' });
          revoked[session.nonce] = session.exp;
          saveRevoked();
          audit(req, 'logout');
        }
        return redirect(res, '/admin/login', { 'Set-Cookie': `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0` });
      }
      if (!session) {
        if (p.startsWith('/admin/api/')) return json(res, 401, { ok: false, error: adminPassword() ? 'SESSION' : 'ADMIN_OFF' });
        return redirect(res, '/admin/login');
      }
      if (p === '/admin' || p === '/admin/') {
        if (req.method !== 'GET') return send(res, 405, 'Method not allowed', { 'Content-Type': 'text/plain' });
        return adminPage(res, session);
      }
      if (p.startsWith('/admin/api/')) return api(req, res, url, session);
      return send(res, 404, 'Not found', { 'Content-Type': 'text/plain' });
    };
    run().catch((error) => {
      console.error('admin request failed', error instanceof Error ? error.message : error);
      if (!res.headersSent) json(res, 500, { ok: false, error: 'SERVER' });
    });
    return true;
  };
}
