// Live app content: records (SoundCloud RSS), events (Squarespace events page
// + Skiddle event pages + Drive posters) and products (Squarespace JSON).
// Refreshed every 20 minutes; each section keeps its last good copy if a
// source fails, and the last good payload survives restarts on the disk.
import { existsSync, mkdirSync, readFileSync, writeFileSync, createReadStream, statSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let sharpLib = null;
function sharp() {
  if (!sharpLib) sharpLib = require('sharp');
  return sharpLib;
}

const REFRESH_MS = 20 * 60 * 1000;
const UA = 'Mozilla/5.0 (compatible; RecklessRavesApp/1.0; +https://www.recklessraves.co.uk)';
const RSS_URL = 'https://feeds.soundcloud.com/users/soundcloud:users:1468076891/sounds.rss';
const EVENTS_PAGE = 'https://www.recklessraves.co.uk/events';
const SHOP_JSON = 'https://www.recklessraves.co.uk/clothing?format=json';
const SITE = 'https://www.recklessraves.co.uk';
const POSTER_FOLDER = process.env.POSTER_FOLDER_ID || '1f4e51jJxfd3zm3fMXsSKWH14E_Xk_Lc2';
const POSTER_W = 1080;
const POSTER_H = 1440;
const POSTER_VERSION = 'v1';

// Curated copy for events already in the app, so titles and full lineups stay
// as the team wrote them. New events use the Skiddle listing as-is.
const OVERRIDES = {
  '42589796': { id: 'warehouse-xl', title: 'THE WARE-HOUSE XL', subtitle: 'HALLOWEEN SPECIAL', venue: 'The Temple', lineup: ['Madmize', 'Mortis', 'BNGHM', 'CRØ'] },
  '42803971': { id: 'temple-008', title: 'GEARBOX X RECKLESS', subtitle: 'THE TEMPLE 008', venue: 'The Temple', lineup: ['Anoluxx', 'Azdat', 'Detailed', 'Exproz', 'Fraw', 'Luna Lunekova', 'Frazz b2b Brenno', 'Montz'] },
  '42853722': { id: 'temple-009', title: 'THE TEMPLE 009', subtitle: 'BOXING DAY SPECIAL', venue: 'The Temple', lineup: ['Toza', 'Voidrage', 'Khayto', 'Umbra', 'Clrk', 'Ethan Mitchell', 'Headstorm'] },
};

// Key dates that map to poster folder names.
const DATE_ALIASES = {
  '12-31': ['NYE', 'NEW YEAR', 'NEW YEARS'],
  '12-26': ['BOXING DAY'],
  '10-31': ['HALLOWEEN'],
  '12-24': ['CHRISTMAS EVE'],
  '12-25': ['CHRISTMAS'],
};

let dataDir = '';
let posterDir = '';
let state = { updatedAt: null, records: [], events: [], products: [], status: {} };
let posters = {}; // key -> { source, kind }
let probes = {}; // drive file id -> { width, height }
let refreshing = null;

function statePath() { return path.join(dataDir, 'content.json'); }
function metaPath() { return path.join(dataDir, 'content-meta.json'); }

function persist() {
  try {
    writeFileSync(statePath(), JSON.stringify(state));
    writeFileSync(metaPath(), JSON.stringify({ posters, probes }));
  } catch (error) {
    console.error('Content persist failed', error instanceof Error ? error.message : error);
  }
}

async function get(url, { as = 'text', timeout = 20000 } = {}) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: '*/*' }, redirect: 'follow', signal: AbortSignal.timeout(timeout) });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  if (as === 'json') return res.json();
  if (as === 'buffer') return Buffer.from(await res.arrayBuffer());
  return res.text();
}

function decode(value) {
  return String(value || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .trim();
}

function tag(xml, name) {
  const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`));
  return m ? decode(m[1]) : '';
}

function attr(xml, name, attribute) {
  const m = xml.match(new RegExp(`<${name}\\s[^>]*${attribute}="([^"]*)"`));
  return m ? decode(m[1]) : '';
}

function clock(hms) {
  const parts = String(hms || '').split(':').map((p) => Number(p) || 0);
  while (parts.length < 3) parts.unshift(0);
  const total = parts[0] * 3600 + parts[1] * 60 + parts[2];
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

// ---------- Records ----------
export function parseRecords(xml) {
  const out = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const item = m[1];
    const raw = tag(item, 'title').replace(/\s+/g, ' ');
    const link = tag(item, 'link');
    const stream = attr(item, 'enclosure', 'url');
    const guid = tag(item, 'guid');
    const author = tag(item, 'itunes:author');
    const id = (guid.match(/tracks\/(\d+)/) || [])[1];
    if (!id || !stream || !/^https:\/\/soundcloud\.com\//.test(link)) continue;
    if (/\/sets\//.test(link)) continue; // playlists are not tracks
    if (/exile/i.test(`${raw} ${link} ${author}`)) continue; // Exile Trax never on Records
    const split = raw.indexOf(' - ');
    if (split < 1) continue; // label posts and promos without "ARTIST - TITLE"
    const artist = raw.slice(0, split).trim();
    const title = raw.slice(split + 3).trim();
    if (!title || /^double r records$/i.test(raw)) continue;
    const art = attr(item, 'itunes:image', 'href').replace(/-t\d+x\d+\./, '-t500x500.');
    out.push({ id, title, artist, label: 'Double R Records', duration: clock(tag(item, 'itunes:duration')), url: link, stream, artwork: art || null });
  }
  return out;
}

async function loadRecords() {
  return parseRecords(await get(RSS_URL));
}

// ---------- Drive posters ----------
async function listFolder(id) {
  const html = await get(`https://drive.google.com/embeddedfolderview?id=${id}`);
  const entries = [];
  for (const m of html.matchAll(/<div class="flip-entry" id="entry-([A-Za-z0-9_-]+)"[\s\S]*?<div class="flip-entry-title">([^<]*)<\/div>/g)) {
    const entryId = m[1];
    const name = decode(m[2]);
    const block = m[0];
    const folder = block.includes('/drive/folders/') || /folder/i.test((block.match(/flip-entry-list-icon[\s\S]*?<img src="([^"]*)"/) || [])[1] || '');
    entries.push({ id: entryId, name, folder });
  }
  return entries;
}

function norm(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
}

function folderMatches(folderName, event) {
  const name = norm(folderName);
  if (!name || name.length < 3 || /LOGO/.test(name)) return 0;
  const hay = ` ${norm(`${event.rawName} ${event.title} ${event.subtitle}`)} `;
  if (hay.includes(` ${name} `)) return 2;
  const md = event.startDate.slice(5, 10);
  const aliases = DATE_ALIASES[md] || [];
  if (aliases.some((alias) => norm(alias) === name || name.includes(norm(alias)))) return 1;
  return 0;
}

async function probeDrive(fileId) {
  if (probes[fileId]) return probes[fileId];
  const buf = await get(`https://drive.google.com/uc?export=download&id=${fileId}`, { as: 'buffer', timeout: 60000 });
  const meta = await sharp()(buf).rotate().metadata();
  let { width, height } = meta;
  if (meta.orientation && meta.orientation >= 5) [width, height] = [height, width];
  probes[fileId] = { width, height };
  await renderPoster(`drive-${fileId}`, buf, 'cover');
  return probes[fileId];
}

function isPosterSize({ width, height }) {
  if (!width || !height || height <= width) return false;
  const ratio = width / height;
  return ratio >= 0.72 && ratio <= 0.78 && width >= 900;
}

async function drivePosterFor(event, folders) {
  const ranked = folders
    .map((f) => ({ f, score: folderMatches(f.name, event) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
  for (const { f } of ranked) {
    let files = [];
    try { files = await listFolder(f.id); } catch { continue; }
    const candidates = files
      .filter((x) => !x.folder && /\.(jpe?g|png|webp)$/i.test(x.name))
      .filter((x) => /POSTER|ARTWORK/i.test(x.name) && !/STORY|COVER/i.test(x.name))
      .sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }));
    for (const file of candidates) {
      try {
        const size = await probeDrive(file.id);
        if (isPosterSize(size)) return { key: `drive-${file.id}`, folder: f.name, file: file.name, size };
      } catch (error) {
        console.error('Poster probe failed', file.name, error instanceof Error ? error.message : error);
      }
    }
  }
  return null;
}

function posterFile(key) {
  return path.join(posterDir, `${key}-${POSTER_VERSION}.jpg`);
}

async function renderPoster(key, buffer, mode) {
  const out = posterFile(key);
  if (existsSync(out)) return out;
  let img = sharp()(buffer).rotate();
  if (mode === 'cover') {
    img = img.resize(POSTER_W, POSTER_H, { fit: 'cover', position: 'centre', withoutEnlargement: false });
  } else {
    img = img.resize(POSTER_W, POSTER_H, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 1 } });
  }
  const jpg = await img.flatten({ background: '#000000' }).jpeg({ quality: 88, mozjpeg: true, chromaSubsampling: '4:4:4' }).toBuffer();
  writeFileSync(out, jpg);
  return out;
}

async function skiddlePoster(image, skiddleId) {
  if (!image) return null;
  const key = `skiddle-${skiddleId}`;
  if (existsSync(posterFile(key))) return key;
  const big = image.replace(/_\d+\.(jpe?g|png)$/i, '_orig.$1');
  let buf = null;
  for (const url of [big, image]) {
    try { buf = await get(url, { as: 'buffer' }); break; } catch { /* try next */ }
  }
  if (!buf) return null;
  await renderPoster(key, buf, 'contain');
  posters[key] = { source: big, kind: 'skiddle' };
  return key;
}

// ---------- Events ----------
function londonParts(iso) {
  const d = new Date(iso);
  const fmt = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', day: '2-digit', month: '2-digit', weekday: 'long' });
  const parts = Object.fromEntries(fmt.formatToParts(d).map((p) => [p.type, p.value]));
  return { badge: `${parts.day}.${parts.month}`, weekday: parts.weekday };
}

function splitName(name) {
  const clean = String(name || '').replace(/\s+/g, ' ').trim();
  const colon = clean.indexOf(':');
  const prefix = colon >= 0 ? clean.slice(0, colon).trim() : '';
  const rest = colon >= 0 ? clean.slice(colon + 1).trim() : clean;
  const bracket = (rest.match(/\[([^\]]+)\]/) || [])[1] || '';
  const main = rest.replace(/\[[^\]]*\]/g, '').trim();
  const collab = prefix && !/^reckless raves$/i.test(prefix) ? prefix : '';
  return {
    title: (collab ? collab.replace(/reckless raves/i, 'RECKLESS') : main).toUpperCase(),
    subtitle: (collab ? [main, bracket].filter(Boolean).join(' ') : bracket).toUpperCase(),
  };
}

function titleCase(value) {
  const v = String(value || '').trim();
  if (v !== v.toUpperCase()) return v;
  return v.toLowerCase().replace(/\b([a-z])/g, (c) => c.toUpperCase());
}

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-GB,en;q=0.9',
};

async function skiddleEvent(id) {
  const res = await fetch(`https://www.skiddle.com/e/${id}`, { headers: BROWSER_HEADERS, redirect: 'follow', signal: AbortSignal.timeout(20000) });
  const html = await res.text();
  if (!res.ok || !html.includes('ld+json')) {
    const title = (html.match(/<title>([^<]*)<\/title>/i) || [])[1] || '';
    console.error('Skiddle page', id, res.status, res.url, title.slice(0, 80), html.length);
  }
  for (const m of html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/g)) {
    let data;
    try { data = JSON.parse(m[1]); } catch { continue; }
    for (const node of Array.isArray(data) ? data : [data]) {
      if (node && /Event/.test(String(node['@type'])) && node.startDate) return node;
    }
  }
  throw new Error(`No event data for Skiddle ${id}`);
}

async function loadEvents(previous) {
  const page = await get(EVENTS_PAGE);
  const ids = [...new Set([...page.matchAll(/skiddle\.com\/(?:e\/|whats-on\/[^"'\s<>]*?\/)(\d{6,10})/g)].map((m) => m[1]))];
  if (!ids.length) throw new Error('No Skiddle links on events page');
  let folders = [];
  try { folders = (await listFolder(POSTER_FOLDER)).filter((x) => x.folder); } catch (error) {
    console.error('Poster folder list failed', error instanceof Error ? error.message : error);
  }
  const prevById = new Map((previous || []).map((e) => [e.skiddleId, e]));
  const now = Date.now();
  const out = [];
  for (const sid of ids) {
    try {
      const ld = await skiddleEvent(sid);
      const end = Date.parse(ld.endDate || ld.startDate) || 0;
      if (end && end < now) continue;
      const o = OVERRIDES[sid] || {};
      const names = splitName(ld.name);
      const when = londonParts(ld.startDate);
      const event = {
        id: o.id || `e${sid}`,
        skiddleId: sid,
        rawName: ld.name,
        startDate: ld.startDate,
        endDate: ld.endDate || null,
        dateBadge: when.badge,
        weekday: when.weekday,
        title: o.title || names.title,
        subtitle: o.subtitle ?? names.subtitle,
        venue: o.venue || titleCase(ld.location?.name || ''),
        city: ld.location?.address?.addressLocality || 'Belfast',
        lineup: o.lineup || (Array.isArray(ld.performer) ? ld.performer.map((p) => p?.name).filter(Boolean) : []),
        ticketsUrl: `https://www.skiddle.com/e/${sid}`,
        image: null,
        poster: null,
      };
      let poster = null;
      try { poster = await drivePosterFor(event, folders); } catch (error) {
        console.error('Drive poster failed', sid, error instanceof Error ? error.message : error);
      }
      if (poster) {
        posters[poster.key] = { kind: 'drive', folder: poster.folder, file: poster.file };
        event.image = `/api/poster/${poster.key}.jpg`;
        event.poster = { source: 'drive', folder: poster.folder, file: poster.file, width: POSTER_W, height: POSTER_H };
      } else {
        const key = await skiddlePoster(typeof ld.image === 'string' ? ld.image : ld.image?.[0], sid).catch(() => null);
        if (key) {
          event.image = `/api/poster/${key}.jpg`;
          event.poster = { source: 'skiddle', width: POSTER_W, height: POSTER_H };
        } else if (prevById.get(sid)?.image) {
          event.image = prevById.get(sid).image;
          event.poster = prevById.get(sid).poster;
        }
      }
      delete event.rawName;
      out.push(event);
    } catch (error) {
      console.error('Skiddle event failed', sid, error instanceof Error ? error.message : error);
      const prev = prevById.get(sid);
      if (prev && (Date.parse(prev.endDate || prev.startDate) || 0) >= now) out.push(prev);
    }
  }
  out.sort((a, b) => Date.parse(a.startDate) - Date.parse(b.startDate));
  return out;
}

// ---------- Products ----------
function money(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '';
  return Number.isInteger(n) ? `£${n}` : `£${n.toFixed(2)}`;
}

export function parseProducts(json) {
  const items = Array.isArray(json?.items) ? json.items : [];
  const out = [];
  for (const item of items) {
    const name = String(item.title || '').trim();
    if (!name || /exile/i.test(`${name} ${item.urlId}`)) continue;
    const sc = item.structuredContent || {};
    const variants = Array.isArray(item.variants) ? item.variants : Array.isArray(sc.variants) ? sc.variants : [];
    const prices = variants.map((v) => Number((v.onSale ? v.salePriceMoney?.value : v.priceMoney?.value) ?? NaN)).filter((n) => Number.isFinite(n) && n > 0);
    const soldOut = variants.length > 0 && variants.every((v) => !v.unlimited && Number(v.qtyInStock || 0) <= 0);
    const gallery = Array.isArray(item.items) ? item.items.map((x) => String(x?.assetUrl || '')).filter((u) => /^https:\/\/images\.squarespace-cdn\.com\//.test(u)) : [];
    const own = String(item.assetUrl || '');
    const asset = gallery[0] || (/\/[^/]+\.[a-z0-9]{3,4}$/i.test(own) ? own : '');
    out.push({
      id: item.urlId,
      name,
      price: prices.length ? money(Math.min(...prices)) : '',
      collection: /^RCKLS(\d+)/i.test(name) ? `Clothing Drop ${name.match(/^RCKLS(\d+)/i)[1]}` : 'Clothing',
      soldOut,
      onSale: variants.some((v) => v.onSale),
      url: `${SITE}${item.fullUrl}`,
      image: asset ? `${asset}?format=1000w` : null,
    });
  }
  return out;
}

async function loadProducts() {
  const json = await get(SHOP_JSON, { as: 'json' });
  return parseProducts(json);
}

// ---------- Orchestration ----------
async function section(name, loader) {
  try {
    const value = await loader();
    if (!Array.isArray(value) || !value.length) throw new Error('empty');
    state[name] = value;
    state.status[name] = { ok: true, at: new Date().toISOString(), count: value.length };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Content ${name} refresh failed`, message);
    state.status[name] = { ok: false, at: new Date().toISOString(), error: message.slice(0, 200), count: state[name]?.length || 0 };
  }
}

export function refreshContent() {
  if (!dataDir) return Promise.resolve();
  if (refreshing) return refreshing;
  refreshing = (async () => {
    const previousEvents = state.events;
    await Promise.all([
      section('records', loadRecords),
      section('products', loadProducts),
      section('events', () => loadEvents(previousEvents)),
    ]);
    state.updatedAt = new Date().toISOString();
    persist();
  })().finally(() => { refreshing = null; });
  return refreshing;
}

export function initContent(dir) {
  dataDir = dir;
  posterDir = path.join(dir, 'posters');
  mkdirSync(posterDir, { recursive: true });
  try { state = { ...state, ...JSON.parse(readFileSync(statePath(), 'utf8')) }; } catch { /* first run */ }
  try { ({ posters = {}, probes = {} } = JSON.parse(readFileSync(metaPath(), 'utf8'))); } catch { /* first run */ }
  void refreshContent();
  setInterval(() => { void refreshContent(); }, REFRESH_MS).unref?.();
}

export async function handleContent(req, res, sendJson) {
  if (!dataDir) throw new Error('content not initialised');
  if (!state.updatedAt) await refreshContent().catch(() => {});
  const body = { ok: true, updatedAt: state.updatedAt, refreshMinutes: REFRESH_MS / 60000, records: state.records, events: state.events, products: state.products, status: state.status };
  res.setHeader('Cache-Control', 'public, max-age=300');
  sendJson(res, 200, body);
}

export function handlePoster(req, res, url) {
  const m = url.pathname.match(/^\/api\/poster\/((?:drive|skiddle)-[A-Za-z0-9_-]+)\.jpg$/);
  const file = m ? posterFile(m[1]) : null;
  if (!file || !existsSync(file)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
    return;
  }
  const { size } = statSync(file);
  res.writeHead(200, {
    'Content-Type': 'image/jpeg',
    'Content-Length': size,
    'Cache-Control': 'public, max-age=86400, stale-while-revalidate=604800',
    'Access-Control-Allow-Origin': '*',
  });
  if (req.method === 'HEAD') { res.end(); return; }
  createReadStream(file).pipe(res);
}
