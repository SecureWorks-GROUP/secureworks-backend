# fencing-tool

Fence Designer Pro — an internal 3D fence-design and quoting tool. Single-page
vanilla HTML/CSS/JS with co-located ES module dependencies. No build step.

## Purpose

Internal tool for visualising fence configurations in 3D and generating quotes.
Not a customer-facing landing page.

## Dependencies

- **three.js** — 3D rendering (loaded from CDN / jsDelivr, third party)
- **jsPDF** — PDF quote export (CDN, third party)
- **Supabase** — cloud persistence via a hardcoded anon key. Backend
  connectivity is **out of scope** for validation; a 401/network failure from
  Supabase is expected in local/CI contexts and does not indicate a broken move.
- **Google Fonts** (third party)
- Local ES modules under `./shared/`:
  - `brand.js` — brand tokens
  - `cloud.js` — cloud/Supabase wiring
  - `integration.js` — integration glue
  - `media.js` — media helpers
- Local data/assets: `business_rules.js` (pricing logic), `textures/panel_harmony_surfmist.png`

## Local development

Serve over **HTTP** — never `file://` (ES module imports require an HTTP origin):

```bash
npx serve apps/fencing-tool
```

## Validation

- **Static link-check**: `node scripts/check-app-links.mjs fencing-tool`
- **Playwright E2E**: load → assert the three.js canvas initialises (non-blank)
  → all four `./shared/*.js` modules load → panel texture returns 200 → zero
  local 4xx/5xx. **Supabase and CDN responses are excluded from the failure
  gate** (backend connectivity out of scope).

## Deployment

Deployed to Vercel by `.github/workflows/deploy-fencing-tool.yml`, triggering
only on pushes to `main` touching `apps/fencing-tool/**`. Routed at
`/fencing-tool` (see root `vercel.json`).

## Asset-ownership rule

This app owns every resource it references. Shared JS modules live in
`./shared/` (moved from the old `tools/shared/`) and are imported with within-app
paths only — **no `../shared/` and no `../` escaping this directory.**
