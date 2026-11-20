# reckless-raves-api

API server for the Reckless Raves app and website: content, posters, gallery, crew (login, XP, wardrobe, codes), track submissions to Google Drive, and the web build of the app (`dist/`). Deployed on Render (`render.yaml`, starter plan, 1 GB disk at `/data`). This repo is the deployed server; the app repo's `server/serve.mjs` is an older copy.

## Public endpoints (CORS `*`, used by recklessraves.co.uk)

- `GET /api/content` – records, events (Skiddle + Drive posters), shop, and optional `nextDrop` (`{ at, name?, url? }`).
  `nextDrop` comes from env `NEXT_DROP` (JSON or a bare ISO date), `/data/next-drop.json`, or the bundled `server/next-drop.json` (RCKLS019, 12 Dec 2026 14:00 Europe/London, clothing shop). It is omitted when unset, invalid, or already past.
  Each event may carry `ticketStatus`: `"soldout"` (Skiddle single-event API
  `ticketStatus === "0"` with `tickets: true`) or `"sellingfast"` (Skiddle search
  API `hotSeller: true`). Omitted otherwise, for cancelled events, and whenever
  the data came from the Skiddle page or seed fallback instead of the API.
  CORS (`Access-Control-Allow-Origin: *`) is applied to every response, including errors and cached poster/content paths.
- `GET /api/poster/<file>[?w=360|540|720]` – posters; `w` serves a cached phone-size JPEG.
- `GET /api/gallery` – albums with `coverUrl` (1200w), `coverThumb` (750w), `images[].url` (1600w), `thumb` (750w), `full` (1500w).
- `GET /api/crew/config` – ladder, crews, wardrobe, digital rewards.
- `GET /spin-rules` – Spin the Wheel rules page.
- `GET /api/health` – `{ drive, xpLedger: { sheet, sheetReadAt, rows, issuedQueued, stale }, mode }`. `drive` is a real Google token test (cached 5 min).

## Crew

- `POST /api/auth/request { email, pin? }` → session token (30 days). Email only unless the account has a PIN (see **Account PIN**). Sessions are revoked on account deletion.
- `GET /api/crew`, `PUT /api/crew { fit?, ack?, avatarBase? }`, `DELETE /api/crew` (account, outfit, codes, sessions; the XP row is kept only if it comes from Sheet purchase records). `GET` includes `avatarBase` (`"male"` | `"female"`, default `"male"`). `PUT` accepts `avatarBase` the same way; omit it to leave the stored value unchanged. Invalid values return `400 { ok: false, error: "AVATAR_BASE" }`. Starter-fit fallback is unchanged.
- `GET /api/crew/avatar-base?email=` and `PUT /api/crew/avatar-base?email=` with JSON `{ "avatarBase": "male" | "female" }` — lightweight public read/write for the website and RECKLESS WORLD. Identity is email only (lowercased and trimmed), with no session or ownership check, matching the app. Missing or unknown emails, and accounts that have never explicitly set a value via `PUT /api/crew/avatar-base` or `PUT /api/crew`, read as `null` and do not create an account; `PUT` creates or updates the account row. A stored `"female"` is always treated as explicit (it was never a creation default). Existing `"male"` rows written as the creation default cannot be distinguished from an explicit male `PUT` and also read as `null` until the value is set again via `PUT`. Invalid or missing email: `400 { ok: false, error: "EMAIL" }`. Invalid body: `400 { ok: false, error: "AVATAR_BASE" }`. `PUT` is rate-limited to 30 requests per minute per email and per IP (`429 { ok: false, error: "RATE" }`). If the account has a PIN, `PUT` also needs `"pin"` in the body (`401 PIN_REQUIRED` / `401 WRONG_PIN` / `429 LOCKED`, same lockout as sign-in). CORS: `GET` is `*`; `PUT` allows `https://recklessraves.co.uk` and `https://www.recklessraves.co.uk` (non-browser clients can still write).
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

## Account PIN (opt-in, dormant until `PIN_SETUP_LIVE=1`)

- Stored per email on the account row in `/data/accounts.json` as `pinHash` (`scrypt$<salt>$<hash>`, 16-byte random salt, N=16384). The PIN is never stored, logged or returned. Only accounts with a PIN are affected; everything else (including `appreview@recklessraves.co.uk`) is email-only as before.
- `GET /api/crew/pin-status?email=` → `200 { ok: true, hasPin }` (`400 EMAIL`, `429 RATE` over 60/min per IP).
- `POST /api/crew/pin?email=` `{ "pin": "1234" }` sets a first PIN (exactly 4 digits, as a string) → `200 { ok: true, hasPin: true, changed: false }`. If a PIN exists: `{ "currentPin", "pin" }` changes it → `changed: true`; without `currentPin` → `409 PIN_SET`. Errors: `400 PIN_FORMAT`, `400 EMAIL`, `401 WRONG_PIN`, `429 LOCKED|LIMIT|RATE`. Setting a PIN on an email with no account creates the account row.
- **Flag:** while env `PIN_SETUP_LIVE` is unset/`0` (default), `POST /api/crew/pin` returns `403 { ok: false, error: "PIN_SETUP_NOT_LIVE" }` unless the request has header `X-Admin-Key: <OAUTH_ADMIN_KEY>`. Set `PIN_SETUP_LIVE=1` to let fans set PINs from the website.
- `DELETE /api/crew/pin?email=` with header `X-Admin-Key: <OAUTH_ADMIN_KEY>` clears the PIN and any lockout (help a locked-out fan) → `200 { ok: true, hasPin: false, cleared }`; wrong key `403 ADMIN`.
- Enforcement (only when the account has a PIN): `POST /api/auth/request` without `pin` → `426 { error: "UPDATE_APP", message: "UPDATE THE APP TO SIGN IN" }` (build 6 has a fixed error map and shows "THAT EMAIL DOES NOT LOOK RIGHT." for this); wrong PIN → `401 { error: "WRONG_PIN", message: "WRONG PIN", triesLeft }`. `PUT /api/crew/avatar-base` needs `pin` too. Sessions issued earlier keep working.
- Lockout: 5 wrong PINs per email (sign-in, avatar-base PUT and PIN change share the count) lock that email for 15 minutes, even for the right PIN → `429 { error: "LOCKED", message: "LOCKED, TRY AGAIN IN 15 MINUTES", retryAfterSeconds }`. A right PIN resets the count. Plus 20 wrong PINs per IP per 15 minutes → `429 { error: "LIMIT" }` (in memory; IP from `x-forwarded-for`).
- CORS: `https://recklessraves.co.uk` and `https://www.recklessraves.co.uk` for `GET`/`POST` (header `Content-Type`). `DELETE` is not exposed cross-origin.
- Known gap: whoever sets a PIN first owns an email that has no PIN yet (identity is still email only).

## Google re-auth

`GET /oauth/google/start?key=<OAUTH_ADMIN_KEY>` sends the owner to Google consent (offline, prompt=consent, Drive + Sheets read/write). `/oauth/google/callback` stores the refresh token in `/data/google-oauth.json` (overrides `GOOGLE_REFRESH_TOKEN`) and tests it. Tokens are never logged or shown. The callback URI (`OAUTH_REDIRECT_URI`, default `https://<host>/oauth/google/callback`) must be an authorised redirect URI on the OAuth client.

## Environment

`AUTH_SECRET` (required, signs sessions), `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN` (Drive + Sheets), `GOOGLE_DRIVE_FOLDER_ID`, `XP_SHEET_ID`, `SKIDDLE_API_KEY`, `OAUTH_ADMIN_KEY`, `OAUTH_REDIRECT_URI`, optional `CREW_CODES` (pool import), `CREW_CODES_LOADED`, `CREW_CODES_LIVE` (default off), `PIN_SETUP_LIVE` (default off) and `CREW_RESET_ID`. Never commit values.
