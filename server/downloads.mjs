// iOS App Store downloads for the admin STATS card, from the App Store Connect
// Sales and Trends API (GET /v1/salesReports, SALES / SUMMARY / DAILY).
// Env: ASC_KEY_P8 (base64 of the .p8), ASC_KEY_ID, ASC_ISSUER_ID, ASC_VENDOR_NUMBER,
//      optional ASC_APP_ID (default 6834422153), ASC_SALES_FROM (first report day, default 2026-11-20).
// Daily totals are cached in DATA_DIR/asc-downloads.json and refreshed every 6 hours.
// Apple publishes each day's report about a day late, so "yesterday" may still be missing.
import { createPrivateKey, createSign } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';

const REFRESH_MS = 6 * 60 * 60 * 1000;
const MAX_DAYS = 120;
// Product Type Identifiers: first-time downloads vs updates vs re-downloads.
const FIRST = new Set(['1', '1F', '1T', 'F1', '1E', '1EP', '1EU']);
const UPDATES = new Set(['7', '7F', '7T', 'F7']);
const REDOWNLOADS = new Set(['3', '3F', '3T', 'F3']);

let dataDir = '';
let cache = { days: {}, checkedAt: null, error: null };
let running = null;

const cachePath = () => path.join(dataDir, 'asc-downloads.json');
const env = (key) => (process.env[key] || '').trim();

function config() {
  const p8 = env('ASC_KEY_P8');
  const keyId = env('ASC_KEY_ID');
  const issuer = env('ASC_ISSUER_ID');
  const vendor = env('ASC_VENDOR_NUMBER');
  return { p8, keyId, issuer, vendor, appId: env('ASC_APP_ID') || '6834422153', from: env('ASC_SALES_FROM') || '2026-11-20' };
}

function missing(cfg) {
  if (!cfg.p8 || !cfg.keyId || !cfg.issuer) return 'NO_KEY';
  if (!cfg.vendor) return 'NO_VENDOR';
  return null;
}

function jwt(cfg) {
  const pem = cfg.p8.includes('BEGIN') ? cfg.p8 : Buffer.from(cfg.p8, 'base64').toString('utf8');
  const key = createPrivateKey(pem);
  const now = Math.floor(Date.now() / 1000);
  const enc = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const head = enc({ alg: 'ES256', kid: cfg.keyId, typ: 'JWT' });
  const body = enc({ iss: cfg.issuer, iat: now, exp: now + 1100, aud: 'appstoreconnect-v1' });
  const sig = createSign('SHA256').update(`${head}.${body}`).sign({ key, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  return `${head}.${body}.${sig}`;
}

function dayKey(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

export function parseSalesReport(tsv, appId) {
  const rows = tsv.split('\n').filter(Boolean).map((line) => line.split('\t'));
  if (!rows.length) return { downloads: 0, updates: 0, redownloads: 0 };
  const head = rows[0].map((name) => name.trim());
  const col = (name) => head.indexOf(name);
  const typeCol = col('Product Type Identifier');
  const unitsCol = col('Units');
  const appCol = col('Apple Identifier');
  const out = { downloads: 0, updates: 0, redownloads: 0 };
  for (const row of rows.slice(1)) {
    if (appCol >= 0 && appId && String(row[appCol]).trim() !== appId) continue;
    const type = String(row[typeCol] || '').trim();
    const units = Number(row[unitsCol]) || 0;
    if (FIRST.has(type)) out.downloads += units;
    else if (UPDATES.has(type)) out.updates += units;
    else if (REDOWNLOADS.has(type)) out.redownloads += units;
  }
  return out;
}

async function fetchDay(cfg, token, date) {
  const params = new URLSearchParams({
    'filter[frequency]': 'DAILY',
    'filter[reportType]': 'SALES',
    'filter[reportSubType]': 'SUMMARY',
    'filter[vendorNumber]': cfg.vendor,
    'filter[reportDate]': date,
    'filter[version]': '1_0',
  });
  const response = await fetch(`https://api.appstoreconnect.apple.com/v1/salesReports?${params}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/a-gzip' },
  });
  if (response.status === 404) return { status: 'none' };
  if (response.status === 401) return { status: 'error', error: 'UNAUTHORIZED' };
  if (response.status === 403) return { status: 'error', error: 'FORBIDDEN_NEEDS_SALES_ROLE' };
  if (!response.ok) return { status: 'error', error: `HTTP_${response.status}` };
  const buffer = Buffer.from(await response.arrayBuffer());
  let text;
  try {
    text = gunzipSync(buffer).toString('utf8');
  } catch {
    text = buffer.toString('utf8');
  }
  return { status: 'ok', ...parseSalesReport(text, cfg.appId) };
}

async function refresh() {
  const cfg = config();
  const why = missing(cfg);
  if (why) {
    cache.error = why;
    return;
  }
  let token;
  try {
    token = jwt(cfg);
  } catch {
    cache.error = 'BAD_KEY';
    return;
  }
  const today = dayKey(Date.now());
  let ms = Date.parse(`${cfg.from}T00:00:00Z`);
  const start = Math.max(ms, Date.now() - MAX_DAYS * 86400000);
  ms = Date.parse(`${dayKey(start)}T00:00:00Z`);
  let error = null;
  for (; dayKey(ms) < today; ms += 86400000) {
    const date = dayKey(ms);
    if (cache.days[date]?.status === 'ok') continue;
    // A day still without a report after a week had no units; stop asking for it.
    if (cache.days[date]?.status === 'none' && date < dayKey(Date.now() - 7 * 86400000)) continue;
    try {
      const result = await fetchDay(cfg, token, date);
      if (result.status === 'error') {
        error = result.error;
        break;
      }
      // 'none' = no report yet (or no units that day); kept so the total is honest.
      cache.days[date] = result.status === 'ok' ? { status: 'ok', downloads: result.downloads, updates: result.updates, redownloads: result.redownloads } : { status: 'none' };
    } catch {
      error = 'FETCH';
      break;
    }
  }
  cache.error = error;
  cache.checkedAt = new Date().toISOString();
  try {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(cachePath(), JSON.stringify(cache));
  } catch {
    // cache is optional
  }
}

export function refreshDownloads() {
  if (!dataDir) return Promise.resolve();
  if (!running) running = refresh().catch(() => { cache.error = 'FETCH'; }).finally(() => { running = null; });
  return running;
}

export function initDownloads(dir) {
  dataDir = dir;
  try {
    const raw = JSON.parse(readFileSync(cachePath(), 'utf8'));
    if (raw && typeof raw.days === 'object') cache = { days: raw.days, checkedAt: raw.checkedAt || null, error: raw.error || null };
  } catch {
    // first run
  }
  setTimeout(() => void refreshDownloads(), 15 * 1000).unref?.();
  setInterval(() => void refreshDownloads(), REFRESH_MS).unref?.();
}

/** Totals for the STATS card. Never includes key material. */
export function downloadsSummary() {
  const cfg = config();
  const why = missing(cfg);
  const ok = Object.entries(cache.days).filter(([, day]) => day.status === 'ok');
  const sum = (list, field) => list.reduce((total, [, day]) => total + (day[field] || 0), 0);
  const yesterday = dayKey(Date.now() - 86400000);
  const weekFrom = dayKey(Date.now() - 7 * 86400000);
  const last7 = ok.filter(([date]) => date >= weekFrom);
  const latest = ok.map(([date]) => date).sort().pop() || null;
  return {
    configured: !why,
    error: why || cache.error,
    total: sum(ok, 'downloads'),
    last7: sum(last7, 'downloads'),
    yesterday: cache.days[yesterday]?.status === 'ok' ? cache.days[yesterday].downloads : null,
    updatesTotal: sum(ok, 'updates'),
    redownloadsTotal: sum(ok, 'redownloads'),
    latestReportDay: latest,
    checkedAt: cache.checkedAt,
    since: cfg.from,
  };
}
