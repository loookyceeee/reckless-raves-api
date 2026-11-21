// RECKLESS social, phase 1: crew handles, GOING lists with a Skiddle VERIFIED tick, event
// check-ins (a per-event code shown at the venue, redeemable in the app during event hours
// only), the rave diary (one entry per check-in: note + one photo) and badges.
//
// Everything counts from go-live (SOCIAL_FROM). Nothing is backfilled from past events.
// SOCIAL_LIVE (default off) gates every fan endpoint. While it is off only emails listed in
// SOCIAL_TEST_EMAILS can use them, and their XP rows are written as test:true.
//
// XP follows the RECKLESS WORLD pattern: the server writes counted rows to an append-only log
// (DATA_DIR/social-events.jsonl, exported with GET /api/social/export + X-Admin-Key) and
// RECKLESS CREW LOYALTY adds them to the XP Sheet. Nothing here writes to the XP ledger.
//
// Emails are never in a public payload. Fans are identified by their crew handle.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let sharpLib = null;
function sharp() {
  if (!sharpLib) sharpLib = require('sharp');
  return sharpLib;
}

/* ---------- rules (approved by Luke, 21 Nov 2026) ---------- */

export const socialRules = {
  // Go-live. Check-ins, badges, diary entries and counts only exist from here on.
  from: '2026-11-21T00:00:00.000Z',
  xp: {
    event_checkin: 50,
    diary_complete: 25,
  },
  // Belt and braces on top of the event-hours window: at most 2 counted check-ins a London day.
  checkinMaxPerLondonDay: 2,
  // Check-in window around the Skiddle start/end times.
  checkinOpensBeforeMs: 60 * 60 * 1000,
  checkinClosesAfterMs: 3 * 60 * 60 * 1000,
  defaultEventLengthMs: 8 * 60 * 60 * 1000,
  noteMax: 280,
  photoMaxBytes: 8 * 1024 * 1024,
  photoMaxEdge: 1440,
  photoDiskCapBytes: 300 * 1024 * 1024,
  facesMax: 6,
  handleChangeEveryMs: 24 * 60 * 60 * 1000,
  rate: { windowMs: 10 * 60 * 1000, emailMax: 60, ipMax: 240, checkinEmailMax: 12, checkinIpMax: 30, photoEmailMax: 10 },
};

export const BADGES = [
  { id: 'founding-raver', name: 'FOUNDING RAVER', sub: 'DAY 1 CREW', detail: 'YOU JOINED IN THE FIRST WEEK', line: 'DAY 1 CREW · 21–28 NOV 2026', mark: ['DAY', '01'], markSub: '21–28 NOV' },
  { id: 'gearbox-008', name: 'GEARBOX 008', sub: 'THE TEMPLE 008', detail: 'YOU CHECKED IN AT GEARBOX X RECKLESS', line: 'THE TEMPLE 008 · 28 NOV 2026', mark: ['GBX', '008'], markSub: '28.11', eventId: 'temple-008' },
  { id: '5-raves', name: '5 RAVES', sub: 'CHECKED IN', detail: 'FIVE RECKLESS NIGHTS CHECKED IN', line: 'FROM 21 NOV 2026 ON', mark: ['5', 'RAVES'], markSub: 'CHECKED IN', raves: 5 },
];

export const socialLive = () => /^(1|true|yes|on)$/i.test(String(process.env.SOCIAL_LIVE || '').trim());
function testEmails() {
  return new Set(
    String(process.env.SOCIAL_TEST_EMAILS || '')
      .split(/[\s,]+/)
      .map((value) => value.trim().toLowerCase())
      .filter((value) => value.includes('@')),
  );
}
/** True when this email may use social (flag on, or a named tester while it is off). */
export function socialOpenFor(email) {
  if (socialLive()) return true;
  return Boolean(email) && testEmails().has(String(email).toLowerCase());
}

/* ---------- handles ---------- */

const HANDLE_RE = /^[A-Z0-9_]{2,12}$/;
const RESERVED = new Set([
  'ADMIN', 'ADMINS', 'ADMINISTRATOR', 'MOD', 'MODS', 'MODERATOR', 'STAFF', 'SUPPORT', 'HELP', 'OFFICIAL', 'TEAM', 'SECURITY', 'WELFARE',
  'RECKLESS', 'RECKLESSRAVES', 'RECKLESS_RAVES', 'RR', 'RRAVES', 'GEARBOX', 'TEMPLE', 'THETEMPLE', 'SKIDDLE', 'APPLE', 'GOOGLE', 'SYSTEM',
  'ROOT', 'NULL', 'UNDEFINED', 'NONE', 'ANON', 'ANONYMOUS', 'YOU', 'ME', 'DELETED', 'REMOVED', 'PRIVATE', 'POLICE', 'PSNI', 'DJ', 'PROMOTER',
]);
// Checked as substrings after leetspeak folding, so variants with digits and underscores are caught too.
const BLOCKED_PARTS = [
  'FUCK', 'FUK', 'FCK', 'SHIT', 'CUNT', 'TWAT', 'WANK', 'BITCH', 'SLUT', 'WHORE', 'DICK', 'COCK', 'PUSSY', 'BOLLOCK', 'BELLEND', 'ARSEHOLE', 'ASSHOLE',
  'NIGG', 'NIGA', 'NIGR', 'FAGG', 'FAGOT', 'DYKE', 'TRANNY', 'RETARD', 'SPAST', 'SPAZ', 'PAKI', 'CHINK', 'KIKE', 'FENIAN',
  'RAPIST', 'PEDO', 'PAEDO', 'NAZI', 'HITLER', 'KKK', 'PORN', 'NUDE', 'KETAMINE', 'MDMA', 'DEALER',
];
// Short words that are only blocked as a whole handle or a whole _-separated part (so GRAPE, ESSEX, RACCOON stay fine).
const BLOCKED_WORDS = new Set(['FAG', 'HUN', 'HUNS', 'TAIG', 'TAIGS', 'WOG', 'GOOK', 'COON', 'RAPE', 'SEX', 'SEXY', 'KYS', 'ISIS', 'COKE', 'PILLS', 'PILL', 'ARSE', 'ASS', 'TIT', 'TITS', 'NOB', 'KNOB', 'PISS', 'CUM', 'JIZZ', 'HOE', 'HOES']);
function fold(value) {
  return value.replace(/0/g, 'O').replace(/1/g, 'I').replace(/3/g, 'E').replace(/4/g, 'A').replace(/5/g, 'S').replace(/7/g, 'T').replace(/8/g, 'B').replace(/\$/g, 'S');
}
/** Returns { handle } (normalised UPPERCASE) or { error } for a requested crew handle. */
export function checkHandle(raw) {
  const handle = String(raw ?? '').trim().toUpperCase();
  if (!HANDLE_RE.test(handle)) return { error: 'HANDLE_FORMAT' };
  if (/^_+$/.test(handle)) return { error: 'HANDLE_FORMAT' };
  const bare = handle.replace(/_/g, '');
  if (RESERVED.has(handle) || RESERVED.has(bare)) return { error: 'HANDLE_RESERVED' };
  const folded = fold(handle);
  const foldedBare = fold(bare);
  for (const part of BLOCKED_PARTS) {
    if (folded.includes(part) || foldedBare.includes(part)) return { error: 'HANDLE_BLOCKED' };
  }
  const words = [foldedBare, ...folded.split('_').filter(Boolean)];
  if (words.some((word) => BLOCKED_WORDS.has(word) || BLOCKED_WORDS.has(word.replace(/S$/, '')))) return { error: 'HANDLE_BLOCKED' };
  return { handle };
}

/* ---------- small helpers ---------- */

function londonDateKey(ms) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(ms));
  const get = (type) => parts.find((part) => part.type === type)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}
const emailHash = (email) => createHash('sha256').update(String(email || '').trim().toLowerCase()).digest('hex').slice(0, 12);
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function newCode() {
  const bytes = randomBytes(6);
  let out = '';
  for (const byte of bytes) out += CODE_ALPHABET[byte % CODE_ALPHABET.length];
  return out;
}
const cleanCode = (value) => String(value ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
const EVENT_ID_RE = /^[a-z0-9_-]{1,64}$/i;
const PHOTO_ID_RE = /^[A-Za-z0-9_-]{32}$/;

function sniffImage(buffer) {
  if (buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpeg';
  if (buffer.length > 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buffer.length > 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'webp';
  return null;
}

/**
 * deps: { dataDir, accounts, existingAccount, accountFor, saveAccounts, readSession, normalizeEmail,
 *   rateLimited, clientIp, xpFor, refreshLedger, standing, crewConfig, contentEventById, adminKeyOk,
 *   sendJson, now? }
 */
export function createSocial(deps) {
  const { dataDir, existingAccount, accountFor, saveAccounts, readSession, normalizeEmail, rateLimited, clientIp, xpFor, refreshLedger, standing, crewConfig, contentEventById, adminKeyOk, sendJson } = deps;
  const now = () => (typeof deps.now === 'function' ? deps.now() : Date.now());
  const statePath = path.join(dataDir, 'social.json');
  const codesPath = path.join(dataDir, 'social-checkin-codes.json');
  const eventsPath = path.join(dataDir, 'social-events.jsonl');
  const photoDir = path.join(dataDir, 'social-photos');
  const ordersPath = path.join(dataDir, 'skiddle-orders.json');

  /* state: { profiles: { email: { handle, private, handleAt, badgesSeen: [] } },
   *          going: { eventId: { email: isoAt } },
   *          checkins: { email: { eventId: { at, snapshot, note, noteAt, photo, photoAt, deleted } } },
   *          blockedHandles: { HANDLE: isoAt } } */
  let state = { profiles: {}, going: {}, checkins: {}, blockedHandles: {} };
  let codes = {};
  let lines = [];
  let countedIds = new Set();
  let ordersSheet = new Map(); // skiddleEventId -> Set(email)
  let ordersFile = { at: 0, map: new Map() };

  function load() {
    try {
      const raw = JSON.parse(readFileSync(statePath, 'utf8'));
      if (raw && typeof raw === 'object') state = { profiles: raw.profiles || {}, going: raw.going || {}, checkins: raw.checkins || {}, blockedHandles: raw.blockedHandles || {} };
    } catch {
      // first run
    }
    try {
      codes = JSON.parse(readFileSync(codesPath, 'utf8')) || {};
    } catch {
      codes = {};
    }
    lines = [];
    countedIds = new Set();
    try {
      for (const line of readFileSync(eventsPath, 'utf8').split('\n')) {
        if (!line) continue;
        try {
          const row = JSON.parse(line);
          lines.push({ line, row });
          if (row.counted) countedIds.add(row.id);
        } catch {
          // skip unreadable line
        }
      }
    } catch {
      // no log yet
    }
  }
  function writeAtomic(file, text) {
    mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, text);
    renameSync(tmp, file);
  }
  const save = () => writeAtomic(statePath, JSON.stringify(state));
  const saveCodes = () => writeAtomic(codesPath, JSON.stringify(codes));
  load();

  /* ---------- XP log ---------- */

  function recordXp({ email, type, eventId }) {
    const atMs = now();
    const id = `${type === 'event_checkin' ? 'sc' : 'sd'}:${eventId}:${emailHash(email)}`;
    let counted = true;
    let reason = null;
    if (countedIds.has(id)) {
      counted = false;
      reason = 'DUPLICATE';
    } else if (type === 'event_checkin') {
      const day = londonDateKey(atMs);
      const today = lines.filter(({ row }) => row.counted && row.type === 'event_checkin' && row.email === email && londonDateKey(Date.parse(row.at)) === day).length;
      if (today >= socialRules.checkinMaxPerLondonDay) {
        counted = false;
        reason = 'DAILY_CAP';
      }
    }
    const test = !(socialLive() && counted && atMs >= Date.parse(socialRules.from));
    const row = { id, type, email, eventId, xp: counted ? socialRules.xp[type] : 0, at: new Date(atMs).toISOString(), counted, reason, test };
    const line = JSON.stringify(row);
    mkdirSync(dataDir, { recursive: true });
    appendFileSync(eventsPath, `${line}\n`);
    lines.push({ line, row });
    if (counted) countedIds.add(id);
    return row;
  }
  function exportSince(sinceMs) {
    const out = lines.filter(({ row }) => Date.parse(row.at) >= sinceMs).map(({ line }) => line);
    return out.length ? `${out.join('\n')}\n` : '';
  }

  /* ---------- Skiddle ticket orders (VERIFIED) ---------- */

  /** From the XP Sheet "Tickets" tab: rows of [email, skiddle_event_id, order_id, purchased_at]. */
  function setTicketOrders(rows) {
    const map = new Map();
    for (const row of rows || []) {
      const email = normalizeEmail(row?.[0]);
      const sid = String(row?.[1] || '').trim();
      if (!email.includes('@') || !/^\d{5,12}$/.test(sid)) continue;
      if (!map.has(sid)) map.set(sid, new Set());
      map.get(sid).add(email);
    }
    ordersSheet = map;
  }
  /** DATA_DIR/skiddle-orders.json: { "orders": [{ "email", "skiddleEventId", "orderId" }] } (re-read once a minute). */
  function fileOrders() {
    if (now() - ordersFile.at < 60 * 1000) return ordersFile.map;
    const map = new Map();
    try {
      const raw = JSON.parse(readFileSync(ordersPath, 'utf8'));
      for (const order of raw?.orders || []) {
        const email = normalizeEmail(order?.email);
        const sid = String(order?.skiddleEventId || '').trim();
        if (!email.includes('@') || !/^\d{5,12}$/.test(sid)) continue;
        if (!map.has(sid)) map.set(sid, new Set());
        map.get(sid).add(email);
      }
    } catch {
      // no file
    }
    ordersFile = { at: now(), map };
    return map;
  }
  function hasTicket(email, skiddleId) {
    if (!skiddleId) return false;
    const sid = String(skiddleId);
    return Boolean(ordersSheet.get(sid)?.has(email) || fileOrders().get(sid)?.has(email));
  }
  function orderSourceStatus() {
    let file = 0;
    for (const set of fileOrders().values()) file += set.size;
    let sheet = 0;
    for (const set of ordersSheet.values()) sheet += set.size;
    return { sheetRows: sheet, fileRows: file };
  }

  /* ---------- derived data ---------- */

  const profileOf = (email) => state.profiles[email] || null;
  function ensureProfile(email) {
    if (!state.profiles[email]) state.profiles[email] = { handle: null, private: false, badgesSeen: [] };
    return state.profiles[email];
  }
  function emailForHandle(handle) {
    for (const [email, profile] of Object.entries(state.profiles)) if (profile.handle === handle) return email;
    return null;
  }
  const fromMs = () => Date.parse(socialRules.from);
  function checkinsOf(email) {
    const mine = state.checkins[email] || {};
    return Object.entries(mine)
      .filter(([, entry]) => Date.parse(entry.at) >= fromMs())
      .map(([eventId, entry]) => ({ eventId, ...entry }))
      .sort((a, b) => Date.parse(b.snapshot?.startDate || b.at) - Date.parse(a.snapshot?.startDate || a.at));
  }
  const raveCount = (email) => checkinsOf(email).length;

  function crewInfo(email) {
    const xp = xpFor(email);
    const { level, crew } = standing(xp);
    const crews = crewConfig()?.crews || [];
    return { xp, level, crewIndex: crew, crewName: crews[crew]?.name || 'FRESHER' };
  }
  function lookOf(email) {
    const account = existingAccount(email);
    const fit = account?.fit && typeof account.fit === 'object' ? { top: account.fit.top ?? null, outer: account.fit.outer ?? null, legs: account.fit.legs ?? null } : { top: null, outer: null, legs: null };
    const base = account?.avatarBase === 'female' ? 'female' : 'male';
    return { avatarBase: base, fit };
  }
  function foundingRaver(email) {
    const account = existingAccount(email);
    const day1 = crewConfig()?.day1;
    if (!account || !day1) return false;
    const from = Date.parse(day1.from);
    const to = Date.parse(day1.to);
    const inWindow = (iso) => {
      const at = Date.parse(iso || '');
      return Number.isFinite(at) && at >= from && at < to;
    };
    // `day1` is stamped by the crew API on the first sign-in inside the DAY 1 window;
    // `createdAt` is stamped on accounts created from this release on.
    return inWindow(account.createdAt) || inWindow(account.day1);
  }
  function crewBadges(email) {
    const crews = crewConfig()?.crews || [];
    const { crewIndex } = crewInfo(email);
    const short = (name) => {
      const value = String(name || '').toUpperCase();
      return value === 'RECKLESS CREW' ? value : value.replace(/^RECKLESS\s+/, '');
    };
    const out = [];
    let highest = -1;
    crews.forEach((crew, index) => {
      if (crew.merchPercent > 0 && index <= crewIndex) highest = index;
    });
    if (highest > 0) out.push({ id: `crew-${crews[highest].id}`, name: short(crews[highest].name), sub: `CREW CODE · ${crews[highest].merchPercent}%`, earned: true, kind: 'crew' });
    const next = crews.findIndex((crew, index) => index > crewIndex && crew.merchPercent > 0);
    if (next > 0) out.push({ id: `crew-${crews[next].id}`, name: short(crews[next].name), sub: `CREW CODE · ${crews[next].merchPercent}%`, earned: false, kind: 'crew' });
    return out;
  }
  function badgesFor(email) {
    const mine = checkinsOf(email);
    const raves = mine.length;
    const out = BADGES.map((badge) => {
      let earned = false;
      let sub = badge.sub;
      if (badge.id === 'founding-raver') earned = foundingRaver(email);
      if (badge.eventId) earned = mine.some((entry) => entry.eventId === badge.eventId);
      if (badge.raves) {
        earned = raves >= badge.raves;
        sub = `${raves} CHECKED IN`;
      }
      return { id: badge.id, name: badge.name, sub, earned, kind: 'social' };
    });
    return [...out, ...crewBadges(email)];
  }
  function badgeDetail(id) {
    const badge = BADGES.find((item) => item.id === id);
    if (!badge) return null;
    return { id: badge.id, name: badge.name, detail: badge.detail, line: badge.line, mark: badge.mark, markSub: badge.markSub };
  }

  function eventWindow(event) {
    const start = Date.parse(event?.startDate || '');
    if (!Number.isFinite(start)) return null;
    const endRaw = Date.parse(event?.endDate || '');
    const end = Number.isFinite(endRaw) && endRaw > start ? endRaw : start + socialRules.defaultEventLengthMs;
    return { opens: start - socialRules.checkinOpensBeforeMs, closes: end + socialRules.checkinClosesAfterMs };
  }
  function checkinOpen(event, at = now()) {
    const window = eventWindow(event);
    return Boolean(window && at >= window.opens && at <= window.closes && at >= fromMs());
  }
  function snapshotOf(event) {
    return {
      title: String(event.title || '').toUpperCase(),
      subtitle: String(event.subtitle || '').toUpperCase(),
      dateBadge: event.dateBadge || null,
      weekday: event.weekday || null,
      startDate: event.startDate || null,
      endDate: event.endDate || null,
      venue: event.venue || '',
      city: event.city || '',
      lineup: Array.isArray(event.lineup) ? event.lineup.slice(0, 24).map(String) : [],
      image: event.image || null,
      skiddleId: event.skiddleId || null,
    };
  }

  function goingRows(eventId) {
    const table = state.going[eventId] || {};
    return Object.entries(table).sort((a, b) => String(a[1]).localeCompare(String(b[1])));
  }
  function personCard(email, viewer, skiddleId) {
    const profile = profileOf(email);
    const info = crewInfo(email);
    return {
      handle: profile?.handle || null,
      crew: info.crewName,
      level: info.level,
      ...lookOf(email),
      verified: hasTicket(email, skiddleId),
      you: email === viewer,
    };
  }
  function eventSummary(eventId, viewer) {
    const event = contentEventById(eventId);
    const rows = goingRows(eventId);
    const skiddleId = event?.skiddleId || null;
    const visible = rows.filter(([email]) => {
      const profile = profileOf(email);
      return profile?.handle && !profile.private;
    });
    const verified = rows.filter(([email]) => hasTicket(email, skiddleId)).length;
    const out = {
      ok: true,
      eventId,
      count: rows.length,
      verified,
      faces: viewer ? visible.slice(0, socialRules.facesMax).map(([email]) => ({ handle: profileOf(email).handle, ...lookOf(email) })) : [],
      going: Boolean(viewer && state.going[eventId]?.[viewer]),
      checkinOpen: event ? checkinOpen(event) : false,
      checkinReady: Boolean(codes[eventId]?.code),
      checkedIn: Boolean(viewer && state.checkins[viewer]?.[eventId] && !state.checkins[viewer][eventId].deleted),
    };
    return out;
  }

  function diaryEntry(email, eventId, entry) {
    return {
      eventId,
      at: entry.at,
      ...entry.snapshot,
      note: entry.note || '',
      photo: entry.photo ? `/api/social/photo/${entry.photo}.jpg` : null,
      complete: Boolean(entry.note && entry.photo),
      xpEarned: countedIds.has(`sd:${eventId}:${emailHash(email)}`) ? socialRules.xp.diary_complete : 0,
    };
  }

  function meView(email) {
    const profile = ensureProfile(email);
    const info = crewInfo(email);
    const badges = badgesFor(email);
    const seen = new Set(profile.badgesSeen || []);
    const upcoming = Object.keys(state.going)
      .filter((eventId) => state.going[eventId]?.[email])
      .map((eventId) => contentEventById(eventId))
      .filter((event) => event && Date.parse(event.endDate || event.startDate) >= now())
      .sort((a, b) => Date.parse(a.startDate) - Date.parse(b.startDate))
      .map((event) => ({ eventId: event.id, title: String(event.title || '').toUpperCase(), subtitle: String(event.subtitle || '').toUpperCase(), dateBadge: event.dateBadge, venue: event.venue, image: event.image || null, count: goingRows(event.id).length }));
    const diary = checkinsOf(email).filter((entry) => !entry.deleted);
    return {
      ok: true,
      live: socialLive(),
      handle: profile.handle || null,
      private: Boolean(profile.private),
      ...lookOf(email),
      xp: info.xp,
      level: info.level,
      crew: info.crewName,
      raves: raveCount(email),
      badges,
      newBadges: badges.filter((badge) => badge.kind === 'social' && badge.earned && !seen.has(badge.id)).map((badge) => badgeDetail(badge.id)),
      going: upcoming,
      latestDiary: diary[0] ? diaryEntry(email, diary[0].eventId, diary[0]) : null,
    };
  }

  function publicProfile(email, viewer) {
    const profile = profileOf(email);
    const info = crewInfo(email);
    return {
      ok: true,
      handle: profile.handle,
      you: email === viewer,
      ...lookOf(email),
      level: info.level,
      crew: info.crewName,
      raves: raveCount(email),
      badges: badgesFor(email),
      going: Object.keys(state.going)
        .filter((eventId) => state.going[eventId]?.[email])
        .map((eventId) => contentEventById(eventId))
        .filter((event) => event && Date.parse(event.endDate || event.startDate) >= now())
        .map((event) => ({ eventId: event.id, title: String(event.title || '').toUpperCase(), subtitle: String(event.subtitle || '').toUpperCase(), dateBadge: event.dateBadge, venue: event.venue, image: event.image || null, count: goingRows(event.id).length })),
    };
  }

  /* ---------- photos ---------- */

  function photoPath(id) {
    return path.join(photoDir, `${id}.jpg`);
  }
  function removePhotoFile(id) {
    if (!id || !PHOTO_ID_RE.test(id)) return;
    try {
      unlinkSync(photoPath(id));
    } catch {
      // already gone
    }
  }
  function photoDiskBytes() {
    let total = 0;
    try {
      for (const name of readdirSync(photoDir)) {
        try {
          total += statSync(path.join(photoDir, name)).size;
        } catch {
          // raced
        }
      }
    } catch {
      // no dir
    }
    return total;
  }
  async function storePhoto(buffer) {
    if (!sniffImage(buffer)) return { error: 'PHOTO_TYPE' };
    let out;
    try {
      // rotate() applies the EXIF orientation; sharp drops all metadata (EXIF, GPS, ICC) unless asked to keep it.
      out = await sharp()(buffer, { limitInputPixels: 40_000_000 })
        .rotate()
        .resize({ width: socialRules.photoMaxEdge, height: socialRules.photoMaxEdge, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 82, mozjpeg: true })
        .toBuffer();
    } catch {
      return { error: 'PHOTO_UNREADABLE' };
    }
    if (photoDiskBytes() + out.length > socialRules.photoDiskCapBytes) return { error: 'PHOTO_STORAGE_FULL' };
    const id = randomBytes(24).toString('base64url');
    mkdirSync(photoDir, { recursive: true });
    writeFileSync(photoPath(id), out);
    return { id, bytes: out.length };
  }

  /* ---------- cleanup ---------- */

  function forget(email) {
    let changed = false;
    if (state.profiles[email]) {
      delete state.profiles[email];
      changed = true;
    }
    for (const table of Object.values(state.going)) {
      if (table[email]) {
        delete table[email];
        changed = true;
      }
    }
    if (state.checkins[email]) {
      for (const entry of Object.values(state.checkins[email])) removePhotoFile(entry.photo);
      delete state.checkins[email];
      changed = true;
    }
    if (changed) save();
  }

  /* ---------- HTTP ---------- */

  function sessionEmail(req) {
    return req.headers.authorization ? readSession(req.headers.authorization) : null;
  }
  function reply(res, status, payload) {
    res.setHeader('Cache-Control', 'no-store');
    sendJson(res, status, payload);
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
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => resolve(over ? { tooBig: true } : { buffer: Buffer.concat(chunks) }));
      req.on('error', () => resolve({ error: true }));
    });
  }
  async function readJsonBody(req) {
    const { buffer, tooBig, error } = await readRaw(req, 16 * 1024);
    if (tooBig || error) return null;
    if (!buffer.length) return {};
    try {
      const body = JSON.parse(buffer.toString('utf8'));
      return body && typeof body === 'object' && !Array.isArray(body) ? body : null;
    } catch {
      return null;
    }
  }

  async function api(req, res, url) {
    const p = url.pathname;
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
    if (p === '/api/social/export') {
      if (req.method !== 'GET') return reply(res, 405, { ok: false, error: 'METHOD' });
      if (!adminKeyOk(String(req.headers['x-admin-key'] || ''))) return reply(res, 403, { ok: false, error: 'ADMIN' });
      const since = url.searchParams.get('since');
      const sinceMs = since ? Date.parse(since) : 0;
      if (since && Number.isNaN(sinceMs)) return reply(res, 400, { ok: false, error: 'SINCE' });
      const body = exportSince(sinceMs);
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' });
      res.end(body);
      return;
    }
    if (rateLimited(`social:ip:${clientIp(req)}`, socialRules.rate.ipMax, socialRules.rate.windowMs)) {
      req.resume();
      return reply(res, 429, { ok: false, error: 'RATE' });
    }
    const viewer = sessionEmail(req);
    if (p === '/api/social/status' && req.method === 'GET') {
      return reply(res, 200, { ok: true, live: socialOpenFor(viewer), tester: Boolean(viewer && !socialLive() && socialOpenFor(viewer)) });
    }
    // Photos: capability URLs (unguessable 192-bit ids, only ever handed to the owner and the admin page).
    const photoMatch = p.match(/^\/api\/social\/photo\/([A-Za-z0-9_-]{32})\.jpg$/);
    if (photoMatch && (req.method === 'GET' || req.method === 'HEAD')) {
      const file = photoPath(photoMatch[1]);
      if (!existsSync(file)) return reply(res, 404, { ok: false, error: 'NOT_FOUND' });
      const body = readFileSync(file);
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': body.length, 'Cache-Control': 'private, max-age=86400', 'X-Content-Type-Options': 'nosniff' });
      res.end(req.method === 'HEAD' ? undefined : body);
      return;
    }
    if (!viewer) {
      req.resume();
      // Signed out: the GOING count only (no faces), so the event page can still show it.
      const countMatch = p.match(/^\/api\/social\/event\/([^/]+)$/);
      if (countMatch && req.method === 'GET' && socialLive() && EVENT_ID_RE.test(countMatch[1])) {
        const summary = eventSummary(countMatch[1], null);
        return reply(res, 200, { ok: true, eventId: summary.eventId, count: summary.count, verified: summary.verified, faces: [], going: false, checkinOpen: summary.checkinOpen, checkinReady: summary.checkinReady, checkedIn: false, signedIn: false });
      }
      return reply(res, 401, { ok: false, error: 'SESSION' });
    }
    if (!socialOpenFor(viewer)) {
      req.resume();
      return reply(res, 403, { ok: false, error: 'SOCIAL_OFF' });
    }
    if (rateLimited(`social:email:${viewer}`, socialRules.rate.emailMax, socialRules.rate.windowMs)) {
      req.resume();
      return reply(res, 429, { ok: false, error: 'RATE' });
    }
    await refreshLedger().catch(() => {});

    if (p === '/api/social/me') {
      if (req.method === 'GET') return reply(res, 200, meView(viewer));
      if (req.method !== 'PUT') return reply(res, 405, { ok: false, error: 'METHOD' });
      const body = await readJsonBody(req);
      if (!body) return reply(res, 400, { ok: false, error: 'BODY' });
      const profile = ensureProfile(viewer);
      if (body.handle !== undefined) {
        const checked = checkHandle(body.handle);
        if (checked.error) return reply(res, 400, { ok: false, error: checked.error });
        if (checked.handle !== profile.handle) {
          if (state.blockedHandles[checked.handle]) return reply(res, 400, { ok: false, error: 'HANDLE_BLOCKED' });
          const owner = emailForHandle(checked.handle);
          if (owner && owner !== viewer) return reply(res, 409, { ok: false, error: 'HANDLE_TAKEN' });
          if (profile.handle && profile.handleAt && now() - Date.parse(profile.handleAt) < socialRules.handleChangeEveryMs) {
            return reply(res, 429, { ok: false, error: 'HANDLE_CHANGE_LIMIT' });
          }
          profile.handle = checked.handle;
          profile.handleAt = new Date(now()).toISOString();
        }
      }
      if (body.private !== undefined) {
        if (typeof body.private !== 'boolean') return reply(res, 400, { ok: false, error: 'PRIVATE' });
        profile.private = body.private;
      }
      if (body.seenBadges !== undefined) {
        if (!Array.isArray(body.seenBadges)) return reply(res, 400, { ok: false, error: 'BADGES' });
        const known = new Set(BADGES.map((badge) => badge.id));
        const seen = new Set(profile.badgesSeen || []);
        for (const id of body.seenBadges) if (known.has(id)) seen.add(id);
        profile.badgesSeen = [...seen];
      }
      save();
      return reply(res, 200, meView(viewer));
    }

    const profileMatch = p.match(/^\/api\/social\/profile\/([A-Za-z0-9_]{2,12})$/);
    if (profileMatch && req.method === 'GET') {
      const email = emailForHandle(profileMatch[1].toUpperCase());
      const profile = email ? profileOf(email) : null;
      if (!email || (profile.private && email !== viewer)) return reply(res, 404, { ok: false, error: 'NOT_FOUND' });
      return reply(res, 200, publicProfile(email, viewer));
    }

    const eventMatch = p.match(/^\/api\/social\/event\/([^/]+)(\/going|\/checkin)?$/);
    if (eventMatch) {
      const eventId = eventMatch[1];
      const sub = eventMatch[2] || '';
      if (!EVENT_ID_RE.test(eventId)) return reply(res, 400, { ok: false, error: 'EVENT' });
      const event = contentEventById(eventId);
      if (!sub && req.method === 'GET') return reply(res, 200, { ...eventSummary(eventId, viewer), signedIn: true });
      if (sub === '/going' && req.method === 'GET') {
        const skiddleId = event?.skiddleId || null;
        const rows = goingRows(eventId);
        const people = rows
          .filter(([email]) => email === viewer || (profileOf(email)?.handle && !profileOf(email)?.private))
          .filter(([email]) => profileOf(email)?.handle)
          .map(([email]) => personCard(email, viewer, skiddleId))
          .sort((a, b) => Number(b.you) - Number(a.you));
        return reply(res, 200, { ok: true, eventId, title: event ? String(event.title || '').toUpperCase() : null, dateBadge: event?.dateBadge || null, count: rows.length, verified: rows.filter(([email]) => hasTicket(email, skiddleId)).length, people });
      }
      if (sub === '/going' && (req.method === 'POST' || req.method === 'DELETE')) {
        req.resume();
        if (req.method === 'POST') {
          if (!event) return reply(res, 404, { ok: false, error: 'EVENT' });
          if (Date.parse(event.endDate || event.startDate) < now()) return reply(res, 409, { ok: false, error: 'EVENT_OVER' });
          if (!profileOf(viewer)?.handle) return reply(res, 409, { ok: false, error: 'HANDLE_NEEDED' });
          if (!state.going[eventId]) state.going[eventId] = {};
          if (!state.going[eventId][viewer]) state.going[eventId][viewer] = new Date(now()).toISOString();
        } else if (state.going[eventId]) {
          delete state.going[eventId][viewer];
        }
        save();
        return reply(res, 200, { ...eventSummary(eventId, viewer), signedIn: true });
      }
      if (sub === '/checkin' && req.method === 'POST') {
        if (rateLimited(`social:checkin:${viewer}`, socialRules.rate.checkinEmailMax, socialRules.rate.windowMs) || rateLimited(`social:checkin:ip:${clientIp(req)}`, socialRules.rate.checkinIpMax, socialRules.rate.windowMs)) {
          req.resume();
          return reply(res, 429, { ok: false, error: 'RATE' });
        }
        const body = await readJsonBody(req);
        if (!body) return reply(res, 400, { ok: false, error: 'BODY' });
        if (!event) return reply(res, 404, { ok: false, error: 'EVENT' });
        if (!checkinOpen(event)) return reply(res, 409, { ok: false, error: 'CHECKIN_CLOSED' });
        const want = codes[eventId]?.code;
        if (!want) return reply(res, 409, { ok: false, error: 'CHECKIN_NOT_READY' });
        const given = Buffer.from(cleanCode(body.code));
        const expected = Buffer.from(want);
        if (given.length !== expected.length || !timingSafeEqual(given, expected)) return reply(res, 400, { ok: false, error: 'CODE' });
        if (!state.checkins[viewer]) state.checkins[viewer] = {};
        const existing = state.checkins[viewer][eventId];
        if (existing && !existing.deleted) return reply(res, 200, { ok: true, already: true, xp: 0, entry: diaryEntry(viewer, eventId, existing), newBadges: [] });
        const before = new Set(badgesFor(viewer).filter((badge) => badge.earned).map((badge) => badge.id));
        if (existing) {
          existing.deleted = false;
        } else {
          state.checkins[viewer][eventId] = { at: new Date(now()).toISOString(), source: 'code', snapshot: snapshotOf(event), note: '', photo: null };
        }
        save();
        const row = recordXp({ email: viewer, type: 'event_checkin', eventId });
        const fresh = badgesFor(viewer).filter((badge) => badge.kind === 'social' && badge.earned && !before.has(badge.id)).map((badge) => badgeDetail(badge.id));
        return reply(res, 200, { ok: true, already: false, xp: row.counted ? row.xp : 0, entry: diaryEntry(viewer, eventId, state.checkins[viewer][eventId]), newBadges: fresh });
      }
      req.resume();
      return reply(res, 405, { ok: false, error: 'METHOD' });
    }

    if (p === '/api/social/diary' && req.method === 'GET') {
      const entries = checkinsOf(viewer).filter((entry) => !entry.deleted).map((entry) => diaryEntry(viewer, entry.eventId, entry));
      return reply(res, 200, { ok: true, raves: raveCount(viewer), entries });
    }
    const diaryMatch = p.match(/^\/api\/social\/diary\/([a-z0-9_-]{1,64})(\/photo)?$/i);
    if (diaryMatch) {
      const eventId = diaryMatch[1];
      const entry = state.checkins[viewer]?.[eventId];
      if (!entry || entry.deleted || Date.parse(entry.at) < fromMs()) {
        req.resume();
        return reply(res, 404, { ok: false, error: 'NOT_FOUND' });
      }
      const completeXp = () => {
        if (entry.note && entry.photo) {
          const row = recordXp({ email: viewer, type: 'diary_complete', eventId });
          return row.counted ? row.xp : 0;
        }
        return 0;
      };
      if (!diaryMatch[2]) {
        if (req.method === 'GET') return reply(res, 200, { ok: true, entry: diaryEntry(viewer, eventId, entry) });
        if (req.method === 'PUT') {
          const body = await readJsonBody(req);
          if (!body || typeof body.note !== 'string') return reply(res, 400, { ok: false, error: 'NOTE' });
          const note = body.note.replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '').replace(/\s+/g, ' ').trim();
          if ([...note].length > socialRules.noteMax) return reply(res, 400, { ok: false, error: 'NOTE_TOO_LONG', max: socialRules.noteMax });
          entry.note = note;
          entry.noteAt = new Date(now()).toISOString();
          save();
          const xp = completeXp();
          return reply(res, 200, { ok: true, xp, entry: diaryEntry(viewer, eventId, entry) });
        }
        if (req.method === 'DELETE') {
          req.resume();
          removePhotoFile(entry.photo);
          entry.photo = null;
          entry.note = '';
          entry.deleted = true;
          save();
          return reply(res, 200, { ok: true, deleted: true });
        }
        req.resume();
        return reply(res, 405, { ok: false, error: 'METHOD' });
      }
      if (req.method === 'POST' || req.method === 'PUT') {
        if (rateLimited(`social:photo:${viewer}`, socialRules.rate.photoEmailMax, socialRules.rate.windowMs)) {
          req.resume();
          return reply(res, 429, { ok: false, error: 'RATE' });
        }
        const declared = Number(req.headers['content-length'] || 0);
        if (declared > socialRules.photoMaxBytes) {
          req.resume();
          return reply(res, 413, { ok: false, error: 'PHOTO_TOO_BIG', maxBytes: socialRules.photoMaxBytes });
        }
        const { buffer, tooBig, error } = await readRaw(req, socialRules.photoMaxBytes);
        if (tooBig) return reply(res, 413, { ok: false, error: 'PHOTO_TOO_BIG', maxBytes: socialRules.photoMaxBytes });
        if (error || !buffer?.length) return reply(res, 400, { ok: false, error: 'PHOTO' });
        const stored = await storePhoto(buffer);
        if (stored.error) return reply(res, stored.error === 'PHOTO_STORAGE_FULL' ? 507 : 400, { ok: false, error: stored.error });
        removePhotoFile(entry.photo);
        entry.photo = stored.id;
        entry.photoAt = new Date(now()).toISOString();
        save();
        const xp = completeXp();
        return reply(res, 200, { ok: true, xp, entry: diaryEntry(viewer, eventId, entry) });
      }
      if (req.method === 'DELETE') {
        req.resume();
        removePhotoFile(entry.photo);
        entry.photo = null;
        save();
        return reply(res, 200, { ok: true, entry: diaryEntry(viewer, eventId, entry) });
      }
      req.resume();
      return reply(res, 405, { ok: false, error: 'METHOD' });
    }
    req.resume();
    return reply(res, 404, { ok: false, error: 'NOT_FOUND' });
  }

  /** Returns true when the request was a /api/social request (handled). */
  function handle(req, res, url) {
    if (!url.pathname.startsWith('/api/social/')) return false;
    api(req, res, url).catch((error) => {
      console.error('social request failed', error instanceof Error ? error.message : error);
      if (!res.headersSent) reply(res, 500, { ok: false, error: 'SERVER' });
    });
    return true;
  }

  /* ---------- admin ---------- */

  function adminLookup(email) {
    const profile = profileOf(email);
    const diary = checkinsOf(email).map((entry) => ({
      eventId: entry.eventId,
      title: entry.snapshot?.title || entry.eventId,
      dateBadge: entry.snapshot?.dateBadge || null,
      at: entry.at,
      deleted: Boolean(entry.deleted),
      note: entry.note || '',
      photo: entry.photo ? `/api/social/photo/${entry.photo}.jpg` : null,
    }));
    return {
      handle: profile?.handle || null,
      private: Boolean(profile?.private),
      going: Object.keys(state.going).filter((eventId) => state.going[eventId]?.[email]),
      raves: raveCount(email),
      badges: badgesFor(email).filter((badge) => badge.earned).map((badge) => badge.name),
      diary,
    };
  }
  function adminAction(email, action, body) {
    if (action === 'remove-handle') {
      const profile = profileOf(email);
      if (!profile?.handle) return { status: 404, body: { ok: false, error: 'NO_HANDLE', message: 'NO HANDLE TO REMOVE' } };
      const handle = profile.handle;
      // The removed handle can't be picked again by anyone.
      state.blockedHandles[handle] = new Date(now()).toISOString();
      profile.handle = null;
      profile.handleAt = null;
      save();
      return { status: 200, body: { ok: true, removed: handle }, audit: { handle } };
    }
    if (action === 'remove-photo' || action === 'remove-note') {
      const eventId = String(body?.eventId || '');
      const entry = state.checkins[email]?.[eventId];
      if (!entry) return { status: 404, body: { ok: false, error: 'NO_ENTRY', message: 'NO DIARY ENTRY FOR THAT NIGHT' } };
      if (action === 'remove-photo') {
        removePhotoFile(entry.photo);
        entry.photo = null;
      } else {
        entry.note = '';
      }
      save();
      return { status: 200, body: { ok: true }, audit: { eventId } };
    }
    return null;
  }
  function adminSummary(events) {
    const profiles = Object.values(state.profiles);
    let checkins = 0;
    let photos = 0;
    for (const table of Object.values(state.checkins)) {
      for (const entry of Object.values(table)) {
        if (Date.parse(entry.at) < fromMs()) continue;
        checkins += 1;
        if (entry.photo) photos += 1;
      }
    }
    const rows = (events || []).map((event) => {
      const full = contentEventById(event.id);
      const window = full ? eventWindow(full) : null;
      return {
        id: event.id,
        title: event.title,
        subtitle: event.subtitle,
        startDate: event.startDate,
        going: goingRows(event.id).length,
        verified: goingRows(event.id).filter(([email]) => hasTicket(email, full?.skiddleId)).length,
        checkins: Object.values(state.checkins).filter((table) => table[event.id]).length,
        code: codes[event.id]?.code || null,
        codeAt: codes[event.id]?.at || null,
        opens: window ? new Date(window.opens).toISOString() : null,
        closes: window ? new Date(window.closes).toISOString() : null,
        open: full ? checkinOpen(full) : false,
      };
    });
    return {
      live: socialLive(),
      testers: testEmails().size,
      handles: profiles.filter((profile) => profile.handle).length,
      private: profiles.filter((profile) => profile.private).length,
      checkins,
      photos,
      photoMb: Math.round((photoDiskBytes() / (1024 * 1024)) * 10) / 10,
      orders: orderSourceStatus(),
      xpRows: lines.length,
      events: rows,
    };
  }
  /** Creates (or replaces) the check-in code for an event. */
  function adminNewCode(eventId) {
    if (!EVENT_ID_RE.test(String(eventId || '')) || !contentEventById(eventId)) return { status: 404, body: { ok: false, error: 'EVENT', message: 'UNKNOWN EVENT' } };
    const code = newCode();
    codes[eventId] = { code, at: new Date(now()).toISOString() };
    saveCodes();
    return { status: 200, body: { ok: true, eventId, code } };
  }

  return { handle, forget, adminLookup, adminAction, adminSummary, adminNewCode, setTicketOrders, exportSince, socialLive, _state: () => state };
}
