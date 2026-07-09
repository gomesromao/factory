// POST /api/logo — uploads a logo (png/webp) into shared/public/logos/ via a GitHub commit.
// DELETE /api/logo — removes a logo, refusing if any page still uses it.
// Auth: same shared ADMIN_PASSWORD as publish. The Vercel Git integration redeploys (~2 min);
// until then the builder previews the new logo locally, and publish validates against the
// FRESH GitHub listing (not the stale bundle), so pages using a just-uploaded logo publish fine.
import crypto from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const MAX_BYTES = 512 * 1024;

export default async function handler(req, res) {
  if (req.method !== 'POST' && req.method !== 'DELETE') {
    res.setHeader('Allow', 'POST, DELETE');
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }
  const body = await readJson(req);
  if (!passwordOk(body && body.password)) return res.status(401).json({ ok: false, error: 'bad_password' });

  const filename = body && body.filename;
  if (!/^[a-z0-9][a-z0-9-]{1,50}\.(png|webp)$/.test(filename || '')) {
    return res.status(400).json({ ok: false, error: 'bad_filename' });
  }
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPO;
  const branch = process.env.GITHUB_BRANCH || 'main';
  if (!token || !repo) return res.status(500).json({ ok: false, error: 'github_not_configured' });
  const apiUrl = `https://api.github.com/repos/${repo}/contents/shared/public/logos/${filename}`;
  const gh = (url, opts = {}) => fetch(url, {
    ...opts,
    headers: {
      Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json',
      'User-Agent': 'coconut-lp-factory', 'X-GitHub-Api-Version': '2022-11-28', ...(opts.headers || {})
    }
  });

  // current sha, if the file exists (update / delete need it)
  let sha;
  const cur = await gh(`${apiUrl}?ref=${branch}`);
  if (cur.status === 200) sha = (await cur.json()).sha;
  else if (cur.status !== 404) return res.status(502).json({ ok: false, error: 'github_read_failed', detail: cur.status });

  if (req.method === 'DELETE') {
    if (!sha) return res.status(404).json({ ok: false, error: 'not_found' });
    // refuse to delete a logo any page still references (a missing logo fails every future build)
    const usedBy = await pagesUsing(filename);
    if (usedBy.length) return res.status(409).json({ ok: false, error: 'logo_in_use', pages: usedBy });
    const del = await gh(apiUrl, { method: 'DELETE', body: JSON.stringify({ message: `builder: delete logo ${filename}`, sha, branch }) });
    if (!del.ok) return res.status(502).json({ ok: false, error: 'github_delete_failed', detail: del.status });
    return res.status(200).json({ ok: true, deleted: filename });
  }

  // POST: validate payload then commit
  const b64 = body && body.contentBase64;
  if (!b64 || typeof b64 !== 'string') return res.status(400).json({ ok: false, error: 'missing_content' });
  let buf;
  try { buf = Buffer.from(b64, 'base64'); } catch { return res.status(400).json({ ok: false, error: 'bad_base64' }); }
  if (!buf.length || buf.length > MAX_BYTES) return res.status(400).json({ ok: false, error: 'too_large_max_512kb' });
  const isPng = buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  const isWebp = buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP';
  if (filename.endsWith('.png') ? !isPng : !isWebp) return res.status(400).json({ ok: false, error: 'content_does_not_match_extension' });

  const put = await gh(apiUrl, {
    method: 'PUT',
    body: JSON.stringify({ message: `builder: ${sha ? 'update' : 'add'} logo ${filename}`, content: b64, branch, ...(sha ? { sha } : {}) })
  });
  if (!put.ok) {
    console.error('logo PUT failed', put.status, await put.text());
    return res.status(502).json({ ok: false, error: 'github_write_failed', detail: put.status });
  }
  return res.status(200).json({ ok: true, filename, replaced: Boolean(sha), publicPath: `/public/logos/${filename}` });
}

async function pagesUsing(filename) {
  // bundle copy of pages/ — may lag GitHub by one deploy, acceptable for a delete guard
  // (the build's own missing-logo check is the hard backstop).
  try {
    const dir = path.join(process.cwd(), 'pages');
    const hits = [];
    for (const f of (await readdir(dir)).filter(x => x.endsWith('.json'))) {
      const cfg = JSON.parse(await readFile(path.join(dir, f), 'utf8'));
      if ((cfg.tools && cfg.tools.items || []).some(t => t.file === filename)) hits.push(cfg.slug);
    }
    return hits;
  } catch { return []; }
}

function passwordOk(given) {
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected || typeof given !== 'string') return false;
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

async function readJson(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  return await new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}
