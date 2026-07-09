// POST /api/publish — commits a page config to GitHub (Contents API) and emails the admins.
// Body: { password, slug, config }. The Vercel Git integration then redeploys automatically (~2 min).
// Env: ADMIN_PASSWORD (required), GITHUB_TOKEN + GITHUB_REPO (required, e.g. "user/coconut-lp-factory"),
//      GITHUB_BRANCH (default "main"), PROD_BASE_URL (e.g. "https://go.coconutva.com"),
//      RESEND_API_KEY + ADMIN_EMAILS (optional — comma-separated; enables the notification email).
import crypto from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const REQUIRED_STRINGS = [
  ['meta', 'title'], ['meta', 'description'], ['meta', 'ogDescription'],
  ['hero', 'eyebrow'], ['hero', 'h1'], ['hero', 'accent'], ['hero', 'lead'],
  ['form', 'step1Button'], ['form', 'step2Sub'], ['form', 'needLabel'],
  ['form', 'successText'], ['form', 'browseUrl'],
  ['ctaBanner', 'heading'], ['ctaBanner', 'sub']
];

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }
  const body = await readJson(req);

  if (!passwordOk(body && body.password)) return res.status(401).json({ ok: false, error: 'bad_password' });

  const slug = body && body.slug;
  const cfg = body && body.config;
  const err = await validate(slug, cfg);
  if (err) return res.status(400).json({ ok: false, error: err });

  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPO;
  const branch = process.env.GITHUB_BRANCH || 'main';
  if (!token || !repo) return res.status(500).json({ ok: false, error: 'github_not_configured' });

  const apiUrl = `https://api.github.com/repos/${repo}/contents/pages/${slug}.json`;
  const gh = (url, opts = {}) => fetch(url, {
    ...opts,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'coconut-lp-factory',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(opts.headers || {})
    }
  });

  // fetch current sha if the file exists (update vs create)
  let sha;
  const cur = await gh(`${apiUrl}?ref=${branch}`);
  if (cur.status === 200) sha = (await cur.json()).sha;
  else if (cur.status !== 404) {
    return res.status(502).json({ ok: false, error: 'github_read_failed', detail: cur.status });
  }

  const content = Buffer.from(JSON.stringify(cfg, null, 2) + '\n').toString('base64');
  const put = await gh(apiUrl, {
    method: 'PUT',
    body: JSON.stringify({
      message: `builder: ${sha ? 'update' : 'create'} ${slug}`,
      content, branch, ...(sha ? { sha } : {})
    })
  });
  if (!put.ok) {
    console.error('github PUT failed', put.status, await put.text());
    return res.status(502).json({ ok: false, error: 'github_write_failed', detail: put.status });
  }
  const putBody = await put.json();
  const commitUrl = putBody.commit && putBody.commit.html_url;
  const base = process.env.PROD_BASE_URL || '';
  const pageUrl = base ? `${base.replace(/\/$/, '')}/${slug}/` : `/${slug}/`;

  await safe(() => notifyAdmins({ slug, cfg, pageUrl, commitUrl, isNew: !sha }), 'email');

  return res.status(200).json({ ok: true, slug, pageUrl, commitUrl, created: !sha });
}

/* ---------------- validation ---------------- */

async function validate(slug, cfg) {
  if (!/^[a-z0-9-]{3,60}$/.test(slug || '')) return 'bad_slug';
  if (!cfg || typeof cfg !== 'object') return 'missing_config';
  if (cfg.slug !== slug || cfg.variant !== slug) return 'slug_variant_mismatch';
  if (!cfg.adsName || !cfg.pageLabel) return 'missing_adsName_or_pageLabel';
  for (const [a, b] of REQUIRED_STRINGS) {
    if (!cfg[a] || typeof cfg[a][b] !== 'string' || !cfg[a][b].trim()) return `missing_${a}.${b}`;
  }
  if (cfg.form.hours && (!Array.isArray(cfg.form.hours.options) || cfg.form.hours.options.length < 2 || !cfg.form.hours.label)) return 'bad_hours_field';
  if (!Array.isArray(cfg.form.needOptions) || cfg.form.needOptions.length < 2) return 'need_at_least_2_options';
  if (!Array.isArray(cfg.roles) || !cfg.roles.length) return 'missing_roles';
  if (!cfg.tools || !Array.isArray(cfg.tools.items) || !cfg.tools.items.length) return 'missing_tools';
  let logoLibrary = await freshLogoLibrary();
  if (!logoLibrary) {
    try { logoLibrary = new Set(await readdir(path.join(process.cwd(), 'shared/public/logos'))); } catch { logoLibrary = null; }
  }
  for (const t of cfg.tools.items) {
    if (!/^[\w-]+\.(png|webp)$/.test(t.file || '')) return 'bad_tool_file';
    if (logoLibrary && !logoLibrary.has(t.file)) return `unknown_logo:${t.file}`;
  }
  // adsName is the CRM filter + Meta content_name — must be unique across pages
  try {
    const dir = path.join(process.cwd(), 'pages');
    for (const f of (await readdir(dir)).filter(x => x.endsWith('.json'))) {
      const other = JSON.parse(await readFile(path.join(dir, f), 'utf8'));
      if (other.slug !== slug && other.adsName === cfg.adsName) return `adsName_taken_by:${other.slug}`;
    }
  } catch { /* pages dir missing in bundle would already break /api/lead — health catches it */ }
  if (!Array.isArray(cfg.wyg) || !cfg.wyg.length) return 'missing_wyg';
  if (!Array.isArray(cfg.faq) || !cfg.faq.length) return 'missing_faq';
  if (!Array.isArray(cfg.testimonialOrder) || cfg.testimonialOrder.length < 4 || cfg.testimonialOrder.length > 10) return 'testimonialOrder_must_have_4_to_10';
  try {
    const lib = JSON.parse(await readFile(path.join(process.cwd(), 'lib/testimonials.json'), 'utf8'));
    for (const n of cfg.testimonialOrder) if (!lib[n]) return `unknown_testimonial:${n}`;
  } catch { /* same note as above */ }
  if (!/^https:\/\//.test(cfg.redirectUrl || '')) return 'bad_redirectUrl';
  if (!/^https:\/\//.test(cfg.calendlyUrl || '')) return 'bad_calendlyUrl';
  return null;
}


// Live listing from GitHub so a logo uploaded seconds ago (commit done, deploy pending)
// validates correctly. Returns null on any failure — caller falls back to the bundled copy.
async function freshLogoLibrary() {
  const token = process.env.GITHUB_TOKEN, repo = process.env.GITHUB_REPO;
  if (!token || !repo) return null;
  try {
    const r = await fetch(`https://api.github.com/repos/${repo}/contents/shared/public/logos?ref=${process.env.GITHUB_BRANCH || 'main'}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'coconut-lp-factory', 'X-GitHub-Api-Version': '2022-11-28' }
    });
    if (!r.ok) return null;
    return new Set((await r.json()).map(f => f.name));
  } catch { return null; }
}

function passwordOk(given) {
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected || typeof given !== 'string') return false;
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

/* ---------------- admin notification (Resend) ---------------- */

async function notifyAdmins({ slug, cfg, pageUrl, commitUrl, isNew }) {
  const key = process.env.RESEND_API_KEY;
  const to = (process.env.ADMIN_EMAILS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!key || !to.length) { console.warn('Resend not configured — admin email skipped'); return; }
  const subject = `${isNew ? 'New LP published' : 'LP updated'}: ${cfg.meta.title}`;
  const subdomainNote = cfg.subdomain
    ? `<p><strong>Subdomain requested:</strong> ${cfg.subdomain}<br>
       Daniel: add the domain to the Vercel project, create the CNAME in Wix DNS, and add this rewrite to vercel.json:</p>
       <pre>{ "source": "/", "has": [{ "type": "host", "value": "${cfg.subdomain}" }], "destination": "/${slug}/" }</pre>`
    : '<p>No subdomain requested — the page is live on its path URL.</p>';
  const html = `
    <h2>${subject}</h2>
    <p><strong>Page:</strong> <a href="${pageUrl}">${pageUrl}</a> (live ~2 min after the deploy finishes)</p>
    <p><strong>Ads name (CRM):</strong> ${cfg.adsName} · <strong>Variant:</strong> ${slug}</p>
    ${subdomainNote}
    ${commitUrl ? `<p><a href="${commitUrl}">View commit</a></p>` : ''}`;
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: 'LP Factory <noreply@coconutva.com>', to, subject, html })
  });
  if (!r.ok) console.error('Resend error', r.status, await r.text());
}

/* ---------------- helpers ---------------- */

async function safe(fn, tag) {
  try { await fn(); } catch (e) { console.error(`Side-effect ${tag} failed`, e); }
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
