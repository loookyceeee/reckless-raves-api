// Checks the admin push scheduler against local servers (child processes, temp DATA_DIR, no network).
//   node scripts/push-schedule-check.mjs
// Covers: create, list, edit, cancel, London time, due send exactly once, missed after 6 hours,
// a restart not double-sending, and the same admin session auth as the other admin push routes.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createPushSchedule, londonParts, londonWallToInstant, MISSED_AFTER_MS } from '../server/push-schedule.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = mkdtempSync(path.join(tmpdir(), 'rr-schedule-'));
const PASSWORD = 'local-schedule-password-4m8q';
const SECRET = 'local-schedule-check-secret';
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

function londonDate(ms) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
}

writeFileSync(
  path.join(dataDir, 'push-devices.json'),
  JSON.stringify({
    'ExponentPushToken[testtokenAAAAAAAA1]': { email: 'fan.one@example.com', platform: 'ios', topics: ['drops', 'events', 'crew'] },
    'ExponentPushToken[testtokenAAAAAAAA2]': { email: null, platform: 'android', topics: ['events', 'crew'] },
    'ExponentPushToken[testtokenAAAAAAAA3]': { email: 'loookyceeee@example.com', platform: 'ios', topics: ['drops'] },
  }),
);

/* ---------- clock and tick (no server) ---------- */
{
  const summer = londonWallToInstant('2026-06-15', '18:00');
  check(summer.at === '2026-06-15T17:00:00.000Z' && summer.london === '2026-06-15T18:00', 'summer 18:00 UK is 17:00 UTC', summer);
  const winter = londonWallToInstant('2026-12-01', '18:00');
  check(winter.at === '2026-12-01T18:00:00.000Z', 'winter 18:00 UK is 18:00 UTC', winter);
  const gap = londonWallToInstant('2026-03-29', '01:30');
  check(gap.error === 'WHEN', 'clock-change gap is rejected', gap);
  const afterGap = londonWallToInstant('2026-03-29', '02:30');
  check(afterGap.at === '2026-03-29T01:30:00.000Z', '02:30 UK after the spring change is 01:30 UTC', afterGap);
  const overlap = londonWallToInstant('2026-10-25', '01:30');
  const overlapParts = overlap.at ? londonParts(Date.parse(overlap.at)) : {};
  check(overlap.at === '2026-10-25T00:30:00.000Z' && overlapParts.hour === '01' && overlapParts.minute === '30', 'repeated UK minute uses the earlier instant', overlap);
  check(londonWallToInstant('2026-02-31', '12:00').error === 'WHEN', '31 Feb is rejected');
  check(londonWallToInstant('', '12:00').error === 'WHEN', 'missing date is rejected');

  const unitDir = mkdtempSync(path.join(tmpdir(), 'rr-schedule-unit-'));
  const nowMs = Date.parse('2026-06-01T12:00:00.000Z');
  let calls = 0;
  let lastOpts = null;
  const sched = createPushSchedule({
    dataDir: unitDir,
    now: () => nowMs,
    pushLive: () => false,
    targetTokens: (target) => (target.topic === 'drops' ? ['tok-a', 'tok-c'] : target.all ? ['tok-a', 'tok-b', 'tok-c'] : []),
    sendPush: async (tokens, message, opts) => {
      calls += 1;
      lastOpts = { tokens, title: message.title, dryRun: opts.dryRun };
      return { dryRun: true, count: tokens.length, sent: 0, errors: [] };
    },
  });
  const onTime = new Date(nowMs - MISSED_AFTER_MS).toISOString();
  const tooLate = new Date(nowMs - MISSED_AFTER_MS - 1).toISOString();
  sched.create({ title: 'ON TIME', body: 'BODY', path: '/events', audience: 'drops', at: onTime, london: '2026-06-01T07:00' });
  sched.create({ title: 'TOO LATE', body: 'BODY', path: null, audience: 'all', at: tooLate, london: '2026-06-01T06:59' });
  sched.create({ title: 'LATER', body: 'BODY', path: null, audience: 'all', at: new Date(nowMs + 60_000).toISOString(), london: '2026-06-01T13:01' });
  await sched.tick();
  await sched.tick();
  const rows = Object.fromEntries(sched.list().map((item) => [item.title, item]));
  check(calls === 1 && lastOpts.tokens.length === 2 && lastOpts.dryRun === true && lastOpts.title === 'ON TIME', 'due row sends once, to the drops audience, as a dry run', { calls, lastOpts });
  check(rows['ON TIME'].status === 'sent' && rows['ON TIME'].dryRun === true && rows['ON TIME'].count === 2 && rows['ON TIME'].sent === 0, 'due row marked sent', rows['ON TIME']);
  check(rows['TOO LATE'].status === 'missed' && rows['TOO LATE'].error === 'LATE' && rows['TOO LATE'].sentAt === null, 'more than 6 hours late is missed, not sent', rows['TOO LATE']);
  check(rows.LATER.status === 'pending', 'future row stays pending', rows.LATER);
  const again = createPushSchedule({
    dataDir: unitDir,
    now: () => nowMs,
    pushLive: () => false,
    targetTokens: () => ['tok-a'],
    sendPush: async () => {
      calls += 1;
      return { dryRun: true, count: 1, sent: 0, errors: [] };
    },
  });
  await again.tick();
  check(calls === 1 && again.list().find((item) => item.title === 'ON TIME').status === 'sent', 'reloading the store does not send the row again');
  const disk = JSON.parse(readFileSync(path.join(unitDir, 'push-schedule.json'), 'utf8'));
  disk.items.push({ id: 'stuck', title: 'STUCK', body: 'X', audience: 'all', at: onTime, london: '2026-06-01T07:00', status: 'sending', createdAt: onTime, updatedAt: onTime });
  writeFileSync(path.join(unitDir, 'push-schedule.json'), JSON.stringify(disk));
  await again.tick();
  const stuck = again.list().find((item) => item.id === 'stuck');
  check(calls === 1 && stuck.status === 'failed' && stuck.error === 'INTERRUPTED', 'a row left in sending is failed, not sent again', stuck);
  check(!existsSync(path.join(unitDir, 'push-schedule.json.tmp')), 'atomic write leaves no temp file');
  const history = readFileSync(path.join(unitDir, 'push-history.jsonl'), 'utf8');
  check(history.trim().split('\n').length === 1 && history.includes('"kind":"schedule"') && !history.includes('tok-a'), 'one history row, no tokens');

  const liveDir = mkdtempSync(path.join(tmpdir(), 'rr-schedule-live-'));
  let liveOpts = null;
  const live = createPushSchedule({
    dataDir: liveDir,
    now: () => nowMs,
    pushLive: () => true,
    targetTokens: () => ['tok-a'],
    sendPush: async (tokens, _message, opts) => {
      liveOpts = opts;
      return { dryRun: opts.dryRun, count: tokens.length, sent: opts.dryRun ? 0 : tokens.length, errors: [] };
    },
  });
  live.create({ title: 'LIVE', body: 'BODY', path: null, audience: 'all', at: onTime, london: '2026-06-01T07:00' });
  await live.tick();
  const liveRow = live.list()[0];
  check(liveOpts.dryRun === false && liveRow.status === 'sent' && liveRow.dryRun === false && liveRow.sent === 1, 'PUSH_LIVE on uses the real send path', liveRow);

  const emptyDir = mkdtempSync(path.join(tmpdir(), 'rr-schedule-empty-'));
  let emptyCalls = 0;
  const empty = createPushSchedule({
    dataDir: emptyDir,
    now: () => nowMs,
    pushLive: () => true,
    targetTokens: () => [],
    sendPush: async () => {
      emptyCalls += 1;
      return { dryRun: false, count: 0, sent: 0, errors: [] };
    },
  });
  empty.create({ title: 'NOBODY', body: 'BODY', path: null, audience: 'crew', at: onTime, london: '2026-06-01T07:00' });
  await empty.tick();
  await empty.tick();
  const nobody = empty.list()[0];
  check(emptyCalls === 1 && nobody.status === 'failed' && nobody.error === 'NO_DEVICES', 'no phones is failed once, not retried', nobody);
}

async function start(dir, env) {
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(root, 'server', 'serve.mjs')], {
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      PORT: String(port),
      HOST: '127.0.0.1',
      DATA_DIR: dir,
      AUTH_SECRET: SECRET,
      CONTENT_REFRESH: 'off',
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

function stop(child) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null || child.signalCode) return resolve();
    const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill();
  });
}

function cookieFrom(res, name) {
  const all = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie') || ''];
  const line = all.find((c) => c.startsWith(`${name}=`));
  return line ? { value: line.split(';')[0].slice(name.length + 1), line } : null;
}

async function loginPage(base) {
  const res = await fetch(`${base}/admin/login`, { headers: { 'X-Forwarded-For': '10.1.0.1' } });
  const html = await res.text();
  const pre = /name="pre" value="([^"]+)"/.exec(html)?.[1];
  return { pre, preCookie: cookieFrom(res, '__Host-rr_admin_pre')?.value };
}

async function login(base, password) {
  const { pre, preCookie } = await loginPage(base);
  return fetch(`${base}/admin/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-Forwarded-For': '10.1.0.2',
      Origin: base,
      Cookie: `__Host-rr_admin_pre=${preCookie}`,
    },
    body: new URLSearchParams({ pre, password }).toString(),
  });
}

const tomorrow = londonDate(Date.now() + 36 * 60 * 60 * 1000);
const yesterday = londonDate(Date.now() - 36 * 60 * 60 * 1000);

// ---------- auth: ADMIN_PASSWORD unset ----------
{
  const s = await start(dataDir, {});
  const refused = await fetch(`${s.base}/api/admin/push/schedule`);
  const body = await refused.json();
  check(refused.status === 401 && body.error === 'ADMIN_OFF', 'unset password: schedule API refused (401 ADMIN_OFF)', body);
  check(!refused.headers.get('access-control-allow-origin'), 'schedule API has no public CORS header');
  await stop(s.child);
}

// ---------- auth + create / list / edit / cancel ----------
let s = await start(dataDir, { ADMIN_PASSWORD: PASSWORD });
let base = s.base;
const noSession = await fetch(`${base}/api/admin/push/schedule`);
check(noSession.status === 401 && (await noSession.json()).error === 'SESSION', 'no session: 401');

const signed = await login(base, PASSWORD);
const sess = cookieFrom(signed, '__Host-rr_admin');
check(signed.status === 303 && sess, 'password signs in');
const cookie = `__Host-rr_admin=${sess?.value}`;
const adminRes = await fetch(`${base}/admin`, { headers: { Cookie: cookie } });
const adminHtml = await adminRes.text();
const csrf = /name="csrf-token" content="([^"]+)"/.exec(adminHtml)?.[1];
check(adminRes.status === 200 && Boolean(csrf) && !adminHtml.includes(PASSWORD), 'admin page loads, password not in the HTML');
const appJs = await (await fetch(`${base}/admin/app.js`)).text();
check(appJs.includes('[ SCHEDULE ]') && appJs.includes('[ YES, CANCEL ]') && appJs.includes('[ YES, SEND NOW ]') && appJs.includes('[ EDIT ]'), 'schedule form keeps SEND NOW and adds edit and cancel');

async function call(method, pathname, json, { token = csrf, origin = base, ck = cookie } = {}) {
  const res = await fetch(`${base}${pathname}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Cookie: ck,
      ...(origin ? { Origin: origin } : {}),
      ...(token ? { 'X-CSRF-Token': token } : {}),
    },
    body: json === undefined ? undefined : JSON.stringify(json),
  });
  return { status: res.status, body: await res.json().catch(() => ({})), headers: res.headers };
}

const future = { title: 'one week until gearbox.', body: 'tap for tickets', path: '/events', audience: 'all', date: tomorrow, time: '15:00' };
check((await call('POST', '/api/admin/push/schedule', future, { token: null })).status === 403, 'POST without CSRF rejected');
check((await call('POST', '/api/admin/push/schedule', future, { origin: 'https://evil.example' })).status === 403, 'POST from another origin rejected');
check((await call('PATCH', '/api/admin/push/schedule', { ...future, id: 'x' }, { token: null })).status === 403, 'PATCH without CSRF rejected');
check((await call('DELETE', '/api/admin/push/schedule', { id: 'x' }, { origin: null })).status === 403, 'DELETE with no origin rejected');
check((await call('PUT', '/api/admin/push/schedule', future)).status === 405, 'PUT rejected');

const past = await call('POST', '/api/admin/push/schedule', { ...future, date: yesterday });
check(past.status === 400 && past.body.error === 'PAST', 'past time refused', past.body);
const long = await call('POST', '/api/admin/push/schedule', { ...future, title: 'X'.repeat(61) });
check(long.status === 400 && long.body.error === 'TOO_LONG', 'title over 60 refused', long.body);
const longBody = await call('POST', '/api/admin/push/schedule', { ...future, body: 'Y'.repeat(181) });
check(longBody.status === 400 && longBody.body.error === 'TOO_LONG', 'message over 180 refused');
const badPath = await call('POST', '/api/admin/push/schedule', { ...future, path: '/admin' });
check(badPath.status === 400 && badPath.body.error === 'PATH', 'unknown tap target refused');
const badAudience = await call('POST', '/api/admin/push/schedule', { ...future, audience: 'everyone' });
check(badAudience.status === 400 && badAudience.body.error === 'AUDIENCE', 'unknown audience refused');
const blank = await call('POST', '/api/admin/push/schedule', { ...future, title: '  ', body: '' });
check(blank.status === 400 && blank.body.error === 'MESSAGE', 'blank message refused');
const gap = await call('POST', '/api/admin/push/schedule', { ...future, date: '2026-03-29', time: '01:30' });
check(gap.status === 400 && gap.body.error === 'WHEN', 'UK time that does not exist is refused');

const created = await call('POST', '/api/admin/push/schedule', future);
const wantWhen = londonWallToInstant(tomorrow, '15:00');
check(
  created.status === 200 && created.body.item.status === 'pending' && created.body.item.title === 'ONE WEEK UNTIL GEARBOX.' && created.body.item.at === wantWhen.at && created.body.item.audience === 'all' && created.body.item.path === '/events',
  'create stores a pending UK time',
  created.body.item,
);
const id = created.body.item?.id;
const listed = await call('GET', '/api/admin/push/schedule');
check(listed.status === 200 && listed.body.items.some((item) => item.id === id && item.status === 'pending'), 'list includes the new row', listed.body.items?.map((item) => item.status));
const viaPage = await call('GET', '/admin/api/push/schedule');
check(viaPage.status === 200 && viaPage.body.items.some((item) => item.id === id), 'admin page route lists the same row');
check(!listed.headers.get('access-control-allow-origin') && /no-store/.test(listed.headers.get('cache-control') || ''), 'list is no-store and has no CORS header');

const edited = await call('PATCH', '/admin/api/push/schedule', { ...future, id, title: 'edited title', body: 'new message', path: '/crew', audience: 'crew', time: '16:30' });
const editedWhen = londonWallToInstant(tomorrow, '16:30');
check(
  edited.status === 200 && edited.body.item.title === 'EDITED TITLE' && edited.body.item.body === 'NEW MESSAGE' && edited.body.item.path === '/crew' && edited.body.item.audience === 'crew' && edited.body.item.at === editedWhen.at && edited.body.item.status === 'pending',
  'edit updates a pending row',
  edited.body.item,
);
const missing = await call('PATCH', '/api/admin/push/schedule', { ...future, id: 'missing-id' });
check(missing.status === 404 && missing.body.error === 'NOT_FOUND', 'edit of an unknown id is 404');
const noId = await call('DELETE', '/api/admin/push/schedule', {});
check(noId.status === 400 && noId.body.error === 'ID', 'cancel without an id is refused');

const due = await call('POST', '/api/admin/push/schedule', { title: 'due drop', body: 'doors open', path: '/events', audience: 'drops', date: tomorrow, time: '18:00' });
const keep = await call('POST', '/api/admin/push/schedule', { title: 'keep future', body: 'still waiting', path: '', audience: 'all', date: tomorrow, time: '19:00' });
check(due.status === 200 && keep.status === 200 && due.body.item.audience === 'drops', 'due and future rows created');
const dueId = due.body.item.id;
const keepId = keep.body.item.id;

const cancelled = await call('DELETE', '/api/admin/push/schedule', { id });
check(cancelled.status === 200 && cancelled.body.item.status === 'cancelled', 'cancel marks a pending row cancelled', cancelled.body);
const cancelAgain = await call('DELETE', '/api/admin/push/schedule', { id });
check(cancelAgain.status === 409 && cancelAgain.body.error === 'NOT_PENDING', 'cancel twice is refused', cancelAgain.body);
const editCancelled = await call('PATCH', '/api/admin/push/schedule', { ...future, id });
check(editCancelled.status === 409 && editCancelled.body.error === 'NOT_PENDING', 'edit after cancel is refused');
const after = await call('GET', '/api/admin/push/schedule');
check(after.body.items.find((item) => item.id === id).status === 'cancelled' && after.body.items.find((item) => item.id === dueId).status === 'pending', 'list shows cancelled and still-pending rows');

const storePath = path.join(dataDir, 'push-schedule.json');
const stored = readFileSync(storePath, 'utf8');
check(!existsSync(`${storePath}.tmp`) && stored.includes(dueId) && !stored.includes('ExponentPushToken') && !stored.includes(PASSWORD), 'schedule file persisted, no temp file, no tokens or password');

await stop(s.child);

// Rewind one pending row so the next boot owes a send, and plant a late row and a stuck sending row.
{
  const disk = JSON.parse(readFileSync(storePath, 'utf8'));
  const row = disk.items.find((item) => item.id === dueId);
  row.at = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  disk.items.push({
    id: 'late-row',
    title: 'TOO LATE',
    body: 'DO NOT SEND',
    path: null,
    audience: 'all',
    at: new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString(),
    london: '2026-01-01T00:00',
    status: 'pending',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    sentAt: null,
    count: null,
    sent: null,
    dryRun: null,
    errors: [],
    error: null,
  });
  disk.items.push({
    id: 'stuck-row',
    title: 'STUCK',
    body: 'DO NOT SEND',
    path: null,
    audience: 'all',
    at: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
    london: '2026-01-01T00:00',
    status: 'sending',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    sentAt: null,
    count: null,
    sent: null,
    dryRun: null,
    errors: [],
    error: null,
  });
  writeFileSync(storePath, JSON.stringify(disk));
}

s = await start(dataDir, { ADMIN_PASSWORD: PASSWORD });
base = s.base;
const signed2 = await login(base, PASSWORD);
const cookie2 = `__Host-rr_admin=${cookieFrom(signed2, '__Host-rr_admin')?.value}`;
const admin2 = await (await fetch(`${base}/admin`, { headers: { Cookie: cookie2 } })).text();
const csrf2 = /name="csrf-token" content="([^"]+)"/.exec(admin2)?.[1];

async function listedUntil() {
  const deadline = Date.now() + 5000;
  let last = null;
  while (Date.now() < deadline) {
    const res = await fetch(`${base}/api/admin/push/schedule`, { headers: { Cookie: cookie2 } });
    last = await res.json();
    const items = last.items || [];
    const dueRow = items.find((item) => item.id === dueId);
    const lateRow = items.find((item) => item.id === 'late-row');
    const stuckRow = items.find((item) => item.id === 'stuck-row');
    if (dueRow?.status === 'sent' && lateRow?.status === 'missed' && stuckRow?.status === 'failed') return last;
    await new Promise((r) => setTimeout(r, 50));
  }
  return last;
}
const booted = await listedUntil();
const byId = Object.fromEntries((booted.items || []).map((item) => [item.id, item]));
check(byId[dueId]?.status === 'sent' && byId[dueId]?.dryRun === true && byId[dueId]?.count === 2 && byId[dueId]?.sent === 0, 'boot sends the due drops row once (dry run, 2 phones)', byId[dueId]);
check(byId['late-row']?.status === 'missed' && byId['late-row']?.error === 'LATE', 'boot marks a 7 hour late row missed', byId['late-row']);
check(byId['stuck-row']?.status === 'failed' && byId['stuck-row']?.error === 'INTERRUPTED', 'boot does not send a row already marked sending', byId['stuck-row']);
check(byId[keepId]?.status === 'pending', 'a future row is not sent on boot', byId[keepId]);
const firstLog = s.log();
check((firstLog.match(/Scheduled push \(/g) || []).length === 1, 'server logged one scheduled send', firstLog);
check((firstLog.match(/Scheduled push missed/g) || []).length === 1, 'server logged the missed row');
check(!/exp\.host/.test(firstLog), 'no request to the Expo push service');
const historyFile = readFileSync(path.join(dataDir, 'push-history.jsonl'), 'utf8');
const historyRows = historyFile.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
check(historyRows.length === 1 && historyRows[0].kind === 'schedule' && historyRows[0].scheduleId === dueId && historyRows[0].count === 2 && !historyFile.includes('ExponentPushToken'), 'history has the one scheduled send and no tokens', historyRows);

const historyApi = await call('GET', '/admin/api/push/history', undefined, { ck: cookie2 });
check(historyApi.body.history?.[0]?.kind === 'schedule' && historyApi.body.history[0].title === 'DUE DROP', 'sent history shows the scheduled send', historyApi.body.history?.[0]);

await stop(s.child);
const second = await start(dataDir, { ADMIN_PASSWORD: PASSWORD });
const signed3 = await login(second.base, PASSWORD);
const cookie3 = `__Host-rr_admin=${cookieFrom(signed3, '__Host-rr_admin')?.value}`;
const res3 = await fetch(`${second.base}/api/admin/push/schedule`, { headers: { Cookie: cookie3 } });
const again = await res3.json();
const againById = Object.fromEntries((again.items || []).map((item) => [item.id, item]));
check(againById[dueId]?.status === 'sent' && againById[dueId]?.count === 2 && againById['late-row']?.status === 'missed' && againById['stuck-row']?.status === 'failed', 'second boot leaves sent, missed and failed rows alone', { due: againById[dueId]?.status, late: againById['late-row']?.status, stuck: againById['stuck-row']?.status });
const secondLog = second.log();
check(!/Scheduled push \(/.test(secondLog) && !/Scheduled push missed/.test(secondLog) && !/Scheduled push interrupted/.test(secondLog), 'second boot does not send, miss or interrupt again', secondLog);
const historyAgain = readFileSync(path.join(dataDir, 'push-history.jsonl'), 'utf8').trim().split('\n').filter(Boolean);
check(historyAgain.length === 1, 'history still has one scheduled send');
await stop(second.child);

console.log(`\npush-schedule-check: ${passes} passed, ${failures} failed (data ${dataDir})`);
process.exit(failures ? 1 : 0);
