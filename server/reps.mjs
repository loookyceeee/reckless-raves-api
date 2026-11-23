// Ticket-rep leaderboard. REP TRACKER posts a weekly Promotion Centre snapshot
// (POST /api/reps, header X-Admin-Key = OAUTH_ADMIN_KEY, same check as the Skiddle
// order push). The app reads it with GET /api/reps (no auth).
//
// The stored snapshot replaces the previous one. Reps left out are deleted, and
// an event that is not one of the four defaults drops off the public feed.
// Full names stay in DATA_DIR/reps.json so weeks can be matched; public
// responses and logs only carry a display name (first name + last-name initial).
// Points are the Promotion Centre figure (10 pts = £1). They are never derived
// from ticket counts.
//
// An optional repId on a row is the Skiddle Rep ID (a numeric string, leading
// zeros kept). It is stored only in DATA_DIR/reps.json. Public GET and the POST
// ack never return it, and neither returns the full name.
//
// A signed-in crew account (the same bearer token as the game event routes)
// claims a repId with POST /api/reps/link. The id has to be in the current
// snapshot (404 REP_NOT_FOUND otherwise). The first account to claim it keeps
// it (409 REP_ALREADY_LINKED). An account that already holds a different id
// gets 409 ACCOUNT_ALREADY_LINKED until it unlinks. Links live in
// DATA_DIR/rep-links.json, separate from the snapshot, so a later week does not
// drop a claim. DELETE /api/reps/link drops that account's claim. GET /api/reps/me
// is that account's events, ranks and reward progress. rewardsEarned lists the
// tier ids (half-off / guestlist / guestlist-plus at 800 / 1000 / 2000) and
// top3-merch when rank is 1, 2 or 3. nextReward.pointsNeeded is how many points
// are still short of the next tier. merchCode on each event stays null until a
// later change fills it from the loyalty code pool.
// Link attempts are limited to 10 per account per hour.
//
// GET /api/reps/links and DELETE /api/reps/links/<repId> use the admin key, so a
// wrongly claimed Rep ID can be listed and reset.
//
// repUrl, when the push includes one, must be an https URL on skiddle.com or
// promotioncentre.co.uk (subdomains allowed). The four links Luke confirmed are
// the default: GET returns them before any snapshot is stored, and again when a
// snapshot leaves that event or its repUrl out (empty reps if the event itself
// was left out). Any other event with no repUrl uses the Skiddle listing page.
// repUrlSource is "promotion-centre" for a supplied link or one of those
// defaults, and "listing" for the listing page.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const REP_REWARDS = [
  { id: 'half-off', label: '50% OFF', points: 800, qty: 50 },
  { id: 'guestlist', label: 'GUESTLIST', points: 1000, qty: 50 },
  { id: 'guestlist-plus', label: 'GUESTLIST +1', points: 2000, qty: 50 },
];

// Confirmed Promotion Centre sign-up links. Kept here so a push does not have
// to repeat them, and so GET can show them before the first snapshot.
const REP_DEFAULTS = [
  { eventId: 'temple-008', skiddleId: '42803971', repUrl: 'https://www.skiddle.com/reps/repallevents.php?lid=2351295' },
  { eventId: 'e43169461', skiddleId: '43169461', repUrl: 'https://www.skiddle.com/reps/repallevents.php?lid=2469267' },
  { eventId: 'temple-009', skiddleId: '42853722', repUrl: 'https://www.skiddle.com/reps/repallevents.php?lid=2368473' },
  { eventId: 'e43187226', skiddleId: '43187226', repUrl: 'https://www.skiddle.com/reps/repallevents.php?lid=2471868' },
];

const REP_ROOTS = ['skiddle.com', 'promotioncentre.co.uk'];
const ISO_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const EVENT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const SKIDDLE_ID_RE = /^\d{5,12}$/;
const MAX_EVENTS = 100;
const MAX_REPS = 500;
const MAX_URL = 2048;
const REP_ID_RE = /^\d{1,20}$/;
const TOP3_MERCH_ID = 'top3-merch';
const LINK_ATTEMPTS = 10;
const LINK_WINDOW_MS = 60 * 60 * 1000;

const MESSAGES = {
  BODY: 'BODY MUST BE A JSON OBJECT',
  UPDATED: 'UPDATEDAT MUST BE AN ISO DATE',
  SOURCE: 'SOURCE MUST BE A STRING',
  EVENTS: 'EVENTS MUST BE AN ARRAY',
  EVENT: 'EVENT MUST MATCH A KNOWN EVENT ID OR SKIDDLE ID',
  REPS: 'REPS MUST BE AN ARRAY',
  NAME: 'REP NAME IS REQUIRED',
  TICKETS: 'TICKETS MUST BE A NUMBER',
  POINTS: 'POINTS IS REQUIRED AND MUST BE A NON-NEGATIVE NUMBER',
  REP_URL: 'REP URL MUST BE HTTPS ON SKIDDLE.COM OR PROMOTIONCENTRE.CO.UK',
  REP_ID: 'REP ID MUST BE A NUMERIC STRING',
  REP_NOT_FOUND: 'REP NOT FOUND',
  REP_ALREADY_LINKED: 'REP ALREADY LINKED',
  ACCOUNT_ALREADY_LINKED: 'ACCOUNT ALREADY LINKED',
  NOT_LINKED: 'NOT LINKED',
};

function hostAllowed(hostname) {
  let host = String(hostname || '').toLowerCase();
  if (host.endsWith('.')) host = host.slice(0, -1);
  if (!host || host.includes('..') || host.includes('%')) return false;
  return REP_ROOTS.some((root) => host === root || host.endsWith(`.${root}`));
}

function authorityOf(text) {
  const rest = text.slice(text.indexOf('//') + 2);
  const cut = rest.search(/[/?#\\]/);
  return (cut === -1 ? rest : rest.slice(0, cut)).toLowerCase();
}

/**
 * Canonical https URL on skiddle.com or promotioncentre.co.uk, or null.
 * Subdomains are allowed. http, other hosts, and userinfo are rejected.
 * @param {unknown} value
 * @returns {string | null}
 */
export function normalizeRepUrl(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text || text.length > MAX_URL) return null;
  if (/[\u0000-\u0020\\]/.test(text)) return null;
  if (!/^https:\/\//i.test(text)) return null;
  const authority = authorityOf(text);
  if (!authority || authority.includes('@') || authority.includes('\\')) return null;
  let url;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password) return null;
  if (!hostAllowed(url.hostname)) return null;
  let again;
  try {
    again = new URL(url.href);
  } catch {
    return null;
  }
  if (again.protocol !== 'https:' || again.username || again.password || !hostAllowed(again.hostname)) return null;
  return url.href;
}

/** Public label. "Cj Mc Henry" → "CJ M" (first name, then the initial of the last name). */
export function repDisplayName(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '';
  const first = parts[0].toUpperCase();
  if (parts.length === 1) return first;
  const initial = [...parts[1].toUpperCase()].find((ch) => /\p{L}/u.test(ch));
  return initial ? `${first} ${initial}` : first;
}

/**
 * Reward progress for one event. Tier ids are earned at points >= 800 / 1000 / 2000.
 * `top3-merch` is added when rank is 1, 2 or 3. nextReward is the next unearned
 * tier, and pointsNeeded is how many points are still short of that tier.
 * merchCode stays null until the loyalty code pool fills it.
 * @param {number} points
 * @param {number} rank
 */
export function repRewardView(points, rank) {
  const rewardsEarned = [];
  let nextReward = null;
  for (const reward of REP_REWARDS) {
    if (points >= reward.points) rewardsEarned.push(reward.id);
    else if (!nextReward) nextReward = { id: reward.id, label: reward.label, pointsNeeded: reward.points - points };
  }
  if (rank <= 3) rewardsEarned.push(TOP3_MERCH_ID);
  return { rewardsEarned, nextReward, merchCode: null };
}

function listingRepUrl(skiddleId) {
  return `https://www.skiddle.com/e/${skiddleId}`;
}

function knownRepUrl(eventId, skiddleId) {
  const id = String(eventId || '');
  const sid = String(skiddleId || '');
  return REP_DEFAULTS.find((row) => row.eventId === id || row.skiddleId === sid) || null;
}

function cleanName(value) {
  if (typeof value !== 'string') return null;
  const name = value.replace(/[\u0000-\u001f\u007f]/g, '').trim().replace(/\s+/g, ' ');
  if (!name || name.length > 80 || !/\p{L}/u.test(name)) return null;
  return name;
}

function parseUpdatedAt(value) {
  if (typeof value !== 'string' || !ISO_AT.test(value.trim())) return null;
  const ms = Date.parse(value.trim());
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

function reject(error, extra = {}) {
  return {
    status: 400,
    body: {
      ok: false,
      error,
      message: extra.message || MESSAGES[error] || error,
      ...(extra.event != null ? { event: extra.event } : {}),
      ...(extra.rep != null ? { rep: extra.rep } : {}),
    },
  };
}

/**
 * Optional Skiddle Rep ID. Absent, null, or a blank string means "no id".
 * Anything else must be a numeric string (trimmed). Leading zeros are kept.
 * @param {object} rep
 * @returns {{ repId: string | null } | { error: 'REP_ID' }}
 */
function parseRepId(rep) {
  if (!Object.prototype.hasOwnProperty.call(rep, 'repId') || rep.repId == null) return { repId: null };
  if (typeof rep.repId !== 'string') return { error: 'REP_ID' };
  const repId = rep.repId.trim();
  if (!repId) return { repId: null };
  if (!REP_ID_RE.test(repId)) return { error: 'REP_ID' };
  return { repId };
}

/**
 * @param {{ dataDir: string, adminKeyOk: (given: string) => boolean, sendJson: Function, contentEventIndex: () => Array<{ id: string, skiddleId: string }>, readSession: (header: string) => string | null, rateLimited: (key: string, max: number, windowMs: number) => boolean }} deps
 */
export function createReps(deps) {
  const { dataDir, adminKeyOk, sendJson, contentEventIndex, readSession, rateLimited } = deps;
  const filePath = path.join(dataDir, 'reps.json');
  const linksPath = path.join(dataDir, 'rep-links.json');
  let snapshot = { updatedAt: null, source: '', events: [] };
  /** @type {Record<string, { email: string, at: string }>} */
  let links = {};

  function load() {
    try {
      const raw = JSON.parse(readFileSync(filePath, 'utf8'));
      if (raw && typeof raw === 'object' && Array.isArray(raw.events)) snapshot = raw;
    } catch {
      snapshot = { updatedAt: null, source: '', events: [] };
    }
  }

  function writeAtomic(target, text) {
    mkdirSync(path.dirname(target), { recursive: true });
    const tmp = `${target}.tmp`;
    writeFileSync(tmp, text);
    renameSync(tmp, target);
  }

  function loadLinks() {
    links = {};
    try {
      const raw = JSON.parse(readFileSync(linksPath, 'utf8'));
      const stored = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw.links : null;
      if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return;
      for (const [repId, row] of Object.entries(stored)) {
        if (!REP_ID_RE.test(repId) || !row || typeof row !== 'object') continue;
        const email = typeof row.email === 'string' ? row.email.trim().toLowerCase() : '';
        if (!email.includes('@')) continue;
        links[repId] = { email, at: typeof row.at === 'string' ? row.at : new Date(0).toISOString() };
      }
    } catch {
      links = {};
    }
  }

  function saveLinks() {
    writeAtomic(linksPath, JSON.stringify({ links }));
  }

  function linkByEmail(email) {
    for (const [repId, row] of Object.entries(links)) {
      if (row.email === email) return { repId, ...row };
    }
    return null;
  }

  function catalog() {
    const rows = typeof contentEventIndex === 'function' ? contentEventIndex() : [];
    return (Array.isArray(rows) ? rows : [])
      .filter((event) => event && event.id && event.skiddleId)
      .map((event) => ({ eventId: String(event.id), skiddleId: String(event.skiddleId) }));
  }

  function resolveEvent(row, events) {
    const eventId = row.eventId == null || row.eventId === '' ? '' : typeof row.eventId === 'string' || typeof row.eventId === 'number' ? String(row.eventId).trim() : null;
    const skiddleId = row.skiddleId == null || row.skiddleId === '' ? '' : typeof row.skiddleId === 'string' || typeof row.skiddleId === 'number' ? String(row.skiddleId).trim() : null;
    if (eventId == null || skiddleId == null || (!eventId && !skiddleId)) {
      return { error: 'EVENT', message: 'EVENT MUST INCLUDE AN EVENT ID OR A SKIDDLE ID' };
    }
    if (eventId && !EVENT_ID_RE.test(eventId)) return { error: 'EVENT' };
    if (skiddleId && !SKIDDLE_ID_RE.test(skiddleId)) return { error: 'EVENT' };
    const byId = eventId ? events.find((event) => event.eventId === eventId) : null;
    const bySid = skiddleId ? events.find((event) => event.skiddleId === skiddleId) : null;
    if (eventId && skiddleId) {
      if (!byId || !bySid || byId.eventId !== bySid.eventId || byId.skiddleId !== bySid.skiddleId) {
        return { error: 'EVENT', message: 'EVENT ID DOES NOT MATCH SKIDDLE ID' };
      }
      return { eventId: byId.eventId, skiddleId: byId.skiddleId };
    }
    const found = byId || bySid;
    if (!found) return { error: 'EVENT', message: 'EVENT MUST MATCH A KNOWN EVENT ID OR SKIDDLE ID' };
    return { eventId: found.eventId, skiddleId: found.skiddleId };
  }

  function parseRep(rep) {
    if (!rep || typeof rep !== 'object' || Array.isArray(rep)) return { error: 'NAME' };
    const name = cleanName(rep.name);
    if (!name) return { error: 'NAME' };
    if (!Object.prototype.hasOwnProperty.call(rep, 'tickets') || typeof rep.tickets !== 'number' || !Number.isInteger(rep.tickets) || rep.tickets > 100000) {
      return { error: 'TICKETS' };
    }
    // Required on every row, including ones dropped for tickets <= 0. Never computed from tickets.
    if (!Object.prototype.hasOwnProperty.call(rep, 'points') || typeof rep.points !== 'number' || !Number.isFinite(rep.points) || rep.points < 0 || rep.points > Number.MAX_SAFE_INTEGER) {
      return { error: 'POINTS' };
    }
    const id = parseRepId(rep);
    if (id.error) return id;
    if (rep.tickets <= 0) return { drop: true };
    const row = { name, tickets: rep.tickets, points: rep.points === 0 ? 0 : rep.points };
    if (id.repId) row.repId = id.repId;
    return row;
  }

  function linkFor(event) {
    const supplied = normalizeRepUrl(event?.repUrl);
    if (supplied) return { repUrl: supplied, repUrlSource: 'promotion-centre' };
    const known = knownRepUrl(event?.eventId, event?.skiddleId);
    if (known) return { repUrl: known.repUrl, repUrlSource: 'promotion-centre' };
    return { repUrl: listingRepUrl(String(event.skiddleId)), repUrlSource: 'listing' };
  }

  function rankReps(reps) {
    return (Array.isArray(reps) ? reps : [])
      .map((rep, index) => ({ rep, index }))
      .filter(({ rep }) => rep && typeof rep.name === 'string' && Number.isInteger(rep.tickets) && rep.tickets > 0 && typeof rep.points === 'number')
      .sort((a, b) => (b.rep.tickets - a.rep.tickets) || (b.rep.points - a.rep.points) || (a.index - b.index))
      .map(({ rep }, index) => ({
        name: rep.name,
        displayName: repDisplayName(rep.name),
        tickets: rep.tickets,
        points: rep.points,
        rank: index + 1,
        ...(typeof rep.repId === 'string' && REP_ID_RE.test(rep.repId) ? { repId: rep.repId } : {}),
      }));
  }

  function publicReps(reps) {
    return rankReps(reps).map(({ displayName, tickets, points, rank }) => ({ displayName, tickets, points, rank }));
  }

  function personalView(repId) {
    let displayName = null;
    const events = [];
    for (const event of storedEvents()) {
      const mine = rankReps(event.reps).find((rep) => rep.repId === repId);
      if (!mine) continue;
      if (!displayName) displayName = mine.displayName;
      events.push({
        eventId: String(event.eventId),
        tickets: mine.tickets,
        points: mine.points,
        rank: mine.rank,
        ...repRewardView(mine.points, mine.rank),
      });
    }
    if (!displayName) return null;
    return { displayName, events };
  }

  function publicEvent(event, updatedAt) {
    return {
      eventId: String(event.eventId),
      skiddleId: String(event.skiddleId),
      ...linkFor(event),
      updatedAt,
      reps: publicReps(event.reps),
    };
  }

  function storedEvents() {
    return (Array.isArray(snapshot.events) ? snapshot.events : [])
      .filter((event) => event && EVENT_ID_RE.test(String(event.eventId || '')) && SKIDDLE_ID_RE.test(String(event.skiddleId || '')));
  }

  function publicFeed() {
    const updatedAt = typeof snapshot.updatedAt === 'string' ? snapshot.updatedAt : null;
    const stored = storedEvents();
    const covered = new Set();
    for (const event of stored) {
      covered.add(String(event.eventId));
      covered.add(String(event.skiddleId));
    }
    const events = stored.map((event) => publicEvent(event, updatedAt));
    for (const known of REP_DEFAULTS) {
      if (covered.has(known.eventId) || covered.has(known.skiddleId)) continue;
      events.push(publicEvent({ eventId: known.eventId, skiddleId: known.skiddleId, reps: [] }, updatedAt));
    }
    return {
      ok: true,
      updatedAt,
      rewards: REP_REWARDS.map((reward) => ({ ...reward })),
      events,
    };
  }

  function ingest(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return reject('BODY');
    const updatedAt = parseUpdatedAt(body.updatedAt);
    if (!updatedAt) return reject('UPDATED');
    let source = '';
    if (body.source != null) {
      if (typeof body.source !== 'string') return reject('SOURCE');
      source = body.source.trim();
      if (source.length > 80) return reject('SOURCE');
    }
    if (!Array.isArray(body.events) || body.events.length > MAX_EVENTS) return reject('EVENTS');
    const events = catalog();
    const seen = new Set();
    const nextEvents = [];
    let dropped = 0;
    for (let i = 0; i < body.events.length; i += 1) {
      const row = body.events[i];
      if (!row || typeof row !== 'object' || Array.isArray(row)) return reject('EVENT', { event: i });
      const resolved = resolveEvent(row, events);
      if (resolved.error) return reject(resolved.error, { event: i, message: resolved.message });
      if (seen.has(resolved.eventId)) return reject('EVENT', { event: i, message: 'DUPLICATE EVENT' });
      seen.add(resolved.eventId);
      let repUrl = null;
      if (row.repUrl != null) {
        repUrl = normalizeRepUrl(row.repUrl);
        if (!repUrl) return reject('REP_URL', { event: i });
      }
      if (!Array.isArray(row.reps) || row.reps.length > MAX_REPS) return reject('REPS', { event: i });
      const reps = [];
      const names = new Set();
      const repIds = new Set();
      for (let j = 0; j < row.reps.length; j += 1) {
        const parsed = parseRep(row.reps[j]);
        if (parsed.error) return reject(parsed.error, { event: i, rep: j });
        if (parsed.drop) {
          dropped += 1;
          continue;
        }
        const key = parsed.name.toLowerCase();
        if (names.has(key)) return reject('NAME', { event: i, rep: j, message: 'DUPLICATE REP' });
        names.add(key);
        if (parsed.repId) {
          if (repIds.has(parsed.repId)) return reject('REP_ID', { event: i, rep: j, message: 'DUPLICATE REP ID' });
          repIds.add(parsed.repId);
        }
        const storedRep = { name: parsed.name, tickets: parsed.tickets, points: parsed.points };
        if (parsed.repId) storedRep.repId = parsed.repId;
        reps.push(storedRep);
      }
      const stored = { eventId: resolved.eventId, skiddleId: resolved.skiddleId, reps };
      if (repUrl) stored.repUrl = repUrl;
      nextEvents.push(stored);
    }
    const stored = { updatedAt, source, events: nextEvents };
    writeAtomic(filePath, JSON.stringify(stored));
    snapshot = stored;
    const feed = publicFeed();
    return { status: 200, body: { ...feed, dropped } };
  }

  function readRaw(req, limit) {
    return new Promise((resolve) => {
      const chunks = [];
      let size = 0;
      let over = false;
      req.on('data', (chunk) => {
        if (over) return;
        size += chunk.length;
        if (size > limit) {
          over = true;
          chunks.length = 0;
          req.resume();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => resolve(over ? { tooBig: true } : { buffer: Buffer.concat(chunks) }));
      req.on('error', () => resolve({ error: true }));
    });
  }

  function fail(error, message) {
    return { status: error === 'REP_NOT_FOUND' ? 404 : error === 'REP_ALREADY_LINKED' || error === 'ACCOUNT_ALREADY_LINKED' ? 409 : error === 'NOT_LINKED' ? 404 : 400, body: { ok: false, error, message: message || MESSAGES[error] || error } };
  }

  function claim(email, repId) {
    const view = personalView(repId);
    if (!view) return fail('REP_NOT_FOUND');
    const holder = links[repId];
    if (holder && holder.email !== email) return fail('REP_ALREADY_LINKED');
    const mine = linkByEmail(email);
    if (mine && mine.repId !== repId) return fail('ACCOUNT_ALREADY_LINKED');
    if (!holder) {
      links[repId] = { email, at: new Date().toISOString() };
      saveLinks();
      console.log('reps link stored');
    }
    return { status: 200, body: { ok: true, repId, displayName: view.displayName } };
  }

  function unlink(email) {
    const mine = linkByEmail(email);
    if (!mine) return fail('NOT_LINKED');
    delete links[mine.repId];
    saveLinks();
    console.log('reps link removed');
    return { status: 200, body: { ok: true, unlinked: true } };
  }

  function me(email) {
    const mine = linkByEmail(email);
    if (!mine) return fail('NOT_LINKED');
    const view = personalView(mine.repId);
    return {
      status: 200,
      body: {
        ok: true,
        repId: mine.repId,
        displayName: view ? view.displayName : null,
        events: view ? view.events : [],
      },
    };
  }

  function listLinks() {
    const rows = Object.entries(links).map(([repId, row]) => {
      const view = personalView(repId);
      return { repId, email: row.email, displayName: view ? view.displayName : null, at: row.at };
    });
    rows.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.repId < b.repId ? -1 : a.repId > b.repId ? 1 : 0));
    return { ok: true, links: rows };
  }

  function adminUnlink(repId) {
    if (!REP_ID_RE.test(repId)) return fail('REP_ID');
    if (!links[repId]) return fail('NOT_LINKED');
    delete links[repId];
    saveLinks();
    console.log('reps link removed');
    return { status: 200, body: { ok: true, repId, removed: true } };
  }

  function sessionEmail(req) {
    if (typeof readSession !== 'function') return null;
    const email = readSession(req.headers.authorization);
    return typeof email === 'string' && email ? email : null;
  }

  function requireCrew(req, res) {
    const email = sessionEmail(req);
    if (!email) {
      req.resume?.();
      sendJson(res, 401, { ok: false, error: 'SESSION' });
      return null;
    }
    return email;
  }

  function requireAdmin(req, res) {
    if (!adminKeyOk(String(req.headers['x-admin-key'] || ''))) {
      req.resume?.();
      sendJson(res, 403, { ok: false, error: 'ADMIN' });
      return false;
    }
    return true;
  }

  async function readBody(req, limit) {
    const { buffer, tooBig, error } = await readRaw(req, limit);
    if (tooBig) return { status: 413, body: { ok: false, error: 'TOO_BIG' } };
    if (error || !buffer.length) return { status: 400, body: { ok: false, error: 'BODY', message: MESSAGES.BODY } };
    try {
      const body = JSON.parse(buffer.toString('utf8'));
      if (!body || typeof body !== 'object' || Array.isArray(body)) return { status: 400, body: { ok: false, error: 'BODY', message: MESSAGES.BODY } };
      return { body };
    } catch {
      return { status: 400, body: { ok: false, error: 'BODY', message: MESSAGES.BODY } };
    }
  }

  async function postLink(req, res) {
    const email = requireCrew(req, res);
    if (!email) return;
    if (typeof rateLimited !== 'function' || rateLimited(`reps-link:${email}`, LINK_ATTEMPTS, LINK_WINDOW_MS)) {
      req.resume?.();
      sendJson(res, 429, { ok: false, error: 'RATE' });
      return;
    }
    const read = await readBody(req, 64 * 1024);
    if (read.status) {
      sendJson(res, read.status, read.body);
      return;
    }
    const parsed = parseRepId(read.body);
    if (parsed.error || !parsed.repId) {
      sendJson(res, 400, { ok: false, error: 'REP_ID', message: MESSAGES.REP_ID });
      return;
    }
    const result = claim(email, parsed.repId);
    sendJson(res, result.status, result.body);
  }

  function deleteLink(req, res) {
    const email = requireCrew(req, res);
    if (!email) return;
    req.resume?.();
    const result = unlink(email);
    sendJson(res, result.status, result.body);
  }

  function getMe(req, res) {
    const email = requireCrew(req, res);
    if (!email) return;
    const result = me(email);
    sendJson(res, result.status, result.body);
  }

  function getLinks(req, res) {
    if (!requireAdmin(req, res)) return;
    sendJson(res, 200, listLinks());
  }

  function deleteAdminLink(req, res, repId) {
    if (!requireAdmin(req, res)) return;
    req.resume?.();
    const result = adminUnlink(repId);
    sendJson(res, result.status, result.body);
  }

  async function post(req, res) {
    if (!adminKeyOk(String(req.headers['x-admin-key'] || ''))) {
      req.resume();
      sendJson(res, 403, { ok: false, error: 'ADMIN' });
      return;
    }
    const { buffer, tooBig, error } = await readRaw(req, 1024 * 1024);
    if (tooBig) {
      sendJson(res, 413, { ok: false, error: 'TOO_BIG' });
      return;
    }
    if (error || !buffer.length) {
      sendJson(res, 400, { ok: false, error: 'BODY', message: MESSAGES.BODY });
      return;
    }
    let body;
    try {
      body = JSON.parse(buffer.toString('utf8'));
    } catch {
      sendJson(res, 400, { ok: false, error: 'BODY', message: MESSAGES.BODY });
      return;
    }
    const result = ingest(body);
    if (result.status === 200) {
      const stored = storedEvents();
      const reps = stored.reduce((sum, event) => sum + (Array.isArray(event.reps) ? event.reps.length : 0), 0);
      console.log(`reps snapshot stored events=${stored.length} reps=${reps} dropped=${result.body.dropped}`);
    }
    sendJson(res, result.status, result.body);
  }

  function report(res, error) {
    console.error('reps request failed', error instanceof Error ? error.name : 'error');
    if (!res.headersSent) sendJson(res, 500, { ok: false, error: 'SERVER' });
  }

  function rejectMethod(req, res) {
    req.resume?.();
    sendJson(res, 405, { ok: false, error: 'METHOD' });
  }

  function handle(req, res, url) {
    const { pathname } = url;
    const linkItem = /^\/api\/reps\/links\/(\d{1,20})$/.exec(pathname);
    const owned = pathname === '/api/reps' || pathname === '/api/reps/link' || pathname === '/api/reps/me' || pathname === '/api/reps/links' || linkItem;
    if (!owned) return false;
    res.setHeader('Cache-Control', 'no-store');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return true;
    }
    if (pathname === '/api/reps') {
      if (req.method === 'GET') {
        sendJson(res, 200, publicFeed());
        return true;
      }
      if (req.method === 'POST') {
        post(req, res).catch((error) => report(res, error));
        return true;
      }
    } else if (pathname === '/api/reps/link') {
      if (req.method === 'POST') {
        postLink(req, res).catch((error) => report(res, error));
        return true;
      }
      if (req.method === 'DELETE') {
        deleteLink(req, res);
        return true;
      }
    } else if (pathname === '/api/reps/me') {
      if (req.method === 'GET') {
        getMe(req, res);
        return true;
      }
    } else if (pathname === '/api/reps/links') {
      if (req.method === 'GET') {
        getLinks(req, res);
        return true;
      }
    } else if (req.method === 'DELETE') {
      deleteAdminLink(req, res, linkItem[1]);
      return true;
    }
    rejectMethod(req, res);
    return true;
  }

  load();
  loadLinks();
  return { handle };
}
