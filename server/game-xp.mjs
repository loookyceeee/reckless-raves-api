/**
 * Game XP caps for RECKLESS WORLD crew events.
 *
 * Source of truth: RECKLESS CREW LOYALTY crew_config.json → xp_rates.game.
 * This object is the approved copy of those numbers. Loyalty owns the rates;
 * change them here only when that config changes.
 *
 * The server enforces the caps. It does not tell the client the XP amounts.
 * GAME_XP_LIVE (default off) only decides whether a counted event is stored
 * as test:false. Counted events are not added to the XP ledger here.
 */
export const gameXp = {
  events: {
    digital_rave_attended: {
      xp: 20,
      maxPerLondonDay: 1,
      maxPerIsoWeek: 2,
    },
    // oncePerId: a counted posterId never counts again for that email.
    // An over-cap (not counted) attempt does not consume the posterId.
    poster_placed: {
      xp: 10,
      maxPerLondonDay: 2,
      oncePerId: true,
    },
  },
  weeklyCapXp: 40,
  minSeconds: 600,
  sessionTtlMs: 6 * 60 * 60 * 1000,
  // Counted events at or after this instant are real (test:false) only when GAME_XP_LIVE is on.
  liveFrom: '2026-11-21T00:00:00.000Z',
  rate: {
    emailMax: 30,
    ipMax: 120,
    windowMs: 10 * 60 * 1000,
  },
};

export function gameXpLive() {
  return ['1', 'true', 'yes', 'on'].includes(String(process.env.GAME_XP_LIVE || '').trim().toLowerCase());
}
