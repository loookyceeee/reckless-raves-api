// Checks RECKLESS social phase 1 against local servers (child processes, temp DATA_DIR, no network).
//   node scripts/social-check.mjs
// Covers: SOCIAL_LIVE off = no effect (403 SOCIAL_OFF, nothing written, crew/content unchanged), testers while off
// (XP rows test:true), handle rules, privacy, GOING + VERIFIED, faces, no email in public payloads, check-in codes
// and event-hours window, XP once-only + daily cap, badges from go-live only (no backfill), diary CRUD, photo limits
// + EXIF strip, admin moderation (remove handle/photo/note, codes), account delete, and the admin-key export.
import { spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkHandle } from '../server/social.mjs';

const require = createRequire(import.meta.url);
const sharp = require('sharp');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SECRET = 'local-social-check-secret';
const ADMIN_KEY = 'local-social-admin-key-0123456789abcdef';
const PASSWORD = 'local-social-password-7x2q';
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

/* ---------- 0) handle rules (unit) ---------- */
{
  const cases = [
    ['nova', 'NOVA'], ['N', 'HANDLE_FORMAT'], ['ABCDEFGHIJKLM', 'HANDLE_FORMAT'], ['NO VA', 'HANDLE_FORMAT'], ['NOVA!', 'HANDLE_FORMAT'], ['NÖVA', 'HANDLE_FORMAT'],
    ['___', 'HANDLE_FORMAT'], ['RAVE_KID_1', 'RAVE_KID_1'], ['admin', 'HANDLE_RESERVED'], ['RECKLESS', 'HANDLE_RESERVED'], ['RECK_LESS', 'HANDLE_RESERVED'], ['STAFF', 'HANDLE_RESERVED'],
    ['FUCKBOY', 'HANDLE_BLOCKED'], ['FUCK_', 'HANDLE_BLOCKED'], ['SH1T', 'HANDLE_BLOCKED'], ['C_U_N_T', 'HANDLE_BLOCKED'], ['N1GG4', 'HANDLE_BLOCKED'], ['HUN', 'HANDLE_BLOCKED'], ['SEX', 'HANDLE_BLOCKED'],
    ['GRAPE', 'GRAPE'], ['ESSEX_RAVER', 'ESSEX_RAVER'], ['HUNTER', 'HUNTER'], ['RACCOON', 'RACCOON'], ['KAI', 'KAI'], ['PX', 'PX'],
  ];
  for (const [input, want] of cases) {
    const got = checkHandle(input);
    check((got.handle || got.error) === want, `handle ${JSON.stringify(input)} -> ${want}`, got);
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

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const now = Date.now();
const iso = (ms) => new Date(ms).toISOString();
// Go-live (socialRules.from). Seeded check-ins sit just after it.
const GO_LIVE = Date.parse('2026-11-21T00:00:00.000Z');
const FANS = {
  a: 'fan.a@example.com', // DAY 1 account, FAMILY crew, has a Skiddle order for Gearbox
  b: 'fan.b@example.com', // older account (not DAY 1)
  c: 'fan.c@example.com', // 4 check-ins already since go-live + 1 from before go-live (must not count)
  d: 'fan.d@example.com', // private profile
  e: 'fan.e@example.com', // tester while the flag is off
};

function seed(dataDir) {
  const events = [
    // Live now: Gearbox (temple-008) started 30 min ago.
    { id: 'temple-008', skiddleId: '42803971', startDate: iso(now - 30 * 60 * 1000), endDate: iso(now + 6 * HOUR), dateBadge: '28.11', weekday: 'Saturday', title: 'GEARBOX X RECKLESS', subtitle: 'THE TEMPLE 008', venue: 'The Temple', city: 'Belfast', lineup: ['Anoluxx', 'Azdat', 'Detailed'], ticketsUrl: 'https://www.skiddle.com/e/42803971', image: '/api/poster/drive-abc.jpg' },
    // Also live now (for the daily cap).
    { id: 'afters-008', skiddleId: '42800001', startDate: iso(now - 10 * 60 * 1000), endDate: iso(now + 4 * HOUR), dateBadge: '28.11', weekday: 'Saturday', title: 'GEARBOX AFTERS', subtitle: '', venue: 'Halt', city: 'Belfast', lineup: [], ticketsUrl: 'https://www.skiddle.com/e/42800001', image: null },
    { id: 'afters-009', skiddleId: '42800002', startDate: iso(now - 5 * 60 * 1000), endDate: iso(now + 4 * HOUR), dateBadge: '28.11', weekday: 'Saturday', title: 'THIRD NIGHT', subtitle: '', venue: 'Halt', city: 'Belfast', lineup: [], ticketsUrl: 'https://www.skiddle.com/e/42800002', image: null },
    // Future: Temple 009 in 30 days (check-in closed).
    { id: 'temple-009', skiddleId: '42853722', startDate: iso(now + 30 * DAY), endDate: iso(now + 30 * DAY + 8 * HOUR), dateBadge: '26.12', weekday: 'Saturday', title: 'THE TEMPLE 009', subtitle: 'BOXING DAY SPECIAL', venue: 'The Temple', city: 'Belfast', lineup: ['Toza'], ticketsUrl: 'https://www.skiddle.com/e/42853722', image: null },
    // Over: ended 2 days ago (still cached; check-in and GOING closed).
    { id: 'past-night', skiddleId: '42000000', startDate: iso(now - 3 * DAY), endDate: iso(now - 2 * DAY), dateBadge: '18.11', weekday: 'Wednesday', title: 'PAST NIGHT', subtitle: '', venue: 'The Temple', city: 'Belfast', lineup: [], ticketsUrl: 'https://www.skiddle.com/e/42000000', image: null },
  ];
  writeFileSync(path.join(dataDir, 'content.json'), JSON.stringify({ updatedAt: iso(now), records: [], events, products: [], status: {} }));
  const fit = { top: 'skate-tee', outer: null, legs: 'barrel-jeans' };
  writeFileSync(
    path.join(dataDir, 'accounts.json'),
    JSON.stringify({
      [FANS.a]: { xp: 0, fit, createdAt: iso(now - HOUR), avatarBase: 'male' },
      [FANS.b]: { xp: 0, fit, createdAt: '2026-10-01T12:00:00.000Z', avatarBase: 'female', avatarBaseSet: true },
      [FANS.c]: { xp: 0, fit, createdAt: '2026-10-02T12:00:00.000Z' },
      [FANS.d]: { xp: 0, fit, createdAt: '2026-10-03T12:00:00.000Z' },
      [FANS.e]: { xp: 0, fit, createdAt: '2026-10-04T12:00:00.000Z' },
    }),
  );
  writeFileSync(path.join(dataDir, 'xp-ledger.json'), JSON.stringify({ source: 'file', updated: iso(now), rows: 1, emails: { [FANS.a]: { xp: 3100 } } }));
  writeFileSync(path.join(dataDir, 'skiddle-orders.json'), JSON.stringify({ orders: [{ email: FANS.a, skiddleEventId: '42803971', orderId: 'T1' }, { email: FANS.d, skiddleEventId: '42803971', orderId: 'T2' }] }));
  const snap = (title) => ({ title, subtitle: '', dateBadge: '01.01', startDate: '2026-11-22T20:00:00.000Z', venue: 'The Temple', city: 'Belfast', lineup: [], image: null });
  writeFileSync(
    path.join(dataDir, 'social.json'),
    JSON.stringify({
      profiles: { [FANS.c]: { handle: 'CEE', private: false, badgesSeen: [] } },
      going: {},
      checkins: {
        [FANS.c]: {
          'old-temple-005': { at: '2026-11-01T22:00:00.000Z', snapshot: snap('THE TEMPLE 005'), note: 'BEFORE GO-LIVE', photo: null },
          'n1': { at: iso(GO_LIVE + 1 * 60 * 1000), snapshot: snap('N1'), note: '', photo: null },
          'n2': { at: iso(GO_LIVE + 2 * 60 * 1000), snapshot: snap('N2'), note: '', photo: null },
          'n3': { at: iso(GO_LIVE + 3 * 60 * 1000), snapshot: snap('N3'), note: '', photo: null },
          'n4': { at: iso(GO_LIVE + 4 * 60 * 1000), snapshot: snap('N4'), note: '', photo: null },
        },
      },
      blockedHandles: {},
    }),
  );
}

async function start(dataDir, env) {
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(root, 'server', 'serve.mjs')], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dataDir, AUTH_SECRET: SECRET, OAUTH_ADMIN_KEY: ADMIN_KEY, CONTENT_REFRESH: 'off', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/api/social/status`);
      if (res.ok) return { base, child, log: () => log };
    } catch {
      // not yet
    }
    await new Promise((r) => setTimeout(r, 60));
  }
  child.kill();
  throw new Error(`server did not start\n${log}`);
}

function token(email) {
  const body = Buffer.from(JSON.stringify({ email, exp: Date.now() + DAY })).toString('base64url');
  return `${body}.${createHmac('sha256', SECRET).update(body).digest('base64url')}`;
}
let ipCounter = 1;
function client(base) {
  return async function call(method, pathname, { as, json, raw, type, headers = {} } = {}) {
    const h = { 'X-Forwarded-For': `10.1.0.${(ipCounter++ % 250) + 1}`, ...headers };
    if (as) h.Authorization = `Bearer ${token(as)}`;
    let body;
    if (json !== undefined) {
      h['Content-Type'] = 'application/json';
      body = JSON.stringify(json);
    } else if (raw !== undefined) {
      h['Content-Type'] = type || 'image/jpeg';
      body = raw;
    }
    const res = await fetch(`${base}${pathname}`, { method, headers: h, body });
    const ct = res.headers.get('content-type') || '';
    const text = ct.includes('application/json') ? await res.text() : null;
    return { status: res.status, body: text ? JSON.parse(text) : null, text, res };
  };
}
const hasEmail = (text) => /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(String(text || ''));

/* ---------- 1) SOCIAL_LIVE off: no effect ---------- */
{
  const dataDir = mkdtempSync(path.join(tmpdir(), 'rr-social-off-'));
  seed(dataDir);
  const socialBefore = readFileSync(path.join(dataDir, 'social.json'), 'utf8');
  const s = await start(dataDir, {});
  const call = client(s.base);
  const st = await call('GET', '/api/social/status', { as: FANS.a });
  check(st.status === 200 && st.body.live === false, 'off: status says live:false');
  for (const [method, p, opts] of [
    ['GET', '/api/social/me', {}],
    ['PUT', '/api/social/me', { json: { handle: 'NOVA' } }],
    ['POST', '/api/social/event/temple-008/going', {}],
    ['POST', '/api/social/event/temple-008/checkin', { json: { code: 'ABCDEF' } }],
    ['GET', '/api/social/diary', {}],
    ['GET', '/api/social/event/temple-008/going', {}],
  ]) {
    const r = await call(method, p, { as: FANS.a, ...opts });
    check(r.status === 403 && r.body.error === 'SOCIAL_OFF', `off: ${method} ${p} -> 403 SOCIAL_OFF`, r.status);
  }
  const anon = await call('GET', '/api/social/event/temple-008');
  check(anon.status === 401, 'off: signed-out event count refused');
  const crew = await call('GET', '/api/crew', { as: FANS.a });
  check(crew.status === 200 && !('social' in crew.body) && !('handle' in crew.body), 'off: /api/crew payload has no social fields');
  const content = await call('GET', '/api/content');
  check(content.status === 200 && content.body.events.length === 5 && !('going' in content.body.events[0]), 'off: /api/content unchanged (no social fields)');
  check(readFileSync(path.join(dataDir, 'social.json'), 'utf8') === socialBefore, 'off: social.json untouched');
  check(!existsSync(path.join(dataDir, 'social-events.jsonl')), 'off: no XP rows written');
  const exp = await call('GET', '/api/social/export');
  check(exp.status === 403, 'export without admin key refused');
  s.child.kill();
}

/* ---------- 2) off, but fan E is a named tester ---------- */
{
  const dataDir = mkdtempSync(path.join(tmpdir(), 'rr-social-test-'));
  seed(dataDir);
  writeFileSync(path.join(dataDir, 'social-checkin-codes.json'), JSON.stringify({ 'temple-008': { code: 'TESTER', at: iso(now) } }));
  const s = await start(dataDir, { SOCIAL_TEST_EMAILS: `${FANS.e}, someone@else.com` });
  const call = client(s.base);
  check((await call('GET', '/api/social/status', { as: FANS.e })).body.live === true, 'tester: status live:true for the tester');
  check((await call('GET', '/api/social/status', { as: FANS.a })).body.live === false, 'tester: still off for everyone else');
  check((await call('GET', '/api/social/me', { as: FANS.a })).status === 403, 'tester: other fans still 403');
  const ci = await call('POST', '/api/social/event/temple-008/checkin', { as: FANS.e, json: { code: 'tester' } });
  check(ci.status === 200 && ci.body.xp === 50, 'tester: check-in works (code is case-insensitive)', ci.body);
  const rows = readFileSync(path.join(dataDir, 'social-events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  check(rows.length === 1 && rows[0].counted === true && rows[0].test === true, 'tester: XP row written as test:true while SOCIAL_LIVE is off', rows);
  s.child.kill();
}

/* ---------- 3) SOCIAL_LIVE=1 ---------- */
const dataDir = mkdtempSync(path.join(tmpdir(), 'rr-social-live-'));
seed(dataDir);
const s = await start(dataDir, { SOCIAL_LIVE: '1', ADMIN_PASSWORD: PASSWORD });
const call = client(s.base);
const base = s.base;

// --- handles ---
{
  const r1 = await call('PUT', '/api/social/me', { as: FANS.a, json: { handle: 'n' } });
  check(r1.status === 400 && r1.body.error === 'HANDLE_FORMAT', 'live: 1-char handle refused');
  const r2 = await call('PUT', '/api/social/me', { as: FANS.a, json: { handle: 'reckless' } });
  check(r2.status === 400 && r2.body.error === 'HANDLE_RESERVED', 'live: reserved handle refused');
  const r3 = await call('PUT', '/api/social/me', { as: FANS.a, json: { handle: 'sh1thead' } });
  check(r3.status === 400 && r3.body.error === 'HANDLE_BLOCKED', 'live: profane handle refused');
  const r4 = await call('PUT', '/api/social/me', { as: FANS.a, json: { handle: 'nova' } });
  check(r4.status === 200 && r4.body.handle === 'NOVA', 'live: handle saved in UPPERCASE');
  const r5 = await call('PUT', '/api/social/me', { as: FANS.b, json: { handle: 'Nova' } });
  check(r5.status === 409 && r5.body.error === 'HANDLE_TAKEN', 'live: taken handle refused (case-insensitive)');
  const r6 = await call('PUT', '/api/social/me', { as: FANS.a, json: { handle: 'NOVA2' } });
  check(r6.status === 429 && r6.body.error === 'HANDLE_CHANGE_LIMIT', 'live: handle change limited to once a day');
  check((await call('PUT', '/api/social/me', { as: FANS.b, json: { handle: 'KAI' } })).status === 200, 'live: second fan picks KAI');
  check((await call('PUT', '/api/social/me', { as: FANS.d, json: { handle: 'RIN', private: true } })).body.private === true, 'live: fan D is private');
  check((await call('PUT', '/api/social/me', { as: FANS.b, json: { private: 'yes' } })).status === 400, 'live: private must be a boolean');
}

// --- GOING + VERIFIED + privacy ---
{
  const noHandle = await call('POST', '/api/social/event/temple-008/going', { as: FANS.e });
  check(noHandle.status === 409 && noHandle.body.error === 'HANDLE_NEEDED', 'going: needs a handle first');
  const g1 = await call('POST', '/api/social/event/temple-008/going', { as: FANS.a });
  check(g1.status === 200 && g1.body.going === true && g1.body.count === 1 && g1.body.verified === 1, 'going: A going + verified by Skiddle order', g1.body);
  await call('POST', '/api/social/event/temple-008/going', { as: FANS.a });
  check((await call('GET', '/api/social/event/temple-008', { as: FANS.a })).body.count === 1, 'going: tapping twice counts once');
  await call('POST', '/api/social/event/temple-008/going', { as: FANS.b });
  await call('POST', '/api/social/event/temple-008/going', { as: FANS.d });
  const sum = await call('GET', '/api/social/event/temple-008', { as: FANS.b });
  check(sum.body.count === 3 && sum.body.verified === 2, 'going: private fan counted (3 going, 2 verified)', sum.body);
  check(sum.body.faces.length === 2 && !sum.body.faces.some((f) => f.handle === 'RIN'), 'going: private fan not in faces');
  check(sum.body.faces.every((f) => f.avatarBase && f.fit), 'going: faces carry the look (base + fit)');
  const list = await call('GET', '/api/social/event/temple-008/going', { as: FANS.b });
  const handles = list.body.people.map((p) => p.handle);
  check(list.body.count === 3 && handles.length === 2 && handles[0] === 'KAI' && list.body.people[0].you === true, 'going list: you first, private hidden', handles);
  check(list.body.people.find((p) => p.handle === 'NOVA')?.verified === true && list.body.people.find((p) => p.handle === 'KAI')?.verified === false, 'going list: VERIFIED tick only for the ticket holder');
  check(list.body.people.find((p) => p.handle === 'NOVA')?.crew === 'RECKLESS FAMILY', 'going list: crew name from the XP ledger');
  const privSelf = await call('GET', '/api/social/event/temple-008/going', { as: FANS.d });
  check(privSelf.body.people.some((p) => p.handle === 'RIN' && p.you), 'going list: a private fan still sees themself');
  const anon = await call('GET', '/api/social/event/temple-008');
  check(anon.status === 200 && anon.body.count === 3 && anon.body.faces.length === 0, 'signed out: count only, no faces');
  check((await call('GET', '/api/social/event/temple-008/going')).status === 401, 'signed out: going list refused');
  for (const r of [sum, list, anon, privSelf]) check(!hasEmail(r.text), 'no email in public payload');
  check((await call('POST', '/api/social/event/past-night/going', { as: FANS.a })).body.error === 'EVENT_OVER', 'going: refused for a night that is over');
  check((await call('POST', '/api/social/event/nope/going', { as: FANS.a })).status === 404, 'going: unknown event 404');
  const off = await call('DELETE', '/api/social/event/temple-008/going', { as: FANS.b });
  check(off.body.going === false && off.body.count === 2, 'going: DELETE removes me');
  await call('POST', '/api/social/event/temple-008/going', { as: FANS.b });
}

// --- profiles ---
{
  const kai = await call('GET', '/api/social/profile/KAI', { as: FANS.a });
  check(kai.status === 200 && kai.body.handle === 'KAI' && kai.body.avatarBase === 'female' && !hasEmail(kai.text), 'profile: crew can see a public profile (no email)');
  check(!('latestDiary' in kai.body) && !('xp' in kai.body), 'profile: someone else gets no diary and no XP');
  check((await call('GET', '/api/social/profile/RIN', { as: FANS.a })).status === 404, 'profile: private profile hidden from others');
  check((await call('GET', '/api/social/profile/RIN', { as: FANS.d })).status === 200, 'profile: private profile visible to its owner');
  check((await call('GET', '/api/social/profile/KAI')).status === 401, 'profile: signed out refused');
}

// --- admin session ---
async function adminLogin() {
  const page = await fetch(`${base}/admin/login`, { headers: { 'X-Forwarded-For': '10.9.9.9' } });
  const html = await page.text();
  const pre = /name="pre" value="([^"]+)"/.exec(html)?.[1];
  const preCookie = (page.headers.getSetCookie() || []).find((c) => c.startsWith('__Host-rr_admin_pre='))?.split(';')[0];
  const res = await fetch(`${base}/admin/login`, {
    method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Forwarded-For': '10.9.9.9', Origin: base, Cookie: preCookie },
    body: new URLSearchParams({ pre, password: PASSWORD }).toString(),
  });
  const cookie = (res.headers.getSetCookie() || []).find((c) => c.startsWith('__Host-rr_admin='))?.split(';')[0];
  const adminHtml = await (await fetch(`${base}/admin`, { headers: { Cookie: cookie } })).text();
  const csrf = /name="csrf-token" content="([^"]+)"/.exec(adminHtml)?.[1];
  return {
    html: adminHtml,
    get: async (p) => (await fetch(`${base}/admin/api${p}`, { headers: { Cookie: cookie } })).json(),
    post: async (p, json) => {
      const r = await fetch(`${base}/admin/api${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: base, 'X-CSRF-Token': csrf }, body: JSON.stringify(json) });
      return { status: r.status, body: await r.json() };
    },
  };
}
const admin = await adminLogin();
check(admin.html.includes('data-tab="social"'), 'admin: SOCIAL tab present');

// --- check-in ---
{
  const notReady = await call('POST', '/api/social/event/temple-008/checkin', { as: FANS.a, json: { code: 'ABCDEF' } });
  check(notReady.status === 409 && notReady.body.error === 'CHECKIN_NOT_READY', 'check-in: no code made yet -> not ready');
  const made = await admin.post('/social/code', { eventId: 'temple-008' });
  check(made.status === 200 && /^[A-HJ-NP-Z2-9]{6}$/.test(made.body.code), 'admin: makes a 6-char check-in code', made.body);
  const code = made.body.code;
  const wrong = await call('POST', '/api/social/event/temple-008/checkin', { as: FANS.a, json: { code: code === 'AAAAAA' ? 'BBBBBB' : 'AAAAAA' } });
  check(wrong.status === 400 && wrong.body.error === 'CODE', 'check-in: wrong code refused');
  await admin.post('/social/code', { eventId: 'temple-009' });
  const future = await call('POST', '/api/social/event/temple-009/checkin', { as: FANS.a, json: { code } });
  check(future.status === 409 && future.body.error === 'CHECKIN_CLOSED', 'check-in: closed before event hours');
  const past = await call('POST', '/api/social/event/past-night/checkin', { as: FANS.a, json: { code } });
  check(past.status === 404 || past.body.error === 'CHECKIN_CLOSED', 'check-in: closed after the night', past.body);
  const ok = await call('POST', '/api/social/event/temple-008/checkin', { as: FANS.a, json: { code: ` ${code.toLowerCase()} ` } });
  check(ok.status === 200 && ok.body.xp === 50 && ok.body.already === false, 'check-in: right code -> +50 XP', ok.body);
  check(ok.body.entry.title === 'GEARBOX X RECKLESS' && ok.body.entry.lineup.length === 3 && ok.body.entry.image, 'check-in: diary entry made with poster, date and lineup');
  const fresh = ok.body.newBadges.map((b) => b.id).sort();
  check(JSON.stringify(fresh) === JSON.stringify(['gearbox-008']), 'check-in: GEARBOX 008 unlocked by this check-in', fresh);
  const again = await call('POST', '/api/social/event/temple-008/checkin', { as: FANS.a, json: { code } });
  check(again.status === 200 && again.body.already === true && again.body.xp === 0, 'check-in: second time = already, 0 XP');
  const summary = await call('GET', '/api/social/event/temple-008', { as: FANS.a });
  check(summary.body.checkedIn === true && summary.body.checkinOpen === true, 'event summary: checkedIn + checkinOpen');

  // Daily cap: 2 counted check-ins a London day.
  const c2 = await admin.post('/social/code', { eventId: 'afters-008' });
  const c3 = await admin.post('/social/code', { eventId: 'afters-009' });
  const second = await call('POST', '/api/social/event/afters-008/checkin', { as: FANS.a, json: { code: c2.body.code } });
  const third = await call('POST', '/api/social/event/afters-009/checkin', { as: FANS.a, json: { code: c3.body.code } });
  check(second.body.xp === 50 && third.status === 200 && third.body.xp === 0, 'check-in: daily cap (3rd night today still logs the diary, 0 XP)', [second.body.xp, third.body.xp]);

  // C: 4 since go-live + this one = 5 RAVES. The pre-go-live check-in never counts.
  const cc = await call('POST', '/api/social/event/temple-008/checkin', { as: FANS.c, json: { code } });
  check(cc.body.newBadges.map((b) => b.id).includes('5-raves'), 'badges: 5 RAVES at the 5th check-in since go-live', cc.body.newBadges);
  const cMe = await call('GET', '/api/social/me', { as: FANS.c });
  check(cMe.body.raves === 5, 'badges: check-in from before go-live not counted (5, not 6)', cMe.body.raves);
  const cDiary = await call('GET', '/api/social/diary', { as: FANS.c });
  check(!cDiary.body.entries.some((e) => e.eventId === 'old-temple-005'), 'diary: nothing backfilled from before go-live');
  check(!cMe.body.badges.some((b) => b.id === 'first-temple'), 'badges: no FIRST TEMPLE badge');
}

// --- badges + profile (me) ---
{
  const me = await call('GET', '/api/social/me', { as: FANS.a });
  const earned = me.body.badges.filter((b) => b.earned).map((b) => b.id);
  check(earned.includes('founding-raver') && earned.includes('gearbox-008') && !earned.includes('5-raves'), 'badges: A has FOUNDING RAVER + GEARBOX 008, not 5 RAVES', earned);
  check(me.body.badges.some((b) => b.name === 'FAMILY' && b.earned && b.sub === 'CREW CODE · 15%') && me.body.badges.some((b) => b.name === 'RECKLESS CREW' && !b.earned), 'badges: crew code badges (FAMILY earned, RECKLESS CREW next)');
  check(me.body.crew === 'RECKLESS FAMILY' && me.body.level === 10 && me.body.xp === 3100, 'me: crew + level from the XP ledger');
  check(me.body.newBadges.map((b) => b.id).sort().join() === 'founding-raver,gearbox-008', 'me: unseen badges listed for the popup');
  check(me.body.going.length === 1 && me.body.going[0].eventId === 'temple-008' && me.body.going[0].count === 3, 'me: GOING list on the profile');
  const ack = await call('PUT', '/api/social/me', { as: FANS.a, json: { seenBadges: ['founding-raver', 'gearbox-008', 'made-up'] } });
  check(ack.body.newBadges.length === 0, 'me: badges acknowledged');
  const b = await call('GET', '/api/social/me', { as: FANS.b });
  check(!b.body.badges.find((x) => x.id === 'founding-raver').earned, 'badges: account from before DAY 1 is not a FOUNDING RAVER');
}

// --- diary ---
async function jpegWithExif(width, height) {
  return sharp({ create: { width, height, channels: 3, background: { r: 200, g: 20, b: 20 } } })
    .jpeg()
    .withExif({ IFD0: { Artist: 'SECRET PERSON', Copyright: 'GPS-HOME' } })
    .withMetadata({ orientation: 6 })
    .toBuffer();
}
{
  const list = await call('GET', '/api/social/diary', { as: FANS.a });
  check(list.body.entries.length === 3 && list.body.raves === 3, 'diary: one entry per check-in', list.body.entries.length);
  check((await call('GET', '/api/social/diary/temple-008', { as: FANS.b })).status === 404, "diary: can't read someone else's entry");
  const long = await call('PUT', '/api/social/diary/temple-008', { as: FANS.a, json: { note: 'X'.repeat(281) } });
  check(long.status === 400 && long.body.error === 'NOTE_TOO_LONG', 'diary: note over 280 refused');
  const note = await call('PUT', '/api/social/diary/temple-008', { as: FANS.a, json: { note: '  First XL.\n\nThe hood-up set went off.  ' } });
  check(note.status === 200 && note.body.entry.note === 'First XL. The hood-up set went off.' && note.body.xp === 0, 'diary: note saved (trimmed), no XP without a photo');
  const notImage = await call('POST', '/api/social/diary/temple-008/photo', { as: FANS.a, raw: Buffer.from('not an image at all'), type: 'image/jpeg' });
  check(notImage.status === 400 && notImage.body.error === 'PHOTO_TYPE', 'photo: non-image refused');
  const huge = await call('POST', '/api/social/diary/temple-008/photo', { as: FANS.a, raw: Buffer.alloc(8 * 1024 * 1024 + 10, 0xff) });
  check(huge.status === 413 && huge.body.error === 'PHOTO_TOO_BIG', 'photo: over 8 MB refused (413)');
  const big = await jpegWithExif(3000, 2000);
  const meta0 = await sharp(big).metadata();
  check(Boolean(meta0.exif) && meta0.orientation === 6, 'photo fixture has EXIF + orientation');
  const up = await call('POST', '/api/social/diary/temple-008/photo', { as: FANS.a, raw: big });
  check(up.status === 200 && up.body.xp === 25 && up.body.entry.complete === true, 'photo: note + photo -> +25 XP', up.body);
  const photoUrl = up.body.entry.photo;
  const img = await fetch(`${base}${photoUrl}`);
  const buf = Buffer.from(await img.arrayBuffer());
  const meta = await sharp(buf).metadata();
  check(img.status === 200 && meta.format === 'jpeg' && Math.max(meta.width, meta.height) === 1440, 'photo: resized to 1440 long edge', [meta.width, meta.height]);
  check(meta.width < meta.height, 'photo: EXIF orientation applied before stripping (portrait)');
  check(!meta.exif && !meta.orientation && !buf.includes(Buffer.from('SECRET PERSON')), 'photo: EXIF stripped');
  const replace = await call('POST', '/api/social/diary/temple-008/photo', { as: FANS.a, raw: await jpegWithExif(400, 300) });
  check(replace.body.xp === 0 && replace.body.entry.photo !== photoUrl, 'photo: replacing gives no more XP');
  check((await fetch(`${base}${photoUrl}`)).status === 404, 'photo: old file deleted on replace');
  const edit = await call('PUT', '/api/social/diary/temple-008', { as: FANS.a, json: { note: 'Edited.' } });
  check(edit.body.xp === 0, 'diary: editing the note gives no more XP');
  const rows = readFileSync(path.join(dataDir, 'social-events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const aRows = rows.filter((r) => r.email === FANS.a);
  check(aRows.filter((r) => r.type === 'diary_complete' && r.counted).length === 1, 'XP log: diary XP once only');
  check(aRows.filter((r) => r.type === 'event_checkin' && r.counted).length === 2 && aRows.every((r) => r.counted ? r.test === false : true), 'XP log: 2 counted check-ins, live rows test:false');
  check(Boolean(rows.find((r) => r.reason === 'DAILY_CAP')) && !rows.some((r) => r.type === 'event_checkin' && r.reason === 'DUPLICATE'), 'XP log: daily cap row logged, repeat check-in writes no row', rows.map((r) => [r.type, r.eventId, r.counted, r.reason]));

  // Delete photo, then the entry; re-check-in restores it with no XP.
  const delPhoto = await call('DELETE', '/api/social/diary/temple-008/photo', { as: FANS.a });
  check(delPhoto.body.entry.photo === null && readdirSync(path.join(dataDir, 'social-photos')).length === 0, 'photo: delete removes the file');
  const delEntry = await call('DELETE', '/api/social/diary/temple-008', { as: FANS.a });
  check(delEntry.body.deleted === true && (await call('GET', '/api/social/diary', { as: FANS.a })).body.entries.length === 2, 'diary: entry deleted');
  const codes = JSON.parse(readFileSync(path.join(dataDir, 'social-checkin-codes.json'), 'utf8'));
  const back = await call('POST', '/api/social/event/temple-008/checkin', { as: FANS.a, json: { code: codes['temple-008'].code } });
  check(back.status === 200 && back.body.xp === 0 && back.body.entry.note === '', 'diary: checking in again restores an empty entry, no new XP', back.body);

  const exp = await call('GET', '/api/social/export', { headers: { 'X-Admin-Key': ADMIN_KEY } });
  check(exp.status === 200 && exp.res.headers.get('content-type').includes('ndjson'), 'export: admin key gets the XP rows');
}

// --- admin moderation ---
{
  const ph = await call('POST', '/api/social/diary/afters-008/photo', { as: FANS.a, raw: await jpegWithExif(300, 300) });
  await call('PUT', '/api/social/diary/afters-008', { as: FANS.a, json: { note: 'something to remove' } });
  const look = await admin.get(`/crew?email=${encodeURIComponent(FANS.a)}`);
  check(look.social?.handle === 'NOVA' && look.social.going.includes('temple-008') && look.social.diary.length >= 2, 'admin: crew lookup shows handle, going and diary', look.social);
  const entry = look.social.diary.find((d) => d.eventId === 'afters-008');
  check(entry.photo === ph.body.entry.photo, 'admin: sees the diary photo');
  const img = await fetch(`${base}${entry.photo}`);
  check(img.status === 200, 'admin: photo loads from the same origin (CSP img-src self)');
  check((await admin.post('/crew/action', { email: FANS.a, action: 'remove-photo', eventId: 'afters-008' })).body.ok, 'admin: remove photo');
  check((await fetch(`${base}${entry.photo}`)).status === 404, 'admin: removed photo is gone');
  check((await admin.post('/crew/action', { email: FANS.a, action: 'remove-note', eventId: 'afters-008' })).body.ok, 'admin: remove note');
  const rh = await admin.post('/crew/action', { email: FANS.b, action: 'remove-handle' });
  check(rh.body.ok && rh.body.removed === 'KAI', 'admin: remove handle');
  const retake = await call('PUT', '/api/social/me', { as: FANS.e, json: { handle: 'KAI' } });
  check(retake.status === 400 && retake.body.error === 'HANDLE_BLOCKED', 'admin: a removed handle cannot be taken again');
  const list = await call('GET', '/api/social/event/temple-008/going', { as: FANS.a });
  check(list.body.count === 3 && !list.body.people.some((p) => p.handle === 'KAI'), 'admin: fan without a handle drops off the list (still counted)');
  const summary = await admin.get('/social');
  check(summary.live === true && summary.events.find((e) => e.id === 'temple-008')?.code && summary.events.find((e) => e.id === 'temple-008').going === 3, 'admin: SOCIAL summary with codes + counts');
  const stats = await admin.get('/stats');
  check(stats.flags.SOCIAL_LIVE === true, 'admin: STATS flags show SOCIAL_LIVE');
  const audit = await admin.get('/audit');
  check(audit.audit.some((r) => r.action === 'social_remove_handle') && audit.audit.some((r) => r.action === 'social_checkin_code'), 'admin: moderation is in the audit log');
}

// --- account delete clears social ---
{
  await call('POST', '/api/social/diary/afters-008/photo', { as: FANS.a, raw: await jpegWithExif(200, 200) });
  check(readdirSync(path.join(dataDir, 'social-photos')).length === 1, 'delete: photo on disk before delete');
  const del = await call('DELETE', '/api/crew', { as: FANS.a });
  check(del.status === 200, 'delete: account deleted');
  check(readdirSync(path.join(dataDir, 'social-photos')).length === 0, 'delete: diary photos removed');
  const st = JSON.parse(readFileSync(path.join(dataDir, 'social.json'), 'utf8'));
  check(!st.profiles[FANS.a] && !st.checkins[FANS.a] && !Object.values(st.going).some((t) => t[FANS.a]), 'delete: profile, going and diary removed');
  check((await call('GET', '/api/social/event/temple-008', { as: FANS.b })).body.count === 2, 'delete: GOING count drops');
}

s.child.kill();
if (/Error|failed/i.test(s.log()) && process.env.SHOW_LOG) console.log(s.log());
console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
