# Make-safe deterministic intake cutover runbook

## Flagged for Marnin: two live-scan behaviour changes

1. A stale allowlist entry no longer poisons later scans. Entries that no longer
   resolve to a case are reported as `selection.unmatched_source_allowlist` /
   `selection.unmatched_instruction_allowlist` and the scan continues on the
   resolved set. Only an allowlist that resolves **no** case at all fails closed.
2. Each live scan now has a flat read and plan cost. The window read is capped at
   500 rows per run (`source_read.cap`), and allowlisted sources are read by id
   outside that cap, so a named source is still proved on every run once it ages
   out of the newest rows. Scan cost no longer grows with mailbox age.
3. The cap comes with a progress guarantee. Half the per-run budget is a sweep
   driven by `makesafe_intake_health.deterministic_scan_cursor_at`, an advancing
   `received_at` position persisted across live runs and restarted at the window
   head once it reaches the end (`source_read.cursor_at` /
   `source_read.next_cursor_at`). Progress does not depend on anything being
   stamped `makesafe_scanned_at`, so ordinary non-actionable SES mail, which no
   run ever stamps, cannot hold the read in place. Dry-run and dark-observe get
   the same guarantee from their own separate position,
   `deterministic_observe_cursor_at`: observation has to cover the whole window
   before cutover, when no live run exists to advance anything, so the sweep
   position is the one thing a dry run writes. It still creates no case, draft,
   job, storage object or health state, and it never moves the live cursor. If
   the cursor column is unreadable or unwritable the run still completes and
   reports `scan_cursor_unavailable` in `evidence.caveats`.
4. Volume meeting configuration can no longer poison the cron. When a run resolves
   no case and every unresolved allowlist entry was merely outside this run's cap,
   the run ends as a reported no-op carrying `no_cases_readable_within_cap` rather
   than throwing; the sweep brings those sources inside the cap on a later run. A
   genuinely stale allowlist that resolves nothing still fails closed. That no-op
   is not a success: it writes `extraction_status = 'degraded'` with
   `degraded_reason = 'deterministic_no_cases_readable_within_cap'` and does not
   refresh `last_successful_extraction_at`, so the alarm and morning-report
   surfaces see the degradation, not just the scan response.

## Authority and scope

This runbook prepares the direct deterministic cutover. It is not deployment or
migration authority. **Merge is not deploy.** Applying any migration, deploying
`ops-api`, flipping the switch, production backfill, or rollback requires the
separately recorded Captain approval.

Production activation remains **NO-GO** after this controls PR merges. Activation
still waits for the separate canonical Board/Hugo seam, the supervised authenticated
alarm drill, a current-main replay that meets the identity-floor threshold with zero
unaccounted sources, and every named G4/G5/G6/G9/H4 approval. This PR must first be
migrated and deployed dark under those gates; no merge changes production state.

The path creates only unassigned make-safe jobs through the existing guarded intake
approval function. It does not plan, schedule, allocate, invoice, send email/SMS,
authorise, mark paid, or move money. Deterministic intake suppresses the existing
manager-arrival SMS side effect for its own provenance.

## Package

Apply in order only after approval:

1. `supabase/migrations/20260717000001_jobs_quoted_value_generated.sql`
2. `supabase/migrations/20260720000001_makesafe_intake_cases.sql`
3. `supabase/migrations/20260720000002_makesafe_deterministic_intake_cutover.sql`
4. `supabase/migrations/20260721000001_makesafe_intake_production_controls.sql`
5. `supabase/migrations/20260721000002_makesafe_intake_full_open.sql`

The intake migrations remain inert because
`makesafe_cron_settings.intake_mode` defaults to `legacy`. The rollout controls
default to `selection_mode=exact`, a cap of one and empty exact allowlists, so an
unapproved case cannot be selected. `full_open` is a separate explicit authority;
it is never inferred from empty lists.

Runtime components:

- `supabase/functions/ops-api/makesafe_deterministic_intake.ts`
- `supabase/functions/ops-api/makesafe_deterministic_intake_runtime.ts`
- `scan_ses_makesafes`, which reads the DB switch once and enters exactly one path
- `makesafe_deterministic_intake_replay`, a no-write aggregate replay action
- `makesafe_deterministic_intake_dark_observe`, an authenticated no-write action that
  requires exact source ids or instruction keys and returns sanitized case proposals

The deterministic branch imports no model SDK and has no AI fallback. The paid AI
extraction API stays off and is not required by automatic scans, terminal skill runs
or manual operator checks. Health records `intake_mode=deterministic` and
`last_scan_model_calls=0`.

The terminal skill integration contract is
`docs/makesafe-intake-terminal-hook.md`. Automatic cron, scoped terminal routine and
manual operator calls all enter the same deterministic scanner; only a DB-approved
selection authority can reach business writes: `exact` via its non-empty allowlists,
or separately approved `full_open` via the bounded cursor page.

## Query and payload constraints

The replay/runtime reads only named columns. Email reads and the persisted
case/case-source resume reads all paginate explicitly in 500-row pages, below the
PostgREST 1,000-row cap, and attachment IDs are fetched in bounded batches. It never selects
`jobs.scope_json`, `calendar_events.scope_json`, `pricing_json`, or any list/feed
`select('*')` payload.

Open PR 334 changes unrelated `ops_summary` calendar and pipeline pricing projections.
This package does not touch those query blocks and does not duplicate that PR.

## Bounded resumable runs

A live scan is incremental and cannot drain an unrelated backlog. It reads its
selection mode and case cap from `makesafe_cron_settings`. The cap defaults to
exactly one and is constrained to 1 through 10. In `exact` mode, empty allowlists
fail closed, and so does an allowlist that resolves no case; a partially resolved
allowlist reports its unmatched entries and proceeds on the resolved set. In
`full_open` mode, both allowlists must be empty and the runtime processes the bounded
cursor page directly. A mixed full-open plus allowlist configuration fails closed in
both the database and runtime. The
window read is capped per invocation and allowlisted sources are read by id, so
read and plan cost stay flat as the mailbox grows. The cap defers work instead of
dropping it: the sweep half of the read walks the whole window from a persisted
`received_at` cursor, so every in-window source is eventually planned no matter how
far behind the newest rows it falls.
One invocation can attempt only allowlisted cases and stops after four times
the explicit case cap, so an edge timeout never discards accounting already committed.
Cases are stamped as they go and the next scan resumes.

That cursor is a completion checkpoint, not a read-ahead marker: it advances only
after the run finishes its writes and truthful health update. A cancelled, rejected
or thrown run therefore retains the prior cursor and rereads the same page
idempotently. A completed but degraded run still advances, carrying the explicit
`scan_page_completed_degraded_retry_next_sweep` caveat so one poison page cannot pin
every older page; the bounded sweep retries it on its next pass to the window head.

Ordering inside a run is: deferred/failed job-creation retries up to half the
budget, then cases never attempted before, then the remaining retries. Cases already
at their resolved state are inert. A systematically failing case therefore cannot
crowd out fresh work.

The guarded job path runs the same required-field gate as approval before any
storage, artifact-ledger or draft write, so an approval rejection (for example a null
canonical client, or a missing work-order PDF on a physical report-family case) leaves
no persisted case, artifact or draft side effect. The `artifacts_created` and
`drafts_created` totals increment at the successful insert boundary, not after approval
returns, so a later rejection cannot leave an uncounted write. Case-wide recovery never
lets off-case client-name evidence flip a null canonical client to satisfied: the gate
validates the actual canonical field, not the correlated cluster hint. A report-family
plan that carries a combined make-safe + report obligation
(`extraction.secondary_obligation`) is treated as physical, so it too requires a
servable work-order PDF and splits the report type onto the secondary card.

Before planning live jobs, the run reads existing make-safe jobs and binds a case
to a pre-existing obligation instead of creating a duplicate. The match is made at
one shared canonical boundary (`_shared/makesafe_refs.ts`) used by both this
selection dedupe and the intake-draft approval duplicate guard, so the two never
drift: the external ref is canonicalised so a manual/recovery composite display
token (`MLB-26537PO-56922`) matches the deterministic claim (`MLB-26537`); the
builder is collapsed through the one shared alias set (`majorloss`/`mlbuilder`/`MLB`,
the AJ cluster, etc.); and a PO discriminator pulled from the explicit PO, the work
order field, or the composite ref keeps two explicitly different POs from ever
over-deduping into one obligation. A cancelled/void/superseded job is a dead
obligation and is excluded from the match, so a later genuine re-issue of the same
claim/PO creates a live job rather than binding to the dead one. The dedupe read is
paged to exhaustion so an obligation past the PostgREST 1,000-row cap cannot hide.
Separately, before any write every selected lineage node is normalised to the cycle
the database trigger will derive: roots land on cycle 1, `reopen_of` children on their
parent's cycle plus one, and every other typed relation (sibling, revision,
cancellation, duplicate) inherits its parent's cycle. Normalisation resolves
recursively, so a reopen descendant is rebased when an earlier sibling or root
collapses to its database cycle, and a parent that is already persisted while also
appearing in the full-open selected plan keeps its authoritative database cycle. Only
the `/cycle:N` key identity and cycle number are aligned to the trigger; revision,
cancellation, reopen and distinct-PO ancestry semantics are preserved.

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
  supabase/functions/ops-api/makesafe_deterministic_intake_runtime_test.ts \
  supabase/functions/ops-api/makesafe_production_controls_test.ts \
  supabase/functions/ops-api/makesafe_alarm_readiness_test.ts
```

The pure adapter tests cover MLB, AJS/AJBR, Prime, RAPID, chatter, case-wide late
evidence, address-only hostile identity, distinct POs, WO formatting, significant PO
suffix punctuation, claim-only exclusion, revisions, reopen cycles, twins, resends,
cancellation, unknown builders, replay equality, zero unaccounted sources, and zero AI
fallback.

The runtime tests cover commit-and-resume behaviour, exact allowlist selection,
full-open selection processing the bounded cursor page while exact-empty and mixed
full-open-plus-allowlist configurations fail closed, the
N=1 cap, bounded fairness, run-twice zero-new-write behaviour, source accounting before
job creation, content-hash artifact deduplication across twin posts, failure injection,
zero AI, and zero assignment/work-order/invoice/client-communication writes. They also
cover the PR 351 rerun remediation: approval prevalidation rejecting a null canonical
client before any artifact or draft persistence, the production-shaped moving-sweep case
where three off-case candidates cannot satisfy a null canonical client, overlapping
manual and scheduled exact invocations converging without prevalidation side effects,
and a report-family combined split obligation requiring a work-order PDF while a plain
report-family plan still needs none. They also cover the external-obligation dedupe
boundary: deterministic selection links a canonical claim ref to its composite-ref
recovery job, an exact-selected sibling of a persisted cycle-1 root rebases to the
trigger-derived cycle (and its persisted source authority survives a capped-cursor
re-key across reruns), a cancelled/void/superseded job is excluded so a re-issue
creates a live job, and two explicitly different POs are never over-deduped. Full-open
lineage normalisation is covered directly: a parentless reopen root planned at an
ambient cycle is written as database cycle 1, and a selected plan whose persisted root
also appears in the full-open set has its siblings, `cancellation_of` node and reopen
descendants all rebased to the cycles the trigger derives. The
migration-contract tests assert both write boundaries share the same canonical ref,
PO-core and builder-alias helpers so they cannot drift.

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
GET /ops-api?action=makesafe_deterministic_intake_replay&days=60&only_unscanned=true&max_sources=2000
```

Use the existing privileged read credential. `max_sources` is optional, bounded to
1 through 2,000, and exists so a narrow acceptance window can be proved in one
response when the 500-row production default is too small. The response contains
aggregate totals by builder and outcome only. It never returns message bodies,
addresses, client details, attachment URLs, secrets, source identifiers, or the
internal post-id tie breaker used by the sweep cursor. `dry_run=true`, `ai_calls=0`,
and all write totals must remain zero.

Required acceptance checks:

- `evidence.zero_unaccounted_proved = true`. `totals.unaccounted = 0` on its own is
  not sufficient: a run that filled either source sub-read, started partway through
  a sweep, or returned a non-null next cursor only accounts for the rows represented
  in that response. It reports `evidence.source_accounting_complete = false` and a
  `source_read_capped` or `source_sweep_partial` caveat, and must not be filed as
  clean evidence. Re-run from the sweep head with a higher `max_sources`, or use a
  narrower `days`, until `cursor_at=null`, `next_cursor_at=null`,
  `source_read.cap_reached=false`, and `evidence.caveats=[]` in the same response.
- `evidence.caveats = []`, so no instruction key went unresolved purely because the
  cap hid its sources (`instruction_allowlist_cap_exposed`)
- every known-builder shortfall is visible in an exception outcome
- distinct PO fixtures stay distinct
- no address-only merge
- no claim-only confirmed-live result
- chatter is counted
- model calls remain zero

The aggregate response also includes `identity_floor`, calculated at canonical-case
grain as `reached / known_builder_work_candidates * 100`, with per-builder counts.
`reached` means the known-builder case has canonical WO/PO identity. Claim-only
work remains below the floor and cannot enter confirmed-live state. The metric does
not claim the case is ready to create a job: missing
client/address, work-order PDF, phone or portal capture remains a loud parser,
artifact or recovery outcome. Own-domain SES copies are structurally accounted as
non-work and never inflate the denominator. File that sanitized object with the
current commit so the 95% gate is reproducible.

For the required N=1 human comparison, call the authenticated dark surface with exactly
one approved source id (or one approved instruction key):

```text
POST /ops-api?action=makesafe_deterministic_intake_dark_observe
{"source_ids":["<approved source id>"],"instruction_keys":[],"days":60}
```

The response contains hashed case handles, outcomes, reason/block fields and
identity-evidence booleans. It returns no source id, raw/canonical ref, name, address,
message text, attachment name or URL. `dry_run=true`, `ai_calls=0`, and every write
total must be zero. A missing or partially resolved allowlist fails rather than
silently widening the comparison.

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

Health must report the effective `intake_mode` and
`alarm_readiness.ready=true` from a fresh authenticated canary timestamp. A configured
recipient or existing cron without fresh authenticated proof is not ready.

Production edge deploys are allowed only from main in:

`/Users/marninstobbe/Projects/_release/secureworks-site-main`

Use the repository guarded deploy script documented in `AGENTS.md`. Do not deploy from
a feature worktree.

## Direct guarded cutover

There is no prolonged dual-running phase. This phase remains blocked until the
separate Board/Hugo sender seam and every named gate pass. In the approved coordinated
window, the first intake update must atomically bind authority to the one reviewed
source and cap:

```sql
update public.makesafe_cron_settings
set intake_mode = 'deterministic',
    deterministic_selection_mode = 'exact',
    deterministic_max_cases_per_run = 1,
    deterministic_source_allowlist = array['<one approved source post id>'],
    deterministic_instruction_allowlist = array[]::text[],
    deterministic_rollout_changed_at = now(),
    deterministic_rollout_changed_by = '<approved operator>',
    intake_mode_changed_at = now(),
    intake_mode_changed_by = '<approved operator>'
where id = true
  and intake_mode = 'legacy';
```

Require exactly one updated row. The next scan can select only that canonical case
(and its correlated twin/resend evidence), up to one case. It cannot enter the
legacy/model branch or pick up unrelated backlog during that invocation.

After the exact N=1 loop is accepted and full-open activation is separately approved,
widen with one atomic configuration change:

```sql
update public.makesafe_cron_settings
set deterministic_selection_mode = 'full_open',
    deterministic_max_cases_per_run = 1,
    deterministic_source_allowlist = array[]::text[],
    deterministic_instruction_allowlist = array[]::text[],
    deterministic_rollout_changed_at = now(),
    deterministic_rollout_changed_by = '<approved full-open operator>'
where id = true
  and intake_mode = 'deterministic'
  and deterministic_selection_mode = 'exact'
  and cardinality(deterministic_source_allowlist) = 1
  and cardinality(deterministic_instruction_allowlist) = 0;
```

Require exactly one updated row. Keep the case cap at one during the bounded
observation window. Full-open changes selection authority only: source reads remain
capped, cursor-driven and zero-AI. An invalid selection mode, non-empty allowlist in
full-open, or exact-empty deterministic configuration fails closed.

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
2. structural source accounting has zero unaccounted emails and the run reports
   `evidence.zero_unaccounted_proved = true` rather than a capped read
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
