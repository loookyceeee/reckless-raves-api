// Push notifications (app 1.0.1+), sent through the Expo push service.
// Devices: DATA_DIR/push-devices.json  { "<ExpoPushToken>": { email, platform, deviceId, topics, at, seen } }
// Real sends to fans only happen when PUSH_LIVE=1. Until then every send is a dry run,
// except an admin send that names explicit `tokens` (for testing on our own devices).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const EXPO_SEND = 'https://exp.host/--/api/v2/push/send';
export const PUSH_TOPICS = ['drops', 'events', 'crew'];
const tokenPattern = /^(ExponentPushToken|ExpoPushToken)\[[A-Za-z0-9_-]{8,64}\]$/;
let dataDir = '';
let devices = {};

const devicesPath = () => path.join(dataDir, 'push-devices.json');
export const pushLive = () => /^(1|true|yes|on)$/i.test((process.env.PUSH_LIVE || '').trim());

export function initPush(dir) {
  dataDir = dir;
  try {
    devices = existsSync(devicesPath()) ? JSON.parse(readFileSync(devicesPath(), 'utf8')) || {} : {};
  } catch {
    devices = {};
  }
}

function save() {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(devicesPath(), JSON.stringify(devices));
}

export const validPushToken = (token) => typeof token === 'string' && tokenPattern.test(token);

function cleanTopics(topics) {
  if (!Array.isArray(topics)) return [...PUSH_TOPICS];
  return PUSH_TOPICS.filter((topic) => topics.includes(topic));
}

/** Registers or refreshes a device. email is the signed-in fan (from the session), or null. */
export function registerDevice({ token, email, platform, deviceId, topics }) {
  const now = new Date().toISOString();
  // One row per device: a new token for the same device replaces the old one.
  if (deviceId) {
    for (const [other, row] of Object.entries(devices)) {
      if (other !== token && row.deviceId && row.deviceId === deviceId) delete devices[other];
    }
  }
  const before = devices[token];
  devices[token] = {
    email: email || null,
    platform: platform === 'ios' || platform === 'android' ? platform : 'unknown',
    deviceId: typeof deviceId === 'string' ? deviceId.slice(0, 80) : before?.deviceId ?? null,
    topics: topics === undefined && before ? before.topics : cleanTopics(topics),
    at: before?.at || now,
    seen: now,
  };
  save();
  return devices[token];
}

export function unregisterDevice(token) {
  if (!devices[token]) return false;
  delete devices[token];
  save();
  return true;
}

export function forgetDevices(email) {
  let changed = false;
  for (const [token, row] of Object.entries(devices)) {
    if (row.email === email) {
      delete devices[token];
      changed = true;
    }
  }
  if (changed) save();
}

export function pushStatus() {
  const rows = Object.values(devices);
  return { live: pushLive(), devices: rows.length, signedIn: rows.filter((row) => row.email).length };
}

/** Device counts by platform, plus how many are signed in (admin stats). */
export function deviceStats() {
  const rows = Object.values(devices);
  const byPlatform = { ios: 0, android: 0, unknown: 0 };
  for (const row of rows) byPlatform[row.platform === 'ios' || row.platform === 'android' ? row.platform : 'unknown'] += 1;
  return { total: rows.length, signedIn: rows.filter((row) => row.email).length, ...byPlatform };
}

/** Number of registered devices for one email (admin crew lookup). */
export function devicesForEmail(email) {
  return Object.values(devices).filter((row) => row.email === email).length;
}

export function emailsWithDevices() {
  return new Set(Object.values(devices).filter((row) => row.email && row.topics?.includes('crew')).map((row) => row.email));
}

/** Picks target tokens. target: { tokens?: string[], emails?: string[], topic?: string, all?: true } */
export function targetTokens(target) {
  if (Array.isArray(target.tokens) && target.tokens.length) return target.tokens.filter(validPushToken);
  const emails = Array.isArray(target.emails) ? new Set(target.emails.map((value) => String(value).trim().toLowerCase())) : null;
  const topic = PUSH_TOPICS.includes(target.topic) ? target.topic : null;
  if (!emails && !topic && target.all !== true) return [];
  return Object.entries(devices)
    .filter(([, row]) => (!emails || emails.has(row.email)) && (!topic || row.topics?.includes(topic)))
    .map(([token]) => token);
}

/**
 * Sends one message to many tokens via Expo (100 per request).
 * dryRun: returns what would be sent and calls nothing.
 */
export async function sendPush(tokens, { title, body, data }, { dryRun = true } = {}) {
  const messages = tokens.map((to) => ({ to, title, body, data: data || {}, sound: 'default', priority: 'high' }));
  if (dryRun || !messages.length) return { dryRun: true, count: messages.length, sent: 0, errors: [] };
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
  const access = (process.env.EXPO_PUSH_ACCESS_TOKEN || '').trim();
  if (access) headers.Authorization = `Bearer ${access}`;
  let sent = 0;
  const errors = [];
  for (let i = 0; i < messages.length; i += 100) {
    const chunk = messages.slice(i, i + 100);
    try {
      const response = await fetch(EXPO_SEND, { method: 'POST', headers, body: JSON.stringify(chunk) });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        errors.push({ status: response.status, error: payload?.errors?.[0]?.code || 'EXPO' });
        continue;
      }
      (payload.data || []).forEach((ticket, index) => {
        if (ticket.status === 'ok') {
          sent += 1;
          return;
        }
        const code = ticket.details?.error || 'ERROR';
        errors.push({ token: chunk[index].to.slice(0, 22) + '…', error: code });
        if (code === 'DeviceNotRegistered') unregisterDevice(chunk[index].to);
      });
    } catch (error) {
      errors.push({ error: error instanceof Error ? error.message : 'FETCH' });
    }
  }
  return { dryRun: false, count: messages.length, sent, errors };
}

/**
 * Level-up pushes. For each signed-in fan with a device, compares the current level with
 * account.lastLevelPushed. The first check only records the level (no push for old levels).
 * Returns the number of fans queued. Sends only when PUSH_LIVE=1, otherwise logs a dry run.
 */
export async function checkLevelUps({ accounts, xpFor, standing, save }) {
  const emails = emailsWithDevices();
  if (!emails.size) return 0;
  const jobs = [];
  let changed = false;
  for (const email of emails) {
    const account = accounts[email];
    if (!account) continue;
    const { level } = standing(xpFor(email));
    if (typeof account.lastLevelPushed !== 'number') {
      account.lastLevelPushed = level;
      changed = true;
      continue;
    }
    if (level > account.lastLevelPushed) {
      jobs.push({ email, level });
      account.lastLevelPushed = level;
      changed = true;
    }
  }
  if (changed) save();
  for (const job of jobs) {
    const tokens = targetTokens({ emails: [job.email], topic: 'crew' });
    const result = await sendPush(
      tokens,
      { title: `LEVEL ${job.level} UNLOCKED`, body: 'NEW GEAR IN YOUR CREW WARDROBE. TAP TO SEE IT.', data: { type: 'level-up', level: job.level, path: '/crew' } },
      { dryRun: !pushLive() },
    );
    console.log(`Level-up push L${job.level}: ${result.dryRun ? 'dry run' : 'sent'} ${result.sent}/${result.count}`);
  }
  return jobs.length;
}
