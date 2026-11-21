// RECKLESS WORLD crew events: open rave sessions plus an append-only JSONL log.
// Sessions are one JSON file (they are replaced and consumed). Events are append-only.
// Both live in DATA_DIR, the same directory as accounts.json.
import { createHash, randomBytes } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { gameXp, gameXpLive } from './game-xp.mjs';

const ID_RE = /^[A-Za-z0-9_.:-]{1,64}$/;

let dataDir = '';
let eventsPath = '';
let sessionsPath = '';
let events = [];
let lines = [];
let byEmail = new Map();
let countedIds = new Set();
let sessions = new Map();
let sessionByEmail = new Map();
let nowFn = () => Date.now();

/** Test hook. `fn` returns epoch milliseconds. Pass nothing to restore the real clock. */
export function setGameClock(fn) {
  nowFn = typeof fn === 'function' ? fn : () => Date.now();
}

function gameNow() {
  const value = Number(nowFn());
  return Number.isFinite(value) ? value : Date.now();
}

function validId(value) {
  return typeof value === 'string' && ID_RE.test(value);
}

function emailHash(email) {
  return createHash('sha256').update(String(email || '').trim().toLowerCase()).digest('hex').slice(0, 12);
}

function londonParts(ms) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(ms));
  const get = (type) => Number(parts.find((part) => part.type === type)?.value);
  return { year: get('year'), month: get('month'), day: get('day') };
}

export function londonDateKey(ms) {
  const { year, month, day } = londonParts(ms);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** ISO week of the Europe/London civil date (Monday-start), not the UTC date. */
export function isoWeekKey(ms) {
  const { year, month, day } = londonParts(ms);
  const date = new Date(Date.UTC(year, month - 1, day));
  const weekday = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - weekday);
  const isoYear = date.getUTCFullYear();
  const jan1 = new Date(Date.UTC(isoYear, 0, 1));
  const week = Math.ceil(((date - jan1) / 86400000 + 1) / 7);
  return `${isoYear}-W${String(week).padStart(2, '0')}`;
}

/**
 * Event ids.
 *
 * Raves: `wr:<raveId>:<sha256(email) hex[:12]>:<YYYY-MM-DD>`.
 * The London civil date is the last component so the same raveId can count again
 * on a later London day when the daily and weekly caps allow. The same rave,
 * email and London day share one id. A counted line makes a repeat DUPLICATE.
 * An uncounted line does not consume the id.
 *
 * Posters: `wp:<posterId>:<sha256(email) hex[:12]>` with no date, because a
 * counted posterId is once per email ever. Over-cap lines are not counted, so
 * the same posterId can count on a later day. The hash is of the normalised
 * (trim + lowercase) email. Ids are opaque: raveId and posterId may contain
 * colons, so read raveId/posterId from the JSON fields.
 */
function eventId({ type, email, raveId, posterId, atMs }) {
  const hash = emailHash(email);
  if (type === 'digital_rave_attended') return `wr:${raveId}:${hash}:${londonDateKey(atMs)}`;
  return `wp:${posterId}:${hash}`;
}

function indexEvent(line, event) {
  lines.push(line);
  events.push(event);
  const list = byEmail.get(event.email);
  if (list) list.push(event);
  else byEmail.set(event.email, [event]);
  if (event.counted) countedIds.add(event.id);
}

function commitEvent(event) {
  const line = JSON.stringify(event);
  mkdirSync(dataDir, { recursive: true });
  appendFileSync(eventsPath, `${line}\n`);
  indexEvent(line, event);
}

function loadEvents() {
  events = [];
  lines = [];
  byEmail = new Map();
  countedIds = new Set();
  let text = '';
  try {
    text = readFileSync(eventsPath, 'utf8');
  } catch {
    return;
  }
  for (const line of text.split('\n')) {
    if (!line) continue;
    try {
      const event = JSON.parse(line);
      if (!event || typeof event.id !== 'string' || typeof event.email !== 'string') continue;
      indexEvent(line, event);
    } catch {
      console.error('game-events: skipped unreadable line');
    }
  }
}

function persistSessions() {
  const obj = {};
  for (const session of sessions.values()) obj[session.sessionId] = session;
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(sessionsPath, JSON.stringify(obj));
}

function purgeExpired(now) {
  let changed = false;
  for (const session of sessions.values()) {
    if (now - Date.parse(session.startedAt) >= gameXp.sessionTtlMs) {
      sessions.delete(session.sessionId);
      if (sessionByEmail.get(session.email) === session.sessionId) sessionByEmail.delete(session.email);
      changed = true;
    }
  }
  return changed;
}

function loadSessions() {
  sessions = new Map();
  sessionByEmail = new Map();
  try {
    const raw = JSON.parse(readFileSync(sessionsPath, 'utf8'));
    if (raw && typeof raw === 'object') {
      for (const session of Object.values(raw)) {
        if (!session?.sessionId || !session.email || !session.startedAt || !session.raveId) continue;
        const currentId = sessionByEmail.get(session.email);
        const current = currentId ? sessions.get(currentId) : null;
        if (current && Date.parse(current.startedAt) >= Date.parse(session.startedAt)) continue;
        if (current) sessions.delete(current.sessionId);
        sessions.set(session.sessionId, session);
        sessionByEmail.set(session.email, session.sessionId);
      }
    }
  } catch {
    sessions = new Map();
    sessionByEmail = new Map();
  }
  if (purgeExpired(gameNow())) persistSessions();
}

export function initGameEvents(dir) {
  dataDir = dir;
  eventsPath = path.join(dir, 'game-events.jsonl');
  sessionsPath = path.join(dir, 'game-sessions.json');
  loadEvents();
  loadSessions();
}

function decide(email, type, id, atMs) {
  if (countedIds.has(id)) return { counted: false, reason: 'DUPLICATE' };
  const spec = gameXp.events[type];
  const day = londonDateKey(atMs);
  const week = isoWeekKey(atMs);
  let dayCount = 0;
  let weekCount = 0;
  let weekXp = 0;
  for (const event of byEmail.get(email) || []) {
    if (!event.counted) continue;
    const when = Date.parse(event.at);
    if (!Number.isFinite(when)) continue;
    const sameWeek = isoWeekKey(when) === week;
    if (event.type === type && londonDateKey(when) === day) dayCount += 1;
    if (event.type === type && sameWeek) weekCount += 1;
    if (sameWeek) weekXp += gameXp.events[event.type]?.xp || 0;
  }
  if (dayCount >= spec.maxPerLondonDay) return { counted: false, reason: 'DAILY_CAP' };
  if (spec.maxPerIsoWeek && weekCount >= spec.maxPerIsoWeek) return { counted: false, reason: 'WEEKLY_CAP' };
  if (weekXp + spec.xp > gameXp.weeklyCapXp) return { counted: false, reason: 'WEEKLY_CAP' };
  return { counted: true, reason: null };
}

function recordEvent({ email, type, raveId, posterId }) {
  const atMs = gameNow();
  const at = new Date(atMs).toISOString();
  const id = eventId({ type, email, raveId, posterId, atMs });
  const { counted, reason } = decide(email, type, id, atMs);
  const test = !(gameXpLive() && counted && atMs >= Date.parse(gameXp.liveFrom));
  const row = {
    id,
    type,
    email,
    ...(type === 'digital_rave_attended' ? { raveId } : { posterId }),
    at,
    counted,
    reason,
    test,
  };
  commitEvent(row);
  const body = { ok: true, recorded: true, counted };
  if (!counted) body.reason = reason;
  return body;
}

export function startRave({ email, raveId }) {
  if (!validId(raveId)) return { status: 400, body: { ok: false, error: 'RAVE' } };
  const now = gameNow();
  purgeExpired(now);
  const previous = sessionByEmail.get(email);
  if (previous) {
    sessions.delete(previous);
    sessionByEmail.delete(email);
  }
  const session = {
    sessionId: randomBytes(18).toString('base64url'),
    email,
    raveId,
    startedAt: new Date(now).toISOString(),
  };
  sessions.set(session.sessionId, session);
  sessionByEmail.set(email, session.sessionId);
  persistSessions();
  return {
    status: 200,
    body: { ok: true, sessionId: session.sessionId, minSeconds: gameXp.minSeconds, startedAt: session.startedAt },
  };
}

export function finishRave({ email, sessionId }) {
  if (typeof sessionId !== 'string' || sessionId.length < 1 || sessionId.length > 200) {
    return { status: 400, body: { ok: false, error: 'SESSION_ID' } };
  }
  const now = gameNow();
  const purged = purgeExpired(now);
  const session = sessions.get(sessionId);
  if (!session || session.email !== email) {
    if (purged) persistSessions();
    return { status: 404, body: { ok: false, error: 'SESSION_NOT_FOUND' } };
  }
  const elapsed = now - Date.parse(session.startedAt);
  const minMs = gameXp.minSeconds * 1000;
  if (elapsed < minMs) {
    if (purged) persistSessions();
    return {
      status: 409,
      body: { ok: false, error: 'TOO_SOON', remainingSeconds: Math.max(1, Math.ceil((minMs - elapsed) / 1000)) },
    };
  }
  const body = recordEvent({ email, type: 'digital_rave_attended', raveId: session.raveId });
  sessions.delete(session.sessionId);
  if (sessionByEmail.get(email) === session.sessionId) sessionByEmail.delete(email);
  persistSessions();
  return { status: 200, body };
}

export function postPoster({ email, type, posterId }) {
  if (type !== 'poster_placed') return { status: 400, body: { ok: false, error: 'TYPE' } };
  if (!validId(posterId)) return { status: 400, body: { ok: false, error: 'POSTER' } };
  return { status: 200, body: recordEvent({ email, type: 'poster_placed', posterId }) };
}

export function eventsForEmail(email) {
  const mine = byEmail.get(email) || [];
  const now = gameNow();
  const day = londonDateKey(now);
  const week = isoWeekKey(now);
  const today = { digital_rave_attended: 0, poster_placed: 0 };
  const weekCounts = { digital_rave_attended: 0, poster_placed: 0 };
  for (const event of mine) {
    if (!event.counted) continue;
    const when = Date.parse(event.at);
    if (!Number.isFinite(when)) continue;
    if (event.type === 'digital_rave_attended' || event.type === 'poster_placed') {
      if (londonDateKey(when) === day) today[event.type] += 1;
      if (isoWeekKey(when) === week) weekCounts[event.type] += 1;
    }
  }
  return {
    ok: true,
    events: mine.slice(-50).reverse(),
    today,
    week: weekCounts,
  };
}

/** Raw JSONL (same bytes as the log) for events with `at` >= sinceMs. */
export function exportEventsSince(sinceMs) {
  const out = [];
  for (let i = 0; i < events.length; i += 1) {
    const at = Date.parse(events[i].at);
    if (Number.isFinite(at) && at >= sinceMs) out.push(lines[i]);
  }
  return out.length ? `${out.join('\n')}\n` : '';
}
