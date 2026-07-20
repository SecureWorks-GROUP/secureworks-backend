# Make-safe deterministic intake cutover runbook

## Authority and scope

This runbook prepares the direct deterministic cutover. It is not deployment or
migration authority. Applying either migration, deploying `ops-api`, flipping the
switch, production backfill, or rollback requires the separately recorded Captain
approval.

The path creates only unassigned make-safe jobs through the existing guarded intake
approval function. It does not plan, schedule, allocate, invoice, send email/SMS,
authorise, mark paid, or move money. Deterministic intake suppresses the existing
manager-arrival SMS side effect for its own provenance.

## Package

Apply in order only after approval:

1. `supabase/migrations/20260720000001_makesafe_intake_cases.sql`
2. `supabase/migrations/20260720000002_makesafe_deterministic_intake_cutover.sql`

The second migration remains inert because
`makesafe_cron_settings.intake_mode` defaults to `legacy`.

Runtime components:

- `supabase/functions/ops-api/makesafe_deterministic_intake.ts`
- `supabase/functions/ops-api/makesafe_deterministic_intake_runtime.ts`
- `scan_ses_makesafes`, which reads the DB switch once and enters exactly one path
- `makesafe_deterministic_intake_replay`, a no-write aggregate replay action

The deterministic branch imports no model SDK and has no AI fallback. Health records
`intake_mode=deterministic` and `last_scan_model_calls=0`.

## Query and payload constraints

The replay/runtime reads only named columns. Email reads and the persisted
case/case-source resume reads all paginate explicitly in 500-row pages, below the
PostgREST 1,000-row cap, and attachment IDs are fetched in bounded batches. It never selects
`jobs.scope_json`, `calendar_events.scope_json`, `pricing_json`, or any list/feed
`select('*')` payload.

Open PR 334 changes unrelated `ops_summary` calendar and pipeline pricing projections.
This package does not touch those query blocks and does not duplicate that PR.

## Bounded resumable runs

A live scan is incremental, not a single drain of the backlog. One invocation
commits at most 25 cases and stops after four times that many attempts, so an edge
timeout never discards accounting for drafts and jobs that already exist. Cases are
stamped as they go and the next scan resumes.

Ordering inside a run is: deferred/failed job-creation retries up to half the
budget, then cases never attempted before, then the remaining retries, then cases
already at their resolved state. A systematically failing case therefore cannot
crowd out fresh work.

A case that is accounted but whose guarded job creation has not yet succeeded is
persisted with reason code `awaiting_job_creation`. It is a pre-job state, not an
adapter failure, and it is retried on the next run. The full approved reason-code
set is enforced by both `MAKESAFE_REASON_CODES` and the
`makesafe_intake_cases_reason_code_check` constraint refreshed in migration
`20260720000002`:

`cancellation`, `duplicate`, `revision`, `unknown_builder`, `non_makesafe`,
`ambiguous_scope`, `below_identity_floor`, `adapter_parse_failure`,
`conflicting_fields`, `awaiting_job_creation`.

## Offline tests

```bash
~/.deno/bin/deno test --allow-read \
  supabase/functions/_shared/makesafe_intake_case_model_test.ts \
  supabase/functions/_shared/makesafe_intake_case_migration_test.ts \
  supabase/functions/ops-api/makesafe_deterministic_intake_test.ts \
  supabase/functions/ops-api/makesafe_deterministic_intake_migration_test.ts \
  supabase/functions/ops-api/makesafe_deterministic_intake_runtime_test.ts
```

The pure adapter tests cover MLB, AJS/AJBR, Prime, RAPID, chatter, case-wide late
evidence, address-only hostile identity, distinct POs, WO formatting, significant PO
suffix punctuation, claim-only exclusion, revisions, reopen cycles, twins, resends,
cancellation, unknown builders, replay equality, zero unaccounted sources, and zero AI
fallback.

The runtime tests cover the commit-and-resume behaviour: the per-run case budget and
attempt ceiling, source accounting before job creation, bounded job-creation retries
that cannot starve fresh cases, paged case/case-source resume reads, write-failure
classification that retains no source content, and storage failures surfacing as a
visible blocker rather than silence.

Run the existing migration clone harness before production migration approval:

```bash
MAKESAFE_PROD_SCHEMA_CLONE_URL='postgres://...' \
MAKESAFE_PROD_SCHEMA_CLONE_ACK=I-confirm-this-is-a-disposable-prod-schema-clone \
  scripts/test-makesafe-intake-case-migration.sh
```

Do not point this at production.

## Read-only backlog replay

After the new code is deployed dark and before the mode flip, call:

```text
GET /ops-api?action=makesafe_deterministic_intake_replay&days=60&only_unscanned=true
```

Use the existing privileged read credential. The response contains aggregate totals by
builder and outcome only. It never returns message bodies, addresses, client details,
attachment URLs, secrets, or source identifiers. `dry_run=true`, `ai_calls=0`, and all
write totals must remain zero.

Required acceptance checks:

- `unaccounted = 0`
- every known-builder shortfall is visible in an exception outcome
- distinct PO fixtures stay distinct
- no address-only merge
- no claim-only confirmed-live result
- chatter is counted
- model calls remain zero

If the credential or safe endpoint is unavailable, record the exact blocker. Do not
weaken the proof by reading production tables through an ad hoc broad query.

## Preflight

With the migration applied but mode still `legacy`, run:

```sql
select *
from public.makesafe_deterministic_intake_preflight(
  '00000000-0000-0000-0000-000000000001'::uuid
);
```

Every check must be true. Also confirm:

1. replay totals and reviewed fixture outcomes are accepted
2. current intake health is truthful
3. no deterministic run has produced model usage
4. the release worktree is the authorised production release source
5. migration and deploy approvals are recorded separately
6. no live backfill is bundled with cutover

Production edge deploys are allowed only from main in:

`/Users/marninstobbe/Projects/_release/secureworks-site-main`

Use the repository guarded deploy script documented in `AGENTS.md`. Do not deploy from
a feature worktree.

## Direct guarded cutover

There is no prolonged dual-running phase. After approved migration, dark deploy,
read-only replay, and preflight, the separately approved cutover is one guarded update:

```sql
update public.makesafe_cron_settings
set intake_mode = 'deterministic',
    intake_mode_changed_at = now(),
    intake_mode_changed_by = '<approved operator>'
where id = true
  and intake_mode = 'legacy';
```

Require exactly one updated row. The next scan runs deterministic adapters only. It
cannot enter the legacy/model branch during that invocation.

## One-switch rollback

Kill criteria include a duplicate job, silent/unaccounted source, ambiguous merge,
incorrect PO collapse, communication side effect, false healthy state, or non-zero
model call in deterministic mode.

The separately approved rollback is:

```sql
update public.makesafe_cron_settings
set intake_mode = 'legacy',
    intake_mode_changed_at = now(),
    intake_mode_changed_by = '<approved operator rollback>'
where id = true
  and intake_mode = 'deterministic';
```

The equivalent prepared file is:

`supabase/rollbacks/20260720000002_makesafe_deterministic_intake_mode_rollback.sql`

Do not drop canonical cases after cutover. They remain append-only evidence. Do not use
the U1 physical down migration once any case is authoritative.

## Post-cutover reconciliation

After the first deterministic scan, verify without mutating production:

1. health reports deterministic mode, OK status, and zero model calls
2. structural source accounting has zero unaccounted emails
3. aggregate outcomes match the approved no-write replay
4. all created jobs are unassigned
5. no manager SMS, client SMS/email, invoice, PDF duplicate, screenshot duplicate,
   outbound message, or duplicate approval was created
6. exceptions name the missing requirement, sources searched, rejected candidates, reason
   code, and next action
7. rerun the same window and verify that already-settled cases produce zero new cases,
   drafts, jobs, approvals, or artifacts. A rerun may still advance cases the previous
   run left unattempted or in `awaiting_job_creation`; that is the bounded resume, not
   duplication. Only cases already at their resolved state must be inert.
8. reconcile aliases/twins using the merged PR 338 safeguards

Backfill remains a separate approved production action. This runbook does not authorise
it.
