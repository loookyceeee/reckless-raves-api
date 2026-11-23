// Checks the ticket-rep leaderboard (GET/POST /api/reps) against a local server.
//   node scripts/reps-check.mjs
// Temp DATA_DIR, no network. Does not print the admin key or full rep names.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalizeRepUrl, repDisplayName, REP_REWARDS } from '../server/reps.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SECRET = 'local-reps-check-secret';
const ADMIN_KEY = 'local-reps-admin-key-0123456789abcdef';
const dataDir = mkdtempSync(path.join(tmpdir(), 'rr-reps-'));
const repsFile = path.join(dataDir, 'reps.json');
let failures = 0;
let passes = 0;

const DEFAULTS = [
  ['temple-008', '42803971', 'https://www.skiddle.com/reps/repallevents.php?lid=2351295'],
  ['e43169461', '43169461', 'https://www.skiddle.com/reps/repallevents.php?lid=2469267'],
  ['temple-009', '42853722', 'https://www.skiddle.com/reps/repallevents.php?lid=2368473'],
  ['e43187226', '43187226', 'https://www.skiddle.com/reps/repallevents.php?lid=2471868'],
];

function check(cond, label) {
  if (cond) {
    passes += 1;
    console.log(`ok   ${label}`);
  } else {
    failures += 1;
    console.log(`FAIL ${label}`);
  }
}

function redact(text) {
  return String(text).split(ADMIN_KEY).join('[redacted]');
}

/* ---------- display name + rep url rules ---------- */
{
  const names = [
    ['Cj Mc Henry', 'CJ M'],
    ['kai', 'KAI'],
    ['  anna   bell  ', 'ANNA B'],
    ['Mary Jane Watson', 'MARY J'],
  ];
  for (const [input, want] of names) check(repDisplayName(input) === want, `display name ${want}`);
  check(REP_REWARDS.map((reward) => `${reward.id}:${reward.points}:${reward.qty}`).join() === 'half-off:800:50,guestlist:1000:50,guestlist-plus:2000:50', 'reward ladder is fixed');

  const allowed = [
    'https://www.skiddle.com/e/42803971',
    'https://skiddle.com/reps',
    'https://a.b.skiddle.com/x?y=1#z',
    'https://promotioncentre.co.uk/reps/nye',
    'https://promo.promotioncentre.co.uk/r/abc',
    'https://www.promotioncentre.co.uk/sign-up',
    'https://www.skiddle.com/path?x=a@b.com',
  ];
  for (const url of allowed) check(normalizeRepUrl(url) === url, `rep url allowed ${url.slice(0, 40)}`);
  check(normalizeRepUrl('HTTPS://WWW.SKIDDLE.COM/Path') === 'https://www.skiddle.com/Path', 'rep url canonicalizes scheme and host');
  check(normalizeRepUrl('https://www.skiddle.com:443/e/1') === 'https://www.skiddle.com/e/1', 'rep url drops the default port');
  for (const [, , url] of DEFAULTS) check(normalizeRepUrl(url) === url, 'confirmed rep link is an allowed https URL');

  const rejected = [
    'http://www.skiddle.com/e/1',
    'http://promotioncentre.co.uk/reps',
    'https://skiddle.com.evil.com/e/1',
    'https://notskiddle.com/e/1',
    'https://www.skiddle.com.evil.com/',
    'https://evil.com/https://www.skiddle.com',
    'https://user@skiddle.com/',
    'https://user:pass@www.skiddle.com/e/1',
    'javascript:https://skiddle.com',
    'https://promotioncentre.co.uk.evil.com/',
    'https://evilpromotioncentre.co.uk/',
    'https://skiddle.co.uk/e/1',
    'https://skiddle.com\\@evil.com',
    '',
    '   ',
  ];
  for (const url of rejected) check(normalizeRepUrl(url) === null, 'rep url rejected');
  check(normalizeRepUrl(null) === null && normalizeRepUrl(12) === null, 'rep url rejects non-strings');
}

mkdirSync(dataDir, { recursive: true });
writeFileSync(
  path.join(dataDir, 'content.json'),
  JSON.stringify({
    updatedAt: '2026-11-23T12:00:00.000Z',
    records: [],
    products: [],
    events: [
      { id: 'temple-008', skiddleId: '42803971', title: 'GEARBOX X RECKLESS', startDate: '2026-11-28T15:00:00.000Z' },
      { id: 'e43169461', skiddleId: '43169461', title: 'TEMPLE 008 AFTERPARTY', startDate: '2026-11-28T23:00:00.000Z' },
      { id: 'temple-009', skiddleId: '42853722', title: 'THE TEMPLE 009', startDate: '2026-12-26T15:00:00.000Z' },
      { id: 'e43187226', skiddleId: '43187226', title: 'LOCATION X NYE', startDate: '2026-12-31T21:00:00.000Z' },
      { id: 'guest-night', skiddleId: '42999991', title: 'GUEST NIGHT', startDate: '2026-12-01T20:00:00.000Z' },
    ],
  }),
);

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

async function start() {
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(root, 'server', 'serve.mjs')], {
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      PORT: String(port),
      HOST: '127.0.0.1',
      DATA_DIR: dataDir,
      AUTH_SECRET: SECRET,
      OAUTH_ADMIN_KEY: ADMIN_KEY,
      CONTENT_REFRESH: 'off',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (chunk) => {
    log += chunk;
  });
  child.stderr.on('data', (chunk) => {
    log += chunk;
  });
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/api/health`);
      if (res.ok) return { base, child, log: () => log };
    } catch {
      // not yet
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  child.kill();
  throw new Error(redact(`server did not start\n${log}`));
}

async function api(base, method, pathname, { json, headers } = {}) {
  const res = await fetch(`${base}${pathname}`, {
    method,
    headers: {
      ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: json !== undefined ? JSON.stringify(json) : undefined,
  });
  const text = await res.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: res.status, body, text, headers: res.headers };
}

function hidesNames(text) {
  const banned = ['Mc Henry', 'Zero Sales', 'Minus Sales', 'Sam Quinn', 'Kai Murphy', 'Ana Bell', 'Pat Doyle', 'Uma Frost', 'Ned Young', 'Gus Night', 'Amy Quinn', 'Zed Quinn'];
  return banned.every((name) => !text.includes(name));
}

function eventById(feed, eventId) {
  return feed?.events?.find((event) => event.eventId === eventId) || null;
}

const rep = (name, tickets, points) => ({ name, tickets, points });

let server;
try {
  server = await start();
  const { base } = server;
  const post = (json, headers = { 'X-Admin-Key': ADMIN_KEY }) => api(base, 'POST', '/api/reps', { json, headers });

  const empty = await api(base, 'GET', '/api/reps');
  check(empty.status === 200 && empty.body?.ok === true && empty.body.updatedAt === null, 'GET before a snapshot is public and empty of reps');
  check(empty.headers.get('access-control-allow-origin') === '*', 'GET allows public CORS');
  check(JSON.stringify(empty.body.rewards) === JSON.stringify(REP_REWARDS), 'GET rewards match the fixed ladder');
  check(empty.body.events?.length === DEFAULTS.length, 'GET before a snapshot lists the four default events');
  check(DEFAULTS.every(([eventId, skiddleId, repUrl], index) => {
    const event = empty.body.events[index];
    return event?.eventId === eventId && event.skiddleId === skiddleId && event.repUrl === repUrl && event.repUrlSource === 'promotion-centre' && event.updatedAt === null && Array.isArray(event.reps) && event.reps.length === 0;
  }), 'default rep links are promotion-centre URLs before any snapshot');
  check(!existsSync(repsFile), 'GET does not write a snapshot');

  const noKey = await post({ updatedAt: '2026-11-23T12:00:00Z', events: [] }, {});
  const wrongKey = await post({ updatedAt: '2026-11-23T12:00:00Z', events: [] }, { 'X-Admin-Key': 'not-the-admin-key-000000000000' });
  const queryKey = await api(base, 'POST', `/api/reps?key=${encodeURIComponent(ADMIN_KEY)}`, { json: { updatedAt: '2026-11-23T12:00:00Z', events: [] } });
  check(noKey.status === 403 && noKey.body?.error === 'ADMIN', 'POST with no admin key is rejected');
  check(wrongKey.status === 403 && wrongKey.body?.error === 'ADMIN', 'POST with the wrong admin key is rejected');
  check(queryKey.status === 403 && queryKey.body?.error === 'ADMIN', 'POST does not accept the admin key in the query');
  check(!existsSync(repsFile), 'rejected auth does not write a snapshot');

  const row = [rep('Cj Mc Henry', 1, 10)];
  const invalid = [
    [{ updatedAt: 'yesterday', events: [{ eventId: 'temple-008', reps: row }] }, 'UPDATED'],
    [{ updatedAt: '2026-11-23T12:00:00Z', events: [{ eventId: 'temple-008', reps: [{ name: 'Cj Mc Henry', tickets: 12 }] }] }, 'POINTS'],
    [{ updatedAt: '2026-11-23T12:00:00Z', events: [{ eventId: 'temple-008', reps: [{ name: 'Cj Mc Henry', tickets: 12, points: -1 }] }] }, 'POINTS'],
    [{ updatedAt: '2026-11-23T12:00:00Z', events: [{ eventId: 'temple-008', reps: [{ name: 'Cj Mc Henry', tickets: 12, points: '1230' }] }] }, 'POINTS'],
    [{ updatedAt: '2026-11-23T12:00:00Z', events: [{ eventId: 'temple-008', reps: [{ name: 'Cj Mc Henry', tickets: '12', points: 10 }] }] }, 'TICKETS'],
    [{ updatedAt: '2026-11-23T12:00:00Z', events: [{ eventId: 'not-a-night', reps: row }] }, 'EVENT'],
    [{ updatedAt: '2026-11-23T12:00:00Z', events: [{ skiddleId: '99999999', reps: row }] }, 'EVENT'],
    [{ updatedAt: '2026-11-23T12:00:00Z', events: [{ eventId: 'temple-008', skiddleId: '42853722', reps: row }] }, 'EVENT'],
    [{ updatedAt: '2026-11-23T12:00:00Z', events: [{ reps: row }] }, 'EVENT'],
    [{ updatedAt: '2026-11-23T12:00:00Z', events: [{ eventId: 'temple-008', repUrl: 'http://www.skiddle.com/reps/repallevents.php?lid=2351295', reps: row }] }, 'REP_URL'],
    [{ updatedAt: '2026-11-23T12:00:00Z', events: [{ eventId: 'temple-008', repUrl: 'https://evil.com/reps', reps: row }] }, 'REP_URL'],
    [{ updatedAt: '2026-11-23T12:00:00Z', events: [{ eventId: 'temple-008', repUrl: 'https://skiddle.com.evil.com/e/1', reps: row }] }, 'REP_URL'],
    [{ updatedAt: '2026-11-23T12:00:00Z', events: [{ eventId: 'temple-008', repUrl: 'https://notskiddle.com/e/1', reps: row }] }, 'REP_URL'],
    [{ updatedAt: '2026-11-23T12:00:00Z', events: [{ eventId: 'temple-008', repUrl: 'https://user@skiddle.com/reps', reps: row }] }, 'REP_URL'],
    [{ updatedAt: '2026-11-23T12:00:00Z', events: [{ eventId: 'temple-008', repUrl: 'https://evilpromotioncentre.co.uk/reps', reps: row }] }, 'REP_URL'],
  ];
  let invalidOk = true;
  let echoed = false;
  for (const [json, error] of invalid) {
    const res = await post(json);
    if (res.status !== 400 || res.body?.error !== error) invalidOk = false;
    if (!hidesNames(res.text || '')) echoed = true;
  }
  check(invalidOk, 'invalid rows return 400 and do not guess');
  check(!echoed, 'rejected responses omit full names');
  check(!existsSync(repsFile), 'invalid rows do not write a snapshot');
  const stillDefault = await api(base, 'GET', '/api/reps');
  check(stillDefault.body?.events?.length === 4 && stillDefault.body.events.every((event) => event.reps.length === 0 && event.repUrlSource === 'promotion-centre'), 'failed posts leave the default links in place');

  const first = await post({
    updatedAt: '2026-11-23T12:00:00Z',
    source: 'skiddle-promotion-centre',
    events: [
      {
        eventId: 'temple-008',
        reps: [
          rep('Sam Quinn', 12, 1500),
          rep('Cj Mc Henry', 12, 1230),
          rep('Kai Murphy', 12, 400),
          rep('Ana Bell', 4, 900),
          rep('Zed Quinn', 3, 100),
          rep('Amy Quinn', 3, 100),
          rep('Zero Sales', 0, 0),
          rep('Minus Sales', -2, 10),
        ],
      },
      { skiddleId: '43169461', reps: [rep('Pat Doyle', 2, 80)] },
      { eventId: 'temple-009', skiddleId: '42853722', repUrl: 'https://www.skiddle.com/reps/custom-009', reps: [rep('Uma Frost', 1, 40)] },
      { eventId: 'e43187226', reps: [rep('Ned Young', 6, 220)] },
      { eventId: 'guest-night', reps: [rep('Gus Night', 5, 50)] },
    ],
  });
  check(first.status === 200 && first.body?.ok === true && first.body.dropped === 2, 'POST stores the snapshot and drops zero-ticket reps');
  check(hidesNames(first.text), 'POST ack omits full names');
  check(first.body.updatedAt === '2026-11-23T12:00:00.000Z', 'POST echoes a canonical updatedAt');

  const feed = await api(base, 'GET', '/api/reps');
  check(feed.status === 200 && hidesNames(feed.text), 'GET hides full names');
  check(!('source' in feed.body) && !('dropped' in feed.body) && !feed.text.includes('"name"'), 'GET has no source, drop count, or name field');
  const temple = eventById(feed.body, 'temple-008');
  check(temple?.skiddleId === '42803971' && temple.repUrl === DEFAULTS[0][2] && temple.repUrlSource === 'promotion-centre', 'omitted repUrl uses the confirmed temple-008 link');
  check(JSON.stringify(temple?.reps) === JSON.stringify([
    { displayName: 'SAM Q', tickets: 12, points: 1500, rank: 1 },
    { displayName: 'CJ M', tickets: 12, points: 1230, rank: 2 },
    { displayName: 'KAI M', tickets: 12, points: 400, rank: 3 },
    { displayName: 'ANA B', tickets: 4, points: 900, rank: 4 },
    { displayName: 'ZED Q', tickets: 3, points: 100, rank: 5 },
    { displayName: 'AMY Q', tickets: 3, points: 100, rank: 6 },
  ]), 'reps rank by tickets, then points, and points are not inferred');
  const afters = eventById(feed.body, 'e43169461');
  check(afters?.skiddleId === '43169461' && afters.repUrl === DEFAULTS[1][2] && afters.repUrlSource === 'promotion-centre' && afters.reps[0]?.displayName === 'PAT D', 'skiddle id maps to the afterparty and its default link');
  const temple9 = eventById(feed.body, 'temple-009');
  check(temple9?.skiddleId === '42853722' && temple9.repUrl === 'https://www.skiddle.com/reps/custom-009' && temple9.repUrlSource === 'promotion-centre', 'a supplied repUrl replaces the default and stays promotion-centre');
  const nye = eventById(feed.body, 'e43187226');
  check(nye?.skiddleId === '43187226' && nye.repUrl === DEFAULTS[3][2] && nye.repUrlSource === 'promotion-centre' && nye.reps[0]?.displayName === 'NED Y', 'event id maps to Location X and its default link');
  const guest = eventById(feed.body, 'guest-night');
  check(guest?.skiddleId === '42999991' && guest.repUrl === 'https://www.skiddle.com/e/42999991' && guest.repUrlSource === 'listing', 'an event with no default link uses the listing page');
  check(feed.body.events.filter((event) => DEFAULTS.some(([id]) => id === event.eventId)).length === 4, 'all four default events are present');

  const disk = JSON.parse(readFileSync(repsFile, 'utf8'));
  const diskTemple = disk.events.find((event) => event.eventId === 'temple-008');
  check(diskTemple?.reps?.some((row) => row.name === 'Cj Mc Henry' && row.points === 1230 && row.tickets === 12), 'disk keeps the full name for matching');
  check(!JSON.stringify(disk).includes('Zero Sales') && !JSON.stringify(disk).includes('Minus Sales'), 'disk drops reps with tickets <= 0');
  check(!diskTemple.repUrl && disk.events.find((event) => event.eventId === 'temple-009')?.repUrl === 'https://www.skiddle.com/reps/custom-009', 'disk stores only a supplied repUrl');
  check(disk.events.length === 5 && !disk.events.some((event) => event.reps.some((row) => row.displayName)), 'disk is the posted snapshot, not the public view');

  const replaced = await post({
    updatedAt: '2026-11-30T12:00:00Z',
    source: 'skiddle-promotion-centre',
    events: [{ skiddleId: '42853722', reps: [rep('Uma Frost', 9, 500)] }],
  });
  check(replaced.status === 200 && replaced.body.dropped === 0, 'a later snapshot replaces the stored feed');
  const next = await api(base, 'GET', '/api/reps');
  const next9 = eventById(next.body, 'temple-009');
  check(next9?.skiddleId === '42853722' && next9.repUrl === DEFAULTS[2][2] && next9.repUrlSource === 'promotion-centre' && next9.reps.length === 1 && next9.reps[0].tickets === 9 && next9.reps[0].points === 500, 'leaving repUrl out of a later snapshot restores the confirmed link');
  check(!eventById(next.body, 'guest-night'), 'an event that is not a default drops out when the snapshot omits it');
  check(DEFAULTS.filter(([eventId]) => eventId !== 'temple-009').every(([eventId, , repUrl]) => {
    const event = eventById(next.body, eventId);
    return event?.repUrl === repUrl && event.repUrlSource === 'promotion-centre' && event.reps.length === 0;
  }), 'default events left out of the snapshot keep their sign-up link and lose their reps');
  check(hidesNames(next.text) && !next.text.includes('custom-009'), 'replaced feed drops the old custom link and the old names');
  const disk2 = readFileSync(repsFile, 'utf8');
  check(disk2.includes('Uma Frost') && !disk2.includes('Cj Mc Henry') && !disk2.includes('custom-009') && !disk2.includes('guest-night'), 'the file on disk is the new snapshot');

  const before = readFileSync(repsFile, 'utf8');
  const badUrl = await post({ updatedAt: '2026-12-07T12:00:00Z', events: [{ eventId: 'temple-008', repUrl: 'http://promotioncentre.co.uk/reps', reps: row }] });
  const badPoints = await post({ updatedAt: '2026-12-07T12:00:00Z', events: [{ eventId: 'temple-008', reps: [{ name: 'Cj Mc Henry', tickets: 15 }] }] });
  const badEvent = await post({ updatedAt: '2026-12-07T12:00:00Z', events: [{ eventId: 'temple-008', skiddleId: '43169461', reps: row }] });
  check(badUrl.status === 400 && badUrl.body.error === 'REP_URL' && badPoints.status === 400 && badPoints.body.error === 'POINTS' && badEvent.status === 400 && badEvent.body.error === 'EVENT', 'a bad snapshot is a 400');
  check(readFileSync(repsFile, 'utf8') === before, 'a rejected snapshot does not replace the stored feed');
  check(hidesNames(badUrl.text) && hidesNames(badPoints.text), 'rejected snapshots still omit full names');

  const open = await api(base, 'GET', '/api/reps', { headers: { 'X-Admin-Key': 'nope' } });
  check(open.status === 200 && open.body.events.length === 4, 'GET stays public after a snapshot');
  const method = await api(base, 'PUT', '/api/reps');
  check(method.status === 405 && method.body?.error === 'METHOD', 'PUT is rejected');

  check(!server.log().includes(ADMIN_KEY) && hidesNames(server.log()), 'logs omit the admin key and full names');

  server.child.kill();
  server = await start();
  const again = await api(server.base, 'GET', '/api/reps');
  check(again.body?.updatedAt === '2026-11-30T12:00:00.000Z' && eventById(again.body, 'temple-009')?.repUrl === DEFAULTS[2][2] && eventById(again.body, 'temple-008')?.reps?.length === 0, 'the snapshot and default links survive a restart');
  check(!server.log().includes(ADMIN_KEY) && hidesNames(server.log()), 'restart logs omit the admin key and full names');
} catch (error) {
  failures += 1;
  console.log(`FAIL ${redact(error instanceof Error ? error.stack || error.message : error)}`);
} finally {
  server?.child?.kill();
}

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
