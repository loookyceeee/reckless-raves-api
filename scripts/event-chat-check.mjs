// Checks temporary per-event chats against local servers (child processes, temp DATA_DIR, no network).
//   node scripts/event-chat-check.mjs
// Covers: verified-only gate, the 7-day / 24-hour window, sweeper hard-delete on boot and on request,
// profanity filter, link stripping, no images, 10/min rate limit, report, block/unblock,
// and admin delete / mute / ban / per-event close.
import { spawn } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chatDisplayName, chatWindow, filterChatText } from '../server/event-chat.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SECRET = 'local-event-chat-check-secret';
const PASSWORD = 'local-event-chat-password-7x2q';
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
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

const userId = (email) => createHash('sha256').update(String(email).trim().toLowerCase()).digest('hex').slice(0, 16);

/* ---------- filter, names, window (no server) ---------- */
{
  const slur = (input, label) => {
    const got = filterChatText(input);
    check(got.ok === false && got.error === 'SLUR', `filter: ${label} blocked`, got.ok ? got.text : got.error);
  };
  slur('you nigger', 'hard slur');
  slur('n1gg3r', 'leet slur');
  slur('n.i.g.g.e.r', 'dotted slur');
  slur('n i g g e r', 'spaced slur');
  slur('f4ggot', 'leet faggot');
  slur('that is retarded', 'retard');
  slur('fenian hun', 'sectarian');
  const masked = filterChatText('what the shit');
  check(masked.ok && masked.text === 'what the ****' && masked.filtered === true, 'filter: shit masked', masked);
  check(filterChatText('what the f*ck').text === 'what the ***', 'filter: starred fuck masked', filterChatText('what the f*ck'));
  check(filterChatText('SH1T happens').text === '**** happens', 'filter: leet shit masked');
  const clean = ['classic', 'cocktail', 'dictionary', 'scunthorpe', 'grape', 'hunter', 'raccoon', 'assignment', 'nigeria', 'nigella', 'cunningham'];
  for (const word of clean) {
    const got = filterChatText(`see ${word} tonight`);
    check(got.ok && got.text === `see ${word} tonight` && got.filtered === false, `filter: ${word} kept`, got);
  }
  const links = filterChatText('come https://evil.example/phish and https://www.skiddle.com/e/1 plus https://recklessraves.co.uk/events and www.google.com');
  check(links.ok && links.text.includes('https://www.skiddle.com/e/1') && links.text.includes('https://recklessraves.co.uk/events') && !links.text.includes('evil') && !links.text.includes('google'), 'filter: only skiddle and reckless links stay', links.text);
  check(filterChatText('https://notskiddle.com/x').text === '' || filterChatText('https://notskiddle.com/x').error === 'TEXT', 'filter: lookalike host stripped', filterChatText('https://notskiddle.com/x'));
  check(filterChatText('https://skiddle.com.evil.test/x').error === 'TEXT', 'filter: skiddle.com.evil stripped');
  check(filterChatText('hi ![pic](https://cdn.example/a.png)').error === 'NO_IMAGES', 'filter: markdown image refused');
  check(filterChatText('data:image/png;base64,aaaa').error === 'NO_IMAGES', 'filter: data image refused');
  check(filterChatText('   ').error === 'TEXT', 'filter: blank refused');
  check(filterChatText('a'.repeat(500)).ok === true, 'filter: 500 chars ok');
  check(filterChatText('a'.repeat(501)).error === 'TEXT_TOO_LONG', 'filter: 501 chars refused');
  check(chatDisplayName({ handle: 'NOVA', personalName: 'Alex Morgan' }) === 'NOVA', 'name: crew handle wins');
  check(chatDisplayName({ handle: '', personalName: 'Alex Morgan' }) === 'ALEX M', 'name: first name + last initial');
  check(chatDisplayName({ handle: '', personalName: '' }) === 'CREW', 'name: fallback CREW');
  const start = Date.parse('2026-12-01T20:00:00.000Z');
  const withEnd = chatWindow({ startDate: new Date(start).toISOString(), endDate: new Date(start + 8 * HOUR).toISOString() });
  check(withEnd.opensMs === start - 7 * DAY && withEnd.closesMs === start + 8 * HOUR + DAY, 'window: opens 7 days before start, closes 24h after the end');
  const noEnd = chatWindow({ startDate: new Date(start).toISOString() });
  check(noEnd.closesMs === start + DAY, 'window: no end time, 24h after the start');
  const badEnd = chatWindow({ startDate: new Date(start).toISOString(), endDate: new Date(start - HOUR).toISOString() });
  check(badEnd.closesMs === start + DAY, 'window: end before start is ignored');
  check(chatWindow({ title: 'x' }) === null, 'window: no start is not a chat');
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

const now = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const FANS = {
  a: 'fan.a@example.com',
  b: 'fan.b@example.com',
  c: 'fan.c@example.com',
  e: 'fan.e@example.com',
};
const OPEN_START = now + 2 * DAY;
const OPEN_END = OPEN_START + 8 * HOUR;
const NO_END_START = now + 1 * DAY;

function seed(dataDir, { files = true } = {}) {
  mkdirSync(dataDir, { recursive: true });
  const events = [
    { id: 'temple-008', skiddleId: '42803971', startDate: iso(OPEN_START), endDate: iso(OPEN_END), dateBadge: '28.11', weekday: 'Saturday', title: 'GEARBOX X RECKLESS', subtitle: 'THE TEMPLE 008', venue: 'The Temple', city: 'Belfast', lineup: [], ticketsUrl: 'https://www.skiddle.com/e/42803971', image: null },
    { id: 'temple-009', skiddleId: '42853722', startDate: iso(now + 10 * DAY), endDate: iso(now + 10 * DAY + 8 * HOUR), dateBadge: '26.12', weekday: 'Saturday', title: 'THE TEMPLE 009', subtitle: '', venue: 'The Temple', city: 'Belfast', lineup: [], ticketsUrl: 'https://www.skiddle.com/e/42853722', image: null },
    { id: 'no-end', skiddleId: '42000011', startDate: iso(NO_END_START), dateBadge: '01.12', weekday: 'Tuesday', title: 'NO END TIME', subtitle: '', venue: 'The Temple', city: 'Belfast', lineup: [], ticketsUrl: 'https://www.skiddle.com/e/42000011', image: null },
    { id: 'after-hours', skiddleId: '42000022', startDate: iso(now - 20 * HOUR), endDate: iso(now - 2 * HOUR), dateBadge: '22.11', weekday: 'Sunday', title: 'JUST ENDED', subtitle: '', venue: 'The Temple', city: 'Belfast', lineup: [], ticketsUrl: 'https://www.skiddle.com/e/42000022', image: null },
    { id: 'long-over', skiddleId: '42000033', startDate: iso(now - 3 * DAY), endDate: iso(now - 30 * HOUR), dateBadge: '18.11', weekday: 'Wednesday', title: 'LONG OVER', subtitle: '', venue: 'The Temple', city: 'Belfast', lineup: [], ticketsUrl: 'https://www.skiddle.com/e/42000033', image: null },
  ];
  writeFileSync(path.join(dataDir, 'content.json'), JSON.stringify({ updatedAt: iso(now), records: [], events, products: [], status: {} }));
  const fit = { top: 'skate-tee', outer: null, legs: 'barrel-jeans' };
  writeFileSync(path.join(dataDir, 'accounts.json'), JSON.stringify({
    [FANS.a]: { xp: 0, fit, createdAt: iso(now - HOUR), avatarBase: 'male' },
    [FANS.b]: { xp: 0, fit: { top: null, outer: null, legs: null }, createdAt: iso(now - HOUR), avatarBase: 'female', avatarBaseSet: true, name: 'Alex Morgan' },
    [FANS.c]: { xp: 0, fit: { top: null, outer: null, legs: null }, createdAt: iso(now - HOUR) },
    [FANS.e]: { xp: 0, fit: { top: null, outer: null, legs: null }, createdAt: iso(now - HOUR), name: 'Sam Lee' },
  }));
  writeFileSync(path.join(dataDir, 'xp-ledger.json'), JSON.stringify({ source: 'file', updated: iso(now), rows: 1, emails: { [FANS.a]: { xp: 3100 } } }));
  writeFileSync(path.join(dataDir, 'skiddle-orders.json'), JSON.stringify({ orders: [
    { email: FANS.a, skiddleEventId: '42803971', orderId: 'T1' },
    { email: FANS.b, skiddleEventId: '42803971', orderId: 'T2' },
    { email: FANS.e, skiddleEventId: '42803971', orderId: 'T3' },
  ] }));
  writeFileSync(path.join(dataDir, 'social.json'), JSON.stringify({
    profiles: {
      [FANS.a]: { handle: 'NOVA', private: false, badgesSeen: [] },
      [FANS.c]: { handle: 'KAI', private: false, badgesSeen: [] },
      [FANS.e]: { handle: 'RIO', private: false, badgesSeen: [] },
    },
    going: {},
    checkins: {},
    blockedHandles: {},
  }));
  if (!files) return;
  const dir = path.join(dataDir, 'chats', 'events');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'ghost.json'), JSON.stringify({
    eventId: 'ghost',
    opensAt: iso(now - 2 * DAY),
    closesAt: iso(now - HOUR),
    messages: [{ id: 'ghostmsg01', email: 'gone@example.com', text: 'SECRET_GONE_CHAT', createdAt: iso(now - 2 * HOUR) }],
    reports: [{ id: 'ghostrep01', messageId: 'ghostmsg01', text: 'SECRET_GONE_CHAT', author: 'gone@example.com', reporter: FANS.c }],
  }));
  writeFileSync(path.join(dir, 'keeper.json'), JSON.stringify({
    eventId: 'keeper',
    opensAt: iso(now - HOUR),
    closesAt: iso(now + 10 * DAY),
    messages: [{ id: 'keepermsg1', email: 'keep@example.com', text: 'KEEP_THIS_CHAT', createdAt: iso(now - 30 * 60 * 1000) }],
    reports: [],
  }));
}

function walk(dir, needle, hits = []) {
  if (!existsSync(dir)) return hits;
  for (const name of readdirSync(dir)) {
    const file = path.join(dir, name);
    if (statSync(file).isDirectory()) walk(file, needle, hits);
    else if (readFileSync(file, 'utf8').includes(needle)) hits.push(file);
  }
  return hits;
}

async function start(dataDir, env) {
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(root, 'server', 'serve.mjs')], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dataDir, AUTH_SECRET: SECRET, CONTENT_REFRESH: 'off', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (chunk) => { log += chunk; });
  child.stderr.on('data', (chunk) => { log += chunk; });
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/api/social/status`);
      if (res.ok) return { base, child, log: () => log };
    } catch {
      // not yet
    }
    await new Promise((resolve) => setTimeout(resolve, 60));
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
  return async function call(method, pathname, { as, json, headers = {} } = {}) {
    const h = { 'X-Forwarded-For': `10.8.0.${(ipCounter++ % 200) + 1}`, ...headers };
    if (as) h.Authorization = `Bearer ${token(as)}`;
    let body;
    if (json !== undefined) {
      h['Content-Type'] = 'application/json';
      body = JSON.stringify(json);
    }
    const res = await fetch(`${base}${pathname}`, { method, headers: h, body });
    const text = await res.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
    return { status: res.status, body: parsed, text, res };
  };
}

async function adminLogin(base) {
  const page = await fetch(`${base}/admin/login`, { headers: { 'X-Forwarded-For': '10.9.9.9' } });
  const html = await page.text();
  const pre = /name="pre" value="([^"]+)"/.exec(html)?.[1];
  const preCookie = (page.headers.getSetCookie?.() || []).find((line) => line.startsWith('__Host-rr_admin_pre='))?.split(';')[0];
  const res = await fetch(`${base}/admin/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Forwarded-For': '10.9.9.9', Origin: base, Cookie: preCookie || '' },
    body: new URLSearchParams({ pre, password: PASSWORD }).toString(),
  });
  const cookie = (res.headers.getSetCookie?.() || []).find((line) => line.startsWith('__Host-rr_admin='))?.split(';')[0];
  const adminHtml = await (await fetch(`${base}/admin`, { headers: { Cookie: cookie } })).text();
  const csrf = /name="csrf-token" content="([^"]+)"/.exec(adminHtml)?.[1];
  return {
    cookie,
    html: adminHtml,
    csrf,
    get: async (pathname) => (await fetch(`${base}/admin/api${pathname}`, { headers: { Cookie: cookie } })).json(),
    post: async (pathname, json) => {
      const response = await fetch(`${base}/admin/api${pathname}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: base, 'X-CSRF-Token': csrf },
        body: JSON.stringify(json),
      });
      return { status: response.status, body: await response.json() };
    },
  };
}

/* ---------- flags off: no post, but boot sweeper still deletes expired files ---------- */
{
  const dataDir = mkdtempSync(path.join(tmpdir(), 'rr-chat-off-'));
  seed(dataDir);
  const s = await start(dataDir, {});
  try {
    const call = client(s.base);
    check(!existsSync(path.join(dataDir, 'chats', 'events', 'ghost.json')), 'boot sweeper: expired chat file unlinked while the flag is off');
    check(walk(dataDir, 'SECRET_GONE_CHAT').length === 0, 'boot sweeper: expired message text is gone from DATA_DIR');
    check(existsSync(path.join(dataDir, 'chats', 'events', 'keeper.json')), 'boot sweeper: a chat that has not expired stays');
    const off = await call('GET', '/api/events/temple-008/chat', { as: FANS.a });
    check(off.status === 403 && off.body.error === 'SOCIAL_OFF', 'flags: both off is SOCIAL_OFF', off.body);
    const posted = await call('POST', '/api/events/temple-008/chat/messages', { as: FANS.a, json: { text: 'should not store' } });
    check(posted.status === 403 && posted.body.error === 'SOCIAL_OFF', 'flags: post refused while off');
    check(!existsSync(path.join(dataDir, 'chats', 'events', 'temple-008.json')), 'flags: nothing written for the event while off');
  } finally {
    s.child.kill();
  }
}
{
  const dataDir = mkdtempSync(path.join(tmpdir(), 'rr-chat-social-'));
  seed(dataDir, { files: false });
  const s = await start(dataDir, { SOCIAL_LIVE: '1' });
  try {
    const call = client(s.base);
    const got = await call('GET', '/api/events/temple-008/chat', { as: FANS.a });
    check(got.status === 403 && got.body.error === 'CHAT_OFF', 'flags: SOCIAL_LIVE without EVENT_CHAT_LIVE is CHAT_OFF', got.body);
  } finally {
    s.child.kill();
  }
}
{
  const dataDir = mkdtempSync(path.join(tmpdir(), 'rr-chat-only-'));
  seed(dataDir, { files: false });
  const s = await start(dataDir, { EVENT_CHAT_LIVE: '1' });
  try {
    const call = client(s.base);
    const got = await call('POST', '/api/events/temple-008/chat/messages', { as: FANS.a, json: { text: 'no' } });
    check(got.status === 403 && got.body.error === 'SOCIAL_OFF', 'flags: EVENT_CHAT_LIVE without SOCIAL_LIVE is SOCIAL_OFF', got.body);
  } finally {
    s.child.kill();
  }
}

/* ---------- both flags on ---------- */
{
  const dataDir = mkdtempSync(path.join(tmpdir(), 'rr-chat-on-'));
  seed(dataDir);
  const s = await start(dataDir, { SOCIAL_LIVE: '1', EVENT_CHAT_LIVE: '1', ADMIN_PASSWORD: PASSWORD });
  const call = client(s.base);
  const base = s.base;
  try {
    check(!existsSync(path.join(dataDir, 'chats', 'events', 'ghost.json')) && walk(dataDir, 'SECRET_GONE_CHAT').length === 0, 'boot sweeper: expired messages hard-deleted before listen');
    check(readFileSync(path.join(dataDir, 'chats', 'events', 'keeper.json'), 'utf8').includes('KEEP_THIS_CHAT'), 'boot sweeper: unexpired file kept');

    const anon = await call('GET', '/api/events/temple-008/chat');
    check(anon.status === 401 && anon.body.error === 'SESSION', 'auth: session required', anon.body);
    const opt = await fetch(`${base}/api/events/temple-008/chat`, { method: 'OPTIONS' });
    check(opt.status === 204, 'auth: OPTIONS 204', opt.status);

    const open = await call('GET', '/api/events/temple-008/chat', { as: FANS.a });
    check(open.status === 200 && open.body.status === 'open' && open.body.canJoin === true && open.body.reason === null && open.body.canRead === true && open.body.canPost === true, 'window: verified fan can join an open chat', open.body);
    check(Date.parse(open.body.opensAt) === OPEN_START - 7 * DAY && Date.parse(open.body.closesAt) === OPEN_END + DAY, 'window: opensAt is start-7d, closesAt is end+24h', open.body);

    const noEnd = await call('GET', '/api/events/no-end/chat', { as: FANS.a });
    check(Date.parse(noEnd.body.closesAt) === NO_END_START + DAY && Date.parse(noEnd.body.opensAt) === NO_END_START - 7 * DAY, 'window: event with no end closes 24h after the start', noEnd.body);

    const early = await call('GET', '/api/events/temple-009/chat', { as: FANS.a });
    check(early.body.status === 'upcoming' && early.body.canJoin === false && early.body.reason === 'NOT_OPEN', 'window: more than 7 days out is NOT_OPEN', early.body);
    const earlyPost = await call('POST', '/api/events/temple-009/chat/messages', { as: FANS.a, json: { text: 'too early' } });
    check(earlyPost.status === 403 && earlyPost.body.error === 'NOT_OPEN', 'window: cannot post before open');

    const ended = await call('GET', '/api/events/long-over/chat', { as: FANS.a });
    check(ended.body.status === 'closed' && ended.body.reason === 'CLOSED' && ended.body.canJoin === false, 'window: 24h after the end is CLOSED', ended.body);
    check(!existsSync(path.join(dataDir, 'chats', 'events', 'long-over.json')), 'window: expired event has no chat file');

    const tail = await call('GET', '/api/events/after-hours/chat', { as: FANS.c });
    check(tail.body.status === 'open' && tail.body.reason === 'NOT_VERIFIED', 'window: still open 2h after the end, unverified cannot join', tail.body);

    const stranger = await call('GET', '/api/events/temple-008/chat', { as: FANS.c });
    check(stranger.body.canJoin === false && stranger.body.reason === 'NOT_VERIFIED' && stranger.body.canRead === false, 'verified: no ticket means NOT_VERIFIED', stranger.body);
    const strangerRead = await call('GET', '/api/events/temple-008/chat/messages', { as: FANS.c });
    const strangerPost = await call('POST', '/api/events/temple-008/chat/messages', { as: FANS.c, json: { text: 'LEAKED_UNVERIFIED' } });
    check(strangerRead.status === 403 && strangerRead.body.error === 'NOT_VERIFIED' && strangerPost.status === 403 && strangerPost.body.error === 'NOT_VERIFIED', 'verified: cannot read or post without a ticket');
    check(walk(dataDir, 'LEAKED_UNVERIFIED').length === 0, 'verified: refused post is not stored');

    const missing = await call('GET', '/api/events/no-such-event/chat', { as: FANS.a });
    check(missing.status === 404 && missing.body.error === 'EVENT', 'event: unknown id is 404');

    mkdirSync(path.join(dataDir, 'chats', 'events'), { recursive: true });
    writeFileSync(path.join(dataDir, 'chats', 'events', 'dropped.json'), JSON.stringify({
      eventId: 'dropped',
      opensAt: iso(now - DAY),
      closesAt: iso(now + DAY),
      skiddleId: '42803971',
      title: 'DROPPED OFF THE FEED',
      closed: false,
      messages: [],
      reports: [],
    }));
    const dropped = await call('GET', '/api/events/dropped/chat', { as: FANS.a });
    const droppedPost = await call('POST', '/api/events/dropped/chat/messages', { as: FANS.a, json: { text: 'still here after the listing dropped' } });
    const droppedStranger = await call('GET', '/api/events/dropped/chat', { as: FANS.c });
    check(dropped.body.status === 'open' && dropped.body.canJoin === true && droppedPost.status === 200 && droppedStranger.body.reason === 'NOT_VERIFIED', 'window: chat keeps working from the stored Skiddle id after the event leaves the content list', droppedPost.body);

    const hello = await call('POST', '/api/events/temple-008/chat/messages', { as: FANS.a, json: { text: 'hello from nova' } });
    check(hello.status === 200 && hello.body.filtered === false && hello.body.message.name === 'NOVA' && hello.body.message.crew === 'RECKLESS FAMILY' && hello.body.message.level === 10 && hello.body.message.avatarBase === 'male' && hello.body.message.fit?.top === 'skate-tee' && hello.body.message.you === true && hello.body.message.userId === userId(FANS.a) && !JSON.stringify(hello.body).includes(FANS.a) && !JSON.stringify(hello.body).includes('@'), 'post: crew name, level, avatar, stable userId, no email', hello.body);

    const swear = await call('POST', '/api/events/temple-008/chat/messages', { as: FANS.a, json: { text: 'what the shit' } });
    check(swear.status === 200 && swear.body.filtered === true && swear.body.message.text === 'what the ****', 'post: profanity masked in the stored text', swear.body.message);
    const linked = await call('POST', '/api/events/temple-008/chat/messages', { as: FANS.a, json: { text: 'tickets https://www.skiddle.com/e/1 and https://evil.example/phish' } });
    check(linked.status === 200 && linked.body.message.text.includes('skiddle.com') && !linked.body.message.text.includes('evil.example'), 'post: non-skiddle link stripped', linked.body.message);
    const slur = await call('POST', '/api/events/temple-008/chat/messages', { as: FANS.a, json: { text: 'you nigger' } });
    check(slur.status === 400 && slur.body.error === 'SLUR' && walk(dataDir, 'nigger').length === 0, 'post: hard slur refused and not stored', slur.body);
    const long = await call('POST', '/api/events/temple-008/chat/messages', { as: FANS.a, json: { text: 'a'.repeat(501) } });
    check(long.status === 400 && long.body.error === 'TEXT_TOO_LONG', 'post: 501 chars refused');
    const image = await call('POST', '/api/events/temple-008/chat/messages', { as: FANS.a, json: { text: 'hi', image: 'pic.jpg' } });
    check(image.status === 400 && image.body.error === 'NO_IMAGES', 'post: image field refused');

    const rio = await call('POST', '/api/events/temple-008/chat/messages', { as: FANS.e, json: { text: 'rio was here' } });
    check(rio.status === 200 && rio.body.message.name === 'RIO', 'post: second verified fan', rio.body);

    const ids = [];
    let lastOk = null;
    for (let i = 0; i < 10; i += 1) {
      lastOk = await call('POST', '/api/events/temple-008/chat/messages', { as: FANS.b, json: { text: `hey ${i} from alex` } });
      if (lastOk.status === 200) ids.push(lastOk.body.message.id);
    }
    check(ids.length === 10 && lastOk.body.message.name === 'ALEX M' && lastOk.body.message.avatarBase === 'female' && lastOk.body.message.level === 1 && lastOk.body.message.crew === 'FRESHER', 'post: no handle uses first name + last initial', lastOk.body);
    const limited = await call('POST', '/api/events/temple-008/chat/messages', { as: FANS.b, json: { text: 'hey 10 from alex' } });
    check(limited.status === 429 && limited.body.error === 'RATE', 'rate: 11th message in a minute is refused', limited.body);

    const all = await call('GET', '/api/events/temple-008/chat/messages', { as: FANS.a });
    const bMessages = all.body.messages.filter((message) => message.userId === userId(FANS.b));
    check(all.status === 200 && bMessages.length === 10 && !JSON.stringify(all.body).includes(FANS.b) && !JSON.stringify(all.body).includes('hey 10'), 'poll: 10 messages, the refused one is absent, no email', all.status);
    const page = await call('GET', `/api/events/temple-008/chat/messages?after=${encodeURIComponent(ids[0])}`, { as: FANS.a });
    check(page.status === 200 && page.body.messages[0]?.id === ids[1] && page.body.messages.every((message) => message.id !== ids[0]), 'poll: after= id returns only later messages', page.body.messages?.map((message) => message.id));
    const badAfter = await call('GET', '/api/events/temple-008/chat/messages?after=not-a-cursor', { as: FANS.a });
    check(badAfter.status === 400 && badAfter.body.error === 'AFTER', 'poll: unknown after is 400');

    const blocked = await call('POST', '/api/events/temple-008/chat/block', { as: FANS.a, json: { userId: userId(FANS.b) } });
    const hidden = await call('GET', '/api/events/temple-008/chat/messages', { as: FANS.a });
    const still = await call('GET', '/api/events/temple-008/chat/messages', { as: FANS.b });
    check(blocked.status === 200 && blocked.body.blocked === true && !hidden.body.messages.some((message) => message.userId === userId(FANS.b)) && still.body.messages.some((message) => message.userId === userId(FANS.b)), 'block: blocked messages hidden for the blocker only', blocked.body);
    const self = await call('POST', '/api/events/temple-008/chat/block', { as: FANS.a, json: { userId: userId(FANS.a) } });
    check(self.status === 400 && self.body.error === 'SELF', 'block: cannot block yourself');
    const unblocked = await call('POST', '/api/events/temple-008/chat/unblock', { as: FANS.a, json: { userId: userId(FANS.b) } });
    const back = await call('GET', '/api/events/temple-008/chat/messages', { as: FANS.a });
    check(unblocked.body.blocked === false && back.body.messages.some((message) => message.userId === userId(FANS.b)), 'unblock: messages come back');

    const own = await call('POST', `/api/events/temple-008/chat/messages/${hello.body.message.id}/report`, { as: FANS.a, json: { reason: 'mine' } });
    check(own.status === 400 && own.body.error === 'OWN', 'report: cannot report your own message');
    const report = await call('POST', `/api/events/temple-008/chat/messages/${ids[0]}/report`, { as: FANS.a, json: { reason: 'spam' } });
    const again = await call('POST', `/api/events/temple-008/chat/messages/${ids[0]}/report`, { as: FANS.a, json: {} });
    check(report.status === 200 && report.body.reported === true && again.body.already === true, 'report: stored once', again.body);

    mkdirSync(path.join(dataDir, 'chats', 'events'), { recursive: true });
    writeFileSync(path.join(dataDir, 'chats', 'events', 'late.json'), JSON.stringify({
      eventId: 'late',
      opensAt: iso(now - DAY),
      closesAt: iso(now - 60 * 1000),
      messages: [{ id: 'latemsg001', email: 'late@example.com', text: 'SECRET_LATE_CHAT', createdAt: iso(now - HOUR) }],
      reports: [],
    }));
    await call('GET', '/api/events/temple-008/chat', { as: FANS.a });
    check(!existsSync(path.join(dataDir, 'chats', 'events', 'late.json')) && walk(dataDir, 'SECRET_LATE_CHAT').length === 0, 'sweeper: a request hard-deletes a chat that expired while the server was up');

    const admin = await adminLogin(base);
    check(admin.html.includes('data-tab="chat"') && admin.csrf, 'admin: CHAT tab is on the page');
    const summary = await admin.get('/chats');
    const reported = summary.reports.find((row) => row.messageId === ids[0]);
    check(summary.ok && summary.chatLive === true && summary.socialLive === true && reported && reported.text.includes('hey 0') && reported.author === FANS.b && reported.reporter === FANS.a && reported.reason === 'spam', 'admin: report listed with text and both fans', reported);
    const removed = await admin.post('/chats/delete', { eventId: 'temple-008', messageId: ids[0] });
    const afterDelete = await call('GET', '/api/events/temple-008/chat/messages', { as: FANS.a });
    check(removed.status === 200 && removed.body.deleted === true && !afterDelete.body.messages.some((message) => message.id === ids[0]), 'admin: delete removes the message for everyone');

    const mute = await admin.post('/chats/mute', { email: FANS.a });
    const mutedStatus = await call('GET', '/api/events/temple-008/chat', { as: FANS.a });
    const mutedRead = await call('GET', '/api/events/temple-008/chat/messages', { as: FANS.a });
    const mutedPost = await call('POST', '/api/events/temple-008/chat/messages', { as: FANS.a, json: { text: 'muted post' } });
    check(mute.body.muted === true && mutedStatus.body.reason === 'MUTED' && mutedStatus.body.canRead === true && mutedStatus.body.canPost === false && mutedRead.status === 200 && mutedPost.status === 403 && mutedPost.body.error === 'MUTED', 'admin: mute can read but not post', mutedStatus.body);
    const lookup = await admin.get(`/crew?email=${encodeURIComponent(FANS.a)}`);
    check(lookup.chat?.muted === true && lookup.chat?.banned === false, 'admin: crew lookup shows the mute');

    const ban = await admin.post('/chats/ban', { email: FANS.b });
    const bannedRead = await call('GET', '/api/events/temple-008/chat/messages', { as: FANS.b });
    const bannedStatus = await call('GET', '/api/events/temple-008/chat', { as: FANS.b });
    check(ban.body.banned === true && bannedStatus.body.reason === 'BANNED' && bannedRead.status === 403 && bannedRead.body.error === 'BANNED', 'admin: ban cannot read or post', bannedStatus.body);
    const stillThere = await call('GET', '/api/events/temple-008/chat/messages', { as: FANS.e });
    check(stillThere.body.messages.some((message) => message.userId === userId(FANS.b)), 'admin: a ban hides nothing from other fans');

    const unmute = await admin.post('/chats/unmute', { email: FANS.a });
    const unban = await admin.post('/chats/unban', { email: FANS.b });
    const postedAgain = await call('POST', '/api/events/temple-008/chat/messages', { as: FANS.a, json: { text: 'back in' } });
    const bReads = await call('GET', '/api/events/temple-008/chat/messages', { as: FANS.b });
    check(unmute.body.muted === false && unban.body.banned === false && postedAgain.status === 200 && bReads.status === 200, 'admin: unmute and unban restore access', postedAgain.body);

    const closed = await admin.post('/chats/close', { eventId: 'temple-008', closed: true });
    const closedGet = await call('GET', '/api/events/temple-008/chat', { as: FANS.a });
    const closedRead = await call('GET', '/api/events/temple-008/chat/messages', { as: FANS.a });
    const onDisk = readFileSync(path.join(dataDir, 'chats', 'events', 'temple-008.json'), 'utf8');
    check(closed.body.closed === true && closedGet.body.status === 'closed' && closedGet.body.reason === 'CLOSED' && closedGet.body.closed === true && closedRead.status === 403 && onDisk.includes('hello from nova'), 'admin: close switch stops the chat and keeps the messages', closedGet.body);
    const reopened = await admin.post('/chats/close', { eventId: 'temple-008', closed: false });
    const openAgain = await call('GET', '/api/events/temple-008/chat/messages', { as: FANS.a });
    check(reopened.body.closed === false && openAgain.status === 200 && openAgain.body.messages.some((message) => message.text === 'hello from nova'), 'admin: reopen restores the same messages');

    const stats = await admin.get('/stats');
    check(stats.flags?.EVENT_CHAT_LIVE === true && stats.flags?.SOCIAL_LIVE === true, 'admin: STATS shows EVENT_CHAT_LIVE');
    const audit = await admin.get('/audit');
    const actions = new Set((audit.audit || []).map((row) => row.action));
    check(['chat_delete', 'chat_mute', 'chat_ban', 'chat_close'].every((action) => actions.has(action)), 'admin: delete, mute, ban and close are in the audit log', [...actions]);

    const removedAccount = await call('DELETE', '/api/crew', { as: FANS.e });
    const afterForget = await call('GET', '/api/events/temple-008/chat/messages', { as: FANS.a });
    const disk = readFileSync(path.join(dataDir, 'chats', 'events', 'temple-008.json'), 'utf8');
    check(removedAccount.status === 200 && !afterForget.body.messages.some((message) => message.text === 'rio was here') && !disk.includes(FANS.e) && !disk.includes('rio was here'), 'delete account: that fan\'s messages are removed');
  } finally {
    s.child.kill();
    if (failures && process.env.SHOW_LOG) console.log(s.log());
  }
}

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
