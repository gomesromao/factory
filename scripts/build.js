// Build: renders every pages/*.json through the template into dist/<slug>/index.html,
// copies shared assets, and assembles /admin with the template + renderer + logo list injected.
// No dependencies — plain Node. Vercel build command: `node scripts/build.js`, output dir: `dist`.
const fs = require('fs');
const path = require('path');
const { render } = require('../lib/render.js');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const template = fs.readFileSync(path.join(ROOT, 'template/page.template.html'), 'utf8');
// Google Ads conversion tag: injected from env so activation is a Vercel env change + redeploy,
// never a code edit. Unset -> '' -> every Google Ads code path in the template is inert.
const GOOGLE_ADS_SEND_TO = (process.env.GOOGLE_ADS_SEND_TO || '').trim();
if (GOOGLE_ADS_SEND_TO && !/^AW-\d+\/[\w-]+$/.test(GOOGLE_ADS_SEND_TO)) {
  throw new Error(`GOOGLE_ADS_SEND_TO is set but malformed ("${GOOGLE_ADS_SEND_TO}") — expected AW-XXXXXXXXXX/label. Failing the build beats deploying broken tracking.`);
}
const templateFinal = template.split('{{GOOGLE_ADS_SEND_TO}}').join(GOOGLE_ADS_SEND_TO);
const testimonials = JSON.parse(fs.readFileSync(path.join(ROOT, 'lib/testimonials.json'), 'utf8'));

fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(DIST, { recursive: true });

// 1. shared assets -> dist/public
fs.cpSync(path.join(ROOT, 'shared/public'), path.join(DIST, 'public'), { recursive: true });

// Guard: a forgotten META_TEST_EVENT_CODE in production silently stops Lead events from
// feeding campaigns (the expense-recon zero-conversions bug). Fail the build instead.
if (process.env.VERCEL_ENV === 'production' && process.env.META_TEST_EVENT_CODE && !process.env.ALLOW_TEST_EVENT_CODE_IN_PROD) {
  throw new Error('META_TEST_EVENT_CODE is set in production. Remove it (or set ALLOW_TEST_EVENT_CODE_IN_PROD=1 for an intentional live test).');
}

const logoLibrary = new Set(fs.readdirSync(path.join(ROOT, 'shared/public/logos')));
const logoSources = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'lib/logo-sources.json'), 'utf8')); }
  catch { return {}; } // missing/invalid file just means: no attribution anywhere
})();

// 2. pages
const slugs = [];
for (const f of fs.readdirSync(path.join(ROOT, 'pages')).filter(f => f.endsWith('.json'))) {
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'pages', f), 'utf8'));
  if (!/^[a-z0-9-]{3,60}$/.test(cfg.slug)) throw new Error('bad slug in ' + f);
  if (cfg.slug !== path.basename(f, '.json')) throw new Error('slug must match filename: ' + f);
  for (const t of cfg.tools.items) {
    if (!logoLibrary.has(t.file)) throw new Error(`Missing logo file: ${t.file} (page ${cfg.slug}) — not in shared/public/logos/`);
  }
  const html = render(templateFinal, cfg, testimonials, logoSources);
  fs.mkdirSync(path.join(DIST, cfg.slug), { recursive: true });
  fs.writeFileSync(path.join(DIST, cfg.slug, 'index.html'), html);
  slugs.push({ slug: cfg.slug, title: cfg.meta.title, subdomain: cfg.subdomain || null });
  console.log('built /' + cfg.slug + '/');
}

// 3. admin: inject template, renderer, testimonials, logo list
const logos = fs.readdirSync(path.join(ROOT, 'shared/public/logos')).filter(f => /\.(png|webp)$/.test(f)).sort();
let admin = fs.readFileSync(path.join(ROOT, 'admin/index.html'), 'utf8');
// NOTE 1: function replacements so "$&" inside the payloads is not treated as a special
// replacement pattern by String.replace (the template contains "$&" in readCookie).
// NOTE 2: inlineJson escapes "</" as "<\/" — a literal "</script>" inside a JS string would
// otherwise terminate the inline <script> block early and dump the rest as page HTML.
const inlineJson = (x) => JSON.stringify(x).replace(/<\//g, '<\\/');
const renderSrc = fs.readFileSync(path.join(ROOT, 'lib/render.js'), 'utf8');
if (/<\/script/i.test(renderSrc)) throw new Error('lib/render.js must not contain "</script"');
admin = admin
  .replace('/*__RENDER_JS__*/', () => renderSrc)
  .replace('"__TEMPLATE__"', () => inlineJson(templateFinal))
  .replace('"__TESTIMONIALS__"', () => inlineJson(testimonials))
  .replace('"__LOGOS__"', () => inlineJson(logos))
  .replace('"__LOGO_SOURCES__"', () => inlineJson(logoSources));
fs.mkdirSync(path.join(DIST, 'admin'), { recursive: true });
fs.writeFileSync(path.join(DIST, 'admin', 'index.html'), admin);
// copy every other static file in admin/ (guide, pages index, future additions)
for (const f of fs.readdirSync(path.join(ROOT, 'admin'))) {
  if (f !== 'index.html') fs.copyFileSync(path.join(ROOT, 'admin', f), path.join(DIST, 'admin', f));
}

// 4. root index: plain list of built pages (handy sanity page)
// RB2B lives here too: their script validator opens the domain ROOT with a query string,
// so the snippet must exist on /, not only on the per-page LPs.
const RB2B_SNIPPET = '<script>!function(key) {if (window.reb2b) return;window.reb2b = {loaded: true};var s = document.createElement("script");s.async = true;s.src = "https://b2bjsstore.s3.us-west-2.amazonaws.com/b/" + key + "/" + key + ".js.gz";document.getElementsByTagName("script")[0].parentNode.insertBefore(s, document.getElementsByTagName("script")[0]);}("8XOE9GHK38OM");</script>';
fs.writeFileSync(path.join(DIST, 'index.html'),
  '<!DOCTYPE html><meta charset="utf-8"><title>Coconut LP Factory</title>' + RB2B_SNIPPET +
  '<body style="font-family:sans-serif;padding:40px"><h1>Coconut LP Factory</h1><ul>' +
  slugs.map(s => `<li><a href="/${s.slug}/">${s.slug}</a> — ${s.title}${s.subdomain ? ' — ' + s.subdomain : ''}</li>`).join('') +
  '</ul><p><a href="/admin/">Page builder</a></p></body>');

console.log('build done: ' + slugs.length + ' page(s), admin, shared assets');
