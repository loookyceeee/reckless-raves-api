// Scheduled pushes: DATA_DIR/push-schedule.json { items: [...] }
// The admin page creates rows. A tick on boot, then every 60s, sends each due row once.
// The row is saved as "sending" before the send, so a restart cannot send it again.
// A row that is more than 6 hours late is saved as "missed" and is not sent.
import { randomBytes } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const TICK_MS = 60 * 1000;
export const MISSED_AFTER_MS = 6 * 60 * 60 * 1000;
export const AUDIENCES = [
  { id: 'all', label: 'ALL PHONES' },
  { id: 'drops', label: 'DROPS' },
  { id: 'events', label: 'EVENTS' },
  { id: 'crew', label: 'CREW' },
];

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^(\d{2}):(\d{2})(?::\d{2})?$/;
const KEPT_DONE = 50;

export function validAudience(value) {
  return AUDIENCES.some((item) => item.id === value);
}

function pad(value) {
  return String(value).padStart(2, '0');
}

/** London wall-clock parts for a UTC instant. Hour is 00-23. */
export function londonParts(ms) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(ms));
  const get = (type) => parts.find((part) => part.type === type)?.value || '';
  let hour = get('hour');
  if (hour === '24') hour = '00';
  return { year: get('year'), month: get('month'), day: get('day'), hour, minute: get('minute'), second: get('second') };
}

function londonOffset(utcMs) {
  const parts = londonParts(utcMs);
  const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
  return Math.round((asUtc - utcMs) / 60000) * 60000;
}

function londonKey(ms) {
  const parts = londonParts(ms);
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

/**
 * Interprets a civil date and time as Europe/London.
 * Returns { at: ISO, london: 'YYYY-MM-DDTHH:mm' } or { error, message }.
 * A clock change that skips the minute is rejected. A repeated minute uses the earlier instant.
 */
export function londonWallToInstant(date, time) {
  const dm = DATE_RE.exec(String(date || '').trim());
  const tm = TIME_RE.exec(String(time || '').trim());
  if (!dm || !tm) return { error: 'WHEN', message: 'ENTER A DATE AND TIME' };
  const year = Number(dm[1]);
  const month = Number(dm[2]);
  const day = Number(dm[3]);
  const hour = Number(tm[1]);
  const minute = Number(tm[2]);
  if (month < 1 || month > 12 || hour > 23 || minute > 59) return { error: 'WHEN', message: 'ENTER A DATE AND TIME' };
  const calendar = new Date(Date.UTC(year, month - 1, day));
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day) {
    return { error: 'WHEN', message: 'ENTER A DATE AND TIME' };
  }
  const want = `${dm[1]}-${dm[2]}-${dm[3]}T${pad(hour)}:${pad(minute)}`;
  const wallAsUtc = Date.UTC(year, month - 1, day, hour, minute, 0);
  const found = new Set();
  const consider = (instant) => {
    if (londonKey(instant) === want) found.add(instant);
  };
  for (const guess of [wallAsUtc - 3600000, wallAsUtc, wallAsUtc + 3600000]) consider(wallAsUtc - londonOffset(guess));
  let cursor = wallAsUtc;
  for (let i = 0; i < 4; i += 1) cursor = wallAsUtc - londonOffset(cursor);
  consider(cursor);
  if (!found.size) return { error: 'WHEN', message: 'THAT TIME DOES NOT EXIST IN THE UK' };
  const atMs = [...found].sort((a, b) => a - b)[0];
  return { at: new Date(atMs).toISOString(), london: want };
}

function view(item) {
  return {
    id: item.id,
    title: item.title,
    body: item.body,
    path: item.path || null,
    audience: item.audience,
    at: item.at,
    london: item.london,
    status: item.status,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    sentAt: item.sentAt || null,
    count: item.count ?? null,
    sent: item.sent ?? null,
    dryRun: typeof item.dryRun === 'boolean' ? item.dryRun : null,
    errors: Array.isArray(item.errors) ? item.errors.slice(0, 20) : [],
    error: item.error || null,
  };
}

/**
 * @param {{ dataDir: string, sendPush: Function, targetTokens: Function, pushLive: Function, now?: () => number }} deps
 */
export function createPushSchedule(deps) {
  const { dataDir, sendPush, targetTokens, pushLive } = deps;
  const now = deps.now || (() => Date.now());
  const file = path.join(dataDir, 'push-schedule.json');
  const historyPath = path.join(dataDir, 'push-history.jsonl');
  let ticking = false;

  function load() {
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch (error) {
      if (error && error.code === 'ENOENT') return [];
      throw error;
    }
    const raw = JSON.parse(text);
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.items)) return [];
    return raw.items.filter((item) => item && typeof item.id === 'string');
  }

  function save(items) {
    const pending = [];
    const done = [];
    for (const item of items) {
      if (item.status === 'pending' || item.status === 'sending') pending.push(item);
      else done.push(item);
    }
    done.sort((a, b) => Date.parse(b.updatedAt || 0) - Date.parse(a.updatedAt || 0));
    const kept = pending.concat(done.slice(0, KEPT_DONE));
    mkdirSync(dataDir, { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ items: kept }));
    renameSync(tmp, file);
  }

  function list() {
    return load()
      .map(view)
      .sort((a, b) => {
        const rank = (status) => (status === 'pending' || status === 'sending' ? 0 : 1);
        const ra = rank(a.status);
        const rb = rank(b.status);
        if (ra !== rb) return ra - rb;
        if (ra === 0) return Date.parse(a.at) - Date.parse(b.at);
        return Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
      });
  }

  function create(fields) {
    const items = load();
    const stamp = new Date(now()).toISOString();
    const item = {
      id: randomBytes(9).toString('base64url'),
      title: fields.title,
      body: fields.body,
      path: fields.path || null,
      audience: fields.audience,
      at: fields.at,
      london: fields.london,
      status: 'pending',
      createdAt: stamp,
      updatedAt: stamp,
      sentAt: null,
      count: null,
      sent: null,
      dryRun: null,
      errors: [],
      error: null,
    };
    items.push(item);
    save(items);
    return view(item);
  }

  function update(id, fields) {
    const items = load();
    const item = items.find((row) => row.id === id);
    if (!item) return { error: 'NOT_FOUND' };
    if (item.status !== 'pending') return { error: 'NOT_PENDING' };
    item.title = fields.title;
    item.body = fields.body;
    item.path = fields.path || null;
    item.audience = fields.audience;
    item.at = fields.at;
    item.london = fields.london;
    item.updatedAt = new Date(now()).toISOString();
    save(items);
    return { item: view(item) };
  }

  function cancel(id) {
    const items = load();
    const item = items.find((row) => row.id === id);
    if (!item) return { error: 'NOT_FOUND' };
    if (item.status !== 'pending') return { error: 'NOT_PENDING' };
    item.status = 'cancelled';
    item.updatedAt = new Date(now()).toISOString();
    save(items);
    return { item: view(item) };
  }

  function recordHistory(item, result, errors) {
    const row = {
      at: new Date(now()).toISOString(),
      kind: 'schedule',
      target: item.audience,
      title: item.title,
      body: item.body,
      path: item.path,
      count: result.count,
      sent: result.sent,
      dryRun: result.dryRun,
      live: Boolean(pushLive()),
      errors,
      scheduleId: item.id,
    };
    try {
      mkdirSync(dataDir, { recursive: true });
      appendFileSync(historyPath, `${JSON.stringify(row)}\n`);
    } catch (error) {
      console.error('push schedule history failed', error instanceof Error ? error.message : error);
    }
  }

  function writeBack(item) {
    const latest = load();
    save(latest.map((row) => (row.id === item.id ? item : row)));
  }

  async function deliver(item) {
    const target = item.audience === 'all' ? { all: true } : { topic: item.audience };
    const tokens = targetTokens(target);
    const data = { type: 'admin' };
    if (item.path) data.path = item.path;
    // Same rule as the admin SEND NOW path: fans are reached only when PUSH_LIVE is on.
    const result = await sendPush(tokens, { title: item.title, body: item.body, data }, { dryRun: !pushLive() });
    const errors = (result.errors || []).map((error) => error.error || error.status || 'ERROR').slice(0, 20);
    recordHistory(item, result, errors);
    const noDevices = result.count === 0;
    const allFailed = !result.dryRun && result.count > 0 && result.sent === 0;
    item.status = noDevices || allFailed ? 'failed' : 'sent';
    item.error = noDevices ? 'NO_DEVICES' : allFailed ? 'SEND' : null;
    item.sentAt = new Date(now()).toISOString();
    item.count = result.count;
    item.sent = result.sent;
    item.dryRun = result.dryRun;
    item.errors = errors;
    console.log(`Scheduled push (${item.audience}): ${result.dryRun ? 'dry run' : 'sent'} ${result.sent}/${result.count}`);
  }

  async function tick() {
    if (ticking) return;
    ticking = true;
    try {
      const nowMs = now();
      let items;
      try {
        items = load();
      } catch (error) {
        console.error('push schedule read failed', error instanceof Error ? error.message : error);
        return;
      }
      const due = [];
      let changed = false;
      for (const item of items) {
        if (item.status === 'sending') {
          item.status = 'failed';
          item.error = 'INTERRUPTED';
          item.updatedAt = new Date(nowMs).toISOString();
          changed = true;
          console.log('Scheduled push interrupted');
          continue;
        }
        if (item.status !== 'pending') continue;
        const atMs = Date.parse(item.at);
        if (!Number.isFinite(atMs) || atMs > nowMs) continue;
        if (nowMs - atMs > MISSED_AFTER_MS) {
          item.status = 'missed';
          item.error = 'LATE';
          item.updatedAt = new Date(nowMs).toISOString();
          changed = true;
          console.log(`Scheduled push missed (${item.audience})`);
          continue;
        }
        item.status = 'sending';
        item.updatedAt = new Date(nowMs).toISOString();
        due.push(item);
        changed = true;
      }
      if (changed) save(items);
      due.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
      for (const item of due) {
        try {
          await deliver(item);
        } catch (error) {
          item.status = 'failed';
          item.error = 'SEND';
          console.error('Scheduled push failed', error instanceof Error ? error.message : error);
        }
        item.updatedAt = new Date(now()).toISOString();
        try {
          writeBack(item);
        } catch (error) {
          console.error('push schedule write failed', error instanceof Error ? error.message : error);
        }
      }
    } finally {
      ticking = false;
    }
  }

  function start() {
    const run = () => {
      void tick().catch((error) => console.error('push schedule tick', error instanceof Error ? error.message : error));
    };
    run();
    const timer = setInterval(run, TICK_MS);
    timer.unref?.();
    return timer;
  }

  return { list, create, update, cancel, tick, start, file };
}
