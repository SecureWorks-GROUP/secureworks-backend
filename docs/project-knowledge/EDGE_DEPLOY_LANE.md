# Canonical Edge Deploy Lane

## The Rule

Production `ops-api` and `send-quote` must only deploy from one place:

- GitHub: `SecureWorks-GROUP/secureworks-site`
- Branch: `main`
- Local release worktree: `/Users/marninstobbe/Projects/_release/secureworks-site-main`

This is a hard operational boundary for Marnin, Shaun, Codex, Claude, and any
other terminal or agent.

For the short source-of-truth contract that future agents should read first,
see `docs/project-knowledge/OPS_API_SOURCE_OF_TRUTH.md`.

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
2. The GitHub Actions production edge deploy workflow
   (`.github/workflows/deploy-edge-functions.yml`) runs automatically on that
   push, in the `production` environment. For changed functions, its first
   deploy gate runs `scripts/apply-pending-migrations.sh`, which applies
   repository migrations missing from the production ledger in version order
   through the Management API. It verifies each migration request before
   writing and read-checking that migration's ledger row. The exact-file
   exclusions for audited production debt live in
   `scripts/migration-autoapply-exclusions.txt`; the one reviewed historical
   ledger-version alias (including its verified production raw-statement SHA) lives in
   `scripts/migration-autoapply-ledger-aliases.txt`. The runner starts at the
   audited `20260722000001` baseline because older production history predates
   this lane and is intentionally sparse. An exception whose file hash changes
   fails closed. Production deploy runs are serialized so two workflow runs
   cannot apply the same pending migration concurrently.

   The independent post-apply gate is the read-only schema preflight in
   `scripts/check-edge-schema-preflight.sh`, driven by
   `scripts/edge-function-schema-requirements.txt`; it refuses deployment when
   the declared production migration version or any required queryable marker is
   absent. Ledger name/checksum drift is reported as a non-blocking advisory.
   One-statement ledger entries are hashed directly against the checked-in raw
   file; parsed multi-statement entries report checksum-unavailable instead of
   comparing JSON-array serialization with raw file bytes.

   For the U2 cycle-scoped MakeSafe media reads, the same preflight also requires
   `20260728000001_makesafe_state_authority_u2.sql` (the `job_media` cycle columns,
   constraint, foreign key, and index), after the attendance-cycle migration.
   For SES Reporting U5/U6/U6R, apply
   `20260728020000_makesafe_ses_invoice_release_u5_u6.sql` before deploying the
   matching `ops-api`. For the SES money and outbound fence, apply
   `20260728030000_makesafe_ses_fence_hardening.sql` before deploying the
   matching `ops-api`, `send-quote`, `send-outlook-email`, `reporting-api`, or
   `xero-sync`. These migrations are applied by the production workflow's
   pending-migration lane before the edge-function deploy; the schema preflight
   remains an independent read-only gate. They create only the reviewed
   database controls and ledgers; they perform no provider or closeout effect.

   Extension objects must be qualified against their live production namespace,
   not a generic Supabase default. In project `kevgrhcjxspbxgovpmfl`, `pg_trgm`
   is installed in `public`, so migrations must install it with `SCHEMA public`
   and use `public.gin_trgm_ops`. `pgcrypto` and `uuid-ossp` remain installed in
   `extensions`. The PR check in
   `supabase/functions/ops-api/migration_extension_schema_test.ts` enforces the
   `pg_trgm` contract across every repository migration.
3. Confirm its smoke checks pass.

What that run does is decided by `scripts/identify-edge-deploy-changes.sh`:

- A merge touching `supabase/functions/**` deploys only the changed functions
  and runs the post-deploy smoke for them. The schema preflight runs before
  any function deploy; if `ops-api` is one of them, the pre-deploy source check
  runs after it and the action-surface smoke runs last.
- A merge touching only the ops-api verification contract (the deploy workflow
  itself, the classifier, `scripts/check-ops-api-source-actions.sh`,
  `scripts/smoke-ops-api-action-surface.sh`,
  `scripts/_ops-api-required-actions.txt`,
  `scripts/check-edge-schema-preflight.sh`, or
  `scripts/edge-function-schema-requirements.txt`) deploys zero functions but
  still runs the pre-deploy ops-api source check and the live action-surface
  smoke. A
  repair to a verifier therefore cannot go green without being exercised
  against production, and cannot silently redeploy a function nobody changed.
- If the push base commit cannot be resolved, the run fails before any deploy
  selection rather than guessing an empty or repo-wide function set.

Approved local break-glass path:

```bash
cd /Users/marninstobbe/Projects/_release/secureworks-site-main
scripts/ops-api-preflight.sh
SW_API_KEY=... scripts/deploy-edge-function.sh ops-api
SW_API_KEY=... scripts/deploy-edge-function.sh send-quote
```

The guarded script refuses to deploy unless the worktree is clean and exactly at
`origin/main`.

If the local Supabase CLI is logged out, `scripts/ops-api-preflight.sh` still
passes the canonical-folder and Git checks but warns that live function metadata
could not be read. That is acceptable for coding/review work. Production deploy
proof should come from the GitHub workflow and smoke checks.

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

The guard is not a replacement for GitHub secret lockdown. A machine with an old
Supabase token can still bypass local shell wrappers by using another CLI,
`supabase.real`, direct API calls, or the Supabase dashboard. Production deploy
tokens must therefore live only in the `secureworks-site` production environment.

## GitHub Secret Policy

Only `SecureWorks-GROUP/secureworks-site` may hold the production
`SUPABASE_ACCESS_TOKEN`, and it should be environment-scoped to `production`.

As of 2026-05-18, the active production deploy token is named
`secureworks-site-prod-edge-18MAY`, expires on 2026-06-17, and is stored only in
the `secureworks-site` `production` environment. Marnin's local Supabase CLI was
logged out after the rotation so local stale worktrees cannot deploy without a
deliberate new login.

Caller repos such as `securedash`, `secureworks-agent`, `secureworks-ops`, and
`secureworks-sale` must not hold production Supabase deploy tokens. If any
non-owner repo is found with such a token, remove it, rotate the token in
Supabase, and set the replacement only in the `secureworks-site` production
environment.

## Required Smoke Checks

After every production deploy:

```bash
SW_API_KEY=... scripts/smoke-edge-functions.sh
```

The smoke must prove, for `send-quote`:

- `send-quote` has `verify_jwt=false`
- `send-quote /view` is not blocked by Supabase gateway JWT
- `send-quote /send-runs` reaches in-handler validation

The `ops-api` half of the contract is owned elsewhere, so it is not restated
here: `docs/project-knowledge/OPS_API_SOURCE_OF_TRUTH.md` ("Live Drift Proof")
owns what the live function must prove, and the header of
`scripts/_ops-api-required-actions.txt` owns the per-action post-deploy probe
policy.

## If Something Breaks Again

1. Do not assume the data is damaged.
2. Run the smoke script from the canonical release worktree.
3. Check Supabase function versions for recent redeploys.
4. Search for old terminals or agents that may have run a raw deploy.
5. Restore only from the canonical release lane.
