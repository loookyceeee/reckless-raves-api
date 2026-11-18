# reckless-raves-api

API server for the Reckless Raves app and website: content, posters, gallery, crew (login, XP, wardrobe, codes), track submissions to Google Drive, and the web build of the app (`dist/`). Deployed on Render (`render.yaml`, starter plan, 1 GB disk at `/data`). This repo is the deployed server; the app repo's `server/serve.mjs` is an older copy.

## Public endpoints (CORS `*`, used by recklessraves.co.uk)

- `GET /api/content` – records, events (Skiddle + Drive posters), shop.
  Each event may carry `ticketStatus`: `"soldout"` (Skiddle single-event API
  `ticketStatus === "0"` with `tickets: true`) or `"sellingfast"` (Skiddle search
  API `hotSeller: true`). Omitted otherwise, for cancelled events, and whenever
  the data came from the Skiddle page or seed fallback instead of the API.
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
- **Codes:** one single-use code per fan for the highest crew reached (skipped crews are logged, no stacking), never re-issued for a crew already issued to that email (refunds and deletion included; deletion keeps only a hash). Squarespace Basic has no Discounts API, so the pool is generated locally (`node server/scripts/generate-crew-codes.mjs <dir>`: `crw5…`/`crw10…`/`crw15…`/`crw20…` + 8 random lowercase/digit chars, 1000/200/50/25) and created by hand in the Squarespace admin from the CSV (percentage off, 1 use total, once per customer). The pool lives at `/data/crew-codes.json` (env `CREW_CODES`, same JSON, is merged in on boot; codes are never dropped).
- **Loaded list (the gate):** a code is only ever issued if it is on the Loaded list, i.e. confirmed to exist in Squarespace. Two sources, combined:
  1. XP Sheet tab named exactly `Loaded`: row 1 is a header (`code`), then one code per row in column A, exactly as in the CSV (e.g. `crw10k7q2m9xa`; case and surrounding spaces are ignored). Other columns (crew, percent, loaded_at, by) are optional and ignored. Re-read with the XP ledger (about every 5 minutes on activity).
  2. Env `CREW_CODES_LOADED`: comma-separated codes, e.g. `crw5ab12cd34,crw5ef56gh78` (fallback while Google is down).
  If a crew has no free loaded code, the fan is queued in `/data/crew-codes-pending.json` (highest crew only) and filled automatically within 5 minutes of codes being loaded.
- **Display:** fans see "coming soon" until env `CREW_CODES_LIVE=1`. `/api/health` → `xpLedger.crewCodes` shows `live`, `loadedListed`, `queuedFans` and per crew `total / free / loadedFree`.
- **Issued log:** every issued code is appended to the XP Sheet tab `Issued`, in the column order from crew-config `issuedColumns`. Rows queue in `/data/issued-queue.json` while Google is down and flush when it is back. The refresh token needs the `spreadsheets` (write) scope for this.
- **Launch reset:** set env `CREW_RESET_ID` to a new value (e.g. `launch-2026-11-23`) and redeploy: clears `/data/xp-ledger.json`, saved outfits and popup markers once. Or `node server/scripts/launch-reset.mjs`.
- **DAY 1 CREW** badge for anyone who signs in 23–29 Nov 2026.

## Google re-auth

`GET /oauth/google/start?key=<OAUTH_ADMIN_KEY>` sends the owner to Google consent (offline, prompt=consent, Drive + Sheets read/write). `/oauth/google/callback` stores the refresh token in `/data/google-oauth.json` (overrides `GOOGLE_REFRESH_TOKEN`) and tests it. Tokens are never logged or shown. The callback URI (`OAUTH_REDIRECT_URI`, default `https://<host>/oauth/google/callback`) must be an authorised redirect URI on the OAuth client.

## Environment

`AUTH_SECRET` (required, signs sessions), `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN` (Drive + Sheets), `GOOGLE_DRIVE_FOLDER_ID`, `XP_SHEET_ID`, `SKIDDLE_API_KEY`, `OAUTH_ADMIN_KEY`, `OAUTH_REDIRECT_URI`, optional `CREW_CODES` (pool import), `CREW_CODES_LOADED`, `CREW_CODES_LIVE` (default off) and `CREW_RESET_ID`. Never commit values.
