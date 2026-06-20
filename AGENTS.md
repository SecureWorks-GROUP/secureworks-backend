# SecureWorks Agent Instructions

## Production Edge Deploy Rule

`ops-api` and `send-quote` are production backend functions. They must have one
deployable reality only.

Current source of truth:

- GitHub repo: `SecureWorks-GROUP/secureworks-backend`
- Branch: `main`
- Canonical source path: `supabase/functions/`
- Deploy lane: PR -> CI -> merge to `main` -> GitHub Actions auto-deploy

Do not deploy these functions manually from dashboard repos, stale worktrees,
feature branches, temporary folders, copied source trees, or any old
`secureworks-site` release checkout.

Disallowed local command:

```bash
supabase functions deploy ops-api
supabase functions deploy send-quote
```

If a local Supabase CLI guard is installed, this disallowed command will be
blocked automatically. Do not bypass the guard.

Why this matters: there is one live Supabase function slug, but this Mac has
multiple old local copies. A deploy from a stale folder overwrites production and
can remove live actions used by Ops, Sales, Finance, Evidence, Scope Freeze, and
quote sending.

If you are unsure, do not deploy. Open a PR against
`SecureWorks-GROUP/secureworks-backend` or run the read-only smoke script:

```bash
SW_API_KEY=... scripts/smoke-edge-functions.sh
```
