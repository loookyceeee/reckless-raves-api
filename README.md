# reckless-raves-api

API server for the Reckless Raves app and website: content, posters, gallery, crew (login, XP, wardrobe, codes), track submissions to Google Drive, and the web build of the app (`dist/`). Deployed on Render (`render.yaml`, starter plan, 1 GB disk at `/data`). This repo is the deployed server; the app repo's `server/serve.mjs` is an older copy.

## Public endpoints (CORS `*`, used by recklessraves.co.uk)

- `GET /api/content` – records, events (Skiddle + Drive posters), shop.
- `GET /api/poster/<file>[?w=360|540|720]` – posters; `w` serves a cached phone-size JPEG.
- `GET /api/gallery` – albums with `coverUrl` (1200w), `coverThumb` (750w), `images[].url` (1600w), `thumb` (750w), `full` (1500w).
- `GET /api/crew/config` – ladder, crews, wardrobe, digital rewards.
- `GET /spin-rules` – Spin the Wheel rules page.
- `GET /api/health` – `{ drive, xpLedger: { sheet, sheetReadAt, rows, issuedQueued, stale }, mode }`. `drive` is a real Google token test (cached 5 min).

## Crew

- `POST /api/auth/request { email }` → session token (email only, 30 days). Sessions are revoked on account deletion.
- `GET /api/crew`, `PUT /api/crew { fit?, ack? }`, `DELETE /api/crew` (account, outfit, codes, sessions; the XP row is kept only if it comes from Sheet purchase records).
- XP comes from the XP Sheet ledger (`XP Ledger!A2:B`); an empty Sheet means 0 XP for everyone.
- **Config:** `server/crew-config.json` is generated from the loyalty config: `node server/scripts/sync-crew-config.mjs /home/box/shared/reckless-crew/crew_config.json`. A copy at `/data/crew-config.json` overrides it without a deploy.
- **Locks:** outfits are clamped server-side to `level >= unlock_level` OR owned. Owned pieces come only from the XP Sheet tab `Owned` (`email | item_name | order_id | purchased_at`, item_name = exact wardrobe name).
- **Codes:** one single-use code per fan for the highest crew reached (skipped crews are logged, no stacking), never re-issued for a crew already issued to that email (refunds and deletion included; deletion keeps only a hash). Squarespace Basic has no Discounts API, so the pool is generated locally (`node server/scripts/generate-crew-codes.mjs <dir>`: `crw5…`/`crw10…`/`crw15…`/`crw20…` + 8 random lowercase/digit chars, 1000/200/50/25) and the CSV is created by hand in the Squarespace admin (percentage off, 1 use total, once per customer). The pool lives at `/data/crew-codes.json`; setting env `CREW_CODES` (same JSON) merges it in on boot, never dropping codes. **Fans see "coming soon" until env `CREW_CODES_LIVE=1`** (set it only after the codes exist in Squarespace). `/api/health` shows `crewCodes.live` and free counts per crew.
- **Issued log:** every issued code is appended to the XP Sheet tab `Issued`, in the column order from crew-config `issuedColumns`. Rows queue in `/data/issued-queue.json` while Google is down and flush when it is back. The refresh token needs the `spreadsheets` (write) scope for this.
- **Launch reset:** set env `CREW_RESET_ID` to a new value (e.g. `launch-2026-11-23`) and redeploy: clears `/data/xp-ledger.json`, saved outfits and popup markers once. Or `node server/scripts/launch-reset.mjs`.
- **DAY 1 CREW** badge for anyone who signs in 23–29 Nov 2026.

## Environment

`AUTH_SECRET` (required, signs sessions), `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN` (Drive + Sheets), `GOOGLE_DRIVE_FOLDER_ID`, `XP_SHEET_ID`, `SKIDDLE_API_KEY`, optional `CREW_CODES` (pool import), `CREW_CODES_LIVE` (default off) and `CREW_RESET_ID`. Never commit values.
