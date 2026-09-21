# Sales performance storage/API contract

Approved plan: wiki `coding/work/campaigns/ceo-ops/audits/2026-09-11-sales-performance-PLAN.md`.
These ops-api actions store weekly collector snapshots. They are not reporting-api `sales_performance`.
Migration must be applied before deploying these actions. This change does not run collectors, migrate live data or deploy.

## Publish

`POST ops-api?action=sales_performance_write` requires the actual service-role secret, not the shared browser, agent-server or routine key.

Body: `org_id` UUID, `week_start` exact Monday `YYYY-MM-DD` (Perth reporting week), `lane` (`patio` or `fencing`; Stratco is a fencing source bucket, not a third lane), `metrics` object, `coverage` object, `queues` object, nonempty `run_id`, nonempty `definition_version`, and `computed_at` ISO timestamp with timezone, not in the future.

`coverage.gaps` must be an array and `coverage.collection_complete` must be boolean `true`. This confirms the collection run completed; it does **not** assert all measures are available. Known unavailable measures remain absent/null with their gaps. Failed, interrupted or over-budget collectors must not set this flag or publish. The API preserves measure payloads; it does not recompute or zero-fill them.

Response `{row}` contains the stored snapshot and existing notes. A repeat org/week/lane replaces report fields in one database upsert without reading or writing notes. Caller-supplied notes and unknown envelope fields are rejected. `computed_at` is the collector's source computation time, not upload time.

## Read

`GET ops-api?action=sales_performance_read[&week_start=YYYY-MM-DD]` requires an authenticated staff operator (admin, owner, ops_manager). Profile org is authoritative; caller org/lane overrides are rejected. Stored rows from both lanes are returned for the selected week and preceding three consecutive calendar weeks; absent lane rows are not synthesized. Default is the latest **stored closed** week, with latest closed Perth calendar week as the fallback if none exists. `latest_closed_week` separately identifies the calendar expectation; `latest_stored_closed_week` and `missing_latest_closed_week` expose stale/missing delivery without treating old data as fresh.

Response: `{rows, week_start, week_starts, latest_closed_week, latest_stored_closed_week, missing_latest_closed_week, available_weeks, available_weeks_limit:104, fetched_at}`. Week discovery is bounded to 208 newest lane rows/104 distinct weeks. Explicit older week queries remain supported. Each `row.computed_at` is report freshness; top-level `fetched_at` is retrieval time. `missing_latest_closed_week` is true only when neither lane has a discovered row for that calendar week; false does not establish both lanes are present. Consumers derive missing lanes for each returned week by comparing its rows with `patio` and `fencing`. To inspect calendar-latest lane coverage when it falls outside the selected four-week window, request `week_start=latest_closed_week` explicitly. Missing rows and measures stay missing. Rates and rolling totals remain a consumer responsibility under the approved definitions.

## Notes

`POST ops-api?action=sales_performance_note` requires an authenticated staff operator. Body is exactly `{week_start,lane,note:string}`; up to 10,000 characters, empty string allowed to clear the box. It updates an existing row only (404 if absent). The database derives org and author from `auth.uid()` and the users profile. Response `{row}` includes `notes:{text,author_id,author_name,updated_at}`. Notes saves use last committed save wins; report reruns never overwrite notes. Notes saves change no collector data or `computed_at`.

## Proof scope

Deno action/store tests cover authorization, validation, missing values, window boundaries, errors and note/rerun contract interleavings. The action registry and existing operator-auth suite guard incumbent routes.

`tests/sales-performance/postgres_test.py` is an additional real database proof: on an empty disposable local database with existing Supabase roles, it loads minimal fixtures and this migration, then tests grants, RLS, attribution, constraints and both actual concurrent row-lock orders. It refuses non-test database names, uses a local Unix socket or an explicit localhost-only TCP port, creates no server/database, drops nothing and uses fictional identities.

Executed successfully on 11 September 2026 using the already-cached `postgres:17` image (`sha256:67f41722b7a8cbdb868a44a4995c846eddfdc2973bccb291ce937dce88ad5675`) and `/opt/homebrew/opt/libpq/bin/psql`. The owned container `sales-performance-proof-20260911-b1` used 128 MiB temporary storage, no persistent volume, one CPU, a 256 MiB memory limit and localhost port 32768. Command: `PATH=/opt/homebrew/opt/libpq/bin:$PATH python3 tests/sales-performance/postgres_test.py sales_performance_test_20260911 32768`. Exit 0: PostgreSQL constraints, role grants, tenant RLS, note attribution, rerun preservation and both real lock interleavings passed. The harness observes the second backend waiting on a database lock before committing the first, in each order. The container was removed afterward and a filtered container listing confirmed none remained. No installation, image pull or shared database was used.

### Existing profile-authority release prerequisite

This proof uses controlled synthetic `users` profiles and grants authenticated users SELECT only on that fixture table. It proves the new table/functions against trusted profile roles and organisations; it does not prove those profile fields are immutable in production. The baseline policy `Users can update own profile` in `supabase/migrations/20250301000001_schema.sql:234` allows a matching user row to be updated and does not itself restrict role/org columns. If effective production table/column grants allow those updates, callers could change the authority inputs used by incumbent staff gates and this feature. This is an existing authentication boundary, not repaired by this slice.

Before release, verify effective production grants, applicable policies and triggers for `users.role` and `users.org_id` through an authorised read-only source, or close that authority gap in a separately scoped change. No live grant inspection was performed by this author; synthetic database success is not production-authorisation clearance.

## Rebase delivery, 21 September 2026

Replays the three commits from https://github.com/SecureWorks-GROUP/secureworks-backend/pull/835 onto main `aefe71af` on a new branch. Conflicts were additive imports, action/schema manifests and schema-preflight fixtures; main's booking, context and other routes remain intact. The store, migration and behavioral tests are unchanged from the original change. Migration version `20260911000001` has no collision on this main, so it was retained. Table, RPC and action names, write envelope, and read window stay in Publish, Read and Notes above.

### Still not covered

This is storage and retrieval, not a measurement engine or a live reporting release. It does not repair either collector or publisher, run or schedule publishing, backfill records, fix acceptance timestamps, verify click/text acceptance evidence, ingest Stratco allocations, repair quote-document reads, reconcile cash to settled bank receipts, or implement the approved plan's other upstream fixes. Won and cash remain separate collector-owned measures; this store validates the envelope, not their business accuracy.

It does not add server-side lead-source filters, per-rep aggregation, a rolling last-seven-days computation, pipeline-state computation, refresh scheduling/manual triggers, the new three-part screen, booking automation, Railway context work, Friday texts or headless fencing quotes. JSON payloads can preserve collector-produced breakdowns but do not establish those capabilities. Existing historical proof and the profile-authority release prerequisite above remain scoped as stated. Live completeness and the plan's twenty-number truth check are not observed by this delivery.

### Local validation and release boundary

On 21 September 2026: `deno test --allow-env --allow-net=127.0.0.1 --allow-read supabase/functions/ops-api/sales_performance_test.ts supabase/functions/ops-api/ops_api_operator_auth_test.ts` passed 48 tests; `bash scripts/test/test-edge-schema-preflight.sh` passed 10 tests; `bash scripts/check-ops-api-source-actions.sh` recognized all 123 required actions. `deno check supabase/functions/ops-api/index.ts`, focused Deno lint and `git diff --check` passed.

The real SQL harness passed again on PostgreSQL 17.11 in a new temporary cluster inside this disposable worktree, bound to localhost with fictional users and a fresh `sales_performance_test_20260921` database. It verified constraints, grants, tenant RLS, author attribution, rerun note preservation and both concurrent row-lock orders. The owned cluster was stopped after the run. No shared or live database was used.

No deployment, live migration, live write or old-branch force push was performed. A separately authorised release must apply the migration before deploying `ops-api`, whose deploy requires `--no-verify-jwt`. Local proof is not evidence of deployed behavior. Firstmate owns the subsequent no-mistakes validation and fresh-PR publication handoff; the original PR remains untouched.
