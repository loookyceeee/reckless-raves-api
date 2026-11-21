// Checks the /admin page against local servers (child processes, temp DATA_DIR).
//   node scripts/admin-check.mjs
// Covers: refuses everything with no ADMIN_PASSWORD, login fail + lock, session cookie flags,
// CSRF/origin rejection, dry-run push (never reaches Expo), push history write, crew actions,
// stats/events/audit, logout revocation, and a password change signing old sessions out.
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = mkdtempSync(path.join(tmpdir(), 'rr-admin-'));
const PASSWORD = 'local-test-password-9f3k';
let failures = 0;
let passes = 0;

function check(cond, label, extra) {
  if (cond) {
    passes += 1;
    console.log(`ok   ${label}`);
  } else {
    failures += 1;
    console.log(`FAIL ${label}${extra !== undefined ? ` :: ${typeof extra === 'string' ? extra : JSON.stringify(extra)}` : ''}`);
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

// Seed data: three fake devices (never valid Expo tokens on the network; every send here is a dry run).
writeFileSync(
  path.join(dataDir, 'push-devices.json'),
  JSON.stringify({
    'ExponentPushToken[testtokenAAAAAAAA1]': { email: 'fan.one@example.com', platform: 'ios', topics: ['drops', 'events', 'crew'] },
    'ExponentPushToken[testtokenAAAAAAAA2]': { email: null, platform: 'android', topics: ['drops', 'events', 'crew'] },
    'ExponentPushToken[testtokenAAAAAAAA3]': { email: 'loookyceeee@example.com', platform: 'ios', topics: ['drops', 'events', 'crew'] },
  }),
);
writeFileSync(
  path.join(dataDir, 'accounts.json'),
  JSON.stringify({
    'fan.one@example.com': { xp: 0, fit: { top: null, outer: null, legs: null }, pinHash: 'scrypt$c2FsdA==$aGFzaA==', pinFails: 0, pinLockedUntil: Date.now() + 10 * 60 * 1000, avatarBase: 'female', avatarBaseSet: true },
    'fan.two@example.com': { xp: 0, fit: { top: null, outer: null, legs: null } },
  }),
);
writeFileSync(
  path.join(dataDir, 'game-events.jsonl'),
  `${JSON.stringify({ id: 'wp:p1:abc', type: 'poster_placed', email: 'fan.one@example.com', posterId: 'p1', at: new Date().toISOString(), counted: true, reason: null, test: false })}\n`,
);

async function start(env) {
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(root, 'server', 'serve.mjs')], {
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      PORT: String(port),
      HOST: '127.0.0.1',
      DATA_DIR: dataDir,
      AUTH_SECRET: 'local-admin-check-secret',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/admin/app.css`);
      if (res.ok) return { base, child, log: () => log };
    } catch {
      // not yet
    }
    await new Promise((r) => setTimeout(r, 60));
  }
  child.kill();
  throw new Error(`server did not start\n${log}`);
}

function cookieFrom(res, name) {
  const all = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie') || ''];
  const line = all.find((c) => c.startsWith(`${name}=`));
  return line ? { value: line.split(';')[0].slice(name.length + 1), line } : null;
}

async function loginPage(base, ip = '10.0.0.1') {
  const res = await fetch(`${base}/admin/login`, { headers: { 'X-Forwarded-For': ip } });
  const html = await res.text();
  const pre = /name="pre" value="([^"]+)"/.exec(html)?.[1];
  return { res, html, pre, preCookie: cookieFrom(res, '__Host-rr_admin_pre')?.value };
}

async function login(base, password, { ip = '10.0.0.1', origin = base, pre, preCookie } = {}) {
  if (!pre) ({ pre, preCookie } = await loginPage(base, ip));
  return fetch(`${base}/admin/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-Forwarded-For': ip,
      Origin: origin,
      Cookie: `__Host-rr_admin_pre=${preCookie}`,
    },
    body: new URLSearchParams({ pre, password }).toString(),
  });
}

// ---------- 1) ADMIN_PASSWORD unset: everything refused ----------
{
  const s = await start({});
  const base = s.base;
  const r1 = await fetch(`${base}/admin`, { redirect: 'manual' });
  check(r1.status === 303 && r1.headers.get('location') === '/admin/login', 'unset: /admin redirects to login');
  const page = await loginPage(base);
  check(page.res.status === 503 && page.html.includes('ADMIN_PASSWORD IS NOT SET'), 'unset: login page says admin is off (503)');
  const r2 = await login(base, 'anything', { pre: page.pre, preCookie: page.preCookie });
  check(r2.status === 503, 'unset: login POST refused (503)', r2.status);
  const r3 = await login(base, '', { pre: page.pre, preCookie: page.preCookie });
  check(r3.status === 503, 'unset: empty password refused');
  const r4 = await fetch(`${base}/admin/api/stats`, { headers: { Cookie: '__Host-rr_admin=forged.sig' } });
  check(r4.status === 401 && (await r4.json()).error === 'ADMIN_OFF', 'unset: API refused (401 ADMIN_OFF)');
  s.child.kill();
}

// ---------- 2) ADMIN_PASSWORD set ----------
let s = await start({ ADMIN_PASSWORD: PASSWORD });
let base = s.base;
{
  const page = await loginPage(base);
  check(page.res.status === 200, 'login page loads');
  check(/no-store/.test(page.res.headers.get('cache-control') || ''), 'login page Cache-Control no-store');
  check(/noindex/.test(page.res.headers.get('x-robots-tag') || '') && page.html.includes('noindex'), 'login page noindex (header + meta)');
  check(!page.res.headers.get('access-control-allow-origin'), 'no public CORS header on admin');
  check(!page.html.includes(PASSWORD), 'password never in page');

  const noPre = await fetch(`${base}/admin/login`, {
    method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: base, 'X-Forwarded-For': '10.0.0.9' },
    body: `password=${PASSWORD}`,
  });
  check(noPre.status === 403, 'login without CSRF token refused (403)', noPre.status);
  check(page.res.headers.get('referrer-policy') === 'same-origin', 'Referrer-Policy same-origin (keeps a real Origin header on POSTs)');
  const nullOrigin = await login(base, PASSWORD, { origin: 'null', ip: '10.0.0.9' });
  check(nullOrigin.status === 403, 'login with Origin: null refused (403)', nullOrigin.status);
  const evilOrigin = await login(base, PASSWORD, { origin: 'https://evil.example', ip: '10.0.0.9' });
  check(evilOrigin.status === 403, 'login from another origin refused (403)', evilOrigin.status);

  const statuses = [];
  for (let i = 0; i < 5; i += 1) statuses.push((await login(base, 'wrong-password', { ip: '10.0.0.5' })).status);
  check(statuses.every((st) => st === 401), 'wrong password refused 5x (401)', statuses);
  const locked = await login(base, PASSWORD, { ip: '10.0.0.5' });
  check(locked.status === 429, '6th try locked even with the right password (429)', locked.status);
}

const good = await login(base, PASSWORD, { ip: '10.0.0.6' });
const sess = cookieFrom(good, '__Host-rr_admin');
check(good.status === 303 && good.headers.get('location') === '/admin', 'right password signs in (303 /admin)', good.status);
check(sess && /HttpOnly/i.test(sess.line) && /Secure/i.test(sess.line) && /SameSite=Strict/i.test(sess.line) && /Max-Age=2592000/.test(sess.line), 'session cookie HttpOnly + Secure + SameSite=Strict + 30 days', sess?.line);
const cookie = `__Host-rr_admin=${sess?.value}`;

const adminRes = await fetch(`${base}/admin`, { headers: { Cookie: cookie } });
const adminHtml = await adminRes.text();
const csrf = /name="csrf-token" content="([^"]+)"/.exec(adminHtml)?.[1];
check(adminRes.status === 200 && csrf, '/admin loads with a session and a CSRF token');
check(!adminHtml.includes(PASSWORD) && !adminHtml.includes('local-admin-check-secret'), 'no secret in admin HTML');
check(/script-src 'self'/.test(adminRes.headers.get('content-security-policy') || ''), 'CSP set');

const tampered = await fetch(`${base}/admin`, { redirect: 'manual', headers: { Cookie: `${cookie.slice(0, -2)}xx` } });
check(tampered.status === 303, 'tampered cookie is signed out');

async function post(pathname, json, { token = csrf, origin = base, ck = cookie } = {}) {
  const res = await fetch(`${base}/admin/api${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: ck, ...(origin ? { Origin: origin } : {}), ...(token ? { 'X-CSRF-Token': token } : {}) },
    body: JSON.stringify(json),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
async function get(pathname, ck = cookie) {
  const res = await fetch(`${base}/admin/api${pathname}`, { headers: { Cookie: ck } });
  const type = res.headers.get('content-type') || '';
  return { status: res.status, body: type.includes('json') ? await res.json() : await res.text(), headers: res.headers };
}

check((await post('/push/check', {}, { token: null })).status === 403, 'POST without CSRF token rejected (403)');
check((await post('/push/check', {}, { token: 'x'.repeat(43) })).status === 403, 'POST with wrong CSRF token rejected (403)');
check((await post('/push/check', {}, { origin: 'https://evil.example' })).status === 403, 'POST from another origin rejected (403)');
check((await post('/push/check', {}, { origin: null })).status === 403, 'POST with no Origin/Referer rejected (403)');
const noSession = await fetch(`${base}/admin/api/push/check`, { method: 'POST', headers: { Origin: base, 'X-CSRF-Token': csrf } });
check(noSession.status === 401, 'POST without a session rejected (401)');

const checkRes = await post('/push/check', {});
check(checkRes.status === 200 && checkRes.body.count === 3 && checkRes.body.live === false, 'dry-run CHECK counts 3 phones, PUSH_LIVE off', checkRes.body);
const targets = await get('/push/targets');
check(targets.body.targets.some((t) => t.path === '/crew') && targets.body.targets.some((t) => t.path === '/music'), 'tap targets list app routes');
const bad = await post('/push/send', { title: 'HI', body: 'THERE', path: '/admin', expect: 3 });
check(bad.status === 400 && bad.body.error === 'PATH', 'unknown tap target refused');
const long = await post('/push/send', { title: 'X'.repeat(61), body: 'THERE', expect: 3 });
check(long.status === 400 && long.body.error === 'TOO_LONG', 'title over 60 refused');
const stale = await post('/push/send', { title: 'ONE WEEK', body: 'TEST', expect: 2 });
check(stale.status === 409 && stale.body.count === 3, 'send with a stale count refused (409)');
const sent = await post('/push/send', { title: 'one week until gearbox.', body: 'tap for tickets', path: '/events', expect: 3 });
check(sent.status === 200 && sent.body.dryRun === true && sent.body.sent === 0 && sent.body.count === 3 && sent.body.title === 'ONE WEEK UNTIL GEARBOX.', 'send with PUSH_LIVE off is a dry run (nothing sent)', sent.body);
const test = await post('/push/test', { title: 'TEST', body: 'ONLY ME', email: 'loookyceeee@example.com', dryRun: true });
check(test.status === 200 && test.body.count === 1 && test.body.dryRun === true, 'test-to-my-phone targets one email (dry run)', test.body);
const noDev = await post('/push/test', { title: 'TEST', body: 'ONLY ME', email: 'nobody@example.com', dryRun: true });
check(noDev.status === 404, 'test to an email with no phones refused');
const history = await get('/push/history');
check(history.body.history.length === 2 && history.body.history[0].kind === 'test' && history.body.history[1].path === '/events', 'push history written (2 rows, newest first)', history.body);
const historyFile = readFileSync(path.join(dataDir, 'push-history.jsonl'), 'utf8');
check(historyFile.trim().split('\n').length === 2 && !historyFile.includes('ExponentPushToken'), 'push-history.jsonl persisted without tokens');

const crew = await get('/crew?email=FAN.ONE@example.com');
check(crew.body.found && crew.body.pin.set && crew.body.pin.locked && crew.body.avatarBase === 'female' && crew.body.devices === 1, 'crew lookup shows PIN, lock, avatar, phones', crew.body);
const missing = await get('/crew?email=ghost@example.com');
check(missing.body.found === false, 'unknown email: not found (no account created)');
const accountsAfterLookup = JSON.parse(readFileSync(path.join(dataDir, 'accounts.json'), 'utf8'));
check(!accountsAfterLookup['ghost@example.com'], 'lookup does not create accounts');
const unlock = await post('/crew/action', { email: 'fan.one@example.com', action: 'unlock-pin' });
check(unlock.status === 200 && unlock.body.wasLocked === true, 'UNLOCK PIN clears the lock');
check((await get('/crew?email=fan.one@example.com')).body.pin.locked === false, 'lock gone after unlock');
const reset = await post('/crew/action', { email: 'fan.one@example.com', action: 'reset-pin' });
check(reset.status === 200 && reset.body.cleared === true && (await get('/crew?email=fan.one@example.com')).body.pin.set === false, 'RESET PIN removes the PIN');
const delBad = await post('/crew/action', { email: 'fan.two@example.com', action: 'delete', confirm: 'fan.one@example.com' });
check(delBad.status === 400, 'DELETE without the typed email refused');
const del = await post('/crew/action', { email: 'fan.two@example.com', action: 'delete', confirm: 'FAN.TWO@example.com' });
check(del.status === 200 && del.body.deleted && !JSON.parse(readFileSync(path.join(dataDir, 'accounts.json'), 'utf8'))['fan.two@example.com'], 'DELETE ACCOUNT removes it after typed confirm');

const stats = await get('/stats');
check(stats.body.crewAccounts === 1 && stats.body.devices.ios === 2 && stats.body.devices.android === 1 && stats.body.gameToday.counted === 1, 'stats: accounts, devices by platform, game today', stats.body);
check(stats.body.flags.PUSH_LIVE === false && 'CREW_RESET_ID' in stats.body.flags && stats.body.downloads.ios.error === 'NO_KEY' && stats.body.downloads.android.devices === 1, 'stats: read-only flags + downloads card (no key here)', stats.body.flags);
const events = await get('/events');
check(events.body.events.length === 1 && events.body.events[0].email === 'fa***@example.com', 'game events listed with masked email', events.body);
const csv = await get('/events.csv');
check(typeof csv.body === 'string' && csv.body.startsWith('at,type,email') && /attachment/.test(csv.headers.get('content-disposition') || ''), 'events CSV download');

const auditFile = readFileSync(path.join(dataDir, 'admin-audit.jsonl'), 'utf8');
check(!auditFile.includes(PASSWORD) && !auditFile.includes('wrong-password') && !auditFile.includes(csrf), 'audit log has no secrets');
const auditApi = await get('/audit');
const actions = auditApi.body.audit.map((row) => row.action);
check(auditApi.body.audit.length === 20 && actions.includes('crew_delete') && actions.includes('pin_reset') && actions.includes('push_send'), 'audit shows the last 20 actions', actions);

// Logout revokes the session.
const logoutBad = await fetch(`${base}/admin/logout`, { method: 'POST', redirect: 'manual', headers: { Cookie: cookie, Origin: base, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'csrf=nope' });
check(logoutBad.status === 403, 'logout without CSRF refused');
const logout = await fetch(`${base}/admin/logout`, { method: 'POST', redirect: 'manual', headers: { Cookie: cookie, Origin: base, 'Content-Type': 'application/x-www-form-urlencoded' }, body: `csrf=${encodeURIComponent(csrf)}` });
check(logout.status === 303 && /Max-Age=0/.test(cookieFrom(logout, '__Host-rr_admin')?.line || ''), 'logout clears the cookie');
check((await get('/stats')).status === 401, 'old cookie refused after logout');
s.child.kill();

// A new ADMIN_PASSWORD signs out old sessions.
s = await start({ ADMIN_PASSWORD: PASSWORD });
base = s.base;
const again = cookieFrom(await login(base, PASSWORD, { ip: '10.0.0.7' }), '__Host-rr_admin');
check((await get('/stats', `__Host-rr_admin=${again.value}`)).status === 200, 'session survives a restart');
s.child.kill();
s = await start({ ADMIN_PASSWORD: `${PASSWORD}-new` });
base = s.base;
check((await get('/stats', `__Host-rr_admin=${again.value}`)).status === 401, 'changing ADMIN_PASSWORD signs old sessions out');
check(!/exp\.host|Admin page push \(all\): sent/.test(s.log()), 'no real push attempted');
s.child.kill();

// Apple sales report parsing (first-time downloads vs updates vs re-downloads, this app only).
const { parseSalesReport } = await import(new URL('../server/downloads.mjs', import.meta.url));
const tsv = 'Provider\tSKU\tUnits\tProduct Type Identifier\tApple Identifier\nAPPLE\ta\t5\t1\t6834422153\nAPPLE\ta\t2\t7\t6834422153\nAPPLE\ta\t1\t3F\t6834422153\nAPPLE\tb\t9\t1\t111\n';
const parsed = parseSalesReport(tsv, '6834422153');
check(parsed.downloads === 5 && parsed.updates === 2 && parsed.redownloads === 1, 'App Store report parsing', parsed);

console.log(`\nadmin-check: ${passes} passed, ${failures} failed (data ${dataDir})`);
process.exit(failures ? 1 : 0);
