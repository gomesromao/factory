// POST /api/face — uploads a face photo (png/webp, transparent bg) into shared/public/faces/
// via a GitHub commit, then upserts the entry in shared/public/faces/manifest.json (which the
// creative generator's modal loads at runtime). Two sequential commits; unlike the logo
// provenance registry, the manifest write is NOT best-effort — a face missing from the
// manifest is invisible, so a manifest failure is reported as an error.
// Auth: same shared ADMIN_PASSWORD as the rest of the admin APIs.
import crypto from 'node:crypto';

const MAX_BYTES = 512 * 1024;
const MANIFEST_PATH = 'shared/public/faces/manifest.json';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }
  const body = await readJson(req);
  if (!passwordOk(body && body.password)) return res.status(401).json({ ok: false, error: 'bad_password' });

  const name = String((body && body.name) || '').trim();
  if (!name || name.length > 40) return res.status(400).json({ ok: false, error: 'bad_name' });
  const filename = body && body.filename;
  if (!/^[a-z0-9][a-z0-9-]{0,50}\.(png|webp)$/.test(filename || '')) {
    return res.status(400).json({ ok: false, error: 'bad_filename' });
  }

  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPO;
  const branch = process.env.GITHUB_BRANCH || 'main';
  if (!token || !repo) return res.status(500).json({ ok: false, error: 'github_not_configured' });
  const gh = (url, opts = {}) => fetch(url, {
    ...opts,
    headers: {
      Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json',
      'User-Agent': 'coconut-lp-factory', 'X-GitHub-Api-Version': '2022-11-28', ...(opts.headers || {})
    }
  });

  // ---- validate content ----
  const b64 = body && body.contentBase64;
  if (!b64 || typeof b64 !== 'string') return res.status(400).json({ ok: false, error: 'missing_content' });
  let buf;
  try { buf = Buffer.from(b64, 'base64'); } catch { return res.status(400).json({ ok: false, error: 'bad_base64' }); }
  if (!buf.length || buf.length > MAX_BYTES) return res.status(400).json({ ok: false, error: 'too_large_max_512kb' });
  const isPng = buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  const isWebp = buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP';
  if (filename.endsWith('.png') ? !isPng : !isWebp) return res.status(400).json({ ok: false, error: 'content_does_not_match_extension' });

  // ---- commit 1: the image ----
  const imgUrl = `https://api.github.com/repos/${repo}/contents/shared/public/faces/${filename}`;
  let imgSha;
  const cur = await gh(`${imgUrl}?ref=${branch}`);
  if (cur.status === 200) imgSha = (await cur.json()).sha;
  else if (cur.status !== 404) return res.status(502).json({ ok: false, error: 'github_read_failed', detail: cur.status });

  const put = await gh(imgUrl, {
    method: 'PUT',
    body: JSON.stringify({ message: `creatives: ${imgSha ? 'update' : 'add'} face ${filename}`, content: b64, branch, ...(imgSha ? { sha: imgSha } : {}) })
  });
  if (!put.ok) {
    console.error('face PUT failed', put.status, await put.text());
    return res.status(502).json({ ok: false, error: 'github_write_failed', detail: put.status });
  }

  // ---- commit 2: the manifest (required, not best-effort) ----
  const manUrl = `https://api.github.com/repos/${repo}/contents/${MANIFEST_PATH}`;
  let manifest = [], manSha;
  const curMan = await gh(`${manUrl}?ref=${branch}`);
  if (curMan.status === 200) {
    const j = await curMan.json();
    manSha = j.sha;
    try { manifest = JSON.parse(Buffer.from(j.content, 'base64').toString('utf8')); } catch { manifest = []; }
  } else if (curMan.status !== 404) {
    return res.status(502).json({ ok: false, error: 'manifest_read_failed', detail: curMan.status, imageCommitted: true });
  }
  if (!Array.isArray(manifest)) manifest = [];
  manifest = manifest.filter(e => e && e.file !== filename);
  manifest.push({ file: filename, name });
  manifest.sort((a, b) => String(a.name).localeCompare(String(b.name)));

  const putMan = await gh(manUrl, {
    method: 'PUT',
    body: JSON.stringify({
      message: `creatives: manifest ${filename} (${name})`,
      content: Buffer.from(JSON.stringify(manifest, null, 2) + '\n').toString('base64'),
      branch, ...(manSha ? { sha: manSha } : {})
    })
  });
  if (!putMan.ok) {
    console.error('manifest PUT failed', putMan.status, await putMan.text());
    return res.status(502).json({ ok: false, error: 'manifest_write_failed', detail: putMan.status, imageCommitted: true });
  }

  return res.status(200).json({ ok: true, file: filename, name, replaced: Boolean(imgSha), manifest });
}

function passwordOk(given) {
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected || typeof given !== 'string') return false;
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

function readJson(req) {
  if (req.body && typeof req.body === 'object') return Promise.resolve(req.body);
  return new Promise((resolve) => {
    let data = '';
    req.on('data', c => { data += c; });
    req.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(null); } });
  });
}
