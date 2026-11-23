// Checks the ticket-rep leaderboard (GET/POST /api/reps) and personal rep rewards
// (link, /me, admin reset) against a local server.
//   node scripts/reps-check.mjs
// Temp DATA_DIR, no network. Does not print the admin key or full rep names.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalizeRepUrl, repDisplayName, repRewardView, REP_REWARDS } from '../server/reps.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SECRET = 'local-reps-check-secret';
const ADMIN_KEY = 'local-reps-admin-key-0123456789abcdef';
const dataDir = mkdtempSync(path.join(tmpdir(), 'rr-reps-'));
const repsFile = path.join(dataDir, 'reps.json');
const linksFile = path.join(dataDir, 'rep-links.json');
const PRIVATE_IDS = ['777001', '777002', '777003', '777004', '777005', '777010', '777011', '777012', '777013', '777014', '777098', '777099'];
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
  const banned = ['Mc Henry', 'Zero Sales', 'Minus Sales', 'Sam Quinn', 'Kai Murphy', 'Ana Bell', 'Pat Doyle', 'Uma Frost', 'Ned Young', 'Gus Night', 'Amy Quinn', 'Zed Quinn', 'Ivy Stone', 'Bo Lane', 'Co Lane', 'Do Lane', 'Eo Lane', 'Fo Lane'];
  return banned.every((name) => !text.includes(name));
}

function hidesRepIds(text) {
  return !String(text).includes('repId') && PRIVATE_IDS.every((id) => !String(text).includes(id));
}

const REWARD_AT = new Map([
  ['0:4', { rewardsEarned: [], nextReward: { id: 'half-off', label: '50% OFF', pointsNeeded: 800 }, merchCode: null }],
  ['400:3', { rewardsEarned: ['top3-merch'], nextReward: { id: 'half-off', label: '50% OFF', pointsNeeded: 400 }, merchCode: null }],
  ['799:4', { rewardsEarned: [], nextReward: { id: 'half-off', label: '50% OFF', pointsNeeded: 1 }, merchCode: null }],
  ['800:1', { rewardsEarned: ['half-off', 'top3-merch'], nextReward: { id: 'guestlist', label: 'GUESTLIST', pointsNeeded: 200 }, merchCode: null }],
  ['900:4', { rewardsEarned: ['half-off'], nextReward: { id: 'guestlist', label: 'GUESTLIST', pointsNeeded: 100 }, merchCode: null }],
  ['1000:2', { rewardsEarned: ['half-off', 'guestlist', 'top3-merch'], nextReward: { id: 'guestlist-plus', label: 'GUESTLIST +1', pointsNeeded: 1000 }, merchCode: null }],
  ['1230:2', { rewardsEarned: ['half-off', 'guestlist', 'top3-merch'], nextReward: { id: 'guestlist-plus', label: 'GUESTLIST +1', pointsNeeded: 770 }, merchCode: null }],
  ['1500:1', { rewardsEarned: ['half-off', 'guestlist', 'top3-merch'], nextReward: { id: 'guestlist-plus', label: 'GUESTLIST +1', pointsNeeded: 500 }, merchCode: null }],
  ['1999:5', { rewardsEarned: ['half-off', 'guestlist'], nextReward: { id: 'guestlist-plus', label: 'GUESTLIST +1', pointsNeeded: 1 }, merchCode: null }],
  ['2000:3', { rewardsEarned: ['half-off', 'guestlist', 'guestlist-plus', 'top3-merch'], nextReward: null, merchCode: null }],
  ['2500:5', { rewardsEarned: ['half-off', 'guestlist', 'guestlist-plus'], nextReward: null, merchCode: null }],
  ['50:2', { rewardsEarned: ['top3-merch'], nextReward: { id: 'half-off', label: '50% OFF', pointsNeeded: 750 }, merchCode: null }],
]);

function eventView(eventId, tickets, points, rank) {
  return { eventId, tickets, points, rank, ...REWARD_AT.get(`${points}:${rank}`) };
}

for (const [points, rank] of [[0, 4], [400, 3], [799, 4], [800, 1], [900, 4], [1000, 2], [1230, 2], [1500, 1], [1999, 5], [2000, 3], [2500, 5], [50, 2]]) {
  check(JSON.stringify(repRewardView(points, rank)) === JSON.stringify(REWARD_AT.get(`${points}:${rank}`)), `reward maths ${points} pts rank ${rank}`);
}

function eventById(feed, eventId) {
  return feed?.events?.find((event) => event.eventId === eventId) || null;
}

const rep = (name, tickets, points, repId) => {
  const row = { name, tickets, points };
  if (repId !== undefined) row.repId = repId;
  return row;
};

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
    [{ updatedAt: '2026-11-23T12:00:00Z', events: [{ eventId: 'temple-008', reps: [{ name: 'Cj Mc Henry', tickets: 12, points: 10, repId: 12345 }] }] }, 'REP_ID'],
    [{ updatedAt: '2026-11-23T12:00:00Z', events: [{ eventId: 'temple-008', reps: [{ name: 'Cj Mc Henry', tickets: 12, points: 10, repId: '12ab' }] }] }, 'REP_ID'],
    [{ updatedAt: '2026-11-23T12:00:00Z', events: [{ eventId: 'temple-008', reps: [{ name: 'Cj Mc Henry', tickets: 0, points: 0, repId: 'nope' }] }] }, 'REP_ID'],
    [{ updatedAt: '2026-11-23T12:00:00Z', events: [{ eventId: 'temple-008', reps: [{ name: 'Cj Mc Henry', tickets: 2, points: 10, repId: '555001' }, { name: 'Kai Murphy', tickets: 1, points: 10, repId: '555001' }] }] }, 'REP_ID'],
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
          rep('Sam Quinn', 12, 1500, '777001'),
          rep('Cj Mc Henry', 12, 1230, '777002'),
          rep('Kai Murphy', 12, 400, '777003'),
          rep('Ana Bell', 4, 900, '777004'),
          rep('Ivy Stone', 3, 2500, ' 777005 '),
          rep('Zed Quinn', 3, 100, ''),
          rep('Amy Quinn', 3, 100),
          rep('Zero Sales', 0, 0, '777098'),
          rep('Minus Sales', -2, 10, '777099'),
        ],
      },
      { skiddleId: '43169461', reps: [rep('Pat Doyle', 2, 80), rep('Sam Quinn', 1, 50, '777001')] },
      { eventId: 'temple-009', skiddleId: '42853722', repUrl: 'https://www.skiddle.com/reps/custom-009', reps: [rep('Uma Frost', 1, 40)] },
      { eventId: 'e43187226', reps: [rep('Ned Young', 6, 220)] },
      {
        eventId: 'guest-night',
        reps: [
          rep('Bo Lane', 10, 800, '777010'),
          rep('Co Lane', 9, 1000, '777011'),
          rep('Do Lane', 8, 2000, '777012'),
          rep('Eo Lane', 7, 799, '777013'),
          rep('Fo Lane', 6, 1999, '777014'),
          rep('Gus Night', 5, 50),
        ],
      },
    ],
  });
  check(first.status === 200 && first.body?.ok === true && first.body.dropped === 2, 'POST stores the snapshot and drops zero-ticket reps');
  check(hidesNames(first.text) && hidesRepIds(first.text), 'POST ack omits full names and rep ids');
  check(first.body.updatedAt === '2026-11-23T12:00:00.000Z', 'POST echoes a canonical updatedAt');

  const feed = await api(base, 'GET', '/api/reps');
  check(feed.status === 200 && hidesNames(feed.text) && hidesRepIds(feed.text), 'GET hides full names and rep ids');
  check(!('source' in feed.body) && !('dropped' in feed.body) && !feed.text.includes('"name"'), 'GET has no source, drop count, or name field');
  const temple = eventById(feed.body, 'temple-008');
  check(temple?.skiddleId === '42803971' && temple.repUrl === DEFAULTS[0][2] && temple.repUrlSource === 'promotion-centre', 'omitted repUrl uses the confirmed temple-008 link');
  check(JSON.stringify(temple?.reps) === JSON.stringify([
    { displayName: 'SAM Q', tickets: 12, points: 1500, rank: 1 },
    { displayName: 'CJ M', tickets: 12, points: 1230, rank: 2 },
    { displayName: 'KAI M', tickets: 12, points: 400, rank: 3 },
    { displayName: 'ANA B', tickets: 4, points: 900, rank: 4 },
    { displayName: 'IVY S', tickets: 3, points: 2500, rank: 5 },
    { displayName: 'ZED Q', tickets: 3, points: 100, rank: 6 },
    { displayName: 'AMY Q', tickets: 3, points: 100, rank: 7 },
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
  check(diskTemple?.reps?.some((row) => row.name === 'Cj Mc Henry' && row.points === 1230 && row.tickets === 12 && row.repId === '777002'), 'disk keeps the full name and the private rep id');
  check(diskTemple?.reps?.find((row) => row.name === 'Ivy Stone')?.repId === '777005', 'disk stores a trimmed rep id');
  check(diskTemple?.reps?.some((row) => row.name === 'Zed Quinn' && !Object.prototype.hasOwnProperty.call(row, 'repId')), 'a blank rep id is left off the row');
  const diskText = JSON.stringify(disk);
  check(!diskText.includes('Zero Sales') && !diskText.includes('Minus Sales') && !diskText.includes('777098') && !diskText.includes('777099'), 'disk drops zero-ticket reps and their rep ids');
  check(!diskTemple.repUrl && disk.events.find((event) => event.eventId === 'temple-009')?.repUrl === 'https://www.skiddle.com/reps/custom-009', 'disk stores only a supplied repUrl');
  check(disk.events.length === 5 && !disk.events.some((event) => event.reps.some((row) => row.displayName)), 'disk is the posted snapshot, not the public view');
  check(disk.events.find((event) => event.eventId === 'e43169461')?.reps?.some((row) => row.name === 'Sam Quinn' && row.repId === '777001'), 'the same rep id can appear on more than one event');

  async function signIn(email) {
    const res = await api(base, 'POST', '/api/auth/request', { json: { email } });
    if (res.status !== 200 || typeof res.body?.token !== 'string') {
      check(false, `sign in ${email}`);
      throw new Error('sign-in failed');
    }
    return res.body.token;
  }
  const bearer = (token) => ({ Authorization: `Bearer ${token}` });
  const linkAs = (token, repId) => api(base, 'POST', '/api/reps/link', { headers: bearer(token), json: { repId } });

  const opt = await api(base, 'OPTIONS', '/api/reps/link');
  check(opt.status === 204 && /authorization/i.test(opt.headers.get('access-control-allow-headers') || '') && opt.headers.get('access-control-allow-origin') === '*', 'link preflight allows the crew bearer');
  const anonLink = await api(base, 'POST', '/api/reps/link', { json: { repId: '777001' } });
  const badBearer = await api(base, 'POST', '/api/reps/link', { headers: { Authorization: 'Bearer not-a-session' }, json: { repId: '777001' } });
  const adminAsCrew = await api(base, 'GET', '/api/reps/me', { headers: { 'X-Admin-Key': ADMIN_KEY } });
  const anonMe = await api(base, 'GET', '/api/reps/me');
  const anonUnlink = await api(base, 'DELETE', '/api/reps/link');
  const anonList = await api(base, 'GET', '/api/reps/links');
  const wrongList = await api(base, 'GET', '/api/reps/links', { headers: { 'X-Admin-Key': 'not-the-admin-key-000000000000' } });
  const queryList = await api(base, 'GET', `/api/reps/links?key=${encodeURIComponent(ADMIN_KEY)}`);
  const anonReset = await api(base, 'DELETE', '/api/reps/links/777001');
  check(anonLink.status === 401 && anonLink.body?.error === 'SESSION' && badBearer.status === 401 && badBearer.body?.error === 'SESSION', 'link without a crew session is rejected');
  check(anonMe.status === 401 && anonMe.body?.error === 'SESSION' && adminAsCrew.status === 401 && adminAsCrew.body?.error === 'SESSION', 'me requires the crew bearer, not the admin key');
  check(anonUnlink.status === 401 && anonUnlink.body?.error === 'SESSION', 'unlink without a session is rejected');
  check(anonList.status === 403 && wrongList.status === 403 && queryList.status === 403 && anonReset.status === 403 && [anonList, wrongList, queryList, anonReset].every((res) => res.body?.error === 'ADMIN'), 'listing and resetting links requires the admin key header');
  check(!existsSync(linksFile), 'rejected auth does not write links');

  const samToken = await signIn('sam.rep@example.com');
  const missingId = await linkAs(samToken, '424242');
  const droppedId = await linkAs(samToken, '777098');
  const numberId = await linkAs(samToken, 777001);
  const blankId = await linkAs(samToken, '');
  check(missingId.status === 404 && missingId.body?.error === 'REP_NOT_FOUND' && droppedId.status === 404 && droppedId.body?.error === 'REP_NOT_FOUND', 'an unknown or dropped rep id is not found');
  check(numberId.status === 400 && numberId.body?.error === 'REP_ID' && blankId.status === 400 && blankId.body?.error === 'REP_ID', 'link rep id must be a numeric string');
  check(!existsSync(linksFile) && hidesNames(missingId.text) && hidesNames(droppedId.text), 'a missed link does not write a file or echo a full name');

  const linked = await linkAs(samToken, '777001');
  check(linked.status === 200 && linked.body?.ok === true && linked.body.repId === '777001' && linked.body.displayName === 'SAM Q' && hidesNames(linked.text) && linked.headers.get('access-control-allow-origin') === '*', 'link returns the display name for a rep id in the snapshot');
  const storedLink = readFileSync(linksFile, 'utf8');
  check(storedLink.includes('777001') && storedLink.includes('sam.rep@example.com') && !storedLink.includes('Sam Quinn'), 'links file keeps the rep id and the account email');
  const relink = await linkAs(samToken, ' 777001 ');
  check(relink.status === 200 && relink.body?.displayName === 'SAM Q' && readFileSync(linksFile, 'utf8') === storedLink, 'the same account can link that rep id again without rewriting the claim');

  const samMe = await api(base, 'GET', '/api/reps/me', { headers: bearer(samToken) });
  check(samMe.status === 200 && samMe.body?.ok === true && samMe.body.repId === '777001' && samMe.body.displayName === 'SAM Q', 'me returns the linked rep');
  check(JSON.stringify(samMe.body.events) === JSON.stringify([
    eventView('temple-008', 12, 1500, 1),
    eventView('e43169461', 1, 50, 2),
  ]), 'me rewards follow points and rank, including a second event');
  check(hidesNames(samMe.text) && !samMe.text.includes('sam.rep@example.com') && !samMe.text.includes('"name"') && samMe.body.events.every((event) => event.merchCode === null && Object.prototype.hasOwnProperty.call(event, 'merchCode')), 'me omits the full name and email, and keeps merchCode null');

  const kaiToken = await signIn('kai.rep@example.com');
  const anaToken = await signIn('ana.rep@example.com');
  const ivyToken = await signIn('ivy.rep@example.com');
  const boToken = await signIn('bo.rep@example.com');
  const coToken = await signIn('co.rep@example.com');
  const doToken = await signIn('do.rep@example.com');
  const eoToken = await signIn('eo.rep@example.com');
  const foToken = await signIn('fo.rep@example.com');
  check((await linkAs(kaiToken, '777003')).status === 200, 'kai links');
  check((await linkAs(anaToken, '777004')).status === 200, 'ana links');
  check((await linkAs(ivyToken, '777005')).status === 200, 'ivy links');
  check((await linkAs(boToken, '777010')).status === 200, 'bo links');
  check((await linkAs(coToken, '777011')).status === 200, 'co links');
  check((await linkAs(doToken, '777012')).status === 200, 'do links');
  check((await linkAs(eoToken, '777013')).status === 200, 'eo links');
  check((await linkAs(foToken, '777014')).status === 200, 'fo links');
  const meEvents = async (token) => (await api(base, 'GET', '/api/reps/me', { headers: bearer(token) })).body?.events;
  check(JSON.stringify(await meEvents(kaiToken)) === JSON.stringify([eventView('temple-008', 12, 400, 3)]), 'rank 3 below 800 earns top3 only and the next tier is 400 points away');
  check(JSON.stringify(await meEvents(anaToken)) === JSON.stringify([eventView('temple-008', 4, 900, 4)]), 'rank 4 at 900 earns half-off and needs 100 more points');
  check(JSON.stringify(await meEvents(ivyToken)) === JSON.stringify([eventView('temple-008', 3, 2500, 5)]), '2500 points earns every tier and has no next reward');
  check(JSON.stringify(await meEvents(boToken)) === JSON.stringify([eventView('guest-night', 10, 800, 1)]), '800 points exactly earns half-off');
  check(JSON.stringify(await meEvents(coToken)) === JSON.stringify([eventView('guest-night', 9, 1000, 2)]), '1000 points exactly earns guestlist and needs 1000 more');
  check(JSON.stringify(await meEvents(doToken)) === JSON.stringify([eventView('guest-night', 8, 2000, 3)]), '2000 points exactly earns every tier plus top 3');
  check(JSON.stringify(await meEvents(eoToken)) === JSON.stringify([eventView('guest-night', 7, 799, 4)]), '799 points earns nothing and needs 1 more');
  check(JSON.stringify(await meEvents(foToken)) === JSON.stringify([eventView('guest-night', 6, 1999, 5)]), '1999 points still needs 1 point for the top tier');

  const cjToken = await signIn('cj.rep@example.com');
  const clash = await linkAs(cjToken, '777001');
  check(clash.status === 409 && clash.body?.error === 'REP_ALREADY_LINKED' && !clash.text.includes('sam.rep@example.com') && hidesNames(clash.text), 'another account cannot take a claimed rep id');
  const second = await linkAs(samToken, '777002');
  check(second.status === 409 && second.body?.error === 'ACCOUNT_ALREADY_LINKED', 'an account keeps the rep id it claimed first');
  const cjEarly = await api(base, 'GET', '/api/reps/me', { headers: bearer(cjToken) });
  check(cjEarly.status === 404 && cjEarly.body?.error === 'NOT_LINKED', 'a refused claim leaves that account unlinked');
  const crewReset = await api(base, 'DELETE', '/api/reps/links/777001', { headers: bearer(samToken) });
  check(crewReset.status === 403 && crewReset.body?.error === 'ADMIN' && (await api(base, 'GET', '/api/reps/me', { headers: bearer(samToken) })).body?.repId === '777001', 'a crew bearer cannot reset someone else');
  const cjUnlink = await api(base, 'DELETE', '/api/reps/link', { headers: bearer(cjToken) });
  check(cjUnlink.status === 404 && cjUnlink.body?.error === 'NOT_LINKED', 'unlinking an account that has no rep does not drop anyone else');

  const unlinked = await api(base, 'DELETE', '/api/reps/link', { headers: bearer(samToken) });
  check(unlinked.status === 200 && unlinked.body?.ok === true && unlinked.body.unlinked === true, 'delete unlinks the signed-in account');
  const unlinkedMe = await api(base, 'GET', '/api/reps/me', { headers: bearer(samToken) });
  check(unlinkedMe.status === 404 && unlinkedMe.body?.error === 'NOT_LINKED', 'an unlinked account gets not linked');
  const unlinkedAgain = await api(base, 'DELETE', '/api/reps/link', { headers: bearer(samToken) });
  check(unlinkedAgain.status === 404 && unlinkedAgain.body?.error === 'NOT_LINKED', 'unlinking again reports not linked');
  const cjClaim = await linkAs(cjToken, '777001');
  check(cjClaim.status === 200 && cjClaim.body?.displayName === 'SAM Q' && hidesNames(cjClaim.text), 'the rep id can be claimed once it is free');
  const cjMe = await api(base, 'GET', '/api/reps/me', { headers: bearer(cjToken) });
  check(cjMe.body?.repId === '777001' && JSON.stringify(cjMe.body.events) === JSON.stringify(samMe.body.events), 'the new account sees that rep, not a private name');

  const listed = await api(base, 'GET', '/api/reps/links', { headers: { 'X-Admin-Key': ADMIN_KEY } });
  const claimed = listed.body?.links?.find((item) => item.repId === '777001');
  check(listed.status === 200 && claimed?.email === 'cj.rep@example.com' && claimed.displayName === 'SAM Q' && typeof claimed.at === 'string', 'admin list shows the account that holds the rep id');
  check(hidesNames(listed.text) && !listed.text.includes('"name"'), 'admin list omits full names');
  const reset = await api(base, 'DELETE', `/api/reps/links/777001`, { headers: { 'X-Admin-Key': ADMIN_KEY } });
  check(reset.status === 200 && reset.body?.ok === true && reset.body.removed === true && reset.body.repId === '777001', 'admin can reset a claimed rep id');
  const resetMe = await api(base, 'GET', '/api/reps/me', { headers: bearer(cjToken) });
  check(resetMe.status === 404 && resetMe.body?.error === 'NOT_LINKED', 'a reset rep is no longer linked');
  const resetAgain = await api(base, 'DELETE', '/api/reps/links/777001', { headers: { 'X-Admin-Key': ADMIN_KEY } });
  check(resetAgain.status === 404 && resetAgain.body?.error === 'NOT_LINKED', 'resetting a free rep id is not linked');
  const samAgain = await linkAs(samToken, '777001');
  check(samAgain.status === 200 && samAgain.body?.repId === '777001', 'the original account can claim the rep id after a reset');

  const rateToken = await signIn('rate.rep@example.com');
  let tenth;
  for (let i = 0; i < 10; i += 1) tenth = await linkAs(rateToken, String(100001 + i));
  check(tenth.status === 404 && tenth.body?.error === 'REP_NOT_FOUND', 'the tenth link attempt still runs');
  const blocked = await linkAs(rateToken, '777002');
  check(blocked.status === 429 && blocked.body?.error === 'RATE', 'the eleventh link attempt is rate limited');
  const lateToken = await signIn('late.rep@example.com');
  const late = await linkAs(lateToken, '777002');
  check(late.status === 200 && late.body?.displayName === 'CJ M' && hidesNames(late.text), 'a rate limited attempt does not claim the rep id');
  const publicAfter = await api(base, 'GET', '/api/reps');
  check(hidesRepIds(publicAfter.text) && hidesNames(publicAfter.text) && !publicAfter.text.includes('example.com'), 'the public feed still has no rep ids, full names, or account emails');

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
  check(hidesNames(next.text) && hidesRepIds(next.text) && !next.text.includes('custom-009'), 'replaced feed drops the old custom link, the old names, and the rep ids');
  const disk2 = readFileSync(repsFile, 'utf8');
  check(disk2.includes('Uma Frost') && !disk2.includes('Cj Mc Henry') && !disk2.includes('custom-009') && !disk2.includes('guest-night') && !disk2.includes('777001'), 'the file on disk is the new snapshot');
  const kept = await api(base, 'GET', '/api/reps/me', { headers: bearer(samToken) });
  check(kept.status === 200 && kept.body?.repId === '777001' && kept.body.displayName === null && Array.isArray(kept.body.events) && kept.body.events.length === 0, 'a claim survives a snapshot that drops that rep');
  const linksKept = readFileSync(linksFile, 'utf8');
  check(linksKept.includes('777001') && linksKept.includes('sam.rep@example.com') && !linksKept.includes('Sam Quinn'), 'the links file is separate from the snapshot');

  const before = readFileSync(repsFile, 'utf8');
  const linksBefore = readFileSync(linksFile, 'utf8');
  const badUrl = await post({ updatedAt: '2026-12-07T12:00:00Z', events: [{ eventId: 'temple-008', repUrl: 'http://promotioncentre.co.uk/reps', reps: row }] });
  const badPoints = await post({ updatedAt: '2026-12-07T12:00:00Z', events: [{ eventId: 'temple-008', reps: [{ name: 'Cj Mc Henry', tickets: 15 }] }] });
  const badEvent = await post({ updatedAt: '2026-12-07T12:00:00Z', events: [{ eventId: 'temple-008', skiddleId: '43169461', reps: row }] });
  const badRep = await post({ updatedAt: '2026-12-07T12:00:00Z', events: [{ eventId: 'temple-008', reps: [rep('Cj Mc Henry', 1, 10, '555001'), rep('Kai Murphy', 1, 10, '555001')] }] });
  check(badUrl.status === 400 && badUrl.body.error === 'REP_URL' && badPoints.status === 400 && badPoints.body.error === 'POINTS' && badEvent.status === 400 && badEvent.body.error === 'EVENT' && badRep.status === 400 && badRep.body.error === 'REP_ID', 'a bad snapshot is a 400');
  check(readFileSync(repsFile, 'utf8') === before && readFileSync(linksFile, 'utf8') === linksBefore, 'a rejected snapshot does not replace the stored feed or the links');
  check(hidesNames(badUrl.text) && hidesNames(badPoints.text), 'rejected snapshots still omit full names');

  const open = await api(base, 'GET', '/api/reps', { headers: { 'X-Admin-Key': 'nope' } });
  check(open.status === 200 && open.body.events.length === 4, 'GET stays public after a snapshot');
  const method = await api(base, 'PUT', '/api/reps');
  check(method.status === 405 && method.body?.error === 'METHOD', 'PUT is rejected');

  check(!server.log().includes(ADMIN_KEY) && hidesNames(server.log()) && PRIVATE_IDS.every((id) => !server.log().includes(id)), 'logs omit the admin key, full names, and rep ids');

  server.child.kill();
  server = await start();
  const again = await api(server.base, 'GET', '/api/reps');
  check(again.body?.updatedAt === '2026-11-30T12:00:00.000Z' && eventById(again.body, 'temple-009')?.repUrl === DEFAULTS[2][2] && eventById(again.body, 'temple-008')?.reps?.length === 0 && hidesRepIds(again.text), 'the snapshot and default links survive a restart');
  const meRestart = await api(server.base, 'GET', '/api/reps/me', { headers: bearer(samToken) });
  check(meRestart.status === 200 && meRestart.body?.repId === '777001' && meRestart.body.displayName === null && meRestart.body.events?.length === 0, 'the rep link survives a restart');
  check(!server.log().includes(ADMIN_KEY) && hidesNames(server.log()) && PRIVATE_IDS.every((id) => !server.log().includes(id)), 'restart logs omit the admin key, full names, and rep ids');
} catch (error) {
  failures += 1;
  console.log(`FAIL ${redact(error instanceof Error ? error.stack || error.message : error)}`);
} finally {
  server?.child?.kill();
}

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
