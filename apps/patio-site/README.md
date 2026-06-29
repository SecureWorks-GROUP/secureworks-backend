# patio-site

The patio service landing pages for SecureWorks WA — the primary revenue driver.
Single-file vanilla HTML/CSS/JS — no build step.

## Pages

- `index.html` — primary **insulated patio** landing page (SolarSpan focus),
  includes the interactive cost estimator.
- `patio-general.html` — generalist patio / outdoor-living page.

## Dependencies

- **Google Fonts** (third party, network required)
- No bundler, no npm packages, no backend calls

## Local development

Serve over **HTTP** — never `file://`:

```bash
npx serve apps/patio-site
# open http://localhost:<port>/             (index.html)
# open http://localhost:<port>/patio-general.html
```

## Validation

- **Static link-check**: `node scripts/check-app-links.mjs patio-site` (covers
  both HTML files).
- **Playwright E2E**: for each page — load → scroll → exercise the cost
  estimator → CTA; assert images render, zero local 404s.

## Deployment

Deployed to Vercel by `.github/workflows/deploy-patio-site.yml`, triggering only
on pushes to `main` touching `apps/patio-site/**`. Routed at the site apex `/`
(primary trade) with `patio-general.html` alongside (see root `vercel.json`).

## Asset-ownership rule

This app owns every resource it references. All logos and photos live under
`apps/patio-site/assets/`. Asset references use within-app paths (e.g.
`assets/photos/foo.jpg`) — **no `../` may escape this directory.**
