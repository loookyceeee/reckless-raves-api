// Crew avatar art, shared by the app (1.0.1+), the website and RECKLESS WORLD.
// Static 540x720 RGBA PNG layers per base, drawn lower first, then upper:
//   GET /avatar/manifest.json
//   GET /avatar/<male|female>/<file>.png   (upper-*, lower-*, upper-body, lower-body)
//   GET /avatar/icons/<icon>.png           (wardrobe marks, same for both bases)
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, createReadStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'avatar');
const BASES = ['male', 'female'];

/**
 * Character art is NOT public until Luke approves it. Until AVATAR_ART_LIVE=1 the manifest only
 * says { live: false, draft: true } and the male/female layer URLs return 404. Approved PNGs go in
 * server/avatar/<base>/ (same file names as the app's layers) before the flag is turned on.
 */
export const avatarArtLive = () => /^(1|true|yes|on)$/i.test((process.env.AVATAR_ART_LIVE || '').trim());
const pngs = (sub) => {
  try {
    return readdirSync(path.join(dir, sub)).filter((name) => name.endsWith('.png'));
  } catch {
    return [];
  }
};
let cached = null;

function version() {
  const hash = createHash('sha256');
  for (const sub of [...BASES, 'icons']) {
    for (const name of pngs(sub).sort()) {
      hash.update(`${sub}/${name}`);
      hash.update(readFileSync(path.join(dir, sub, name)));
    }
  }
  return hash.digest('hex').slice(0, 12);
}

export function avatarManifest(origin, wardrobe = []) {
  if (!avatarArtLive() || BASES.some((base) => pngs(base).length === 0)) {
    return { ok: true, live: false, draft: true, message: 'CHARACTER ART IS NOT PUBLISHED YET', size: { width: 540, height: 720 }, bases: {} };
  }
  if (!cached) {
    const pieces = JSON.parse(readFileSync(path.join(dir, 'pieces.json'), 'utf8'));
    cached = { pieces, v: version() };
  }
  const { pieces, v } = cached;
  const url = (sub, file) => `${origin}/avatar/${sub}/${file}.png?v=${v}`;
  const names = Object.fromEntries((wardrobe || []).map((item) => [item.id, item]));
  const bases = {};
  for (const base of BASES) {
    bases[base] = {
      body: { lower: url(base, 'lower-body'), upper: url(base, 'upper-body') },
      pieces: Object.fromEntries(
        Object.entries(pieces).map(([id, piece]) => [id, { layer: piece.layer, file: `${piece.file}.png`, url: url(base, piece.file) }]),
      ),
    };
  }
  return {
    ok: true,
    live: true,
    draft: false,
    version: v,
    size: { width: 540, height: 720 },
    order: 'Draw lower first (the legs piece, else body.lower), then upper (the outer piece, else the top piece, else body.upper).',
    pieces: Object.fromEntries(
      Object.entries(pieces).map(([id, piece]) => [
        id,
        { name: names[id]?.name ?? null, slot: names[id]?.slot ?? null, level: names[id]?.level ?? null, layer: piece.layer, icon: url('icons', piece.icon) },
      ]),
    ),
    bases,
  };
}

/** Returns true when the request was an /avatar/ asset and has been answered. */
export function handleAvatarAsset(req, res, url) {
  const match = url.pathname.match(/^\/avatar\/(male|female|icons)\/([a-z0-9-]+\.png)$/);
  if (!match) return false;
  if (match[1] !== 'icons' && !avatarArtLive()) {
    res.writeHead(404, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
    res.end('Not found');
    return true;
  }
  const file = path.join(dir, match[1], match[2]);
  if (!existsSync(file)) {
    res.writeHead(404, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
    res.end('Not found');
    return true;
  }
  const { size, mtimeMs } = statSync(file);
  const etag = `"${match[1]}-${match[2]}-${size}-${Math.floor(mtimeMs)}"`;
  const headers = {
    'Content-Type': 'image/png',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': url.searchParams.has('v') ? 'public, max-age=31536000, immutable' : 'public, max-age=3600, stale-while-revalidate=86400',
    ETag: etag,
  };
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers);
    res.end();
    return true;
  }
  res.writeHead(200, { ...headers, 'Content-Length': size });
  if (req.method === 'HEAD') {
    res.end();
    return true;
  }
  createReadStream(file).pipe(res);
  return true;
}
