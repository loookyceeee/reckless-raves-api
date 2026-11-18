// Crew loyalty server logic for /api/crew: ladder + wardrobe from crew-config.json
// (one swappable table shared by the app, game and toolkit), owned pieces,
// per-fan discount codes, server-driven crew-up / level-up popups and badges.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
let dataDir = '';
let config = loadConfig();
let issued = {};

function loadConfig() {
  // DATA_DIR/crew-config.json overrides the copy in the repo, so the ladder can be
  // swapped on the server without a code change.
  const files = [dataDir && path.join(dataDir, 'crew-config.json'), path.join(here, 'crew-config.json')].filter(Boolean);
  for (const file of files) {
    try {
      if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8'));
    } catch (error) {
      console.error('crew-config unreadable', file, error instanceof Error ? error.message : error);
    }
  }
  return { crews: [], ranks: [{ level: 1, xp: 0, crew: 0, step: 'I' }], wardrobe: [], rewards: [] };
}

export function crewConfig() {
  return config;
}

const issuedPath = () => path.join(dataDir, 'crew-codes-issued.json');

export function initCrew(dir) {
  dataDir = dir;
  config = loadConfig();
  try {
    issued = JSON.parse(readFileSync(issuedPath(), 'utf8')) || {};
  } catch {
    issued = {};
  }
}

function saveIssued() {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(issuedPath(), JSON.stringify(issued));
}

export function standing(xp) {
  let rank = config.ranks[0];
  for (const item of config.ranks) if (xp >= item.xp) rank = item;
  return { level: rank.level, crew: rank.crew };
}

function crewEntryLevel(index) {
  return config.ranks.find((rank) => rank.crew === index)?.level ?? Infinity;
}

/**
 * Owned pieces: bought items unlock regardless of level.
 * Input file DATA_DIR/crew-owned.json: { "fan@email.com": ["barrel-jeans", "stan-hoodie"] }
 * (or env CREW_OWNED with the same JSON). Ids are wardrobe ids from crew-config.json.
 */
let ownedSheet = {};
let ownedCache = { at: 0, map: {} };
/** Optional Sheet input ("Owned" tab: email | comma-separated ids), merged over the file. */
export function setOwnedSheet(map) {
  ownedSheet = map || {};
  ownedCache.at = 0;
}
function readOwnedFiles() {
  let map = {};
  // Fallback files, shaped { "fan@email.com": ["SKATE TEE", "barrel-jeans", ...] } (names or ids).
  const files = [path.join(dataDir, 'owned.json'), path.join(dataDir, 'crew-owned.json'), '/home/box/shared/reckless-crew/owned.json'];
  for (const file of files) {
    try {
      if (existsSync(file)) map = { ...map, ...JSON.parse(readFileSync(file, 'utf8')) };
    } catch {
      console.error('owned file unreadable', path.basename(file));
    }
  }
  try {
    if ((process.env.CREW_OWNED || '').trim()) map = { ...map, ...JSON.parse(process.env.CREW_OWNED) };
  } catch {
    console.error('CREW_OWNED env is not valid JSON');
  }
  const out = {};
  for (const [email, ids] of Object.entries({ ...map, ...ownedSheet })) {
    if (Array.isArray(ids)) out[String(email).trim().toLowerCase()] = ids.filter((id) => typeof id === 'string');
  }
  return out;
}
export function ownedFor(email) {
  if (Date.now() - ownedCache.at > 60 * 1000) ownedCache = { at: Date.now(), map: readOwnedFiles() };
  const byKey = new Map();
  for (const piece of config.wardrobe) {
    byKey.set(piece.id, piece.id);
    byKey.set(piece.name.trim().toUpperCase(), piece.id);
  }
  const out = new Set();
  for (const value of ownedCache.map[email] || []) {
    const id = byKey.get(value) || byKey.get(String(value).trim().toUpperCase());
    if (id) out.add(id);
  }
  return [...out];
}

/** Keeps only real pieces in their own slot that the level (or ownership) has unlocked. */
export function validFit(fit, xp, owned = []) {
  const { level } = standing(xp);
  const next = { top: null, outer: null, legs: null };
  if (!fit || typeof fit !== 'object') return next;
  for (const slot of Object.keys(next)) {
    const piece = config.wardrobe.find((item) => item.id === fit[slot]);
    if (piece && piece.slot === slot && (piece.level <= level || owned.includes(piece.id))) next[slot] = piece.id;
  }
  return next;
}

function codeTable() {
  let table = {};
  const file = path.join(dataDir, 'crew-codes.json');
  try {
    if (existsSync(file)) table = { ...table, ...JSON.parse(readFileSync(file, 'utf8')) };
  } catch (error) {
    console.error('crew-codes.json unreadable', error instanceof Error ? error.message : error);
  }
  try {
    if ((process.env.CREW_CODES || '').trim()) table = { ...table, ...JSON.parse(process.env.CREW_CODES) };
  } catch {
    console.error('CREW_CODES env is not valid JSON');
  }
  return table;
}

const emailHash = (email) => createHash('sha256').update(email).digest('hex');

/** Every code this email has ever been issued, oldest first (survives refunds and deletion, by hash). */
function issuedTo(email) {
  const hash = emailHash(email);
  return Object.entries(issued)
    .filter(([, value]) => value.hash === hash)
    .map(([code, value]) => ({ code, ...value }))
    .sort((a, b) => String(a.at).localeCompare(String(b.at)));
}

/* Issued-tab log for the XP Sheet. Rows queue on disk while Google is down. */
const queuePath = () => path.join(dataDir, 'issued-queue.json');
let sheetWriter = null;
export function setIssuedWriter(fn) {
  sheetWriter = fn;
}
function readQueue() {
  try {
    return JSON.parse(readFileSync(queuePath(), 'utf8')) || [];
  } catch {
    return [];
  }
}
function queueRow(row) {
  const queue = readQueue();
  queue.push(row);
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(queuePath(), JSON.stringify(queue));
  void flushIssued();
}
let flushing = false;
export async function flushIssued() {
  if (!sheetWriter || flushing) return;
  const queue = readQueue();
  if (!queue.length) return;
  flushing = true;
  try {
    await sheetWriter(queue);
    const rest = readQueue().slice(queue.length);
    writeFileSync(queuePath(), JSON.stringify(rest));
    console.log(`Issued tab: wrote ${queue.length} row(s)`);
  } catch (error) {
    console.error('Issued tab write queued', error instanceof Error ? error.message : error);
  } finally {
    flushing = false;
  }
}
export function issuedQueueLength() {
  return readQueue().length;
}

/**
 * Crew-up codes. Pool table: { "<crewId>": { "codes": ["CREW-CAS5-7KQ2XM", ...] } }.
 * One single-use code per fan per crew. A fan who skips crews gets ONE code for the
 * highest crew reached (the skipped crews are logged). A crew already issued to this
 * email is never issued again, even after a refund drops them back and they re-cross.
 * Empty pool = "coming soon"; the code is issued on a later read once the pool is loaded.
 */
function codesFor(email, xp, level, account) {
  const crewIndex = standing(xp).crew;
  const mine = issuedTo(email);
  const highestIssued = mine.reduce((max, item) => Math.max(max, config.crews.findIndex((crew) => crew.id === item.crew)), 0);
  let fresh = null;
  const target = config.crews[crewIndex];
  if (target && target.merchPercent > 0 && crewIndex > highestIssued && !mine.some((item) => item.crew === target.id)) {
    const pool = (codeTable()[target.id]?.codes || []).map((value) => String(value).trim()).filter(Boolean);
    const free = pool.find((value) => !issued[value]);
    if (free) {
      const from = config.crews[Math.max(highestIssued, account.lastCrewSeen ?? 0)]?.key || 'FRESHER';
      const skipped = config.crews.slice(Math.max(highestIssued, account.lastCrewSeen ?? 0) + 1, crewIndex).map((crew) => crew.key);
      const at = new Date().toISOString();
      issued[free] = { hash: emailHash(email), email, crew: target.id, at };
      saveIssued();
      fresh = free;
      queueRow([at, email, from, target.key, skipped.join(','), free, String(target.merchPercent), `app:crew:${emailHash(email).slice(0, 12)}:${target.key}`, String(xp), 'issued', '', '', '', 'app', '']);
    }
  }
  const list = issuedTo(email).map((item) => {
    const crew = config.crews.find((entry) => entry.id === item.crew);
    return { crew: item.crew, name: crew?.name, percent: crew?.merchPercent ?? 0, code: item.code, status: 'ready', issuedAt: item.at };
  });
  const pending =
    target && target.merchPercent > 0 && crewIndex > highestIssued && !fresh && !list.some((item) => item.crew === target.id)
      ? { crew: target.id, name: target.name, percent: target.merchPercent, code: null, status: 'soon' }
      : null;
  return { codes: pending ? [...list, pending] : list, changed: Boolean(fresh), fresh };
}

export function forgetCodes(email) {
  // Keep the hash so the same email can never be issued that crew's code twice.
  let changed = false;
  for (const value of Object.values(issued)) {
    if (value.email === email) {
      value.email = 'deleted';
      changed = true;
    }
  }
  if (changed) saveIssued();
}

function inDay1(now = Date.now()) {
  const day1 = config.day1;
  if (!day1) return false;
  return now >= Date.parse(day1.from) && now < Date.parse(day1.to);
}

/** Marks DAY 1 CREW for anyone signed in during launch week. */
export function touchDay1(account) {
  if (!account.day1 && inDay1()) {
    account.day1 = new Date().toISOString();
    return true;
  }
  return false;
}

/**
 * Full crew payload. lastCrewSeen / lastLevelSeen are stored per email; when the
 * current standing is above them the payload carries `crewUp` / `levelUp`, and the
 * app acknowledges with PUT { ack: { level } } after showing the popup.
 */
export function crewState(email, xp, account) {
  const { level, crew } = standing(xp);
  const owned = ownedFor(email);
  if (!account.fitSet) {
    account.fit = { ...(config.starterFit || {}) };
    account.fitSet = true;
  }
  account.fit = validFit(account.fit, xp, owned);
  let changed = touchDay1(account);
  if (typeof account.lastLevelSeen !== 'number') {
    // First sign-in: everything above level 1 counts as new, so the popup shows once.
    account.lastLevelSeen = 1;
    account.lastCrewSeen = 0;
    changed = true;
  }
  const { codes, changed: codesChanged } = codesFor(email, xp, level, account);
  const unlocked = (from, to) => config.wardrobe.filter((piece) => piece.level > from && piece.level <= to).map((piece) => piece.id);
  const levelUp =
    level > account.lastLevelSeen
      ? {
          from: account.lastLevelSeen,
          to: level,
          unlocked: unlocked(account.lastLevelSeen, level),
          rewards: config.rewards.filter((reward) => reward.level > account.lastLevelSeen && reward.level <= level).map((reward) => reward.id),
        }
      : null;
  const crewUp =
    crew > (account.lastCrewSeen ?? 0)
      ? {
          from: account.lastCrewSeen ?? 0,
          to: crew,
          name: config.crews[crew]?.name,
          percent: config.crews[crew]?.merchPercent ?? 0,
          code: codes.find((item) => item.crew === config.crews[crew]?.id) || codes[codes.length - 1] || null,
        }
      : null;
  const badges = config.rewards.filter((reward) => reward.level <= level).map((reward) => reward.id);
  if (account.day1) badges.push('day1');
  return {
    payload: { xp, level, crew, fit: account.fit, owned, codes, badges, levelUp, crewUp },
    changed: changed || codesChanged,
  };
}

export function acknowledge(account, xp, ack) {
  if (!ack || typeof ack !== 'object') return false;
  const { level, crew } = standing(xp);
  const seen = Math.min(level, Math.max(0, Math.floor(Number(ack.level) || 0)));
  if (seen <= (account.lastLevelSeen ?? 0)) return false;
  account.lastLevelSeen = seen;
  account.lastCrewSeen = seen >= level ? crew : standing(config.ranks.find((rank) => rank.level === seen)?.xp ?? 0).crew;
  return true;
}
