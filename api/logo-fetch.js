// GET /api/logo-fetch?domain=acme.com — fetches a company logo from Logo.dev server-side
// and returns it as base64 for the builder to preview/commit through the normal /api/logo path.
//
// Why a proxy instead of hitting img.logo.dev from the browser: the token stays in env,
// CORS never gets in the way, and the asset is committed to the repo like any manual upload —
// pages and the html2canvas creative generator keep reading local files, so nothing downstream
// changes. Logo.dev is an authoring-time convenience only; the LPs never hotlink it.
//
// Auth: x-admin-password header (same shared ADMIN_PASSWORD as the rest of the admin APIs).
// Env: LOGO_DEV_TOKEN (publishable key from logo.dev).
import crypto from 'node:crypto';

const MAX_BYTES = 512 * 1024; // same hard limit as /api/logo

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }
  if (!passwordOk(req.headers['x-admin-password'])) {
    return res.status(401).json({ ok: false, error: 'bad_password' });
  }
  const token = process.env.LOGO_DEV_TOKEN;
  if (!token) return res.status(500).json({ ok: false, error: 'logo_dev_not_configured' });

  // lenient normalization: accept pasted URLs, strip protocol/www/paths
  let domain = String((req.query && req.query.domain) || '').trim().toLowerCase();
  domain = domain.replace(/^https?:\/\//, '').replace(/^www\./, '').split(/[/?#]/)[0];
  if (!/^[a-z0-9][a-z0-9.-]{1,80}\.[a-z]{2,}$/.test(domain)) {
    return res.status(400).json({ ok: false, error: 'bad_domain' });
  }

  // fallback=404: a plain 404 beats committing a generic monogram placeholder to the repo
  const url = `https://img.logo.dev/${encodeURIComponent(domain)}?token=${encodeURIComponent(token)}&size=280&retina=true&format=png&fallback=404`;
  let r;
  try { r = await fetch(url); }
  catch { return res.status(502).json({ ok: false, error: 'logo_dev_unreachable' }); }
  if (r.status === 404) return res.status(404).json({ ok: false, error: 'logo_not_found', domain });
  if (!r.ok) return res.status(502).json({ ok: false, error: 'logo_dev_error', detail: r.status });

  const buf = Buffer.from(await r.arrayBuffer());
  if (!buf.length) return res.status(502).json({ ok: false, error: 'empty_response' });
  if (buf.length > MAX_BYTES) return res.status(400).json({ ok: false, error: 'too_large_max_512kb' });

  // only PNG or WebP make it into the library (mirrors /api/logo's magic-byte check)
  const isPng = buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  const isWebp = buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP';
  if (!isPng && !isWebp) return res.status(502).json({ ok: false, error: 'unexpected_format' });

  return res.status(200).json({
    ok: true, domain,
    ext: isPng ? 'png' : 'webp',
    contentBase64: buf.toString('base64'),
    bytes: buf.length
  });
}

function passwordOk(given) {
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected || typeof given !== 'string') return false;
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}
