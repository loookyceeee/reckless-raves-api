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
 * @param {{ dataDir: string, adminKeyOk: (given: string) => boolean, sendJson: Function, contentEventIndex: () => Array<{ id: string, skiddleId: string }> }} deps
 */
export function createReps(deps) {
  const { dataDir, adminKeyOk, sendJson, contentEventIndex } = deps;
  const filePath = path.join(dataDir, 'reps.json');
  let snapshot = { updatedAt: null, source: '', events: [] };

  function load() {
    try {
      const raw = JSON.parse(readFileSync(filePath, 'utf8'));
      if (raw && typeof raw === 'object' && Array.isArray(raw.events)) snapshot = raw;
    } catch {
      snapshot = { updatedAt: null, source: '', events: [] };
    }
  }

  function writeAtomic(text) {
    mkdirSync(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.tmp`;
    writeFileSync(tmp, text);
    renameSync(tmp, filePath);
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
    if (rep.tickets <= 0) return { drop: true };
    return { name, tickets: rep.tickets, points: rep.points === 0 ? 0 : rep.points };
  }

  function linkFor(event) {
    const supplied = normalizeRepUrl(event?.repUrl);
    if (supplied) return { repUrl: supplied, repUrlSource: 'promotion-centre' };
    const known = knownRepUrl(event?.eventId, event?.skiddleId);
    if (known) return { repUrl: known.repUrl, repUrlSource: 'promotion-centre' };
    return { repUrl: listingRepUrl(String(event.skiddleId)), repUrlSource: 'listing' };
  }

  function publicReps(reps) {
    return (Array.isArray(reps) ? reps : [])
      .map((rep, index) => ({ rep, index }))
      .filter(({ rep }) => rep && typeof rep.name === 'string' && Number.isInteger(rep.tickets) && rep.tickets > 0 && typeof rep.points === 'number')
      .sort((a, b) => (b.rep.tickets - a.rep.tickets) || (b.rep.points - a.rep.points) || (a.index - b.index))
      .map(({ rep }, index) => ({
        displayName: repDisplayName(rep.name),
        tickets: rep.tickets,
        points: rep.points,
        rank: index + 1,
      }));
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
        reps.push({ name: parsed.name, tickets: parsed.tickets, points: parsed.points });
      }
      const stored = { eventId: resolved.eventId, skiddleId: resolved.skiddleId, reps };
      if (repUrl) stored.repUrl = repUrl;
      nextEvents.push(stored);
    }
    const stored = { updatedAt, source, events: nextEvents };
    writeAtomic(JSON.stringify(stored));
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

  function handle(req, res, url) {
    if (url.pathname !== '/api/reps') return false;
    res.setHeader('Cache-Control', 'no-store');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return true;
    }
    if (req.method === 'GET') {
      sendJson(res, 200, publicFeed());
      return true;
    }
    if (req.method === 'POST') {
      post(req, res).catch((error) => {
        console.error('reps request failed', error instanceof Error ? error.name : 'error');
        if (!res.headersSent) sendJson(res, 500, { ok: false, error: 'SERVER' });
      });
      return true;
    }
    req.resume?.();
    sendJson(res, 405, { ok: false, error: 'METHOD' });
    return true;
  }

  load();
  return { handle };
}
