# reckless-raves-api

API server for the Reckless Raves app and website: content, posters, gallery, crew (login, XP, wardrobe, codes), track submissions to Google Drive, and the web build of the app (`dist/`). Deployed on Render (`render.yaml`, starter plan, 1 GB disk at `/data`). This repo is the deployed server; the app repo's `server/serve.mjs` is an older copy.

## Public endpoints (CORS `*`, used by recklessraves.co.uk)

- `GET /api/content` – records, events (Skiddle + Drive posters), shop, `instagram` (`{ username: "reckless.raves", followers_count }`), and optional `nextDrop` (`{ at, name?, url? }`).
  `followers_count` is a number only when env `BEHOLD_FEED_URL` is a Behold JSON feed that returns `followersCount`; it is `null` when that URL is unset, unreachable, or has no count. Records, events, and products do not depend on it.
  Each event includes `skiddleImage` (the Skiddle image URL) when Skiddle sent one. `image` stays the Drive poster when that exists, and otherwise the processed Skiddle poster.
  `nextDrop` comes from env `NEXT_DROP` (JSON or a bare ISO date), `/data/next-drop.json`, or the bundled `server/next-drop.json` (RCKLS019, 12 Dec 2026 14:00 Europe/London, clothing shop). It is omitted when unset, invalid, or already past.
  Each event may carry `ticketStatus`: `"soldout"` (Skiddle single-event API
  `ticketStatus === "0"` with `tickets: true`) or `"sellingfast"` (Skiddle search
  API `hotSeller: true`). Omitted otherwise, for cancelled events, and whenever
  the data came from the Skiddle page or seed fallback instead of the API.
  CORS (`Access-Control-Allow-Origin: *`) is applied to every response, including errors and cached poster/content paths.
- `POST /api/submit` – track upload to the Drive submissions folder (50MB cap unchanged). 5 requests per IP per hour; the next returns `429 { ok: false, error: "RATE_LIMIT" }` before the file is parsed.
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
- **Launch reset:** set env `CREW_RESET_ID` to a new value (e.g. `launch-2026-11-21`) and redeploy: clears `/data/xp-ledger.json`, saved outfits and popup markers once. Or `node server/scripts/launch-reset.mjs`.
- **DAY 1 CREW** badge for anyone who signs in 23–29 Nov 2026.

## RECKLESS WORLD game events

The browser game (`https://reckless-world.onrender.com`) only POSTs events. It never sends XP amounts, and these routes never return XP amounts. Caps are enforced here. Counted events are stored for the loyalty bot to pull; they are not added to the XP Sheet ledger or to `accounts.json` XP.

Auth is the existing session bearer (`Authorization: Bearer <token>` from `POST /api/auth/request`). Missing or invalid session: `401 { ok: false, error: "SESSION" }`. CORS preflight is `OPTIONS 204` with `Access-Control-Allow-Headers: Content-Type, Authorization, X-Admin-Key`.

`server/game-xp.mjs` holds the approved caps. Source of truth: RECKLESS CREW LOYALTY `crew_config.json` → `xp_rates.game`.

- `digital_rave_attended`: 20 XP, max 1 per Europe/London day and 2 per ISO week (of that London date) per email.
- `poster_placed`: 10 XP, once per `posterId` per email ever, max 2 per Europe/London day. An over-cap poster does not consume the `posterId` (the same id can count on a later day).
- Weekly game cap: 40 XP per email (a grant that lands on exactly 40 still counts; the next one does not).
- Cap check order: `DUPLICATE`, then `DAILY_CAP`, then `WEEKLY_CAP` (the per-type ISO-week count, then the 40 XP week). Both weekly limits use reason `WEEKLY_CAP`.
- Over-cap and duplicate events still return `200 { ok: true, recorded: true, counted: false, reason: "DAILY_CAP" | "WEEKLY_CAP" | "DUPLICATE" }`. Counted events return `200 { ok: true, recorded: true, counted: true }`.
- Rate limit (in-memory, same `rateLimited()` helper): 30 event calls per email per 10 minutes and 120 per IP per 10 minutes on the player routes. `429 { ok: false, error: "RATE" }`.

`raveId` and `posterId` must match `[A-Za-z0-9_.:-]{1,64}` (`400` `RAVE` or `POSTER`). A missing, non-string, or over-long `sessionId` is `400` `SESSION_ID`. `POST /api/crew/events` accepts only `type: "poster_placed"` (`400 { ok: false, error: "TYPE" }` otherwise). Bad JSON is `400 { ok: false, error: "BODY" }`.

- `POST /api/crew/events/rave/start { raveId }` → `200 { ok: true, sessionId, minSeconds: 600, startedAt }`. `startedAt` is the server clock as ISO UTC. One open session per email (a new start replaces the old). Unfinished sessions expire after 6 hours. Stored in `/data/game-sessions.json` as `{ email, raveId, startedAt, sessionId }`.
- `POST /api/crew/events/rave/finish { sessionId }` → if that session belongs to this email and server-clock elapsed is at least 600 seconds, records `digital_rave_attended` and consumes the session. Too soon: `409 { ok: false, error: "TOO_SOON", remainingSeconds }` and the session stays open. Unknown, someone else's, or expired: `404 { ok: false, error: "SESSION_NOT_FOUND" }`.
- `POST /api/crew/events { type: "poster_placed", posterId }` → records `poster_placed`.
- `GET /api/crew/events/me` → `{ ok: true, events, today, week }`. `events` is this email's last 50 log lines, newest first. `today` and `week` are counts of counted events (`digital_rave_attended` and `poster_placed`) for the current Europe/London day and ISO week. They are counts, not XP.
- `GET /api/crew/events/export?since=<ISO>` with header `X-Admin-Key: <OAUTH_ADMIN_KEY>` → `application/x-ndjson` log lines whose `at` is at or after `since`. Omit `since` to export the whole log. Bad `since`: `400 { ok: false, error: "SINCE" }`. Wrong key: `403 { ok: false, error: "ADMIN" }`. Own rate bucket, 120 per IP per 10 minutes.

Event log: append-only `/data/game-events.jsonl` (same directory as `accounts.json`). Each line is `{ id, type, email, raveId|posterId, at, counted, reason, test }` with `at` in ISO UTC. `reason` is `null` when the event counted.

- Rave id: `wr:<raveId>:<sha256(normalised email) hex[:12]>:<YYYY-MM-DD>`. The London date is included so the same rave can count on a later London day when the caps allow. The same rave, email and London day share one id.
- Poster id: `wp:<posterId>:<sha256(normalised email) hex[:12]>`. No date. Only a counted line consumes the id.

**Flag:** `GAME_XP_LIVE` (default off: unset or `0`). While off, every line is `test: true`. While on, counted events with `at >= 2026-11-21T00:00:00Z` (midnight 21 Nov 2026, Europe/London) are `test: false`. Nothing here writes the XP ledger either way. Check locally with `node scripts/game-events-check.mjs`.

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

## Admin page (`/admin`)

Private, mobile-first page for Luke (black and white, ALL CAPS). `/admin` redirects to `/admin/login` when signed out. Code: `server/admin.mjs`, `server/admin/app.js`, `server/admin/app.css`, `server/downloads.mjs`.

- **Auth:** env `ADMIN_PASSWORD`. Unset = the login page says ADMIN IS OFF and every admin request is refused (login `503`, API `401 ADMIN_OFF`). The password is compared with scrypt + `timingSafeEqual`, never stored or logged. Login sets `__Host-rr_admin` (HttpOnly, Secure, SameSite=Strict, 30 days, HMAC-signed with `AUTH_SECRET`). Changing `ADMIN_PASSWORD` signs every session out; `[ LOG OUT ]` revokes that session (`/data/admin-sessions.json`).
- **Limits:** 5 failed logins per IP per 15 minutes (then `429`, even for the right password), plus 30 failed logins per 15 minutes across all IPs.
- **CSRF:** every POST needs a same-origin `Origin` (or `Referer`) and a CSRF token tied to the session (`X-CSRF-Token`; the login form uses a double-submit token). Admin pages use `Referrer-Policy: same-origin` so browsers send a real `Origin` on POSTs.
- **Headers:** `Cache-Control: no-store`, `X-Robots-Tag: noindex`, CSP `script-src 'self'`, `X-Frame-Options: DENY`, and no public CORS headers. No secret (`OAUTH_ADMIN_KEY`, Expo/Apple keys) is sent to the browser; the page calls the server internals directly.
- **NOTIFY:** title (60) + message (180), live counters and ALL CAPS preview, optional tap target (`data.path`: `/`, `/events`, `/event/<id>` from the cached events, `/shop`, `/crew`, `/music` = RECORDS, `/gallery`). `[ CHECK ]` = dry run with the phone count; `[ SEND TO N PHONES ]` asks to confirm and is refused (`409`) if the count changed. Same rule as `/api/push/send`: fans are only reached when `PUSH_LIVE=1`, otherwise it is a dry run. `[ TEST TO MY PHONE ]` sends to one email's phones (max 3, default `loookyceeee@gmail.com`), also while `PUSH_LIVE` is off. Every send/test is kept in `/data/push-history.jsonl` (time, title, body, path, sent/count, errors; no tokens).
- **CREW:** lookup by email (read-only; never creates an account or issues a code): XP, level, crew, avatar base, PIN set/locked, crew codes issued, owned merch, phones, game events. Actions with a confirm step: `[ UNLOCK PIN ]` (clears the lockout), `[ RESET PIN ]` (removes the PIN), `[ DELETE ACCOUNT ]` (type the email; same deletion as `DELETE /api/crew`).
- **STATS:** crew accounts, accounts with a PIN, pins locked, phones with notifications (iOS/Android/unknown, signed in), game events recorded/counted today (London day), and read-only flags (`PUSH_LIVE`, `PIN_SETUP_LIVE`, `GAME_XP_LIVE`, `CREW_CODES_LIVE`, `CREW_RESET_ID` set or not). No toggles.
- **DOWNLOADS:** iOS first-time downloads (product types 1/1F/1T/F1…; updates 7/7F and re-downloads 3/3F counted separately) from the App Store Connect Sales and Trends API (`/v1/salesReports`, SALES/SUMMARY/DAILY), refreshed every 6 hours and cached per day in `/data/asc-downloads.json`: total since `ASC_SALES_FROM` (default 2026-11-20), last 7 days, yesterday. Apple's data is about a day behind. Env: `ASC_KEY_P8` (base64 of the .p8), `ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_VENDOR_NUMBER` (App Store Connect > Payments and Financial Reports), optional `ASC_APP_ID` (default 6834422153). Android shows CONNECT PLAY REPORTING plus the Android notification-device count as a labelled lower bound until Play reporting is connected.
- **GAME:** latest 50 RECKLESS WORLD events (type, masked email, time, counted, reason, test) and `[ DOWNLOAD CSV ]` (all events, masked emails).
- **LOG:** every admin action (login, failed login, lookups, sends, PIN actions, deletes, CSRF rejections) goes to `/data/admin-audit.jsonl` without secrets; the last 20 are shown.
- **Checks:** `node scripts/admin-check.mjs` (local servers on a temp `DATA_DIR`; only dry-run pushes).

## Google re-auth

`GET /oauth/google/start?key=<OAUTH_ADMIN_KEY>` sends the owner to Google consent (offline, prompt=consent, Drive + Sheets read/write). `/oauth/google/callback` stores the refresh token in `/data/google-oauth.json` (overrides `GOOGLE_REFRESH_TOKEN`) and tests it. Tokens are never logged or shown. The callback URI (`OAUTH_REDIRECT_URI`, default `https://<host>/oauth/google/callback`) must be an authorised redirect URI on the OAuth client.

## Environment

Admin page: `ADMIN_PASSWORD` (unset = admin off), `ASC_KEY_P8`, `ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_VENDOR_NUMBER`, optional `ASC_APP_ID`, `ASC_SALES_FROM`.

`AUTH_SECRET` (required, signs sessions), `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN` (Drive + Sheets), `GOOGLE_DRIVE_FOLDER_ID`, `XP_SHEET_ID`, `SKIDDLE_API_KEY`, `OAUTH_ADMIN_KEY`, `OAUTH_REDIRECT_URI`, optional `BEHOLD_FEED_URL` (Instagram follower count; leave unset until the website supplies a Behold JSON feed URL), `CREW_CODES` (pool import), `CREW_CODES_LOADED`, `CREW_CODES_LIVE` (default off), `PIN_SETUP_LIVE` (default off), `GAME_XP_LIVE` (default off; RECKLESS WORLD events stay `test: true` and do not enter the XP ledger) and `CREW_RESET_ID`. Never commit values.
