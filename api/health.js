// GET /api/health — post-deploy sanity check with zero side effects.
// Proves the exact failure mode that would break leads silently: whether the
// serverless bundle can actually read pages/*.json at runtime (includeFiles).
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

export default async function handler(req, res) {
  try {
    const dir = path.join(process.cwd(), 'pages');
    const files = (await readdir(dir)).filter(f => f.endsWith('.json'));
    const slugs = [];
    for (const f of files) {
      const cfg = JSON.parse(await readFile(path.join(dir, f), 'utf8'));
      if (!cfg.adsName || !Array.isArray(cfg.form.needOptions)) throw new Error('invalid config: ' + f);
      slugs.push(cfg.slug);
    }
    return res.status(200).json({ ok: true, pagesReadableAtRuntime: slugs.length, slugs, metaTestEventCodeActive: Boolean(process.env.META_TEST_EVENT_CODE) });
  } catch (e) {
    console.error('health failed', e);
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
}
