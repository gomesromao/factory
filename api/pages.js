// GET /api/pages — returns every page config (for the builder's list + "duplicate from").
// Auth: x-admin-password header. Reads pages/*.json bundled with the deployment (includeFiles).
import crypto from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }
  if (!passwordOk(req.headers['x-admin-password'])) {
    return res.status(401).json({ ok: false, error: 'bad_password' });
  }
  try {
    const dir = path.join(process.cwd(), 'pages');
    const files = (await readdir(dir)).filter(f => f.endsWith('.json'));
    const pages = [];
    for (const f of files) {
      pages.push(JSON.parse(await readFile(path.join(dir, f), 'utf8')));
    }
    pages.sort((a, b) => a.slug.localeCompare(b.slug));
    return res.status(200).json({ ok: true, pages, baseUrl: process.env.PROD_BASE_URL || '' });
  } catch (e) {
    console.error('pages read failed', e);
    return res.status(500).json({ ok: false, error: 'read_failed' });
  }
}

function passwordOk(given) {
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected || typeof given !== 'string') return false;
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}
