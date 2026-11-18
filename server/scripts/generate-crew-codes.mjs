// Generates the crew-up code pool locally (Squarespace Basic has no Discounts API, so the
// codes are created by hand in the Squarespace admin from the CSV).
//
//   node server/scripts/generate-crew-codes.mjs <out-dir>
//
// Writes <out-dir>/crew-codes.json (server pool, goes to /data/crew-codes.json on Render) and
// <out-dir>/crew-codes-pool.csv (crew,percent,code). Codes: lowercase letters + digits, no hyphen,
// prefix crw<percent> + 8 random chars (crypto), e.g. crw10k7q2m9xa. All checked unique.
// Fans only see them once CREW_CODES_LIVE=1 is set on the server.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomInt } from 'node:crypto';

const outDir = process.argv[2];
if (!outDir) {
  console.error('usage: node server/scripts/generate-crew-codes.mjs <out-dir>');
  process.exit(1);
}
const here = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(readFileSync(path.join(here, '..', 'crew-config.json'), 'utf8'));
const counts = { casual: 1000, regular: 200, family: 50, 'reckless-crew': 25 };
const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789'; // no 0/o, 1/l/i look-alikes
const suffix = () => Array.from({ length: 8 }, () => alphabet[randomInt(alphabet.length)]).join('');

const seen = new Set();
const table = {};
const rows = [['crew', 'percent', 'code']];
for (const crew of config.crews) {
  const want = counts[crew.id];
  if (!crew.merchPercent || !want) continue;
  const codes = [];
  while (codes.length < want) {
    const code = `crw${crew.merchPercent}${suffix()}`;
    if (seen.has(code)) continue;
    seen.add(code);
    codes.push(code);
  }
  table[crew.id] = { shared: false, percent: crew.merchPercent, codes };
  for (const code of codes) rows.push([crew.key, String(crew.merchPercent), code]);
}
const all = Object.values(table).flatMap((pool) => pool.codes);
if (new Set(all).size !== all.length || !all.every((code) => /^[a-z0-9]+$/.test(code))) throw new Error('codes not unique/clean');
mkdirSync(outDir, { recursive: true });
writeFileSync(path.join(outDir, 'crew-codes.json'), JSON.stringify(table));
writeFileSync(path.join(outDir, 'crew-codes-pool.csv'), `${rows.map((row) => row.join(',')).join('\n')}\n`);
console.error(Object.entries(table).map(([id, pool]) => `${id} ${pool.codes.length}`).join(', '), `| ${all.length} unique`);
