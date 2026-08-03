# Trade multi-person allocation collision

Date: 2026-08-03 (Australia/Perth)

## Production diagnosis

The Trade app toast at 17:27 AWST corresponds to two adjacent Henry-authenticated
`allocate_job` requests on `ops-api` version 990:

- `2026-08-03T09:27:21.926Z` returned HTTP 500.
- `2026-08-03T09:27:22.483Z` returned HTTP 200.

The failed request reassigned one representative crew row to a person who
already had another row on the same job and scheduled date. PostgREST returned
HTTP 409 with PostgreSQL SQLSTATE `23505`:

```text
duplicate key value violates unique constraint
"job_assignments_job_user_date_key"
Key (job_id, user_id, scheduled_date)=(..., ..., 2026-08-04) already exists.
```

`allocateJob` previously passed that database error through to the outer
unhandled-error response, producing the unexplained 500. The paired request was
the existing active-crew idempotency path and returned 200, giving the client
its `Assigned 1 of 2 - 1 failed` total.

The exact log pair belongs to SWF-26589, not the reported Westminster card
SWF-26535. The Westminster job already had both intended crew members, and its
assignment rows were not mutated on 2026-08-03. Time-bounded production logs
contained reads for that job but no assignment POST, PATCH, or DELETE. The
failure mechanism is nevertheless the Trade multi-select shape described in
the report: its first selected person is sent as a reassignment of one
representative row, even when that person already occupies another row in the
crew.

## Read-only evidence route

Database evidence was queried through the Supabase Management API
`/v1/projects/{ref}/database/query` with `read_only:true`. Runtime evidence was
queried through the GET-only ClickHouse endpoint
`/v1/projects/{ref}/analytics/endpoints/logs`, bounded to the incident window.
The useful joins and predicates were:

```sql
-- Crew snapshot for a resolved job id.
SELECT a.id, a.job_id, a.user_id, u.name, a.scheduled_date, a.status,
       a.created_at, a.updated_at
FROM public.job_assignments a
LEFT JOIN public.users u ON u.id = a.user_id
WHERE a.job_id = '<job-id>'
ORDER BY a.created_at DESC, a.id;

-- Invocation pair: source=function_edge_logs, POST allocate_job,
-- 2026-08-03T09:27:10Z through 2026-08-03T09:27:24Z.
-- Runtime error: source=function_logs over the same bounded window.
-- Internal write chain: source=edge_logs, SupabaseEdgeRuntime user agent.
```

The internal chain was a source-assignment GET, job GET, target-user GET,
old-state GET, and then a `job_assignments` PATCH returning 409. No production
write or schema change was made during diagnosis.

## Runtime and PR 513

The incident ran on `ops-api` v990, after PR 513 had merged. The current
production function is v991 at commit `f91de02b...`; two consecutive
`ops_api_version` reads agreed, and the successful deployment workflow reported
function convergence. GitHub comparison shows the current commit is ahead of
PR 513's merge commit `6db1bbe...`, so PR 513 is already deployed.

PR 513's `setJobLead` TOCTOU/PGRST116 mapping is separate. `allocate_job` does
not call `setJobLead`; this fix needs no pending PR 513 deployment and no schema
migration.

## Fix contract

For a membership-only reassignment whose target person already has an active
assignment on the same job/date, the desired multi-person crew state already
exists. Return that target row as a deduped success and preserve both
assignments. Do not silently discard requested date, time, crew-name, or notes
changes. Repeat the exact read after a unique-key race before deciding the
response.

If SQLSTATE `23505` names `job_assignments_job_user_date_key` but there is no
reusable active row, return HTTP 409 with code
`assignment_user_date_conflict`, the constraint name, `user_id`, and
`scheduled_date`. Do not map unrelated constraint errors.

Regression coverage lives in
`supabase/functions/ops-api/allocation_authz_test.ts` and pins both the
multi-person success shape and the precise conflict response.

The inconsistent trade-report `submitted_by` fields are not the same plumbing.
Allocation takes the assignee from the request and the allocator from the
authenticated server context; report submission attribution uses a separate
path and remains outside this fix.
