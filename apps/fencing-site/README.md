# fencing-site

Colorbond fencing service landing page for SecureWorks WA. Single-file vanilla
HTML/CSS/JS — no build step.

## Purpose

Customer-facing landing page that converts visitors into fencing quote requests.

## Dependencies

- **Google Fonts** (loaded from `fonts.googleapis.com` — third party, network required)
- No bundler, no npm packages, no backend calls

## Local development

Serve over **HTTP** — never open via `file://` (relative paths and fetch
behaviour differ from production):

```bash
npx serve apps/fencing-site
# then open the printed http://localhost:<port>/ URL
```

## Validation

- **Static link-check**: `node scripts/check-app-links.mjs fencing-site`
  parses every `src`/`href`/`url()`/`import` and asserts each local target
  exists inside this directory.
- **Playwright E2E**: load → hero + logo render → scroll all sections → click
  primary CTA; gate fails on any local 4xx/5xx or console error.

## Deployment

Deployed to Vercel by `.github/workflows/deploy-fencing-site.yml`, which
triggers only on pushes to `main` touching `apps/fencing-site/**`. Routed at
`/fencing` (see root `vercel.json`).

## Asset-ownership rule

This app owns every resource it references. All logos and photos live under
`apps/fencing-site/assets/`. **No path may use `../` to escape this directory.**
If you need a new shared image, copy it in here — do not reach into another
app's folder or a shared parent.
