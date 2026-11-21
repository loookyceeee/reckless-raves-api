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

function sourceUpdatedAt(cfg) {
  const match = String(cfg?.source || '').match(/updated\s+(\d{4}-\d{2}-\d{2}T[0-9:.]+Z)/i);
  return match ? Date.parse(match[1]) : 0;
}

function loadConfig() {
  // DATA_DIR/crew-config.json overrides the bundled copy, so the ladder can be
  // swapped on the server without a code change. If the bundled file's source
  // date is newer than the disk copy, write it to /data and use it.
  const bundledPath = path.join(here, 'crew-config.json');
  let bundled = null;
  try {
    bundled = JSON.parse(readFileSync(bundledPath, 'utf8'));
  } catch (error) {
    console.error('crew-config unreadable', bundledPath, error instanceof Error ? error.message : error);
  }
  const dataFile = dataDir ? path.join(dataDir, 'crew-config.json') : '';
  let disk = null;
  if (dataFile) {
    try {
      if (existsSync(dataFile)) disk = JSON.parse(readFileSync(dataFile, 'utf8'));
    } catch (error) {
      console.error('crew-config unreadable', dataFile, error instanceof Error ? error.message : error);
    }
  }
  const bundledTime = sourceUpdatedAt(bundled);
  const diskTime = sourceUpdatedAt(disk);
  if (disk && (diskTime >= bundledTime || !bundled)) return disk;
  if (bundled && dataFile && bundledTime > diskTime) {
    try {
      mkdirSync(dataDir, { recursive: true });
      writeFileSync(dataFile, `${JSON.stringify(bundled, null, 1)}\n`);
    } catch (error) {
      console.error('crew-config write failed', dataFile, error instanceof Error ? error.message : error);
    }
  }
  return bundled || disk || { crews: [], ranks: [{ level: 1, xp: 0, crew: 0, step: 'I' }], wardrobe: [], rewards: [] };
}

export function crewConfig() {
  return config;
}

const issuedPath = () => path.join(dataDir, 'crew-codes-issued.json');

/**
 * Crew codes are compared case-insensitively and always stored and shown in UPPERCASE,
 * matching how Squarespace lists them (the starter batch was generated in lowercase).
 */
export const codeKey = (value) => String(value ?? '').trim().toUpperCase();

/** Re-keys the issued table in UPPERCASE (older rows may be lowercase). Keeps the earliest row on a clash. */
function normalizeIssued(table) {
  const out = {};
  let changed = false;
  for (const [code, value] of Object.entries(table || {})) {
    const key = codeKey(code);
    if (!key) continue;
    if (key !== code) changed = true;
    if (!out[key] || String(value?.at) < String(out[key]?.at)) out[key] = value;
  }
  return { table: out, changed };
}

export function initCrew(dir) {
  dataDir = dir;
  config = loadConfig();
  try {
    issued = JSON.parse(readFileSync(issuedPath(), 'utf8')) || {};
  } catch {
    issued = {};
  }
  const normal = normalizeIssued(issued);
  issued = normal.table;
  if (normal.changed) saveIssued();
  importCodesFromEnv();
}

/** One-way import: CREW_CODES env (JSON pool) is merged into DATA_DIR/crew-codes.json; codes are never dropped. */
function importCodesFromEnv() {
  const raw = (process.env.CREW_CODES || '').trim();
  if (!raw) return;
  let incoming;
  try {
    incoming = JSON.parse(raw);
  } catch {
    console.error('CREW_CODES env is not valid JSON');
    return;
  }
  const file = path.join(dataDir, 'crew-codes.json');
  let current = {};
  try {
    if (existsSync(file)) current = JSON.parse(readFileSync(file, 'utf8')) || {};
  } catch {
    current = {};
  }
  let added = 0;
  for (const [crewId, pool] of Object.entries(incoming)) {
    const have = current[crewId]?.codes || [];
    const seen = new Set(have.map(codeKey));
    const extra = [];
    for (const code of pool?.codes || []) {
      if (typeof code !== 'string' || !codeKey(code) || seen.has(codeKey(code))) continue;
      seen.add(codeKey(code));
      extra.push(codeKey(code));
    }
    added += extra.length;
    current[crewId] = { ...(current[crewId] || {}), ...pool, codes: [...have, ...extra] };
  }
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(file, JSON.stringify(current));
  console.log(`Crew code pool: imported ${added} new code(s) into crew-codes.json`);
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
/** Owned pieces come only from the XP Sheet "Owned" tab (email | item_name | order_id | purchased_at). */
function readOwnedFiles() {
  const out = {};
  for (const [email, names] of Object.entries(ownedSheet)) {
    if (Array.isArray(names)) out[String(email).trim().toLowerCase()] = names.filter((name) => typeof name === 'string');
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
  const given = fit && typeof fit === 'object' ? fit : {};
  for (const slot of Object.keys(next)) {
    const piece = config.wardrobe.find((item) => item.id === given[slot]);
    if (piece && piece.slot === slot && (piece.level <= level || owned.includes(piece.id))) next[slot] = piece.id;
  }
  // Nobody renders without a top or bottoms: an empty or clamped top/legs slot gets the
  // starter piece (crew config starterFit: Skate Tee / Barrel Jeans, both L1). Outer stays optional.
  for (const slot of ['top', 'legs']) {
    if (next[slot]) continue;
    const starter = config.wardrobe.find((item) => item.id === config.starterFit?.[slot]);
    if (starter && starter.slot === slot) next[slot] = starter.id;
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
  return table;
}

export function codePoolStatus() {
  const table = codeTable();
  const used = new Set(Object.keys(issued).map(codeKey));
  const pools = {};
  for (const [crewId, pool] of Object.entries(table)) {
    const codes = pool?.codes || [];
    pools[crewId] = { total: codes.length, free: codes.filter((code) => !used.has(codeKey(code))).length, loadedFree: freeLoaded(crewId).length };
  }
  return { live: codesLive(), loadedListed: loadedCodes().size, queuedFans: pendingCount(), pools };
}

export const codesLive = () => /^(1|true|yes|on)$/i.test((process.env.CREW_CODES_LIVE || '').trim());

const emailHash = (email) => createHash('sha256').update(email).digest('hex');

/** Every code this email has ever been issued, oldest first (survives refunds and deletion, by hash). */
function issuedTo(email) {
  const hash = emailHash(email);
  return Object.entries(issued)
    .filter(([, value]) => value.hash === hash)
    .map(([code, value]) => ({ code: codeKey(code), ...value }))
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
/* Loaded list: codes the loyalty teammate has confirmed exist in Squarespace.
 * Sources (union): XP Sheet tab "Loaded" column A (one code per row, header in row 1),
 * and env CREW_CODES_LOADED (comma-separated). A code is only ever issued if it is listed. */
let loadedSheet = new Set();
export function setLoadedSheet(codes) {
  loadedSheet = new Set((codes || []).map(codeKey).filter(Boolean));
  fillPending();
}
function loadedCodes() {
  const out = new Set(loadedSheet);
  for (const code of (process.env.CREW_CODES_LOADED || '').split(/[\s,]+/)) {
    const clean = codeKey(code);
    if (clean) out.add(clean);
  }
  return out;
}
function freeLoaded(crewId) {
  const loaded = loadedCodes();
  return (codeTable()[crewId]?.codes || [])
    .map(codeKey)
    .filter((value) => value && !issued[value] && loaded.has(value));
}

/* Fans who reached a crew while its loaded pool was empty. { email: { crew, from, skipped, xp, at } } */
const pendingPath = () => path.join(dataDir, 'crew-codes-pending.json');
function readPending() {
  try {
    return JSON.parse(readFileSync(pendingPath(), 'utf8')) || {};
  } catch {
    return {};
  }
}
function writePending(pending) {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(pendingPath(), JSON.stringify(pending));
}
export function pendingCount() {
  return Object.keys(readPending()).length;
}

function issueCode(email, target, xp, from, skipped, rawCode) {
  const code = codeKey(rawCode);
  const at = new Date().toISOString();
  issued[code] = { hash: emailHash(email), email, crew: target.id, at };
  saveIssued();
  const row = {
    issued_at: at,
    email,
    from_crew: from,
    to_crew: target.key,
    skipped_crews: skipped.join(','),
    code,
    percent: String(target.merchPercent),
    trigger_event_id: `app:crew:${emailHash(email).slice(0, 12)}:${target.key}`,
    xp_total_at_issue: String(xp),
    status: 'issued',
    channel: 'app',
  };
  const columns = config.issuedColumns || Object.keys(row);
  queueRow(columns.map((column) => row[column] ?? ''));
}

function crewIndexOf(id) {
  return config.crews.findIndex((crew) => crew.id === id);
}

/** Fill queued fans from newly loaded codes (called when the Loaded list changes and on reads). */
export function fillPending() {
  if (!config) return 0;
  const pending = readPending();
  let filled = 0;
  for (const [email, wait] of Object.entries(pending)) {
    const target = config.crews[crewIndexOf(wait.crew)];
    const mine = issuedTo(email);
    if (!target || mine.some((item) => crewIndexOf(item.crew) >= crewIndexOf(wait.crew))) {
      delete pending[email];
      continue;
    }
    const code = freeLoaded(target.id)[0];
    if (!code) continue;
    issueCode(email, target, wait.xp, wait.from, wait.skipped || [], code);
    delete pending[email];
    filled += 1;
  }
  writePending(pending);
  if (filled) console.log(`Crew codes: filled ${filled} queued fan(s)`);
  return filled;
}

/**
 * Crew-up codes. One single-use code per fan for the highest crew reached (skipped crews are
 * logged); a crew already issued to this email is never issued again (refunds included).
 * Only codes on the Loaded list are handed out. If that crew has no free loaded code, the fan
 * is queued and filled as soon as codes are loaded. Codes are shown only when CREW_CODES_LIVE=1.
 */
function codesFor(email, xp, level, account) {
  const crewIndex = standing(xp).crew;
  const mine = issuedTo(email);
  const highestIssued = mine.reduce((max, item) => Math.max(max, crewIndexOf(item.crew)), 0);
  let fresh = null;
  let waiting = false;
  const target = config.crews[crewIndex];
  if (target && target.merchPercent > 0 && crewIndex > highestIssued && !mine.some((item) => item.crew === target.id)) {
    const base = Math.max(highestIssued, account.lastCrewSeen ?? 0);
    const from = config.crews[base]?.key || 'FRESHER';
    const skipped = config.crews.slice(base + 1, crewIndex).map((crew) => crew.key);
    const pending = readPending();
    const code = freeLoaded(target.id)[0];
    if (code) {
      issueCode(email, target, xp, pending[email]?.from || from, skipped, code);
      fresh = code;
      if (pending[email]) {
        delete pending[email];
        writePending(pending);
      }
    } else {
      waiting = true;
      if (pending[email]?.crew !== target.id) {
        // Highest crew only: a later, higher crew replaces the queued one.
        pending[email] = { crew: target.id, from: pending[email]?.from || from, skipped, xp, at: new Date().toISOString() };
        writePending(pending);
      }
    }
  }
  const live = codesLive();
  const list = issuedTo(email).map((item) => {
    const crew = config.crews.find((entry) => entry.id === item.crew);
    return { crew: item.crew, name: crew?.name, percent: crew?.merchPercent ?? 0, code: live ? item.code : null, status: live ? 'ready' : 'soon', issuedAt: item.at };
  });
  const pendingItem = waiting ? { crew: target.id, name: target.name, percent: target.merchPercent, code: null, status: 'soon' } : null;
  return { codes: pendingItem ? [...list, pendingItem] : list, changed: Boolean(fresh), fresh };
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
  const pending = readPending();
  if (pending[email]) {
    delete pending[email];
    writePending(pending);
  }
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


const AVATAR_BASES = new Set(['male', 'female']);

/** Returns 'male' or 'female', or null if the value is missing/invalid. */
export function validAvatarBase(value) {
  const next = String(value || '').trim().toLowerCase();
  return AVATAR_BASES.has(next) ? next : null;
}

/** Stored per email; missing or invalid values read as the default, 'male'. Used by GET /api/crew. */
export function avatarBaseOf(account) {
  return validAvatarBase(account?.avatarBase) || 'male';
}

/** Valid stored value, or null if missing/invalid. Does not default to male. */
export function storedAvatarBase(account) {
  return validAvatarBase(account?.avatarBase);
}

/**
 * Explicit pick only, for GET /api/crew/avatar-base.
 * A value is explicit if it was set via PUT (avatarBaseSet) or is 'female'
 * (female was never written as a creation default). Existing 'male' rows
 * without avatarBaseSet cannot be distinguished from the default written on
 * account creation, so they read as null.
 */
export function explicitAvatarBase(account) {
  const value = storedAvatarBase(account);
  if (!value) return null;
  if (account?.avatarBaseSet === true || value === 'female') return value;
  return null;
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
    payload: { xp, level, crew, fit: account.fit, avatarBase: avatarBaseOf(account), owned, codes, badges, levelUp, crewUp },
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
