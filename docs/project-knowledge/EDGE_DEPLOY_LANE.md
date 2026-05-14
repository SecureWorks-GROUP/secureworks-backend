# Canonical Edge Deploy Lane

## The Rule

Production `ops-api` and `send-quote` must only deploy from one place:

- GitHub: `marninms98-dotcom/secureworks-site`
- Branch: `main`
- Local release worktree: `/Users/marninstobbe/Projects/_release/secureworks-site-main`

This is a hard operational boundary for Marnin, Shaun, Codex, Claude, and any
other terminal or agent.

## Why This Exists

Supabase has one live function slug named `ops-api` and one named `send-quote`.
The last deploy wins.

This Mac has had many stale worktrees and copied repos containing old versions of
those functions. Some old copies had dashboard notes actions but missed newer
sales/finance/evidence/scope actions. Other copies had newer site actions but
missed dashboard actions. Deploying from the wrong folder made live features
disappear and reappear.

This was a source-control/deploy-lane problem, not a database corruption problem.

## Allowed Production Deploy Paths

Preferred path:

1. Merge reviewed changes to `secureworks-site/main`.
2. Run the GitHub Actions production edge deploy workflow.
3. Confirm the post-deploy smoke test passes.

Approved local break-glass path:

```bash
cd /Users/marninstobbe/Projects/_release/secureworks-site-main
git fetch origin --prune
git status --short --branch
SW_API_KEY=... scripts/deploy-edge-function.sh ops-api
SW_API_KEY=... scripts/deploy-edge-function.sh send-quote
```

The guarded script refuses to deploy unless the worktree is clean and exactly at
`origin/main`.

## Disallowed Deploy Paths

Do not deploy `ops-api` or `send-quote` from:

- `/Users/marninstobbe/Projects/securedash*`
- `/Users/marninstobbe/Projects/secureworks-site-*`
- `/Users/marninstobbe/Projects/secureworks-site` if it is on a feature branch
- `/private/tmp/*`
- any copied repo, stale worktree, or feature card folder

Do not run raw deploys for these two functions:

```bash
supabase functions deploy ops-api
supabase functions deploy send-quote
```

Use `scripts/deploy-edge-function.sh` instead.

## Local Mac Guard

This Mac should also have the local Supabase CLI guard installed:

```bash
cd /Users/marninstobbe/Projects/_release/secureworks-site-main
scripts/install-local-supabase-guard.sh
```

The guard only blocks protected production deploys:

- `supabase functions deploy ops-api`
- `supabase functions deploy send-quote`

It allows all other Supabase commands to pass through normally. Protected deploys
are allowed only from the canonical release worktree when it is clean and exactly
at `origin/main`.

## Required Smoke Checks

After every production deploy:

```bash
SW_API_KEY=... scripts/smoke-edge-functions.sh
```

The smoke must prove:

- `ops-api` has `verify_jwt=false`
- `send-quote` has `verify_jwt=false`
- `ops_api_version` is recognised
- `ops_api_version` reports `source_repo: secureworks-site`
- Ops notes, sales, finance, evidence, and scope-freeze actions are recognised
- `send-quote /view` is not blocked by Supabase gateway JWT
- `send-quote /send-runs` reaches in-handler validation

## If Something Breaks Again

1. Do not assume the data is damaged.
2. Run the smoke script from the canonical release worktree.
3. Check Supabase function versions for recent redeploys.
4. Search for old terminals or agents that may have run a raw deploy.
5. Restore only from the canonical release lane.
