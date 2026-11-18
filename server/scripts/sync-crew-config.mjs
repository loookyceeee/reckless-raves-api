// Copies the loyalty teammate's config (source of truth) into server/crew-config.json.
//   node server/scripts/sync-crew-config.mjs [/home/box/shared/reckless-crew/crew_config.json]
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const source = process.argv[2] || '/home/box/shared/reckless-crew/crew_config.json';
const src = JSON.parse(readFileSync(source, 'utf8'));
const ids = { FRESHER: 'fresher', CASUAL_RAVER: 'casual', RECKLESS_REGULAR: 'regular', RECKLESS_FAMILY: 'family', RECKLESS_CREW: 'reckless-crew' };
const crews = [...src.crews].sort((a, b) => a.order - b.order);
const out = {
  version: 2,
  source: `${src.schema} updated ${src.updated_at}`,
  note: 'Generated from the loyalty config. Do not edit by hand: run server/scripts/sync-crew-config.mjs.',
  crews: crews.map((crew) => ({
    id: ids[crew.key] || crew.key.toLowerCase(),
    key: crew.key,
    name: crew.label,
    merchPercent: crew.merch_percent,
    ticketPercent: crew.ticket_percent,
    codePrefix: crew.code_prefix,
  })),
  ranks: src.levels.map((level) => ({
    level: level.level,
    xp: level.xp_to_enter,
    crew: crews.findIndex((crew) => crew.key === level.crew),
    step: level.step,
  })),
  wardrobe: src.wardrobe.items.map((item) => ({ id: item.id, name: item.name, slot: item.slot, level: item.unlock_level })),
  starterFit: src.wardrobe.starter_fit,
  rewards: src.digital_rewards.map((reward) => ({ ...reward, kind: 'digital' })),
  day1: { id: 'day1', name: 'DAY 1 CREW', from: '2026-11-23T00:00:00Z', to: '2026-11-30T00:00:00Z' },
  issuedColumns: src.issued_tab_columns,
  launch: src.launch,
};
const target = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'crew-config.json');
writeFileSync(target, `${JSON.stringify(out, null, 1)}\n`);
console.log(`crew-config.json: ${out.ranks.length} levels, ${out.wardrobe.length} pieces`);
