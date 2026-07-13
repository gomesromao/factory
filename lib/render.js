// Universal page renderer: template + page config + testimonials lib -> final HTML.
// Used by scripts/build.js (Node) AND the /admin live preview (browser) so the two can never diverge.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.LPRender = factory();
})(typeof self !== 'undefined' ? self : this, function () {

  function escAmp(s) { return String(s).replace(/&(?!amp;|lt;|gt;|quot;|#)/g, '&amp;'); }

  function needOptions(opts) {
    return opts.map(o => '                <option>' + escAmp(o) + '</option>').join('\n');
  }
  function rolePills(roles) {
    return roles.map(r => '        <span class="role-pill">' + escAmp(r) + '</span>').join('\n');
  }
  function toolChips(items) {
    return items.map(t =>
      '        <span class="stack-chip"><img src="/public/logos/' + t.file + '" alt="' + escAmp(t.alt) + '" /></span>'
    ).join('\n');
  }
  function wygRows(rows) {
    return rows.map((r, i) => {
      const num = String(i + 1).padStart(2, '0');
      const cls = r.featured ? 'wyg-row wyg-featured' : 'wyg-row';
      return '      <div class="' + cls + '"><div class="wyg-num">' + num + '</div><div class="wyg-text"><h4>' + r.title + '</h4><p>' + r.text + '</p></div></div>';
    }).join('\n');
  }
  function faqsJson(faq) {
    // pretty single-line-per-item, matching the hand-written style closely enough for humans
    return '[\n' + faq.map(f => '    ' + JSON.stringify({ q: f.q, a: f.a })).join(',\n') + '\n  ]';
  }
  function testimonialCards(order, lib) {
    return order.map(name => {
      const c = lib[name];
      if (!c) throw new Error('unknown testimonial: ' + name);
      return [
        '        <div class="review-card">',
        '          <div class="card-inner-content">',
        '            <img src="https://cdn.prod.website-files.com/67111c3384d75aea7ce2ff4a/67111c3384d75aea7ce2ff9c_S%20Star.svg" class="star-rating" alt="5 out of 5 stars" loading="lazy" decoding="async" width="90" height="20" />',
        '            <p class="testimonial-text">' + c.text + '</p>',
        '            <div class="client-info">',
        '              <p class="client-name">' + name + '</p>',
        '              <p class="client-title">' + c.title + '</p>',
        '            </div>',
        '            <img src="/public/testimonials/' + c.logoFile + '" class="company-logo" alt="' + c.logoAlt + '" loading="lazy" decoding="async" width="120" height="45" />',
        '          </div>',
        '          <img src="/public/testimonials/' + c.photoFile + '" class="client-image" alt="" loading="lazy" decoding="async" width="180" height="180" />',
        '        </div>'
      ].join('\n');
    }).join('\n');
  }

  function hoursBlocks(cfg) {
    const h = cfg.form.hours;
    if (h && Array.isArray(h.options) && h.options.length) {
      const opts = h.options.map(o => '                <option>' + escAmp(o) + '</option>').join('\n');
      return {
        field: '            <div class="field">\n              <label for="f-hours">' + escAmp(h.label) + '</label>\n              <select id="f-hours">\n                <option value="">Select one\u2026</option>\n' + opts + '\n              </select>\n            </div>\n',
        state: "{ name:'', email:'', company:'', helpHours:'', primaryNeed:'', phone:'', hiringTimeline:'' }",
        payload: 'primaryNeed: state.primaryNeed, helpHours: state.helpHours, phone: state.phone, hiringTimeline: state.hiringTimeline,',
        collect: "    state.company     = document.getElementById('f-company').value.trim();\n    state.helpHours   = document.getElementById('f-hours').value;\n    state.primaryNeed = document.getElementById('f-need').value;\n    if (!state.company)     { err2.textContent = 'Please enter your company.'; return; }\n    if (!state.helpHours)   { err2.textContent = 'Please pick how much help you need.'; return; }\n    if (!state.primaryNeed) { err2.textContent = 'Please pick one.'; return; }"
      };
    }
    return {
      field: '',
      state: "{ name:'', email:'', company:'', primaryNeed:'', phone:'', hiringTimeline:'' }",
      payload: 'primaryNeed: state.primaryNeed, phone: state.phone, hiringTimeline: state.hiringTimeline,',
      collect: "    state.company     = document.getElementById('f-company').value.trim();\n    state.primaryNeed = document.getElementById('f-need').value;\n    if (!state.company)     { err2.textContent = 'Please enter your company.'; return; }\n    if (!state.primaryNeed) { err2.textContent = 'Please pick one.'; return; }"
    };
  }

  // utm_source is ALWAYS the page slug — clones can never inherit another page's attribution.
  function forceUtmSource(url, slug) {
    if (!/^https:\/\//.test(url || '')) throw new Error('calendlyUrl must be https');
    var base = url.split('#')[0];
    var hash = url.indexOf('#') >= 0 ? url.slice(url.indexOf('#')) : '';
    var qIdx = base.indexOf('?');
    var path = qIdx >= 0 ? base.slice(0, qIdx) : base;
    var params = qIdx >= 0 ? base.slice(qIdx + 1).split('&').filter(function (p) {
      return p && p.split('=')[0] !== 'utm_source';
    }) : [];
    params.push('utm_source=' + encodeURIComponent(slug));
    return path + '?' + params.join('&') + hash;
  }

  function render(template, cfg, testimonials, logoSources) {
    let h = template;
    const scalars = {
      '{{meta.title}}': cfg.meta.title,
      '{{meta.description}}': cfg.meta.description,
      '{{meta.ogDescription}}': cfg.meta.ogDescription,
      '{{hero.eyebrow|escAmp}}': escAmp(cfg.hero.eyebrow),
      '{{hero.h1}}': cfg.hero.h1,
      '{{hero.accent}}': cfg.hero.accent,
      '{{hero.lead}}': cfg.hero.lead,
      '{{form.step1Button}}': cfg.form.step1Button,
      '{{form.step2Sub}}': cfg.form.step2Sub,
      '{{form.needLabel}}': cfg.form.needLabel,
      '{{form.successText}}': cfg.form.successText,
      '{{form.browseUrl}}': cfg.form.browseUrl,
      '{{tools.wrapMaxWidth}}': String(cfg.tools.wrapMaxWidth),
      '{{tools.chipHeight}}': String(cfg.tools.chipHeight),
      '{{tools.imgHeight}}': String(cfg.tools.imgHeight),
      '{{tools.imgMaxWidth}}': String(cfg.tools.imgMaxWidth),
      '{{ctaBanner.heading}}': cfg.ctaBanner.heading,
      '{{ctaBanner.sub}}': cfg.ctaBanner.sub,
      '{{calendlyUrl}}': forceUtmSource(cfg.calendlyUrl, cfg.slug),
      '{{redirectUrl}}': cfg.redirectUrl,
      '{{variant}}': cfg.variant,
      '{{adsName}}': cfg.adsName
    };
    for (const [ph, v] of Object.entries(scalars)) {
      if (v === undefined || v === null) throw new Error('missing config value for ' + ph);
      h = h.split(ph).join(v);
    }
    const hb = hoursBlocks(cfg);
    h = h.replace('{{HOURS_FIELD}}', hb.field);
    h = h.replace('{{STATE_LINE}}', hb.state);
    h = h.replace('{{PAYLOAD_LINE}}', hb.payload);
    h = h.replace('{{CONTINUE_COLLECT}}', hb.collect);
    h = h.replace('{{NEED_OPTIONS}}', needOptions(cfg.form.needOptions));
    h = h.replace('{{ROLE_PILLS}}', rolePills(cfg.roles));
    h = h.replace('{{TOOL_CHIPS}}', toolChips(cfg.tools.items));
    h = h.replace('{{WYG_ROWS}}', wygRows(cfg.wyg));
    h = h.replace('{{FAQS_JSON}}', faqsJson(cfg.faq));
    h = h.replace('{{TESTIMONIAL_CARDS}}', testimonialCards(cfg.testimonialOrder, testimonials));
    // Logo.dev free-tier attribution: only on pages that actually display a fetched logo.
    // Provenance lives in lib/logo-sources.json (written by /api/logo when source === 'logo.dev').
    const srcs = logoSources || {};
    const usesLogoDev = (cfg.tools && cfg.tools.items || []).some(function (t) { return srcs[t.file] === 'logo.dev'; });
    h = h.split('{{LOGODEV_ATTRIBUTION}}').join(usesLogoDev
      ? ' \u00B7 <a href="https://logo.dev" rel="noopener nofollow" style="opacity:.75">Logos provided by Logo.dev</a>'
      : '');
    const leftover = h.match(/\{\{[\w.|]+\}\}/g);
    if (leftover) throw new Error('unresolved placeholders: ' + leftover.join(', '));
    return h;
  }

  return { render: render };
});
