// Checks the crew selector avatar manifest and 1x/2x layer routes.
//   node scripts/avatar-check.mjs
// Covers: AVATAR_ART_LIVE off = draft manifest and 404 layer URLs (icons still served),
// live manifest keeps 540×720 `url` / body.lower / body.upper as the 1x fallback and adds
// size2x plus url2x / lower2x / upper2x pointing at /avatar/<base>/2x/<file>.png, version
// includes the 2x files, and the 1x and 2x PNGs are the expected sizes.
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { createServer as createNetServer } from 'node:net';
import { URL } from 'node:url';

import { avatarManifest, handleAvatarAsset } from '../server/avatar.mjs';

const require = createRequire(import.meta.url);
const sharp = require('sharp');

let failures = 0;
let passes = 0;

function check(cond, name, detail) {
  if (cond) {
    passes += 1;
    console.log(`ok  ${name}`);
  } else {
    failures += 1;
    console.error(`FAIL  ${name}${detail ? `\n      ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
  }
}

function listen(server) {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => {
        server.listen(port, '127.0.0.1', () => resolve(port));
      });
    });
    probe.on('error', reject);
    server.on('error', reject);
  });
}

async function withServer(fn) {
  const server = createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname === '/avatar/manifest.json') {
      const body = JSON.stringify(avatarManifest(`http://${req.headers.host}`, [{ id: 'skate-tee', name: 'SKATE TEE', slot: 'top', level: 1 }]));
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
      res.end(body);
      return;
    }
    if (handleAvatarAsset(req, res, url)) return;
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  });
  const port = await listen(server);
  const origin = `http://127.0.0.1:${port}`;
  try {
    await fn(origin);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const prev = process.env.AVATAR_ART_LIVE;
delete process.env.AVATAR_ART_LIVE;

await withServer(async (origin) => {
  const off = await fetch(`${origin}/avatar/manifest.json`).then((r) => r.json());
  check(off.ok && off.live === false && off.draft === true && off.size?.width === 540 && off.size2x?.width === 1080 && Object.keys(off.bases || {}).length === 0, 'off: draft manifest, 540 1x and 1080 size2x, no bases');
  const layer = await fetch(`${origin}/avatar/male/upper-tee.png`);
  const layer2x = await fetch(`${origin}/avatar/male/2x/upper-tee.png`);
  check(layer.status === 404 && layer2x.status === 404, 'off: 1x and 2x layer URLs 404');
  const icon = await fetch(`${origin}/avatar/icons/icon-tee.png`);
  check(icon.status === 200 && icon.headers.get('content-type') === 'image/png', 'off: wardrobe icons still served');
});

process.env.AVATAR_ART_LIVE = '1';

await withServer(async (origin) => {
  const res = await fetch(`${origin}/avatar/manifest.json`);
  const body = await res.json();
  check(res.status === 200 && body.ok && body.live === true && body.draft === false, 'live: manifest is live', body);
  check(body.size?.width === 540 && body.size?.height === 720, 'live: size stays 540×720 1x fallback', body.size);
  check(body.size2x?.width === 1080 && body.size2x?.height === 1440, 'live: size2x is 1080×1440', body.size2x);
  check(typeof body.version === 'string' && /^[0-9a-f]{12}$/.test(body.version), 'live: version is 12 hex chars from the hashed PNGs', body.version);

  for (const base of ['male', 'female']) {
    const b = body.bases?.[base];
    const { lower, upper, lower2x, upper2x } = b?.body || {};
    check(
      typeof lower === 'string' && lower.startsWith(`${origin}/avatar/${base}/lower-body.png?v=${body.version}`),
      `${base}: body.lower is the 1x fallback`,
      lower,
    );
    check(
      typeof upper === 'string' && upper.startsWith(`${origin}/avatar/${base}/upper-body.png?v=${body.version}`),
      `${base}: body.upper is the 1x fallback`,
      upper,
    );
    check(
      typeof lower2x === 'string' && lower2x.startsWith(`${origin}/avatar/${base}/2x/lower-body.png?v=${body.version}`),
      `${base}: body.lower2x points at the 2x file`,
      lower2x,
    );
    check(
      typeof upper2x === 'string' && upper2x.startsWith(`${origin}/avatar/${base}/2x/upper-body.png?v=${body.version}`),
      `${base}: body.upper2x points at the 2x file`,
      upper2x,
    );
    const ids = Object.keys(b?.pieces || {});
    check(ids.length >= 20, `${base}: wardrobe pieces are listed`, ids.length);
    const missing = ids.filter((id) => !b.pieces[id].url || !b.pieces[id].url2x);
    check(missing.length === 0, `${base}: every piece has url and url2x`, missing);
    const tee = b.pieces['skate-tee'];
    check(
      tee?.file === 'upper-tee.png' &&
        tee.url === `${origin}/avatar/${base}/upper-tee.png?v=${body.version}` &&
        tee.url2x === `${origin}/avatar/${base}/2x/upper-tee.png?v=${body.version}`,
      `${base}: skate-tee url is 1x, url2x is 2x, same version`,
      tee,
    );
  }

  check(body.pieces['skate-tee']?.name === 'SKATE TEE' && body.pieces['skate-tee']?.icon.includes('/avatar/icons/icon-tee.png'), 'piece meta and icon stay on /avatar/icons (no 2x icons)');

  async function dim(url) {
    const r = await fetch(url);
    const buf = Buffer.from(await r.arrayBuffer());
    const meta = await sharp(buf).metadata();
    return { status: r.status, type: r.headers.get('content-type'), width: meta.width, height: meta.height, bytes: buf.length };
  }

  const one = await dim(`${origin}/avatar/male/upper-tee.png?v=${body.version}`);
  const two = await dim(`${origin}/avatar/male/2x/upper-tee.png?v=${body.version}`);
  const fem = await dim(`${origin}/avatar/female/2x/lower-jeans.png?v=${body.version}`);
  check(one.status === 200 && one.type === 'image/png' && one.width === 540 && one.height === 720, 'GET 1x upper-tee is a 540×720 PNG', one);
  check(two.status === 200 && two.type === 'image/png' && two.width === 1080 && two.height === 1440, 'GET 2x upper-tee is a 1080×1440 PNG', two);
  check(fem.status === 200 && fem.width === 1080 && fem.height === 1440, 'GET female 2x lower-jeans is 1080×1440', fem);

  const head = await fetch(`${origin}/avatar/female/2x/upper-tee.png`, { method: 'HEAD' });
  check(head.status === 200 && head.headers.get('content-type') === 'image/png' && Number(head.headers.get('content-length')) > 0, 'HEAD 2x is image/png with a length');

  const miss = await fetch(`${origin}/avatar/male/2x/no-such-layer.png`);
  check(miss.status === 404, 'missing 2x file is 404');

  const noMatch = handleAvatarAsset({ method: 'GET', headers: {} }, { writeHead() {}, end() {} }, new URL('http://127.0.0.1/avatar/icons/2x/icon-tee.png'));
  check(noMatch === false, 'icons/2x is not a valid asset path');
});

if (prev === undefined) delete process.env.AVATAR_ART_LIVE;
else process.env.AVATAR_ART_LIVE = prev;

console.log(`${passes} passed, ${failures} failed`);
if (failures) process.exit(1);
