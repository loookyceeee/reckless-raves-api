// Crew loyalty server logic for /api/crew: ladder + wardrobe from crew-config.json
// (one swappable table shared by the app, game and toolkit), owned pieces,
// per-fan discount codes, server-driven crew-up / level-up popups and badges.
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
  const file = path.join(dataDir, 'crew-owned.json');
  try {
    if (existsSync(file)) map = { ...map, ...JSON.parse(readFileSync(file, 'utf8')) };
  } catch {
    console.error('crew-owned.json unreadable');
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
  const ids = new Set(config.wardrobe.map((piece) => piece.id));
  return (ownedCache.map[email] || []).filter((id) => ids.has(id));
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

/**
 * Code table: { "<crewId>": { "codes": ["CREW-CAS5-7KQ2", ...], "shared": false } }.
 * Each email gets its own single-use code from the pool (recorded in
 * crew-codes-issued.json, never handed out twice). Empty pool = "coming soon".
 */
function codesFor(email, level, account) {
  const table = codeTable();
  account.codes = account.codes && typeof account.codes === 'object' ? account.codes : {};
  let changed = false;
  const out = [];
  config.crews.forEach((crew, index) => {
    if (!crew.merchPercent || level < crewEntryLevel(index)) return;
    let code = account.codes[crew.id] || null;
    if (!code) {
      const tier = table[crew.id];
      const pool = Array.isArray(tier?.codes) ? tier.codes.map((value) => String(value).trim()).filter(Boolean) : [];
      if (pool.length && tier.shared) code = pool[0];
      else {
        const free = pool.find((value) => !issued[value]);
        if (free) {
          code = free;
          issued[free] = { email, crew: crew.id, at: new Date().toISOString() };
          saveIssued();
        }
      }
      if (code) {
        account.codes[crew.id] = code;
        changed = true;
      }
    }
    out.push({ crew: crew.id, name: crew.name, percent: crew.merchPercent, level: crewEntryLevel(index), code, status: code ? 'ready' : 'soon' });
  });
  return { codes: out, changed };
}

export function forgetCodes(email) {
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
  account.fit = validFit(account.fit, xp, owned);
  let changed = touchDay1(account);
  if (typeof account.lastLevelSeen !== 'number') {
    // First sign-in: everything above level 1 counts as new, so the popup shows once.
    account.lastLevelSeen = 1;
    account.lastCrewSeen = 0;
    changed = true;
  }
  const { codes, changed: codesChanged } = codesFor(email, level, account);
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
          code: codes.find((item) => item.crew === config.crews[crew]?.id) || null,
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
