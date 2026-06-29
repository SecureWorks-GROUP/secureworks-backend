# apps/ — bounded static-site applications

This directory is the canonical parent for all bounded static-site apps in the
repo. Each app is **self-contained** and **independently deployable**.

## The `apps/<name>/` convention

1. **One directory per app.** Every customer-facing or internal static-site app
   lives at `apps/<app-name>/` with its own `index.html`.

2. **Each app owns its resources.** Images, logos, fonts, and JS modules that an
   app references live *inside that app's directory* (typically under
   `apps/<name>/assets/` and, for JS, `apps/<name>/shared/`). Apps do **not**
   reach into another app's folder or a shared parent.

3. **No `../` escaping the app boundary.** Every `src`, `href`, CSS `url()`, and
   JS `import` must resolve within `apps/<name>/`. Use within-app paths like
   `assets/photos/foo.jpg` or `./shared/cloud.js` — never `../assets/` or
   `../shared/`. Duplication across apps is accepted at this scale in exchange
   for isolation (see `openspec` change `monorepo-apps-restructure`, decision D1).

4. **Every app has a `README.md`** documenting purpose, dependencies, how to run
   it locally over HTTP, how it is validated, and how it is deployed.

5. **Serve over HTTP, never `file://`.** Relative-path and ES-module resolution
   differ under `file://` and give false confidence:
   ```bash
   npx serve apps/<name>
   ```

## Apps in this repo

| App | Purpose | Route |
|-----|---------|-------|
| `fencing-site` | Colorbond fencing landing page | `/fencing` |
| `decking-site` | Decking landing page (GHL form pending) | `/decking` |
| `patio-site` | Insulated + general patio landing pages | `/` (apex) |
| `fencing-tool` | Internal 3D Fence Designer Pro tool | `/fencing-tool` |

Routing is defined in the root `vercel.json`.

## Validation (run before merging changes to an app)

Each app must pass two layers:

1. **Static link-resolution check** (exhaustive, hard gate) — parses every
   referenced local path and asserts it resolves on disk within the app, with no
   `../` boundary escapes:
   ```bash
   node scripts/check-app-links.mjs            # all apps
   node scripts/check-app-links.mjs <name>     # one app
   ```

2. **Playwright E2E smoke** (UX regression net) — load the app over local HTTP,
   drive a representative journey, and fail on any **same-origin** 4xx/5xx or
   console error. Third-party hosts (Google Fonts, CDNs, Supabase) are out of
   scope for the failure gate.

## What is NOT an app

- **Root collateral** (`brand-bible.html`, `lookbook-*.html`, `design-brief.html`,
  `council-approval-guide.html`) stays at the repo root and may reference the
  root `assets/` folder. These are print/design collateral, not deployed apps.
- **`supabase/`** (edge functions + migrations) stays at the repo root as its own
  entrypoint and is never moved under `apps/`.
- **`dashboard/`** is a git submodule (`secureworks-ux`) and is out of scope here.

## CI/CD

Each app has a path-filtered GitHub Actions workflow
(`.github/workflows/deploy-<name>.yml`) that triggers **only** on pushes to
`main` touching `apps/<name>/**` — so a change to one app never redeploys another.
The existing `deploy-edge-functions.yml` / `pr-check.yml` (filtered to
`supabase/functions/**`) are untouched.
