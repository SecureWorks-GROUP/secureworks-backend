# OPS API Source Of Truth

## Current Rule

Production `ops-api` is owned by one repository and one deploy lane:

- GitHub repo: `marninms98-dotcom/secureworks-site`
- Branch: `main`
- Local release worktree: `/Users/marninstobbe/Projects/_release/secureworks-site-main`
- Supabase function slug: `/functions/v1/ops-api`
- Current trusted release label: `ops-apiV1-trusted-18MAY-plus-secure-sale`

`securedash`, Trade App, Sales Dash, JARVIS, and other tools may call
`ops-api`, but they do not own the production function source or production
deploy authority.

## Why This Exists

Supabase has one live `ops-api` function. The last deploy wins.

This machine has had many historical worktrees with copies of
`supabase/functions/ops-api`. Some copies had newer Sales/JARVIS handlers, some
had newer Trade/Ops handlers, and some were stale. Deploying the wrong copy can
make live features disappear even when the database and frontend are fine.

## Required Preflight For Any Agent

Before editing or deploying `ops-api`, every Codex, Claude, terminal, or human
must run:

```bash
cd /Users/marninstobbe/Projects/_release/secureworks-site-main
scripts/ops-api-preflight.sh
```

If the preflight fails, do not edit or deploy `ops-api`.

If the only warning is that the local Supabase CLI is logged out, that is
acceptable for coding/review work. Production deploy proof must then come from
the GitHub production workflow and smoke checks, not from a local CLI session.

## Allowed Deploy Paths

Normal path:

1. Merge reviewed changes into `secureworks-site/main`.
2. Use the GitHub Actions workflow `deploy production edge functions`.
3. Type the explicit approval phrase when dispatching the workflow.
4. Confirm smoke checks pass.

Break-glass local path:

```bash
cd /Users/marninstobbe/Projects/_release/secureworks-site-main
SW_API_KEY=... scripts/deploy-edge-function.sh ops-api
```

The local path is allowed only when the release worktree is clean and exactly at
`origin/main`.

## Forbidden Paths

Do not deploy production `ops-api` from:

- `securedash`
- `secureworks-site` feature branches
- `secureworks-site-*` worktrees
- copied repos
- temporary folders
- Symphony card worktrees
- Shaun's machine unless it has pulled `secureworks-site/main` and is using the
  guarded deploy lane

Do not run raw deploys:

```bash
supabase functions deploy ops-api
```

## Secret Policy

Only `secureworks-site` may hold the production Supabase deploy token.

Current production deploy token state as of 2026-05-18:

- Token name in Supabase: `secureworks-site-prod-edge-18MAY`
- GitHub storage: `marninms98-dotcom/secureworks-site` production
  environment secret `SUPABASE_ACCESS_TOKEN`
- Expiry: 2026-06-17
- Local Supabase CLI on Marnin's Mac: logged out after token rotation, so
  stale local worktrees cannot deploy unless a human deliberately logs in again

No production `SUPABASE_ACCESS_TOKEN` is allowed in:

- `securedash`
- `secureworks-agent`
- `secureworks-ops`
- `secureworks-sale`
- old feature worktrees
- local docs

After any suspected drift, rotate the Supabase access token, revoke the old
token, and set the new token only in the `secureworks-site` production
environment.

## Live Drift Proof

The live function must prove:

- `verify_jwt=false`
- `ops_api_version` is recognised
- `source_repo=secureworks-site`
- `build_label` is present
- `commit_sha` matches the approved deploy commit
- all required actions in `scripts/_ops-api-required-actions.txt` are recognised

Use:

```bash
SW_API_KEY=... scripts/smoke-edge-functions.sh
```

## Old Worktrees

Old worktrees are not automatically wrong, but they are not deploy sources.
Before deletion, audit them for useful stranded work. If a stale copy contains
Trade App, Xero, supplier, work order, PO, Sales, booking, evidence, or JARVIS
changes that are missing from canonical, produce a review packet before porting.
