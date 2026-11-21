// Exercises RECKLESS WORLD crew event routes against a local server.
//   node scripts/game-events-check.mjs
// Time is faked through setGameClock() in server/game-events.mjs (same process).
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = mkdtempSync(path.join(tmpdir(), 'rr-game-events-'));
const adminKey = 'test-admin-key-0123456789abcd';

process.env.DATA_DIR = dataDir;
process.env.HOST = '127.0.0.1';
process.env.AUTH_SECRET = 'test-auth-secret-game-events';
process.env.GAME_XP_LIVE = '0';
process.env.OAUTH_ADMIN_KEY = adminKey;
for (const key of [
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'GOOGLE_REFRESH_TOKEN',
  'GOOGLE_DRIVE_FOLDER_ID',
  'XP_SHEET_ID',
  'CREW_RESET_ID',
  'CREW_CODES',
  'CREW_CODES_LOADED',
  'CREW_CODES_LIVE',
  'BEHOLD_FEED_URL',
  'NEXT_DROP',
  'PIN_SETUP_LIVE',
]) {
  delete process.env[key];
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

function hash12(email) {
  return createHash('sha256').update(email).digest('hex').slice(0, 12);
}

function fail(message, extra) {
  console.error(`FAIL ${message}`);
  if (extra !== undefined) console.error(typeof extra === 'string' ? extra : JSON.stringify(extra));
  process.exit(1);
}

function assert(cond, message, extra) {
  if (!cond) fail(message, extra);
}

const SIX_H = 6 * 60 * 60 * 1000;
let now = Date.parse('2026-11-23T12:00:00.000Z');

process.on('unhandledRejection', (error) => {
  fail(`unhandled rejection: ${error instanceof Error ? error.stack : error}`);
});

const port = await freePort();
process.env.PORT = String(port);
const base = `http://127.0.0.1:${port}`;

const game = await import(new URL('../server/game-events.mjs', import.meta.url));
game.setGameClock(() => now);

assert(game.londonDateKey(Date.parse('2026-07-15T23:30:00.000Z')) === '2026-07-16', 'BST rolls the London date at 23:00 UTC');
assert(game.londonDateKey(Date.parse('2026-11-23T00:30:00.000Z')) === '2026-11-23', 'GMT keeps the UTC date');
assert(
  game.isoWeekKey(Date.parse('2026-11-23T12:00:00.000Z')) === game.isoWeekKey(Date.parse('2026-11-29T23:00:00.000Z')),
  'Mon 23 Nov and Sun 29 Nov are one London ISO week',
);
assert(
  game.isoWeekKey(Date.parse('2026-11-22T23:00:00.000Z')) !== game.isoWeekKey(Date.parse('2026-11-23T00:30:00.000Z')),
  'London Sunday and Monday are different ISO weeks',
);
assert(
  game.isoWeekKey(Date.parse('2026-11-30T00:30:00.000Z')) !== game.isoWeekKey(Date.parse('2026-11-29T12:00:00.000Z')),
  '30 Nov starts the next London ISO week',
);

await import(new URL('../server/serve.mjs', import.meta.url));

async function waitForServer() {
  const deadline = Date.now() + 8000;
  let last = '';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/api/health`);
      if (res.ok) return;
      last = `status ${res.status}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  fail(`server did not start: ${last}`);
}

await waitForServer();

async function api(method, pathname, { token, json, headers, ip } = {}) {
  const res = await fetch(`${base}${pathname}`, {
    method,
    headers: {
      ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(ip ? { 'X-Forwarded-For': ip } : {}),
      ...headers,
    },
    body: json !== undefined ? JSON.stringify(json) : undefined,
  });
  const text = await res.text();
  let body = text;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  } else {
    body = null;
  }
  return { status: res.status, body, text, headers: res.headers };
}

async function signIn(email) {
  const res = await api('POST', '/api/auth/request', { json: { email } });
  assert(res.status === 200 && res.body?.token, `sign in ${email}`, res.text);
  return res.body.token;
}

function logLines() {
  const file = path.join(dataDir, 'game-events.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function sessions() {
  const file = path.join(dataDir, 'game-sessions.json');
  if (!existsSync(file)) return {};
  return JSON.parse(readFileSync(file, 'utf8'));
}

function noXp(body, label) {
  const encoded = JSON.stringify(body);
  assert(!encoded.includes('"xp"'), `${label} must not return XP`, encoded);
}

const emailA = 'player-a@example.com';
const emailB = 'player-b@example.com';
const emailC = 'player-c@example.com';
const emailD = 'player-d@example.com';
const emailE = 'player-e@example.com';
const emailR = 'player-r@example.com';
const hashA = hash12(emailA);

const tokenA = await signIn(emailA);
const tokenB = await signIn(emailB);
const tokenC = await signIn(emailC);
const tokenD = await signIn(emailD);
const tokenE = await signIn(emailE);
const tokenR = await signIn(emailR);

const opt = await fetch(`${base}/api/crew/events/rave/start`, { method: 'OPTIONS' });
assert(opt.status === 204, 'OPTIONS 204', String(opt.status));
const allowHeaders = opt.headers.get('access-control-allow-headers') || '';
assert(/content-type/i.test(allowHeaders) && /authorization/i.test(allowHeaders), 'OPTIONS allow headers', allowHeaders);
assert(opt.headers.get('access-control-allow-origin') === '*', 'OPTIONS allow origin');

const anon = await api('POST', '/api/crew/events/rave/start', { json: { raveId: 'rave-1' } });
assert(anon.status === 401 && anon.body?.error === 'SESSION' && anon.body.ok === false, 'no session', anon.body);

const badRave = await api('POST', '/api/crew/events/rave/start', { token: tokenA, json: { raveId: 'bad id' } });
assert(badRave.status === 400 && badRave.body?.error === 'RAVE', 'bad rave id', badRave.body);
const longRave = await api('POST', '/api/crew/events/rave/start', { token: tokenA, json: { raveId: 'a'.repeat(65) } });
assert(longRave.status === 400 && longRave.body?.error === 'RAVE', 'long rave id', longRave.body);

const started = await api('POST', '/api/crew/events/rave/start', { token: tokenA, json: { raveId: 'rave-1' } });
assert(started.status === 200, 'start', started.body);
assert(started.body.ok === true && started.body.minSeconds === 600, 'start shape', started.body);
assert(started.body.startedAt === '2026-11-23T12:00:00.000Z', 'start uses server clock', started.body.startedAt);
assert(typeof started.body.sessionId === 'string' && started.body.sessionId.length >= 16, 'session id', started.body.sessionId);
noXp(started.body, 'start');
const session1 = started.body.sessionId;

const tooSoon = await api('POST', '/api/crew/events/rave/finish', { token: tokenA, json: { sessionId: session1 } });
assert(tooSoon.status === 409 && tooSoon.body?.error === 'TOO_SOON' && tooSoon.body.remainingSeconds === 600, 'finish immediately', tooSoon.body);
assert(logLines().length === 0, 'too soon does not record');

now += 599000;
const stillSoon = await api('POST', '/api/crew/events/rave/finish', { token: tokenA, json: { sessionId: session1 } });
assert(stillSoon.status === 409 && stillSoon.body.remainingSeconds === 1, 'finish at 599s', stillSoon.body);

now += 1000;
const attended = await api('POST', '/api/crew/events/rave/finish', { token: tokenA, json: { sessionId: session1 } });
assert(attended.status === 200 && attended.body?.ok === true && attended.body.recorded === true && attended.body.counted === true, 'finish at 600s', attended.body);
assert(!('reason' in attended.body), 'counted finish has no reason', attended.body);
noXp(attended.body, 'finish');
const again = await api('POST', '/api/crew/events/rave/finish', { token: tokenA, json: { sessionId: session1 } });
assert(again.status === 404 && again.body?.error === 'SESSION_NOT_FOUND', 'session consumed', again.body);

const raveLine = logLines().at(-1);
assert(raveLine.id === `wr:rave-1:${hashA}:2026-11-23`, 'rave id includes London date', raveLine);
assert(raveLine.type === 'digital_rave_attended' && raveLine.email === emailA && raveLine.raveId === 'rave-1', 'rave line', raveLine);
assert(raveLine.at === '2026-11-23T12:10:00.000Z' && raveLine.counted === true && raveLine.reason === null && raveLine.test === true, 'rave line flags', raveLine);

const second = await api('POST', '/api/crew/events/rave/start', { token: tokenA, json: { raveId: 'rave-2' } });
now += 600000;
const secondFinish = await api('POST', '/api/crew/events/rave/finish', { token: tokenA, json: { sessionId: second.body.sessionId } });
assert(secondFinish.status === 200 && secondFinish.body.counted === false && secondFinish.body.reason === 'DAILY_CAP', 'second rave same London day', secondFinish.body);

async function poster(token, posterId) {
  return api('POST', '/api/crew/events', { token, json: { type: 'poster_placed', posterId } });
}

const p1 = await poster(tokenA, 'poster-1');
assert(p1.status === 200 && p1.body.counted === true && p1.body.recorded === true, 'first poster', p1.body);
noXp(p1.body, 'poster');
const p1again = await poster(tokenA, 'poster-1');
assert(p1again.status === 200 && p1again.body.counted === false && p1again.body.reason === 'DUPLICATE', 'same poster', p1again.body);
const p2 = await poster(tokenA, 'poster.2');
assert(p2.status === 200 && p2.body.counted === true, 'second poster of the day', p2.body);
const p3 = await poster(tokenA, 'poster:3');
assert(p3.status === 200 && p3.body.counted === false && p3.body.reason === 'DAILY_CAP', 'third poster same day', p3.body);

const posterLine = logLines().find((line) => line.posterId === 'poster-1' && line.counted);
assert(posterLine.id === `wp:poster-1:${hashA}`, 'poster id', posterLine);
const cappedPoster = logLines().find((line) => line.posterId === 'poster:3');
assert(cappedPoster.counted === false && cappedPoster.reason === 'DAILY_CAP' && cappedPoster.id === `wp:poster:3:${hashA}`, 'over-cap poster line', cappedPoster);

const me = await api('GET', '/api/crew/events/me', { token: tokenA });
assert(me.status === 200 && me.body.ok === true, 'me', me.body);
assert(me.body.today.digital_rave_attended === 1 && me.body.today.poster_placed === 2, 'today counts', me.body.today);
assert(me.body.week.digital_rave_attended === 1 && me.body.week.poster_placed === 2, 'week counts', me.body.week);
assert(me.body.events[0].posterId === 'poster:3' && me.body.events[0].counted === false, 'me is newest first', me.body.events[0]);
noXp(me.body, 'me');

const crew = await api('GET', '/api/crew', { token: tokenA });
assert(crew.status === 200 && crew.body.xp === 0, 'crew XP untouched', crew.body?.xp);

const firstC = await api('POST', '/api/crew/events/rave/start', { token: tokenC, json: { raveId: 'rave-c' } });
const secondC = await api('POST', '/api/crew/events/rave/start', { token: tokenC, json: { raveId: 'rave-c2' } });
const open = sessions();
assert(Object.keys(open).length === 1 && open[secondC.body.sessionId]?.raveId === 'rave-c2', 'new start replaces the open session', open);
const stolen = await api('POST', '/api/crew/events/rave/finish', { token: tokenA, json: { sessionId: secondC.body.sessionId } });
assert(stolen.status === 404 && stolen.body.error === 'SESSION_NOT_FOUND', 'other email cannot finish', stolen.body);
assert(sessions()[secondC.body.sessionId], 'foreign finish leaves the session');
const oldC = await api('POST', '/api/crew/events/rave/finish', { token: tokenC, json: { sessionId: firstC.body.sessionId } });
assert(oldC.status === 404, 'replaced session is gone', oldC.body);
now = Date.parse(secondC.body.startedAt) + SIX_H;
const expired = await api('POST', '/api/crew/events/rave/finish', { token: tokenC, json: { sessionId: secondC.body.sessionId } });
assert(expired.status === 404 && expired.body.error === 'SESSION_NOT_FOUND', '6h expiry', expired.body);
assert(!sessions()[secondC.body.sessionId], 'expired session is dropped');

async function rave(token, raveId) {
  const start = await api('POST', '/api/crew/events/rave/start', { token, json: { raveId } });
  assert(start.status === 200, `start ${raveId}`, start.body);
  now = Date.parse(start.body.startedAt) + 600000;
  const done = await api('POST', '/api/crew/events/rave/finish', { token, json: { sessionId: start.body.sessionId } });
  return done;
}

now = Date.parse('2026-11-23T18:30:00.000Z');
const b1 = await rave(tokenB, 'rave-b1');
assert(b1.status === 200 && b1.body.counted === true, 'B first rave of the week', b1.body);
now = Date.parse('2026-11-24T12:00:00.000Z');
const b2 = await rave(tokenB, 'rave-b2');
assert(b2.status === 200 && b2.body.counted === true, 'B second rave, next London day, same ISO week', b2.body);
assert(logLines().filter((line) => line.email === emailB && line.counted).at(-1).id.endsWith(':2026-11-24'), 'Tuesday rave id uses that London date');

const p3next = await poster(tokenA, 'poster:3');
assert(p3next.status === 200 && p3next.body.counted === false && p3next.body.reason === 'WEEKLY_CAP', 'poster next day hits the 40 XP week', p3next.body);

now = Date.parse('2026-11-25T12:00:00.000Z');
const b3 = await rave(tokenB, 'rave-b3');
assert(b3.status === 200 && b3.body.counted === false && b3.body.reason === 'WEEKLY_CAP', 'third rave of the ISO week', b3.body);

now = Date.parse('2026-11-30T12:00:00.000Z');
const p3later = await poster(tokenA, 'poster:3');
assert(p3later.status === 200 && p3later.body.counted === true, 'over-cap poster counts on a later week', p3later.body);
const p1later = await poster(tokenA, 'poster-1');
assert(p1later.body.counted === false && p1later.body.reason === 'DUPLICATE', 'counted poster stays spent', p1later.body);
const bPoster = await poster(tokenB, 'poster-1');
assert(bPoster.status === 200 && bPoster.body.counted === true, 'poster dedupe is per email', bPoster.body);
const meLater = await api('GET', '/api/crew/events/me', { token: tokenA });
assert(meLater.body.today.poster_placed === 1 && meLater.body.today.digital_rave_attended === 0, 'me today follows the clock', meLater.body.today);
assert(meLater.body.week.poster_placed === 1 && meLater.body.week.digital_rave_attended === 0, 'me week follows the clock', meLater.body.week);

process.env.GAME_XP_LIVE = '1';
now = Date.parse('2026-11-21T00:00:00.000Z');
const live = await poster(tokenD, 'live-1');
assert(live.body.counted === true, 'live poster counted', live.body);
const liveLine = logLines().find((line) => line.posterId === 'live-1');
assert(liveLine.test === false && liveLine.at === '2026-11-21T00:00:00.000Z', 'counted event on the cutoff is not a test', liveLine);
const liveDup = await poster(tokenD, 'live-1');
assert(liveDup.status === 200 && liveDup.body.counted === false && liveDup.body.reason === 'DUPLICATE', 'duplicate while live', liveDup.body);
assert(logLines().find((line) => line.posterId === 'live-1' && line.counted === false).test === true, 'an uncounted event stays test:true while GAME_XP_LIVE is on');
now = Date.parse('2026-11-20T22:00:00.000Z');
const before = await poster(tokenD, 'live-2');
assert(before.body.counted === true, 'poster before the cutoff still counts as a test', before.body);
assert(logLines().find((line) => line.posterId === 'live-2').test === true, 'before cutoff stays test:true while live');
process.env.GAME_XP_LIVE = '0';
now = Date.parse('2026-11-30T15:00:00.000Z');
const flaggedOff = await poster(tokenD, 'live-3');
assert(flaggedOff.body.counted === true, 'flag off still records', flaggedOff.body);
assert(logLines().find((line) => line.posterId === 'live-3').test === true, 'flag off forces test:true');

const crewD = await api('GET', '/api/crew', { token: tokenD });
assert(crewD.status === 200 && crewD.body.xp === 0, 'live flag does not write crew XP', crewD.body?.xp);

now = Date.parse('2026-12-07T12:00:00.000Z');
const edgeStart = await api('POST', '/api/crew/events/rave/start', { token: tokenE, json: { raveId: 'rave-e' } });
now = Date.parse(edgeStart.body.startedAt) + SIX_H - 1;
const edgeOk = await api('POST', '/api/crew/events/rave/finish', { token: tokenE, json: { sessionId: edgeStart.body.sessionId } });
assert(edgeOk.status === 200 && edgeOk.body.counted === true, '1ms inside the 6h window still counts', edgeOk.body);
const edge2 = await api('POST', '/api/crew/events/rave/start', { token: tokenE, json: { raveId: 'rave-e2' } });
now = Date.parse(edge2.body.startedAt) + SIX_H;
const edgeGone = await api('POST', '/api/crew/events/rave/finish', { token: tokenE, json: { sessionId: edge2.body.sessionId } });
assert(edgeGone.status === 404, 'exactly 6h is expired', edgeGone.body);

const badType = await api('POST', '/api/crew/events', { token: tokenA, json: { type: 'digital_rave_attended', raveId: 'rave-1' } });
assert(badType.status === 400 && badType.body.error === 'TYPE', 'rave type is not accepted on the poster route', badType.body);
const badPoster = await api('POST', '/api/crew/events', { token: tokenA, json: { type: 'poster_placed', posterId: 'has space' } });
assert(badPoster.status === 400 && badPoster.body.error === 'POSTER', 'bad poster id', badPoster.body);
const badJson = await fetch(`${base}/api/crew/events`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenA}` },
  body: '{',
});
assert(badJson.status === 400, 'bad json', String(badJson.status));
const badJsonBody = await badJson.json();
assert(badJsonBody.error === 'BODY', 'bad json error', badJsonBody);
const wrongMethod = await api('GET', '/api/crew/events/rave/start', { token: tokenA });
assert(wrongMethod.status === 405 && wrongMethod.body.error === 'METHOD', 'wrong method', wrongMethod.body);

let rateCounted = 0;
for (let i = 0; i < 30; i += 1) {
  const res = await api('POST', '/api/crew/events', {
    token: tokenR,
    ip: '203.0.113.50',
    json: { type: 'poster_placed', posterId: 'rate-poster' },
  });
  assert(res.status === 200, `rate call ${i}`, res.body);
  if (res.body.counted) rateCounted += 1;
}
const limited = await api('POST', '/api/crew/events', {
  token: tokenR,
  ip: '203.0.113.50',
  json: { type: 'poster_placed', posterId: 'rate-poster' },
});
assert(limited.status === 429 && limited.body.error === 'RATE', '31st call is rate limited', limited.body);
assert(rateCounted === 1, 'rate burst counts the poster once', rateCounted);
const rateLines = logLines().filter((line) => line.email === emailR);
assert(rateLines.length === 30, 'rejected call is not stored', rateLines.length);
assert(rateLines.filter((line) => line.counted).length === 1, 'only the first rate poster counted');

const noKey = await api('GET', '/api/crew/events/export?since=2026-11-30T00:00:00.000Z');
assert(noKey.status === 403 && noKey.body.error === 'ADMIN', 'export without key', noKey.body);
const badSince = await api('GET', '/api/crew/events/export?since=yesterday', { headers: { 'X-Admin-Key': adminKey } });
assert(badSince.status === 400 && badSince.body.error === 'SINCE', 'bad since', badSince.body);
const exported = await fetch(`${base}/api/crew/events/export?since=2026-11-30T00:00:00.000Z`, {
  headers: { 'X-Admin-Key': adminKey },
});
assert(exported.status === 200, 'export', String(exported.status));
assert((exported.headers.get('content-type') || '').includes('application/x-ndjson'), 'export content type');
const exportedText = await exported.text();
const exportedLines = exportedText.split('\n').filter(Boolean).map((line) => JSON.parse(line));
assert(exportedLines.length > 0, 'export has rows');
assert(exportedLines.every((line) => Date.parse(line.at) >= Date.parse('2026-11-30T00:00:00.000Z')), 'export since filter', exportedLines.map((line) => line.at));
assert(!exportedLines.some((line) => line.raveId === 'rave-1'), 'export hides earlier raves');
assert(exportedLines.some((line) => line.posterId === 'poster:3' && line.counted === true), 'export includes the later counted poster');

const accounts = JSON.parse(readFileSync(path.join(dataDir, 'accounts.json'), 'utf8'));
for (const email of [emailA, emailB, emailC, emailD, emailE, emailR]) {
  assert(accounts[email]?.xp === 0, `${email} account xp stays 0`, accounts[email]);
}
assert(!existsSync(path.join(dataDir, 'xp-ledger.json')), 'game events do not write the XP ledger');

game.initGameEvents(dataDir);
const reloaded = await poster(tokenA, 'poster-1');
assert(reloaded.status === 200 && reloaded.body.counted === false && reloaded.body.reason === 'DUPLICATE', 'reloading the log keeps a counted poster spent', reloaded.body);

const all = logLines();
assert(all.every((line) => line.test === true || (line.test === false && line.counted === true && line.at >= '2026-11-21T00:00:00.000Z')), 'test flag rules', all.filter((line) => line.test === false));

console.log(`game-events-check: ok (${all.length} log lines, data ${dataDir})`);
process.exit(0);
