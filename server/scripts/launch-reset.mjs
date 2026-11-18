// One-shot launch reset, run on the server: node server/scripts/launch-reset.mjs
// Clears DATA_DIR/xp-ledger.json and every saved outfit / popup marker in accounts.json.
// Prefer the CREW_RESET_ID env flag on Render (see serve.mjs launchReset) when no shell is available.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const dataDir = path.resolve(process.env.DATA_DIR || 'server/data');
const ledgerPath = path.join(dataDir, 'xp-ledger.json');
const accountsPath = path.join(dataDir, 'accounts.json');
writeFileSync(ledgerPath, JSON.stringify({ source: 'reset', updated: new Date().toISOString(), rows: 0, emails: {} }));
let accounts = {};
try {
  accounts = JSON.parse(readFileSync(accountsPath, 'utf8'));
} catch {
  accounts = {};
}
for (const account of Object.values(accounts)) {
  account.fit = { top: null, outer: null, legs: null };
  delete account.fitSet;
  delete account.lastLevelSeen;
  delete account.lastCrewSeen;
  account.xp = 0;
}
writeFileSync(accountsPath, JSON.stringify(accounts));
console.log(`Reset ledger and ${Object.keys(accounts).length} outfits in ${dataDir}. Restart the service.`);
