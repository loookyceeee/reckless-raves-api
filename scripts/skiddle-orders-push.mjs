#!/usr/bin/env node
// Pushes Skiddle ticket orders to the API so GOING lists can show the VERIFIED tick.
//
// Source: the Skiddle Promotion Centre order exports (Customers/Orders -> View Orders -> Export)
// that RECKLESS CREW LOYALTY already keeps in its toolkit (data/skiddle/*.csv, data/skiddle_new/*.csv).
// Skiddle has no promoter order API or webhook, so those CSVs are the only order source.
//
// Only what VERIFIED needs leaves the box: order id, sha256(lowercase email), ticket count, event
// name and start time. No names, phones, addresses or plain emails are sent.
//
//   node scripts/skiddle-orders-push.mjs --dry-run              # counts only, sends nothing
//   node scripts/skiddle-orders-push.mjs                         # push to the live API
//   node scripts/skiddle-orders-push.mjs --api http://127.0.0.1:8080 --csv-dir DIR [--csv-dir DIR2]
//   --since-days N   only events that start from N days ago on (default 2; past events never need VERIFIED)
//
// Admin key: OAUTH_ADMIN_KEY env, else the file ~/.secrets/render/OAUTH_ADMIN_KEY. It is never printed.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const LOYALTY = '/home/box/agent-data/agents/5d227997-49e6-4cad-9c9d-90a3ef1162bc/xp-ingest/data';
const DEAD = /cancel|refund|void|revoked/i;

function args(argv) {
  const out = { csvDirs: [], api: 'https://reckless-raves-api-30is.onrender.com', dryRun: false, sinceDays: 2 };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--csv-dir') out.csvDirs.push(argv[++i]);
    else if (a === '--api') out.api = String(argv[++i]).replace(/\/$/, '');
    else if (a === '--since-days') out.sinceDays = Number(argv[++i]);
    else if (a === '--help' || a === '-h') {
      console.log(readFileSync(new URL(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n'));
      process.exit(0);
    } else throw new Error(`unknown argument ${a}`);
  }
  if (!out.csvDirs.length) out.csvDirs = [path.join(LOYALTY, 'skiddle'), path.join(LOYALTY, 'skiddle_new')];
  return out;
}

/** RFC 4180-ish CSV parser (quoted fields, "" escapes, CRLF). */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const src = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 1;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  const [head, ...body] = rows.filter((r) => r.length > 1 || r[0]);
  return (body || []).map((r) => Object.fromEntries((head || []).map((key, idx) => [key.trim(), (r[idx] ?? '').trim()])));
}

/** Rows (one per ticket) -> orders: { orderId, emailSha256, qty, eventName, eventStart }. */
export function ordersFromRows(rows) {
  const orders = new Map();
  let dead = 0;
  let noEmail = 0;
  for (const r of rows) {
    const orderId = String(r['Skiddle order ID'] || '').trim();
    const email = String(r['Customer email'] || '').trim().toLowerCase();
    if (!orderId || !email.includes('@')) {
      noEmail += 1;
      continue;
    }
    if (DEAD.test(String(r.Status || ''))) {
      dead += 1;
      continue;
    }
    const order = orders.get(orderId) || { orderId, emailSha256: createHash('sha256').update(email).digest('hex'), qty: 0, eventName: r['Event name'] || '', eventStart: r['Event start date'] || '' };
    order.qty += 1;
    orders.set(orderId, order);
  }
  return { orders: [...orders.values()], dead, noEmail };
}

function adminKey() {
  if (process.env.OAUTH_ADMIN_KEY) return process.env.OAUTH_ADMIN_KEY.trim();
  const file = path.join(os.homedir(), '.secrets/render/OAUTH_ADMIN_KEY');
  return existsSync(file) ? readFileSync(file, 'utf8').trim() : '';
}

async function main() {
  const opt = args(process.argv.slice(2));
  const files = [];
  for (const dir of opt.csvDirs) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir).sort()) if (name.toLowerCase().endsWith('.csv')) files.push(path.join(dir, name));
  }
  const byOrder = new Map();
  let dead = 0;
  let noEmail = 0;
  for (const file of files) {
    const parsed = ordersFromRows(parseCsv(readFileSync(file, 'utf8')));
    dead += parsed.dead;
    noEmail += parsed.noEmail;
    // Same order in an older and a newer export: the later file (sorted name, then dir order) wins.
    for (const order of parsed.orders) byOrder.set(order.orderId, order);
  }
  const since = Date.now() - opt.sinceDays * 24 * 60 * 60 * 1000;
  const orders = [...byOrder.values()].filter((order) => !Number.isFinite(Date.parse(order.eventStart)) || Date.parse(order.eventStart) >= since);
  const events = new Map();
  for (const order of orders) {
    const key = `${order.eventName}|${order.eventStart}`;
    const e = events.get(key) || { name: order.eventName, start: order.eventStart, orders: 0, tickets: 0 };
    e.orders += 1;
    e.tickets += order.qty;
    events.set(key, e);
  }
  const summary = { files: files.length, ordersInFiles: byOrder.size, ordersSent: orders.length, cancelledRows: dead, rowsWithoutEmail: noEmail, events: [...events.values()] };
  if (opt.dryRun) {
    console.log(JSON.stringify({ status: 'dry_run', api: opt.api, ...summary }, null, 1));
    return;
  }
  const key = adminKey();
  if (!key) throw new Error('No admin key: set OAUTH_ADMIN_KEY or ~/.secrets/render/OAUTH_ADMIN_KEY');
  const response = await fetch(`${opt.api}/api/social/skiddle-orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Admin-Key': key },
    body: JSON.stringify({ source: 'skiddle-export', orders }),
    signal: AbortSignal.timeout(60000),
  });
  const result = await response.json().catch(() => ({ ok: false, error: `HTTP ${response.status}` }));
  console.log(JSON.stringify({ status: result.ok ? 'ok' : 'error', http: response.status, ...summary, result }, null, 1));
  if (!result.ok) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(JSON.stringify({ status: 'error', error: error instanceof Error ? error.message : String(error) }));
    process.exit(1);
  });
}
