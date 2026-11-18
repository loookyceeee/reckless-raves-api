// Mints unique single-use Squarespace discount codes for each crew-up and writes the server
// code table. Needs a Squarespace API key with the Discounts (Read and Write) permission.
//
//   SQUARESPACE_API_KEY=... node server/scripts/mint-crew-codes.mjs > crew-codes.json
//   SQUARESPACE_API_KEY=... node server/scripts/mint-crew-codes.mjs --top-up crew-codes.json > crew-codes.next.json
//
// Pool per crew (first-3-month estimate + headroom): CASUAL 750 -> 1000, REGULAR 125 -> 200,
// FAMILY 25 -> 50, CREW 10 -> 25. Override with e.g. --casual=1200. Percent and prefix come from
// crew-config.json (merch_percent / code_prefix). Each code: percentage off any order, 1 use in
// total, once per customer, no expiry. Load the output at DATA_DIR/crew-codes.json on Render.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const key = (process.env.SQUARESPACE_API_KEY || '').trim();
if (!key) {
  console.error('Set SQUARESPACE_API_KEY');
  process.exit(1);
}
const here = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(readFileSync(path.join(here, '..', 'crew-config.json'), 'utf8'));
const args = process.argv.slice(2);
const flag = (name) => args.find((arg) => arg.startsWith(`--${name}=`))?.split('=')[1];
const topUpFile = args[args.indexOf('--top-up') + 1];
const existing = args.includes('--top-up') && topUpFile && existsSync(topUpFile) ? JSON.parse(readFileSync(topUpFile, 'utf8')) : {};
const targets = { casual: 1000, regular: 200, family: 50, 'reckless-crew': 25 };
const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const token = () => Array.from(randomBytes(6), (byte) => alphabet[byte % alphabet.length]).join('');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const table = { ...existing };
for (const crew of config.crews) {
  if (!crew.merchPercent) continue;
  const want = Math.max(0, Number(flag(crew.id)) || targets[crew.id] || 0);
  const pool = (table[crew.id] = { shared: false, codes: [...(table[crew.id]?.codes || [])] });
  const prefix = `CREW-${crew.codePrefix || crew.id.toUpperCase()}`;
  while (pool.codes.length < want) {
    const promoCode = `${prefix}-${token()}`;
    if (pool.codes.includes(promoCode)) continue;
    const response = await fetch('https://api.squarespace.com/v1/commerce/discounts', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'User-Agent': 'Reckless Raves crew codes' },
      body: JSON.stringify({
        name: `${crew.name} crew-up ${crew.merchPercent}% (${promoCode})`,
        criteria: { type: 'ANY_ORDER' },
        template: { type: 'PERCENTAGE', discountAmount: { value: crew.merchPercent } },
        trigger: { type: 'CODE', promoCode },
        validFrom: new Date().toISOString(),
        isLimitedUses: true,
        maxUsesAllowed: 1,
        isOncePerCustomer: true,
      }),
    });
    if (response.status === 429) {
      await sleep(5000);
      continue;
    }
    if (!response.ok) {
      console.error(`Squarespace ${response.status} on ${promoCode}: ${(await response.text()).slice(0, 300)}`);
      process.stdout.write(JSON.stringify(table, null, 1));
      process.exit(2);
    }
    pool.codes.push(promoCode);
    await sleep(250);
  }
  console.error(`${crew.name}: ${pool.codes.length} codes`);
}
process.stdout.write(JSON.stringify(table, null, 1));
