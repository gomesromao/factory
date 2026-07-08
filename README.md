# Coconut LP Factory

One repo, one Vercel project, N ad landing pages. Every page is a single JSON config in
`pages/` rendered through a shared template at build time. A password-protected page builder
at `/admin` lets non-devs create and edit pages with a live preview; **Publish** commits the
JSON to GitHub, which triggers a Vercel redeploy automatically.

Fidelity: `pages/trades-office-admin.json` and `pages/trades-bookkeeper.json` reproduce the
live ads5/ads6 pages structurally 1:1 (proven by `npm run verify`).

## How it works

```
pages/<slug>.json  ──┐
template/page.template.html ──┼── scripts/build.js ──> dist/<slug>/index.html  (+ /admin, /public)
lib/testimonials.json ──┘
api/lead.js     generic lead handler — loads pages/<variant>.json at runtime
api/publish.js  builder "Publish" — commits config via GitHub Contents API + emails admins
api/pages.js    builder page list (auth: x-admin-password header)
```

- Page URL: `https://<project-domain>/<slug>/` — works with zero extra setup.
- Optional subdomain (e.g. `dispatch.coconutva.com`): see "Wiring a subdomain" below.
- The form sends `variant=<slug>`; `api/lead.js` loads that page's config for the dropdown
  allowlist, `ads_name`, Slack labels, and Meta `content_name`. Page copy and lead handling
  can never drift apart because both come from the same JSON.

## First-time setup

1. **Create the repo** (private) and push this folder:
   ```bash
   git init && git add -A && git commit -m "coconut-lp-factory v1"
   git remote add origin git@github.com:<you>/coconut-lp-factory.git
   git push -u origin main
   ```
2. **Import into Vercel** (Add New → Project → this repo). Build settings are read from
   `vercel.json` automatically (build: `node scripts/build.js`, output: `dist`).
3. **Environment variables** (Project → Settings → Environment Variables). See `.env.example`:
   - Pages (same values as ads5/ads6 today): `SUPABASE_OS_URL`, `SUPABASE_OS_SERVICE_ROLE_KEY`,
     `SLACK_BOT_TOKEN`, `META_PIXEL_ID`, `META_CAPI_ACCESS_TOKEN`
     (+ optional `SLACK_CHANNEL_ID`, `META_TEST_EVENT_CODE`, `PAGE_URL`).
   - Builder: `ADMIN_PASSWORD`, `GITHUB_TOKEN`, `GITHUB_REPO`, `PROD_BASE_URL`
     (+ optional `RESEND_API_KEY`, `ADMIN_EMAILS` for publish notifications).
4. **GitHub token** (`GITHUB_TOKEN`): GitHub → Settings → Developer settings →
   Fine-grained personal access tokens → Generate new token →
   Repository access: **Only select repositories** → this repo →
   Permissions → Repository permissions → **Contents: Read and write**. Nothing else.
   Set expiration to 1 year and put a calendar reminder to rotate it.
5. Deploy. Sanity check: `/` lists the built pages, `/admin/` shows the builder login.

## Creating a page (the whole flow)

1. Open `/admin/`, enter the admin password.
2. Pick the closest existing page → **Duplicate as new page…** → give it a slug
   (e.g. `trades-dispatcher`).
3. Edit the copy section by section — the preview on the right updates live and uses the
   exact same renderer as the deployed pages.
4. **Publish.** The config is committed to `pages/<slug>.json`; Vercel redeploys (~2 min);
   admins get an email with the page URL and, if a subdomain was requested, the exact
   rewrite block to paste.
5. The page is live at `PROD_BASE_URL/<slug>/`. Point the Meta ad there, or wire a subdomain.

## Wiring a subdomain (manual, ~1 min, Daniel)

1. Vercel project → Settings → Domains → add `sub.coconutva.com`.
2. Wix DNS: add CNAME `sub` → `cname.vercel-dns.com`.
3. Add to `rewrites` in `vercel.json` (the publish email contains this block ready to paste):
   ```json
   { "source": "/", "has": [{ "type": "host", "value": "sub.coconutva.com" }], "destination": "/<slug>/" }
   ```
4. Commit. Done.

## Adding a tool logo (manual for now)

Drop a transparent PNG (uniform height ~120px, trimmed) into `shared/public/logos/` and
commit. It appears as a checkbox in the builder after the next deploy.

## Notes & gotchas

- **`helpHours`** ("How much help do you need?"): optional per page (`form.hours` in the
  config). When present it is required in the form, validated server-side against the
  page's options, and shown in Slack as "Hours needed". It is NOT stored in Coconut OS yet
  (no column) — add one later if wanted.
- **Vercel Hobby domain limits**: with many subdomains you'll hit the per-project cap —
  upgrade to Pro ($20/mo) or prefer path URLs.
- **Structural changes** (new sections, different layout) are template work, not builder
  work: edit `template/page.template.html` + `lib/render.js`, run `npm run build`, commit.
- `scripts/extract.js` and `scripts/verify.js` were used to bootstrap from the live
  ads5/ads6 repos and prove fidelity; they're kept for reference/re-verification.

## Editing the template safely (blast radius = every live page)

A template change rebuilds ALL pages on deploy. Never edit `template/page.template.html`
directly on `main`:
1. Branch + PR — Vercel automatically creates a **preview deployment** for the PR.
2. On the preview URL: open every page visually, then hit `GET /api/health` — it proves the
   serverless bundle can read `pages/*.json` at runtime (the classic silent-breakage mode).
3. Optionally submit the form on one preview page with a test email and check Slack/OS/Meta.
4. Merge. Production deploys the exact commit you previewed.

`/api/health` is also the 10-second post-deploy check for ANY production deploy.

## Migrating office/books into the factory (when ready)

The two configs already produce identical pages. To retire ads5/ads6:
1. Add `office.coconutva.com` and `books.coconutva.com` as domains on THIS Vercel project
   (remove them from the old projects first). The rewrites are already in `vercel.json`.
2. Test both pages end-to-end (form → Slack + Coconut OS + Meta Test Events).
3. Archive the ads5/ads6 repos and delete the old Vercel projects.
