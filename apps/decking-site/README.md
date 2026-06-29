# decking-site

Decking service landing page for SecureWorks WA (composite + hardwood). Single-file
vanilla HTML/CSS/JS — no build step. Already self-contained; the move to `apps/`
required no path fixes.

## Purpose

Customer-facing landing page that converts visitors into decking quote requests.

## Dependencies

- **Google Fonts** (third party, network required)
- **GoHighLevel (GHL) form** — currently a **placeholder pending GHL setup**.
  The lead-capture form is not yet wired; the placeholder element carries inline
  integration instructions in HTML comments. This is intentional.
- No bundler, no npm packages

## Local development

Serve over **HTTP** — never `file://`:

```bash
npx serve apps/decking-site
```

## Validation

- **Static link-check**: `node scripts/check-app-links.mjs decking-site`
- **Playwright E2E**: load → scroll gallery → expand an FAQ accordion → reach
  the form area; assert gallery renders, GHL placeholder present, zero local
  404s.

## Deployment

Deployed to Vercel by `.github/workflows/deploy-decking-site.yml`, triggering
only on pushes to `main` touching `apps/decking-site/**`. Routed at `/decking`
(see root `vercel.json`).

## Asset-ownership rule

This app owns every resource it references — all 18 deck photos and 2 logo SVGs
live under `apps/decking-site/assets/`. **No path may use `../` to escape this
directory.**
