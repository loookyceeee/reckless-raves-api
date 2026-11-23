// Temporary per-event group chats.
//
// A chat opens 7 days before the event start and is hard-deleted 24 hours after the event.
// The close is the content end time when the event has one (and it is not before the start),
// otherwise the start. Only crew with a VERIFIED Skiddle ticket for that event can read or post.
// Both SOCIAL_LIVE and EVENT_CHAT_LIVE (default off) have to be on.
//
// Messages live in DATA_DIR/chats/events/<eventId>.json. A sweeper unlinks expired files on boot,
// on a timer, and before each chat request. Moderation (mutes, bans, blocks) is DATA_DIR/chats/moderation.json.
// Emails stay in those files and never go out on a public response.
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { repDisplayName } from './reps.mjs';

export const CHAT_OPEN_BEFORE_MS = 7 * 24 * 60 * 60 * 1000;
export const CHAT_CLOSE_AFTER_MS = 24 * 60 * 60 * 1000;
export const CHAT_TEXT_MAX = 500;
export const CHAT_PAGE = 200;
const POSTS_PER_MIN = 10;
const ATTEMPTS_PER_MIN = 30;
const READS_PER_MIN = 300;
const SWEEP_MS = 5 * 60 * 1000;
const EVENT_ID_RE = /^[a-z0-9_-]{1,64}$/i;
const FILE_RE = /^[a-z0-9_-]{1,64}\.json$/i;
const USER_ID_RE = /^[0-9a-f]{16}$/;
const MESSAGE_ID_RE = /^[A-Za-z0-9_-]{8,40}$/;

export const eventChatLive = () => /^(1|true|yes|on)$/i.test(String(process.env.EVENT_CHAT_LIVE || '').trim());
const socialFlag = () => /^(1|true|yes|on)$/i.test(String(process.env.SOCIAL_LIVE || '').trim());

/* ---------- window ---------- */

/**
 * { opensAt, closesAt, opensMs, closesMs } or null when the event has no start.
 * Close basis is the end time when the content has a parseable end at or after the start,
 * otherwise the start. The chat then stays up for 24 hours past that.
 */
export function chatWindow(event) {
  const start = Date.parse(event?.startDate || '');
  if (!Number.isFinite(start)) return null;
  let end = Date.parse(event?.endDate || '');
  if (!Number.isFinite(end) || end < start) end = start;
  const opensMs = start - CHAT_OPEN_BEFORE_MS;
  const closesMs = end + CHAT_CLOSE_AFTER_MS;
  return {
    opensAt: new Date(opensMs).toISOString(),
    closesAt: new Date(closesMs).toISOString(),
    opensMs,
    closesMs,
  };
}

/** Crew handle when they have one, otherwise first name + last initial, otherwise CREW. */
export function chatDisplayName(member) {
  const handle = String(member?.handle || '').trim();
  if (handle) return handle;
  const personal = repDisplayName(member?.personalName || '');
  return personal || 'CREW';
}

export function chatUserId(email) {
  return createHash('sha256').update(String(email || '').trim().toLowerCase()).digest('hex').slice(0, 16);
}

/* ---------- language filter ---------- */

function stripMarks(value) {
  return String(value || '').normalize('NFKD').replace(/\p{M}/gu, '');
}
function foldLeet(value) {
  return stripMarks(value)
    .toLowerCase()
    .replace(/[\u200b-\u200d\ufeff]/g, '')
    .replace(/0/g, 'o')
    .replace(/1/g, 'i')
    .replace(/3/g, 'e')
    .replace(/4/g, 'a')
    .replace(/5/g, 's')
    .replace(/7/g, 't')
    .replace(/@/g, 'a')
    .replace(/\$/g, 's')
    .replace(/!/g, 'i');
}
/** "n.i.g.g.e.r" / "n i g g e r" -> "nigger". Leaves ordinary words alone. */
function collapseSplitLetters(folded) {
  let cur = folded;
  const re = /([a-z])[^a-z\n]+(?=[a-z](?:[^a-z\n]|$))/g;
  for (let i = 0; i < 40; i += 1) {
    const next = cur.replace(re, '$1');
    if (next === cur) break;
    cur = next;
  }
  return cur;
}
function wordsOf(text) {
  const folded = foldLeet(text);
  const collapsed = collapseSplitLetters(folded);
  const words = new Set();
  for (const src of [folded, collapsed]) {
    for (const word of src.split(/[^a-z]+/)) if (word) words.add(word);
  }
  return words;
}
function isHardSlur(word) {
  if (word.startsWith('snigg') || word.startsWith('niggl') || word.startsWith('nigeri')) return false;
  if (['fag', 'fags', 'dyke', 'dykes', 'spaz', 'spazz', 'paki', 'pakis', 'chink', 'chinks', 'kike', 'kikes', 'fenian', 'fenians', 'wog', 'wogs', 'gook', 'gooks', 'coon', 'coons', 'taig', 'taigs', 'hun', 'huns', 'kkk', 'rape', 'rapes', 'raped', 'raping'].includes(word)) return true;
  if (word.startsWith('nigg') || (word.startsWith('niga') && !word.startsWith('nigell'))) return true;
  if (word.startsWith('faggot') || word.startsWith('fagg') || word.startsWith('tranny') || word.startsWith('trannie')) return true;
  if (word.startsWith('retard') || word.startsWith('spastic')) return true;
  if (word.startsWith('hitler') || word.startsWith('nazi') || word.startsWith('rapist')) return true;
  if (/^pedo(s|phile|philes|philia)?$/.test(word) || /^paedo(s|phile|philes|philia)?$/.test(word)) return true;
  return false;
}
/** True when `rest` is empty or a short slang ending, so "dictionary" and "cocktail" stay. */
function slangRest(rest) {
  return /^(?:s|es|ed|ing|er|ers|y|head|face|bag|hole|wit)?$/.test(rest);
}
function stemMask(word, stem) {
  return word.startsWith(stem) && slangRest(word.slice(stem.length));
}
function shouldMask(word) {
  if (['ass', 'asses', 'arse', 'tit', 'tits', 'cum', 'hoe', 'hoes', 'nob', 'crap', 'craps', 'damn', 'damned', 'damnit', 'dammit', 'bloody'].includes(word)) return true;
  if (word.includes('fuck') || word === 'fuk' || word === 'fck' || word === 'fukc') return true;
  if (word.includes('shit') && word !== 'shitake') return true;
  if (word.includes('bitch') || word.includes('slut') || word.includes('whore') || word.includes('wank') || word.includes('twat')) return true;
  if (stemMask(word, 'cunt') || stemMask(word, 'dick') || stemMask(word, 'cock') || stemMask(word, 'piss')) return true;
  if (stemMask(word, 'bollock') || stemMask(word, 'pussy') || stemMask(word, 'bastard')) return true;
  if (stemMask(word, 'arsehole') || stemMask(word, 'asshole') || stemMask(word, 'bellend') || stemMask(word, 'jizz')) return true;
  if (/^knob(?:s|head|end)?$/.test(word)) return true;
  if (/^tit(?:s|ties|ty)?$/.test(word)) return true;
  if (/^cum(?:s|ming|med)?$/.test(word)) return true;
  if (word.startsWith('crapp')) return true;
  return false;
}
function hasHardSlur(text) {
  for (const word of wordsOf(text)) if (isHardSlur(word)) return true;
  return false;
}

const ALLOWED_HOST = /(^|\.)skiddle\.com$|(^|\.)recklessraves\.co\.uk$/;
function linkHost(token) {
  let raw = String(token || '').replace(/[),.;!?]+$/g, '').replace(/^hxxp/i, 'http');
  if (!raw) return '';
  if (!/^https?:\/\//i.test(raw)) raw = `http://${raw}`;
  try {
    return new URL(raw).hostname.toLowerCase().replace(/\.$/, '').replace(/^www\./, '');
  } catch {
    return '';
  }
}
function allowedLink(token) {
  const host = linkHost(token);
  return Boolean(host) && ALLOWED_HOST.test(host);
}
function stripLinks(text) {
  const re = /\b(?:(?:https?:\/\/|hxxps?:\/\/|www\.)[^\s<>"']+|(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s<>"']*)?)/gi;
  return text.replace(re, (token) => (allowedLink(token) ? token.replace(/[),.;!?]+$/g, '') : ''));
}
function maskProfanity(text) {
  const starred = text.replace(/([A-Za-z0-9@$])\*+(?=[A-Za-z0-9@$])/g, '$1');
  const masked = starred.replace(/[A-Za-z0-9@$!]+/g, (token) => (shouldMask(foldLeet(token)) ? '*'.repeat([...token].length) : token));
  return masked.replace(/\b(?:[A-Za-z0-9@$!][^A-Za-z0-9@$!\n]+){2,}[A-Za-z0-9@$!]\b/g, (span) => {
    const joined = foldLeet(span).replace(/[^a-z]/g, '');
    if (!joined || isHardSlur(joined)) return span;
    return shouldMask(joined) ? '*'.repeat([...span].length) : span;
  });
}

/**
 * { ok: true, text, filtered } or { ok: false, error }.
 * Hard slurs are refused. Other profanity is masked. Links are removed unless the host is
 * skiddle.com or recklessraves.co.uk (subdomains included). No images.
 */
export function filterChatText(raw) {
  if (typeof raw !== 'string') return { ok: false, error: 'TEXT' };
  let text = stripMarks(raw).replace(/\r\n/g, '\n').replace(/[\u0000-\u0008\u000B-\u000C\u000E-\u001F\u007F]/g, '');
  text = text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/[ \t]{2,}/g, ' ').trim();
  if (!text) return { ok: false, error: 'TEXT' };
  if ([...text].length > CHAT_TEXT_MAX) return { ok: false, error: 'TEXT_TOO_LONG' };
  if (/data:\s*image\//i.test(text) || /<\s*img\b/i.test(text) || /!\[[^\]]*\]\([^)]*\)/.test(text)) return { ok: false, error: 'NO_IMAGES' };
  if (hasHardSlur(text)) return { ok: false, error: 'SLUR' };
  let out = stripLinks(maskProfanity(text));
  out = out.replace(/[ \t]{2,}/g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n[ \t]+/g, '\n').trim();
  if (!out) return { ok: false, error: 'TEXT' };
  if (hasHardSlur(out)) return { ok: false, error: 'SLUR' };
  return { ok: true, text: out, filtered: out !== text };
}

/* ---------- store ---------- */

function writeAtomic(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value));
  renameSync(tmp, file);
}
function blankChat(eventId) {
  return { eventId, opensAt: null, closesAt: null, skiddleId: null, title: '', closed: false, messages: [], reports: [] };
}
function blankMod() {
  return { mutes: {}, bans: {}, blocks: {}, users: {} };
}
function asChat(raw, eventId) {
  if (!raw || typeof raw !== 'object') return null;
  const messages = Array.isArray(raw.messages) ? raw.messages.filter((row) => row && typeof row.id === 'string' && typeof row.email === 'string' && typeof row.text === 'string' && typeof row.createdAt === 'string') : [];
  const reports = Array.isArray(raw.reports) ? raw.reports.filter((row) => row && typeof row.id === 'string' && typeof row.messageId === 'string') : [];
  return {
    eventId,
    opensAt: typeof raw.opensAt === 'string' ? raw.opensAt : null,
    closesAt: typeof raw.closesAt === 'string' ? raw.closesAt : null,
    skiddleId: raw.skiddleId ? String(raw.skiddleId) : null,
    title: String(raw.title || '').slice(0, 120),
    closed: raw.closed === true,
    messages,
    reports,
  };
}

/**
 * deps: { dataDir, readSession, normalizeEmail, validEmail, rateLimited, sendJson,
 *   contentEventById, contentEvents, chatMember, hasVerifiedTicket }
 */
export function createEventChat(deps) {
  const { dataDir, readSession, normalizeEmail, validEmail, rateLimited, sendJson, contentEventById, contentEvents, chatMember, hasVerifiedTicket } = deps;
  const root = path.join(dataDir, 'chats');
  const eventsDir = path.join(root, 'events');
  const modPath = path.join(root, 'moderation.json');
  const now = () => Date.now();
  const flagsOn = () => socialFlag() && eventChatLive();

  function readMod() {
    try {
      const raw = JSON.parse(readFileSync(modPath, 'utf8'));
      if (!raw || typeof raw !== 'object') return blankMod();
      return {
        mutes: raw.mutes && typeof raw.mutes === 'object' ? raw.mutes : {},
        bans: raw.bans && typeof raw.bans === 'object' ? raw.bans : {},
        blocks: raw.blocks && typeof raw.blocks === 'object' ? raw.blocks : {},
        users: raw.users && typeof raw.users === 'object' ? raw.users : {},
      };
    } catch {
      return blankMod();
    }
  }
  const saveMod = (mod) => writeAtomic(modPath, mod);
  function eventPath(eventId) {
    return path.join(eventsDir, `${eventId}.json`);
  }
  function eventFiles() {
    try {
      return readdirSync(eventsDir).filter((name) => FILE_RE.test(name));
    } catch {
      return [];
    }
  }
  function load(eventId) {
    try {
      return asChat(JSON.parse(readFileSync(eventPath(eventId), 'utf8')), eventId);
    } catch {
      return null;
    }
  }
  function save(row) {
    writeAtomic(eventPath(row.eventId), row);
  }
  function findEvent(eventId) {
    const want = String(eventId || '').toLowerCase();
    const exact = contentEventById(want) || (want !== eventId ? contentEventById(eventId) : null);
    if (exact) return exact;
    for (const brief of contentEvents() || []) {
      if (String(brief?.id || '').toLowerCase() !== want) continue;
      return contentEventById(brief.id) || null;
    }
    return null;
  }
  function indexUsers(row) {
    const mod = readMod();
    let changed = false;
    for (const message of row?.messages || []) {
      const id = chatUserId(message.email);
      if (mod.users[id] !== message.email) {
        mod.users[id] = message.email;
        changed = true;
      }
    }
    if (changed) saveMod(mod);
  }
  function remember(event) {
    if (!flagsOn() || !event?.id) return null;
    const window = chatWindow(event);
    if (!window || window.closesMs <= now()) return null;
    const eventId = String(event.id).toLowerCase();
    const row = load(eventId) || blankChat(eventId);
    const skiddleId = event.skiddleId ? String(event.skiddleId) : row.skiddleId;
    const title = String(event.title || row.title || '').slice(0, 120);
    if (row.opensAt === window.opensAt && row.closesAt === window.closesAt && row.skiddleId === skiddleId && row.title === title) return row;
    row.opensAt = window.opensAt;
    row.closesAt = window.closesAt;
    row.skiddleId = skiddleId;
    row.title = title;
    save(row);
    return row;
  }

  /** Unlink chat files whose close time has passed. Refreshes windows from content while the flags are on. */
  function sweep() {
    if (flagsOn()) {
      for (const brief of contentEvents() || []) {
        const event = brief?.id ? findEvent(brief.id) : null;
        if (event) remember(event);
      }
    }
    let removed = 0;
    for (const name of eventFiles()) {
      const eventId = name.slice(0, -'.json'.length).toLowerCase();
      const event = findEvent(eventId);
      const live = event ? chatWindow(event) : null;
      const row = live ? null : load(eventId);
      const closesMs = live ? live.closesMs : Date.parse(row?.closesAt || '');
      if (!Number.isFinite(closesMs) || closesMs > now()) continue;
      try {
        unlinkSync(eventPath(eventId));
        removed += 1;
      } catch {
        // already gone
      }
    }
    if (removed) console.log(`Event chat sweeper removed ${removed} expired chat${removed === 1 ? '' : 's'}`);
    return removed;
  }
  const timer = setInterval(() => {
    try {
      sweep();
    } catch (error) {
      console.error('event chat sweep failed', error instanceof Error ? error.message : error);
    }
  }, SWEEP_MS);
  timer.unref?.();

  function room(eventId) {
    const event = findEvent(eventId);
    if (event && flagsOn()) remember(event);
    const id = String(event?.id || eventId).toLowerCase();
    const row = load(id);
    const live = event ? chatWindow(event) : null;
    let window = live;
    if (!window && row?.opensAt && row?.closesAt) {
      const opensMs = Date.parse(row.opensAt);
      const closesMs = Date.parse(row.closesAt);
      if (Number.isFinite(opensMs) && Number.isFinite(closesMs)) window = { opensAt: row.opensAt, closesAt: row.closesAt, opensMs, closesMs };
    }
    if (!window) return null;
    return {
      eventId: id,
      window,
      skiddleId: event?.skiddleId ? String(event.skiddleId) : row?.skiddleId || null,
      adminClosed: Boolean(row?.closed),
      row,
    };
  }
  function access(email, info) {
    const at = now();
    let status = 'open';
    let reason = null;
    if (!info || info.adminClosed || at >= info.window.closesMs) {
      status = 'closed';
      reason = 'CLOSED';
    } else if (at < info.window.opensMs) {
      status = 'upcoming';
      reason = 'NOT_OPEN';
    } else if (readMod().bans[email]) {
      reason = 'BANNED';
    } else if (!info.skiddleId || !hasVerifiedTicket(email, info.skiddleId)) {
      reason = 'NOT_VERIFIED';
    } else if (readMod().mutes[email]) {
      reason = 'MUTED';
    }
    const canRead = reason === null || reason === 'MUTED';
    const canPost = reason === null;
    return {
      status,
      opensAt: info?.window.opensAt || null,
      closesAt: info?.window.closesAt || null,
      canJoin: canRead && canPost,
      canRead,
      canPost,
      reason,
      closed: Boolean(info?.adminClosed),
    };
  }
  function present(message, viewer) {
    const member = chatMember(message.email) || {};
    const named = member.handle || member.personalName;
    return {
      id: message.id,
      userId: chatUserId(message.email),
      name: named ? chatDisplayName(member) : message.name || 'CREW',
      crew: member.crew || message.crew || null,
      level: Number.isInteger(member.level) ? member.level : message.level ?? null,
      avatarBase: member.avatarBase ?? null,
      fit: member.fit ?? null,
      text: message.text,
      createdAt: message.createdAt,
      you: message.email === viewer,
    };
  }
  function visibleMessages(row, viewer) {
    const blocked = new Set(Object.keys(readMod().blocks[viewer] || {}));
    return (row?.messages || []).filter((message) => message.email === viewer || !blocked.has(message.email));
  }
  function pageOf(messages, after) {
    let start = 0;
    if (after) {
      const idx = messages.findIndex((message) => message.id === after);
      if (idx >= 0) start = idx + 1;
      else if (/^\d{4}-\d{2}-\d{2}T/.test(after) && Number.isFinite(Date.parse(after))) {
        const ms = Date.parse(after);
        start = messages.findIndex((message) => Date.parse(message.createdAt) > ms);
        if (start < 0) start = messages.length;
      } else return null;
    } else if (messages.length > CHAT_PAGE) start = messages.length - CHAT_PAGE;
    const slice = messages.slice(start, start + CHAT_PAGE);
    return { slice, more: start + slice.length < messages.length };
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
    const type = String(req.headers['content-type'] || '');
    if (/^multipart\//i.test(type) || /^image\//i.test(type)) return { image: true };
    const { buffer, tooBig, error } = await readRaw(req, 16 * 1024);
    if (tooBig) return { tooBig: true };
    if (error) return { error: true };
    if (!buffer.length) return { body: {} };
    try {
      const body = JSON.parse(buffer.toString('utf8'));
      if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: true };
      return { body };
    } catch {
      return { error: true };
    }
  }
  function sessionEmail(req) {
    return req.headers.authorization ? readSession(req.headers.authorization) : null;
  }
  function newId() {
    return randomBytes(9).toString('base64url');
  }

  function statusPayload(info, email) {
    const gate = access(email, info);
    return { ok: true, eventId: info.eventId, ...gate };
  }

  async function postMessage(req, res, info, email) {
    const parsed = await readJsonBody(req);
    if (parsed.image) return reply(res, 400, { ok: false, error: 'NO_IMAGES' });
    if (parsed.tooBig) return reply(res, 413, { ok: false, error: 'TOO_BIG' });
    if (parsed.error || !parsed.body) return reply(res, 400, { ok: false, error: 'BODY' });
    const body = parsed.body;
    if (body.image != null || body.photo != null || body.media != null || body.attachment != null || body.file != null) return reply(res, 400, { ok: false, error: 'NO_IMAGES' });
    if (rateLimited(`chat:attempt:${email}`, ATTEMPTS_PER_MIN, 60 * 1000)) return reply(res, 429, { ok: false, error: 'RATE' });
    const filtered = filterChatText(body.text);
    if (!filtered.ok) return reply(res, 400, { ok: false, error: filtered.error, ...(filtered.error === 'TEXT_TOO_LONG' ? { max: CHAT_TEXT_MAX } : {}) });
    if (rateLimited(`chat:post:${email}`, POSTS_PER_MIN, 60 * 1000)) return reply(res, 429, { ok: false, error: 'RATE' });
    const member = chatMember(email) || {};
    const row = load(info.eventId) || blankChat(info.eventId);
    row.opensAt = info.window.opensAt;
    row.closesAt = info.window.closesAt;
    row.skiddleId = info.skiddleId;
    const message = {
      id: newId(),
      email,
      userId: chatUserId(email),
      text: filtered.text,
      createdAt: new Date(now()).toISOString(),
      name: chatDisplayName(member),
      crew: member.crew || null,
      level: Number.isInteger(member.level) ? member.level : null,
      avatarBase: member.avatarBase ?? null,
      fit: member.fit ?? null,
    };
    row.messages.push(message);
    save(row);
    indexUsers(row);
    return reply(res, 200, { ok: true, filtered: filtered.filtered, message: present(message, email) });
  }

  async function api(req, res, eventId, sub) {
    const info = room(eventId);
    if (!info) {
      req.resume();
      return reply(res, 404, { ok: false, error: 'EVENT' });
    }
    const email = sessionEmail(req);
    const gate = access(email, info);

    if (sub === '' && req.method === 'GET') {
      req.resume();
      return reply(res, 200, statusPayload(info, email));
    }
    if (sub === 'messages' && req.method === 'GET') {
      req.resume();
      if (!gate.canRead) return reply(res, 403, { ok: false, error: gate.reason });
      const url = new URL(req.url || '/', 'http://localhost');
      const after = String(url.searchParams.get('after') || '');
      const row = load(info.eventId);
      const page = pageOf(visibleMessages(row, email), after);
      if (!page) return reply(res, 400, { ok: false, error: 'AFTER' });
      return reply(res, 200, { ok: true, eventId: info.eventId, messages: page.slice.map((message) => present(message, email)), more: page.more });
    }
    if (sub === 'messages' && req.method === 'POST') {
      if (!gate.canPost) {
        req.resume();
        return reply(res, 403, { ok: false, error: gate.reason });
      }
      return postMessage(req, res, info, email);
    }
    const reportMatch = sub.match(/^messages\/([A-Za-z0-9_-]{8,40})\/report$/);
    if (reportMatch && req.method === 'POST') {
      if (!gate.canRead) {
        req.resume();
        return reply(res, 403, { ok: false, error: gate.reason });
      }
      const parsed = await readJsonBody(req);
      if (parsed.image) return reply(res, 400, { ok: false, error: 'NO_IMAGES' });
      if (parsed.tooBig) return reply(res, 413, { ok: false, error: 'TOO_BIG' });
      if (parsed.error || !parsed.body) return reply(res, 400, { ok: false, error: 'BODY' });
      let reason = '';
      if (parsed.body.reason != null && parsed.body.reason !== '') {
        if (typeof parsed.body.reason !== 'string') return reply(res, 400, { ok: false, error: 'REASON' });
        reason = parsed.body.reason.replace(/[\u0000-\u001F\u007F]/g, '').trim().slice(0, 200);
      }
      const messageId = reportMatch[1];
      if (!MESSAGE_ID_RE.test(messageId)) return reply(res, 400, { ok: false, error: 'MESSAGE' });
      const row = load(info.eventId);
      const message = visibleMessages(row, email).find((item) => item.id === messageId);
      if (!message) return reply(res, 404, { ok: false, error: 'NOT_FOUND' });
      if (message.email === email) return reply(res, 400, { ok: false, error: 'OWN' });
      const existing = (row.reports || []).find((item) => item.messageId === messageId && item.reporter === email);
      if (existing) return reply(res, 200, { ok: true, reported: true, already: true });
      row.reports.push({
        id: newId(),
        messageId,
        at: new Date(now()).toISOString(),
        reason,
        reporter: email,
        author: message.email,
        authorName: message.name || chatDisplayName(chatMember(message.email)),
        text: message.text,
        deleted: false,
      });
      save(row);
      return reply(res, 200, { ok: true, reported: true });
    }
    if ((sub === 'block' || sub === 'unblock') && req.method === 'POST') {
      // A muted member can still block. Anyone who cannot read the room cannot.
      if (gate.reason && gate.reason !== 'MUTED') {
        req.resume();
        return reply(res, 403, { ok: false, error: gate.reason });
      }
      const parsed = await readJsonBody(req);
      if (parsed.tooBig) return reply(res, 413, { ok: false, error: 'TOO_BIG' });
      if (parsed.error || !parsed.body) return reply(res, 400, { ok: false, error: 'BODY' });
      const userId = String(parsed.body.userId || '').trim().toLowerCase();
      if (!USER_ID_RE.test(userId)) return reply(res, 400, { ok: false, error: 'USER' });
      if (userId === chatUserId(email)) return reply(res, 400, { ok: false, error: 'SELF' });
      const mod = readMod();
      const target = mod.users[userId];
      if (!target) return reply(res, 404, { ok: false, error: 'USER' });
      if (!mod.blocks[email]) mod.blocks[email] = {};
      if (sub === 'block') mod.blocks[email][target] = new Date(now()).toISOString();
      else delete mod.blocks[email][target];
      if (mod.blocks[email] && !Object.keys(mod.blocks[email]).length) delete mod.blocks[email];
      saveMod(mod);
      return reply(res, 200, { ok: true, blocked: sub === 'block', userId });
    }
    req.resume();
    return reply(res, 405, { ok: false, error: 'METHOD' });
  }

  function handle(req, res, url) {
    const match = url.pathname.match(/^\/api\/events\/([^/]+)\/chat(?:\/(.*))?$/);
    if (!match) return false;
    const eventKey = match[1];
    const sub = match[2] || '';
    const run = async () => {
      try {
        sweep();
      } catch (error) {
        console.error('event chat sweep failed', error instanceof Error ? error.message : error);
      }
      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }
      if (!socialFlag()) {
        req.resume();
        return reply(res, 403, { ok: false, error: 'SOCIAL_OFF' });
      }
      if (!eventChatLive()) {
        req.resume();
        return reply(res, 403, { ok: false, error: 'CHAT_OFF' });
      }
      if (!EVENT_ID_RE.test(eventKey)) {
        req.resume();
        return reply(res, 400, { ok: false, error: 'EVENT' });
      }
      const email = sessionEmail(req);
      if (!email) {
        req.resume();
        return reply(res, 401, { ok: false, error: 'SESSION' });
      }
      if (rateLimited(`chat:read:${email}`, READS_PER_MIN, 60 * 1000)) {
        req.resume();
        return reply(res, 429, { ok: false, error: 'RATE' });
      }
      await api(req, res, eventKey.toLowerCase(), sub);
    };
    run().catch((error) => {
      console.error('event chat request failed', error instanceof Error ? error.message : error);
      if (!res.headersSent) reply(res, 500, { ok: false, error: 'SERVER' });
    });
    return true;
  }

  /* ---------- account deletion ---------- */

  function forget(email) {
    const key = normalizeEmail(email);
    if (!key) return;
    let removed = 0;
    for (const name of eventFiles()) {
      const eventId = name.slice(0, -'.json'.length).toLowerCase();
      const row = load(eventId);
      if (!row) continue;
      const before = row.messages.length;
      row.messages = row.messages.filter((message) => message.email !== key);
      removed += before - row.messages.length;
      for (const report of row.reports) {
        if (report.author === key && !row.messages.some((message) => message.id === report.messageId)) report.deleted = true;
      }
      if (before !== row.messages.length) save(row);
    }
    const mod = readMod();
    let changed = false;
    if (mod.blocks[key]) {
      delete mod.blocks[key];
      changed = true;
    }
    for (const [id, owner] of Object.entries(mod.users)) {
      if (owner === key) {
        delete mod.users[id];
        changed = true;
      }
    }
    if (changed) saveMod(mod);
    return removed;
  }

  /* ---------- admin ---------- */

  function memberLine(email) {
    const mod = readMod();
    return {
      muted: Boolean(mod.mutes[email]),
      banned: Boolean(mod.bans[email]),
      mutedAt: mod.mutes[email]?.at || null,
      bannedAt: mod.bans[email]?.at || null,
    };
  }
  function eventAdminRow(eventId) {
    const event = findEvent(eventId);
    const row = load(eventId);
    const live = event ? chatWindow(event) : null;
    const window = live || (row?.opensAt ? { opensAt: row.opensAt, closesAt: row.closesAt, opensMs: Date.parse(row.opensAt), closesMs: Date.parse(row.closesAt) } : null);
    const at = now();
    let status = 'closed';
    if (window && row?.closed) status = 'closed';
    else if (window && at < window.opensMs) status = 'upcoming';
    else if (window && at < window.closesMs) status = 'open';
    return {
      id: eventId,
      title: event?.title || row?.title || eventId,
      status,
      opensAt: window?.opensAt || null,
      closesAt: window?.closesAt || null,
      closed: Boolean(row?.closed),
      messages: row?.messages?.length || 0,
      reports: (row?.reports || []).filter((item) => !item.deleted).length,
    };
  }
  function adminSummary() {
    try {
      sweep();
    } catch {
      // the page still loads
    }
    const seen = new Set();
    const events = [];
    for (const brief of contentEvents() || []) {
      if (!brief?.id) continue;
      const id = String(brief.id).toLowerCase();
      if (seen.has(id)) continue;
      seen.add(id);
      events.push(eventAdminRow(id));
    }
    for (const name of eventFiles()) {
      const id = name.slice(0, -'.json'.length).toLowerCase();
      if (seen.has(id)) continue;
      seen.add(id);
      events.push(eventAdminRow(id));
    }
    const reports = [];
    for (const name of eventFiles()) {
      const id = name.slice(0, -'.json'.length).toLowerCase();
      const row = load(id);
      for (const report of row?.reports || []) {
        const mod = memberLine(report.author);
        reports.push({
          id: report.id,
          eventId: id,
          title: row.title || id,
          messageId: report.messageId,
          text: report.text || '',
          at: report.at,
          reason: report.reason || '',
          reporter: report.reporter,
          author: report.author,
          authorName: report.authorName || '',
          authorMuted: mod.muted,
          authorBanned: mod.banned,
          deleted: Boolean(report.deleted) || !(row.messages || []).some((message) => message.id === report.messageId),
        });
      }
    }
    reports.sort((a, b) => String(b.at).localeCompare(String(a.at)));
    const mod = readMod();
    const people = (table) => Object.entries(table).map(([email, entry]) => ({ email, at: entry?.at || null, ...memberLine(email), name: chatDisplayName(chatMember(email)) }));
    return {
      live: flagsOn(),
      socialLive: socialFlag(),
      chatLive: eventChatLive(),
      events,
      reports: reports.slice(0, 100),
      mutes: people(mod.mutes),
      bans: people(mod.bans),
    };
  }
  function requireEmail(body) {
    const email = normalizeEmail(body?.email);
    if (!email || !validEmail(email)) return { error: { status: 400, body: { ok: false, error: 'EMAIL', message: 'ENTER A VALID EMAIL' } } };
    return { email };
  }
  function adminDelete(body) {
    const eventId = String(body?.eventId || '').toLowerCase();
    const messageId = String(body?.messageId || '');
    if (!EVENT_ID_RE.test(eventId) || !MESSAGE_ID_RE.test(messageId)) return { status: 400, body: { ok: false, error: 'MESSAGE', message: 'UNKNOWN MESSAGE' } };
    const row = load(eventId);
    const message = row?.messages?.find((item) => item.id === messageId);
    if (!row || !message) return { status: 404, body: { ok: false, error: 'NOT_FOUND', message: 'THAT MESSAGE IS ALREADY GONE' } };
    row.messages = row.messages.filter((item) => item.id !== messageId);
    for (const report of row.reports) if (report.messageId === messageId) report.deleted = true;
    save(row);
    return { status: 200, body: { ok: true, deleted: true }, audit: { eventId, messageId } };
  }
  function setMod(kind, email, on) {
    const mod = readMod();
    const table = kind === 'ban' ? mod.bans : mod.mutes;
    if (on) table[email] = { at: new Date(now()).toISOString() };
    else delete table[email];
    saveMod(mod);
    return { status: 200, body: { ok: true, email, [kind === 'ban' ? 'banned' : 'muted']: on }, audit: { email } };
  }
  function adminClose(body) {
    const eventId = String(body?.eventId || '').toLowerCase();
    if (!EVENT_ID_RE.test(eventId)) return { status: 400, body: { ok: false, error: 'EVENT', message: 'UNKNOWN EVENT' } };
    const event = findEvent(eventId);
    const existing = load(eventId);
    const live = event ? chatWindow(event) : null;
    const closesMs = live?.closesMs ?? Date.parse(existing?.closesAt || '');
    if (!live && !existing) return { status: 404, body: { ok: false, error: 'EVENT', message: 'UNKNOWN EVENT' } };
    if (Number.isFinite(closesMs) && closesMs <= now()) return { status: 409, body: { ok: false, error: 'CLOSED', message: 'THAT CHAT HAS ALREADY ENDED' } };
    const row = existing || blankChat(event?.id?.toLowerCase?.() || eventId);
    if (live) {
      row.opensAt = live.opensAt;
      row.closesAt = live.closesAt;
      row.skiddleId = event?.skiddleId ? String(event.skiddleId) : row.skiddleId;
      row.title = String(event?.title || row.title || '').slice(0, 120);
    }
    row.closed = body?.closed !== false;
    save(row);
    return { status: 200, body: { ok: true, eventId: row.eventId, closed: row.closed }, audit: { eventId: row.eventId, closed: row.closed } };
  }
  function adminAction(action, body) {
    if (action === 'delete') return adminDelete(body);
    if (action === 'mute' || action === 'unmute' || action === 'ban' || action === 'unban') {
      const checked = requireEmail(body);
      if (checked.error) return checked.error;
      const ban = action === 'ban' || action === 'unban';
      return setMod(ban ? 'ban' : 'mute', checked.email, action === 'mute' || action === 'ban');
    }
    if (action === 'close') return adminClose(body);
    return null;
  }

  return { handle, sweep, forget, adminSummary, adminAction, adminMember: memberLine };
}
