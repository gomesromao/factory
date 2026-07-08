// Build: renders every pages/*.json through the template into dist/<slug>/index.html,
// copies shared assets, and assembles /admin with the template + renderer + logo list injected.
// No dependencies — plain Node. Vercel build command: `node scripts/build.js`, output dir: `dist`.
const fs = require('fs');
const path = require('path');
const { render } = require('../lib/render.js');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const template = fs.readFileSync(path.join(ROOT, 'template/page.template.html'), 'utf8');
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

// 2. pages
const slugs = [];
for (const f of fs.readdirSync(path.join(ROOT, 'pages')).filter(f => f.endsWith('.json'))) {
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'pages', f), 'utf8'));
  if (!/^[a-z0-9-]{3,60}$/.test(cfg.slug)) throw new Error('bad slug in ' + f);
  if (cfg.slug !== path.basename(f, '.json')) throw new Error('slug must match filename: ' + f);
  for (const t of cfg.tools.items) {
    if (!logoLibrary.has(t.file)) throw new Error(`Missing logo file: ${t.file} (page ${cfg.slug}) — not in shared/public/logos/`);
  }
  const html = render(template, cfg, testimonials);
  fs.mkdirSync(path.join(DIST, cfg.slug), { recursive: true });
  fs.writeFileSync(path.join(DIST, cfg.slug, 'index.html'), html);
  slugs.push({ slug: cfg.slug, title: cfg.meta.title, subdomain: cfg.subdomain || null });
  console.log('built /' + cfg.slug + '/');
}

// 3. admin: inject template, renderer, testimonials, logo list
const logos = fs.readdirSync(path.join(ROOT, 'shared/public/logos')).filter(f => /\.(png|webp)$/.test(f)).sort();
let admin = fs.readFileSync(path.join(ROOT, 'admin/index.html'), 'utf8');
// NOTE: function replacements so "$&"/"$'" inside the payloads are not treated as
// special replacement patterns by String.replace (the template contains "$&" in readCookie).
admin = admin
  .replace('/*__RENDER_JS__*/', () => fs.readFileSync(path.join(ROOT, 'lib/render.js'), 'utf8'))
  .replace('"__TEMPLATE__"', () => JSON.stringify(template))
  .replace('"__TESTIMONIALS__"', () => JSON.stringify(testimonials))
  .replace('"__LOGOS__"', () => JSON.stringify(logos));
fs.mkdirSync(path.join(DIST, 'admin'), { recursive: true });
fs.writeFileSync(path.join(DIST, 'admin', 'index.html'), admin);

// 4. root index: plain list of built pages (handy sanity page)
fs.writeFileSync(path.join(DIST, 'index.html'),
  '<!DOCTYPE html><meta charset="utf-8"><title>Coconut LP Factory</title>' +
  '<body style="font-family:sans-serif;padding:40px"><h1>Coconut LP Factory</h1><ul>' +
  slugs.map(s => `<li><a href="/${s.slug}/">${s.slug}</a> — ${s.title}${s.subdomain ? ' — ' + s.subdomain : ''}</li>`).join('') +
  '</ul><p><a href="/admin/">Page builder</a></p></body>');

console.log('build done: ' + slugs.length + ' page(s), admin, shared assets');
