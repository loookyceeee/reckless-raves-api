// Mints per-fan single-use Squarespace discount codes for each crew-up and writes the
// server code table. Needs a Squarespace API key with the Discounts (Read and Write) permission.
//
//   SQUARESPACE_API_KEY=... node server/scripts/mint-crew-codes.mjs 50 > crew-codes.json
//
// Then load the output into the server: put it at DATA_DIR/crew-codes.json, or set it as the
// CREW_CODES env var on Render. Codes: CREW-CAS5-XXXXXX (5%), CREW-REG10- (10%), CREW-FAM15- (15%),
// CREW-RC20- (20%); percentage off any order, 1 use site-wide, once per customer, no expiry.
import { randomBytes } from 'node:crypto';

const key = (process.env.SQUARESPACE_API_KEY || '').trim();
if (!key) {
  console.error('Set SQUARESPACE_API_KEY');
  process.exit(1);
}
const perTier = Math.max(1, Math.min(500, Number(process.argv[2] || 50)));
const tiers = [
  ['casual', 'CAS5', 5, 'CASUAL RAVER'],
  ['regular', 'REG10', 10, 'RECKLESS REGULAR'],
  ['family', 'FAM15', 15, 'RECKLESS FAMILY'],
  ['reckless-crew', 'RC20', 20, 'RECKLESS CREW'],
];
const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const token = () => Array.from(randomBytes(6), (byte) => alphabet[byte % alphabet.length]).join('');

const table = {};
for (const [id, prefix, percent, name] of tiers) {
  table[id] = { shared: false, codes: [] };
  for (let i = 0; i < perTier; i += 1) {
    const promoCode = `CREW-${prefix}-${token()}`;
    const response = await fetch('https://api.squarespace.com/v1/commerce/discounts', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        'User-Agent': 'Reckless Raves crew codes',
      },
      body: JSON.stringify({
        name: `${name} crew-up ${percent}% (${promoCode})`,
        criteria: { type: 'ANY_ORDER' },
        template: { type: 'PERCENTAGE', discountAmount: { value: percent } },
        trigger: { type: 'CODE', promoCode },
        validFrom: new Date().toISOString(),
        isLimitedUses: true,
        maxUsesAllowed: 1,
        isOncePerCustomer: true,
      }),
    });
    if (!response.ok) {
      console.error(`Squarespace ${response.status} on ${promoCode}: ${(await response.text()).slice(0, 300)}`);
      process.exit(2);
    }
    table[id].codes.push(promoCode);
  }
  console.error(`${name}: ${perTier} codes`);
}
process.stdout.write(JSON.stringify(table, null, 1));
