// Public CORS headers applied to every response, including errors and cached
// paths. Individual handlers may still set a tighter Allow-Origin; that wins.
export const PUBLIC_CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Admin-Key',
  'Access-Control-Max-Age': '86400',
  'Vary': 'Origin',
};

export function mergeCors(headers = {}) {
  const out = { ...PUBLIC_CORS };
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) return out;
  for (const [key, value] of Object.entries(headers)) {
    if (value != null) out[key] = value;
  }
  return out;
}

/** Stamp CORS on a ServerResponse and wrap writeHead so later headers keep them. */
export function attachCors(res) {
  if (!res || res.__rrCors) {
    if (res && !res.headersSent) {
      for (const [key, value] of Object.entries(PUBLIC_CORS)) {
        if (!res.getHeader(key)) res.setHeader(key, value);
      }
    }
    return res;
  }
  res.__rrCors = true;
  for (const [key, value] of Object.entries(PUBLIC_CORS)) {
    if (!res.getHeader(key)) res.setHeader(key, value);
  }
  const orig = res.writeHead;
  res.writeHead = function writeHeadWithCors(status, a, b) {
    if (typeof a === 'string') return orig.call(this, status, a, mergeCors(b));
    if (Array.isArray(a)) {
      const asObject = Object.fromEntries(a.map((pair) => (Array.isArray(pair) ? pair : [pair, ''])));
      return orig.call(this, status, mergeCors(asObject));
    }
    if (a && typeof a === 'object') return orig.call(this, status, mergeCors(a));
    return orig.call(this, status, mergeCors());
  };
  return res;
}
