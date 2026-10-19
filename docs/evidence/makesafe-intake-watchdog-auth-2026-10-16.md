# MakeSafe Intake Watchdog: red since 12 Aug 2026, fixed by a read-only database read

The watchdog is `.github/workflows/makesafe-intake-watchdog.yml`. Every 30 minutes it
checks, from outside Supabase, that the make-safe intake scan is still running.

## What was wrong (measured 16 Oct 2026)

- **The last green run was 31622967572, at 2026-08-12T17:30Z.** Every run after it failed
  the same way: 628 runs, from 31630869926 at 2026-08-12T19:04Z to 38830476477 at
  2026-10-16T00:37Z. Each failure was HTTP 401
  `{"error":"A signed-in Supabase user session is required.","code":"user_jwt_required"}`
  from `ops-api?action=intake_health`.
- **Cause:** PR #667 (`754084d4`, "Require verified operators for privileged ops routes"),
  merged at 2026-08-12T18:04Z. Since then `_authorizeOpsApiAction` accepts the api_key
  class only when a server secret is presented. The shared `SW_API_KEY` is refused on
  every action outside `OPS_API_STATIC_KEY_COMPATIBLE_ACTIONS`, and `intake_health` is not
  on that list. The refusal is intended; the watchdog was never moved off the shared key.
- **Intake itself was healthy.** A read-only SELECT at 2026-10-16 04:51Z found:
  - `makesafe_intake_health.last_scan_at` 0 min old;
  - `extraction_status` `ok`;
  - `makesafe_cron_settings.cron_enabled` true;
  - the make-safe poll cron job active.
  So the cost was two months with no outside alarm, not a missed outage.

## The fix (captain's choice, 16 Oct 2026)

`scripts/check-makesafe-intake-health.sh` replaces the ops-api probe. It sends one fixed
SELECT on `public.makesafe_intake_health` to the Supabase Management API
`/database/query` endpoint, with `read_only: true`. It authenticates with the existing
`SUPABASE_ACCESS_TOKEN` production environment secret. It fails when:

- the API cannot be reached (Supabase down);
- the read is refused or the project is paused (non-2xx);
- the health row or its `last_scan_at` is missing;
- the scan is older than `STALE_MINUTES` (30). The age comes from the database clock.

These are the same two fields ops-api published as `extraction.last_scan_at` and
`extraction.status`. No new secret was added, and ops-api auth is unchanged. Tests:
`scripts/test/test-check-makesafe-intake-health.sh`, run by `pr-check`.

## Security trade-off

- **Rejected: ops-api machine credentials.** They would have needed a new GitHub secret:
  either the make-safe routine key, or a new watchdog-only key.
- **What the fix costs:** `SUPABASE_ACCESS_TOKEN` is an account-wide Management API token,
  and this job now uses it every 30 minutes. It was already held by the same `production`
  environment for the deploy workflow, so no new holder gains it.
- **How the job limits it:** the job passes the token only to the check script. The script
  sends one fixed read-only SELECT and never prints the token.
- **What the watchdog no longer proves:** that ops-api answers HTTP. A dead ops-api,
  pg_cron or project still shows up, as a stale scan or a failed read.
