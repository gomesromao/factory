// One-time extraction: builds pages/*.json, lib/testimonials.json and template/page.template.html
// from the two live repos (ads5 = office, ads6 = bookkeeper). Run from repo root:
//   node scripts/extract.js <path-to-ads5-index> <path-to-ads6-index>
// The template is derived from ads5 by replacing every page-specific value with a placeholder,
// asserting each value occurs exactly where expected. Fidelity is proven later by scripts/verify.js.
const fs = require('fs');
const vm = require('vm');

const [,, ads5Path, ads6Path] = process.argv;
const A = fs.readFileSync(ads5Path, 'utf8');
const B = fs.readFileSync(ads6Path, 'utf8');

function one(html, re, name) {
  const m = html.match(re);
  if (!m) throw new Error('extract miss: ' + name);
  return m[1];
}
function all(html, re) { return Array.from(html.matchAll(re), m => m[1]); }
function decode(s) { return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'); }

function extract(html) {
  const cfg = {};
  cfg.meta = {
    title: one(html, /<title>([^<]+)<\/title>/, 'title'),
    description: one(html, /<meta name="description" content="([^"]+)"/, 'desc')
  };
  cfg.hero = {
    eyebrow: decode(one(html, /class="hero-eyebrow">([^<]+)<\/span>/, 'eyebrow')),
    h1: one(html, /<h1>(.*?)<\/h1>/s, 'h1'),                 // keep <br> as-is
    accent: one(html, /class="hero-accent">([^<]+)<\/span>/, 'accent'),
    lead: one(html, /<p class="lead">(.*?)<\/p>/s, 'lead')   // may contain <strong>
  };
  cfg.form = {
    step1Button: one(html, /id="nextBtn" type="button">([^<]+)<\/button>/, 'step1btn'),
    step2Sub: one(html, /id="step2">\s*<h3>[^<]*<\/h3>\s*<p class="sub">([^<]+)<\/p>/, 'step2sub'),
    needLabel: one(html, /<label for="f-need">([^<]+)<\/label>/, 'needLabel'),
    needOptions: all(one(html, /<select id="f-need">([\s\S]*?)<\/select>/, 'needSel'), /<option>([^<]+)<\/option>/g).map(decode),
    successText: one(html, /id="formSuccess">[\s\S]*?<p>([^<]+)<\/p>/, 'successText'),
    browseUrl: one(html, /id="browseBtn" href="([^"]+)"/, 'browseUrl')
  };
  const hoursSel = html.match(/<label for="f-hours">([^<]+)<\/label>\s*<select id="f-hours">([\s\S]*?)<\/select>/);
  if (hoursSel) {
    cfg.form.hours = { label: hoursSel[1], options: all(hoursSel[2], /<option>([^<]+)<\/option>/g).map(decode) };
  }
  cfg.roles = all(one(html, /<div class="roles-wrap">([\s\S]*?)<\/div>/, 'roles'), /<span class="role-pill">([^<]+)<\/span>/g).map(decode);
  cfg.tools = {
    wrapMaxWidth: parseInt(one(html, /\.stack-wrap\s*\{[\s\S]*?max-width:\s*(\d+)px; margin: 0 auto;/, 'wrapMax')),
    chipHeight: parseInt(one(html, /\.stack-chip\s*\{[\s\S]*?height:\s*(\d+)px;\s*\n\s*padding: 0 16px;/, 'chipH')),
    imgHeight: parseInt(one(html, /\.stack-chip img\s*\{\s*\n\s*height:\s*(\d+)px;/, 'imgH')),
    imgMaxWidth: parseInt(one(html, /\.stack-chip img\s*\{[\s\S]*?max-width:\s*(\d+)px;/, 'imgMax')),
    items: Array.from(one(html, /<div class="stack-wrap">([\s\S]*?)<\/div>/, 'stack')
      .matchAll(/<img src="\/public\/logos\/([^"]+)" alt="([^"]+)"/g), m => ({ file: m[1], alt: m[2] }))
  };
  const wygList = one(html, /<div class="wyg-list">([\s\S]*?)<\/div>\s*<div class="wyg-cta-wrap">/, 'wyg');
  cfg.wyg = Array.from(wygList.matchAll(/<div class="wyg-row( wyg-featured)?"><div class="wyg-num">(\d+)<\/div><div class="wyg-text"><h4>([\s\S]*?)<\/h4><p>([\s\S]*?)<\/p><\/div><\/div>/g),
    m => ({ featured: !!m[1], title: m[3], text: m[4] }));
  cfg.ctaBanner = {
    heading: one(html, /<div class="cta-banner">[\s\S]*?<h2>([^<]+)<\/h2>/, 'ctaH'),
    sub: one(html, /<div class="cta-banner">[\s\S]*?<h2>[^<]+<\/h2>\s*<p>([^<]+)<\/p>/, 'ctaP')
  };
  cfg.calendlyUrl = one(html, /faq-cta-text">[\s\S]*?<a href="([^"]+)"/, 'calendly');
  // faqs: evaluate the literal JS array safely
  const faqSrc = one(html, /var faqs = (\[[\s\S]*?\]);\s*\n\s*var list/, 'faqs');
  cfg.faq = vm.runInNewContext('(' + faqSrc + ')');
  cfg.variant = one(html, /var VARIANT = '([^']+)';/, 'variant');
  cfg.redirectUrl = one(html, /var REDIRECT_URL = '([^']+)';/, 'redirect');
  cfg.contentName = one(html, /content_name: '([^']+)' \}, \{ eventID/, 'contentName');
  cfg.testimonialOrder = all(html, /<p class="client-name">([^<]+)<\/p>/g)
    .slice(0, 6); // first 6 (JS clones them at runtime; static HTML has 6)
  return cfg;
}

const office = extract(A);
const books = extract(B);

// ---- shared testimonials library (cards are identical across pages; only order differs)
const cardRe = /<div class="review-card">\s*<div class="card-inner-content">([\s\S]*?)<\/div>\s*<img src="\/public\/testimonials\/[^"]*" class="client-image"[\s\S]*?\/>\s*<\/div>/g;
const cards = {};
for (const m of A.matchAll(/<div class="review-card">[\s\S]*?client-image[\s\S]*?\/>\s*<\/div>/g)) {
  const block = m[0];
  const name = one(block, /class="client-name">([^<]+)</, 'cardName');
  cards[name] = {
    text: one(block, /class="testimonial-text">([\s\S]*?)<\/p>/, 'cardText'),
    title: one(block, /class="client-title">([\s\S]*?)<\/p>/, 'cardTitle'), // includes <strong>Company</strong>
    logoFile: one(block, /src="\/public\/testimonials\/([^"]+)" class="company-logo"/, 'cardLogo'),
    logoAlt: one(block, /class="company-logo" alt="([^"]+)"/, 'cardLogoAlt'),
    photoFile: one(block, /src="\/public\/testimonials\/([^"]+)" class="client-image"/, 'cardPhoto')
  };
}
if (Object.keys(cards).length !== 6) throw new Error('expected 6 testimonial cards, got ' + Object.keys(cards).length);
fs.writeFileSync('lib/testimonials.json', JSON.stringify(cards, null, 2));

// ---- final page configs
function pageConfig(cfg, extra) {
  return Object.assign({
    slug: cfg.variant, variant: cfg.variant,
    adsName: cfg.contentName,
    pageLabel: extra.pageLabel, subdomain: extra.subdomain,
    meta: cfg.meta, hero: cfg.hero, form: cfg.form,
    roles: cfg.roles, tools: cfg.tools, wyg: cfg.wyg,
    ctaBanner: cfg.ctaBanner, faq: cfg.faq,
    calendlyUrl: cfg.calendlyUrl, redirectUrl: cfg.redirectUrl,
    testimonialOrder: cfg.testimonialOrder
  });
}
fs.writeFileSync('pages/trades-office-admin.json', JSON.stringify(pageConfig(office, { pageLabel: 'Trades Office Admin', subdomain: 'office.coconutva.com' }), null, 2));
fs.writeFileSync('pages/trades-bookkeeper.json', JSON.stringify(pageConfig(books, { pageLabel: 'Trades Bookkeeper', subdomain: 'books.coconutva.com' }), null, 2));

// ---- template: replace each office value in ads5 html with a placeholder
let T = A;
function sub(value, ph, expect = 1) {
  const n = T.split(value).length - 1;
  if (n !== expect) throw new Error(`template sub "${ph}": found ${n}, expected ${expect}\nvalue: ${String(value).slice(0,80)}`);
  T = T.split(value).join(ph);
}
sub('<title>' + office.meta.title + '</title>', '<title>{{meta.title}}</title>');
sub('content="' + office.meta.title + '"', 'content="{{meta.title}}"', 2);           // og + twitter
sub('content="' + office.meta.description + '"', 'content="{{meta.description}}"', 1);
// og/twitter descriptions differ slightly from meta description in both pages — keep og desc as its own?
// Check: extract og desc from both.
const ogDescA = one(A, /property="og:description" content="([^"]+)"/, 'ogA');
const ogDescB = one(B, /property="og:description" content="([^"]+)"/, 'ogB');
sub('content="' + ogDescA + '"', 'content="{{meta.ogDescription}}"', 2);              // og + twitter share it
// store in configs
for (const [f, d] of [['pages/trades-office-admin.json', ogDescA], ['pages/trades-bookkeeper.json', ogDescB]]) {
  const j = JSON.parse(fs.readFileSync(f, 'utf8')); j.meta.ogDescription = d;
  fs.writeFileSync(f, JSON.stringify(j, null, 2));
}
sub('class="hero-eyebrow">For roofers, electricians, plumbers &amp; HVAC pros</span>', 'class="hero-eyebrow">{{hero.eyebrow|escAmp}}</span>');
sub('<h1>' + office.hero.h1 + '</h1>', '<h1>{{hero.h1}}</h1>');
sub('class="hero-accent">' + office.hero.accent + '</span>', 'class="hero-accent">{{hero.accent}}</span>');
sub('<p class="lead">' + office.hero.lead + '</p>', '<p class="lead">{{hero.lead}}</p>');
sub('id="nextBtn" type="button">' + office.form.step1Button + '</button>', 'id="nextBtn" type="button">{{form.step1Button}}</button>');
sub('<p class="sub">' + office.form.step2Sub + '</p>', '<p class="sub">{{form.step2Sub}}</p>');
sub('<label for="f-need">' + office.form.needLabel + '</label>', '<label for="f-need">{{form.needLabel}}</label>');
sub(one(A, /(<select id="f-need">[\s\S]*?<\/select>)/, 'sel'), '<select id="f-need">\n                <option value="">Select one…</option>\n{{NEED_OPTIONS}}\n              </select>');
sub('<p>' + office.form.successText + '</p>', '<p>{{form.successText}}</p>');
sub('id="browseBtn" href="' + office.form.browseUrl + '"', 'id="browseBtn" href="{{form.browseUrl}}"');
sub(one(A, /(<div class="roles-wrap">[\s\S]*?<\/div>)/, 'rw'), '<div class="roles-wrap">\n{{ROLE_PILLS}}\n      </div>');
sub(one(A, /(<div class="stack-wrap">[\s\S]*?<\/div>)/, 'sw'), '<div class="stack-wrap">\n{{TOOL_CHIPS}}\n      </div>');
sub('max-width: ' + office.tools.wrapMaxWidth + 'px; margin: 0 auto;', 'max-width: {{tools.wrapMaxWidth}}px; margin: 0 auto;');
sub('height: ' + office.tools.chipHeight + 'px;\n  padding: 0 16px;', 'height: {{tools.chipHeight}}px;\n  padding: 0 16px;');
sub('height: ' + office.tools.imgHeight + 'px;            /*', 'height: {{tools.imgHeight}}px;            /*');
sub('max-width: ' + office.tools.imgMaxWidth + 'px;        /*', 'max-width: {{tools.imgMaxWidth}}px;        /*');
sub(one(A, /(<div class="wyg-list">[\s\S]*?)<div class="wyg-cta-wrap">/, 'wl'), '<div class="wyg-list">\n{{WYG_ROWS}}\n    </div>\n    ');
sub('<h2>' + office.ctaBanner.heading + '</h2>', '<h2>{{ctaBanner.heading}}</h2>');
sub('<p>' + office.ctaBanner.sub + '</p>', '<p>{{ctaBanner.sub}}</p>');
sub('href="' + office.calendlyUrl + '"', 'href="{{calendlyUrl}}"');
sub("var REDIRECT_URL = '" + office.redirectUrl + "';", "var REDIRECT_URL = '{{redirectUrl}}';");
sub("var VARIANT = '" + office.variant + "';", "var VARIANT = '{{variant}}';");
sub("content_name: '" + office.contentName + "' }, { eventID", "content_name: '{{adsName}}' }, { eventID");
sub(one(A, /var faqs = (\[[\s\S]*?\]);\n  var list/, 'fq'), '{{FAQS_JSON}}');
sub(one(A, /(<div class="reviews-track" id="reviews-track">[\s\S]*?)<\/div>\s*<\/div>\s*<\/div>\s*<\/section>/, 'rt'), '<div class="reviews-track" id="reviews-track">\n{{TESTIMONIAL_CARDS}}\n      ');
// hours-aware placeholders (ads5 has no hours field; render.js re-creates ads6's exact blocks when cfg.form.hours exists)
sub('            <div class="field">\n              <label for="f-need">', '{{HOURS_FIELD}}            <div class="field">\n              <label for="f-need">');
sub("  var state = { name:'', email:'', company:'', primaryNeed:'', phone:'', hiringTimeline:'' };", '  var state = {{STATE_LINE}};');
sub("        primaryNeed: state.primaryNeed, phone: state.phone, hiringTimeline: state.hiringTimeline,", '        {{PAYLOAD_LINE}}');
sub("    state.company     = document.getElementById('f-company').value.trim();\n    state.primaryNeed = document.getElementById('f-need').value;\n    if (!state.company)     { err2.textContent = 'Please enter your company.'; return; }\n    if (!state.primaryNeed) { err2.textContent = 'Please pick one.'; return; }", '{{CONTINUE_COLLECT}}');
fs.writeFileSync('template/page.template.html', T);
console.log('extracted: 2 page configs, testimonials lib, template (' + T.length + ' bytes)');
console.log('office options:', office.form.needOptions.length, '| books options:', books.form.needOptions.length);
console.log('office wyg rows:', office.wyg.length, '| books wyg rows:', books.wyg.length);
console.log('office faqs:', office.faq.length, '| books faqs:', books.faq.length);
