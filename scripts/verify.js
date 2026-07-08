// Fidelity proof: the factory build must reproduce the live repos (ads5/ads6) exactly,
// modulo whitespace and the FAQ serialization style (compared structurally instead).
//   node scripts/verify.js <ads5-index.html> <ads6-index.html>
const fs = require('fs');
const vm = require('vm');

const [,, a5, a6] = process.argv;
const pairs = [
  ['dist/trades-office-admin/index.html', a5],
  ['dist/trades-bookkeeper/index.html', a6]
];

function faqs(html) {
  const m = html.match(/var faqs = (\[[\s\S]*?\]);\s*\n\s*var list/);
  return vm.runInNewContext('(' + m[1] + ')');
}
function stripFaq(html) {
  return html.replace(/var faqs = \[[\s\S]*?\];\s*\n(\s*var list)/, 'var faqs = FAQS;\n$1');
}
function norm(html) {
  html = html.replace(/utm_source=[\w-]+/g, 'utm_source=X'); // utm now derives from slug (intentional fix vs prod)
  html = html.replace(/\s*<meta name="robots" content="noindex, nofollow" \/>/, ''); // factory-only addition
  return stripFaq(html).split('\n').map(l => l.trim()).filter(Boolean).join('\n');
}

let fail = 0;
for (const [gen, orig] of pairs) {
  const G = fs.readFileSync(gen, 'utf8');
  const O = fs.readFileSync(orig, 'utf8');
  const structural = norm(G) === norm(O);
  const faqEqual = JSON.stringify(faqs(G)) === JSON.stringify(faqs(O));
  console.log(`${gen}: structural=${structural ? 'MATCH' : 'DIFF'} faq=${faqEqual ? 'MATCH' : 'DIFF'}`);
  if (!structural) {
    const g = norm(G).split('\n'), o = norm(O).split('\n');
    for (let i = 0; i < Math.max(g.length, o.length); i++) {
      if (g[i] !== o[i]) { console.log('  first diff at line', i, '\n   gen:', (g[i] || '').slice(0, 120), '\n  orig:', (o[i] || '').slice(0, 120)); break; }
    }
    fail++;
  }
  if (!faqEqual) fail++;
}
process.exit(fail ? 1 : 0);
