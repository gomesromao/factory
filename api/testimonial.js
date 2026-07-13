// POST /api/testimonial — adds or updates a testimonial: commits the person's photo +
// company logo into shared/public/testimonials/ and rewrites lib/testimonials.json.
// DELETE /api/testimonial — removes one, refusing if any page's testimonialOrder uses it.
// Auth: same shared ADMIN_PASSWORD. Images are normalized client-side (B&W photo, resized);
// this endpoint is the backstop: password, filename regex, size caps, magic bytes.
// Write order matters: POST commits images first, then the JSON that references them;
// DELETE removes the JSON reference first, then images (a failed image delete only orphans a file).
import crypto from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const MAX_BYTES = 512 * 1024;
const LIB_PATH = 'lib/testimonials.json';
const ASSET_DIR = 'shared/public/testimonials';

export default async function handler(req, res) {
  if (req.method !== 'POST' && req.method !== 'DELETE') {
    res.setHeader('Allow', 'POST, DELETE');
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }
  const body = await readJson(req);
  if (!passwordOk(body && body.password)) return res.status(401).json({ ok: false, error: 'bad_password' });

  const name = typeof (body && body.name) === 'string' ? body.name.trim() : '';
  if (!name || name.length > 60) return res.status(400).json({ ok: false, error: 'bad_name' });

  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPO;
  const branch = process.env.GITHUB_BRANCH || 'main';
  if (!token || !repo) return res.status(500).json({ ok: false, error: 'github_not_configured' });
  const gh = (url, opts = {}) => fetch(`https://api.github.com/repos/${repo}${url}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json',
      'User-Agent': 'coconut-lp-factory', 'X-GitHub-Api-Version': '2022-11-28', ...(opts.headers || {})
    }
  });

  // fresh library from GitHub (sha needed for the rewrite)
  const libRes = await gh(`/contents/${LIB_PATH}?ref=${branch}`);
  if (libRes.status !== 200) return res.status(502).json({ ok: false, error: 'github_read_failed', detail: libRes.status });
  const libFile = await libRes.json();
  let lib;
  try { lib = JSON.parse(Buffer.from(libFile.content, 'base64').toString('utf8')); }
  catch { return res.status(502).json({ ok: false, error: 'library_parse_failed' }); }

  if (req.method === 'DELETE') {
    if (!lib[name]) return res.status(404).json({ ok: false, error: 'not_found' });
    const usedBy = await pagesUsing(name);
    if (usedBy.length) return res.status(409).json({ ok: false, error: 'testimonial_in_use', pages: usedBy });
    const entry = lib[name];
    delete lib[name];
    const put = await putJson(gh, libFile.sha, lib, branch, `builder: delete testimonial ${name}`);
    if (!put.ok) return res.status(502).json({ ok: false, error: 'github_write_failed', detail: put.status });
    // best-effort image cleanup — skip any file another entry still references
    const stillUsed = new Set();
    for (const e of Object.values(lib)) { stillUsed.add(e.photoFile); stillUsed.add(e.logoFile); }
    for (const f of [entry.photoFile, entry.logoFile]) {
      if (!f || stillUsed.has(f)) continue;
      const cur = await gh(`/contents/${ASSET_DIR}/${f}?ref=${branch}`);
      if (cur.status !== 200) continue;
      const { sha } = await cur.json();
      await gh(`/contents/${ASSET_DIR}/${f}`, { method: 'DELETE', body: JSON.stringify({ message: `builder: delete testimonial asset ${f}`, sha, branch }) });
    }
    return res.status(200).json({ ok: true, deleted: name });
  }

  // POST — validate the full payload
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  const logoAlt = typeof body.logoAlt === 'string' ? body.logoAlt.trim() : '';
  if (text.length < 10 || text.length > 700) return res.status(400).json({ ok: false, error: 'bad_text_10_to_700_chars' });
  if (!title || title.length > 120) return res.status(400).json({ ok: false, error: 'bad_title' });
  if (!logoAlt || logoAlt.length > 60) return res.status(400).json({ ok: false, error: 'bad_logoAlt' });

  const replacing = Boolean(lib[name]);
  const images = [];
  for (const kind of ['photo', 'logo']) {
    const fn = body[kind + 'Filename'], b64 = body[kind + 'Base64'];
    if (!fn && !b64) {
      // updating text only is allowed when the entry already exists (keep current assets)
      if (!replacing) return res.status(400).json({ ok: false, error: `missing_${kind}` });
      continue;
    }
    if (!/^[a-z0-9][a-z0-9-]{1,60}\.(png|webp)$/.test(fn || '')) return res.status(400).json({ ok: false, error: `bad_${kind}_filename` });
    let buf;
    try { buf = Buffer.from(b64 || '', 'base64'); } catch { return res.status(400).json({ ok: false, error: `bad_${kind}_base64` }); }
    if (!buf.length || buf.length > MAX_BYTES) return res.status(400).json({ ok: false, error: `${kind}_too_large_max_512kb` });
    const isPng = buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
    const isWebp = buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP';
    if (fn.endsWith('.png') ? !isPng : !isWebp) return res.status(400).json({ ok: false, error: `${kind}_content_does_not_match_extension` });
    images.push({ kind, fn, b64 });
  }

  // 1) commit images
  for (const img of images) {
    const cur = await gh(`/contents/${ASSET_DIR}/${img.fn}?ref=${branch}`);
    let sha;
    if (cur.status === 200) sha = (await cur.json()).sha;
    else if (cur.status !== 404) return res.status(502).json({ ok: false, error: 'github_read_failed', detail: cur.status });
    const put = await gh(`/contents/${ASSET_DIR}/${img.fn}`, {
      method: 'PUT',
      body: JSON.stringify({ message: `builder: ${sha ? 'update' : 'add'} testimonial asset ${img.fn}`, content: img.b64, branch, ...(sha ? { sha } : {}) })
    });
    if (!put.ok) return res.status(502).json({ ok: false, error: 'github_write_failed', detail: put.status });
  }

  // 2) rewrite the library referencing them
  const prev = lib[name] || {};
  const photoImg = images.find(i => i.kind === 'photo');
  const logoImg = images.find(i => i.kind === 'logo');
  lib[name] = {
    text, title, logoAlt,
    logoFile: logoImg ? logoImg.fn : prev.logoFile,
    photoFile: photoImg ? photoImg.fn : prev.photoFile
  };
  const put = await putJson(gh, libFile.sha, lib, branch, `builder: ${replacing ? 'update' : 'add'} testimonial ${name}`);
  if (!put.ok) return res.status(502).json({ ok: false, error: 'github_write_failed', detail: put.status });
  return res.status(200).json({ ok: true, name, replaced: replacing, entry: lib[name] });
}

async function putJson(gh, sha, lib, branch, message) {
  return gh(`/contents/${LIB_PATH}`, {
    method: 'PUT',
    body: JSON.stringify({
      message,
      content: Buffer.from(JSON.stringify(lib, null, 2) + '\n').toString('base64'),
      sha, branch
    })
  });
}

async function pagesUsing(name) {
  // bundle copy of pages/ — may lag GitHub by one deploy; acceptable for a delete guard.
  try {
    const dir = path.join(process.cwd(), 'pages');
    const hits = [];
    for (const f of (await readdir(dir)).filter(x => x.endsWith('.json'))) {
      const cfg = JSON.parse(await readFile(path.join(dir, f), 'utf8'));
      if ((cfg.testimonialOrder || []).indexOf(name) !== -1) hits.push(cfg.slug);
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
