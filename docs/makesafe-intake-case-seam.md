# Deterministic make-safe intake case seam

## Status

This is the inert U1 structural slice for the approved deterministic make-safe
intake mission. The migration is drafted but has not been applied. No current
adapter, scan, auto-file, job creation, board read, message path or AI path uses
these files.

Up migration:

`supabase/migrations/20260720000001_makesafe_intake_cases.sql`

Manual down migration:

`supabase/rollbacks/20260720000001_makesafe_intake_cases_down.sql`

Production apply and rollback both remain Captain-gated under G4.

## Data grain and idempotency

`makesafe_intake_cases` stores one row per source instruction. A later adapter
must derive `source_instruction_key` from the stable source message id and a
stable deliverable discriminator. If one message contains two separately
servable POs or deliverables, it must produce two instruction keys and two
cases. Replaying the same instruction uses the same key and conflicts on:

`(org_id, source_system, source_mailbox, source_instruction_key)`

Twin Graph posts and re-sends have different source message ids. They remain
separate cases and are related with `duplicate_of` or another evidenced lineage
edge. Canonical external reference, PO and deliverable columns are indexed for
candidate matching but are intentionally not unique. Therefore matching cannot
silently collapse genuine separate work.

Raw builder, external reference, PO and deliverable values are separate from
canonical values. Once a raw value exists, the database trigger refuses to
replace or clear it. Canonical changes require updated field provenance.

## Tables

- `makesafe_intake_cases`: source identity, raw and canonical identity, current
  outcome, named missing/conflicting fields, related jobs and latest decision.
- `makesafe_intake_case_transitions`: append-only initial classifications and
  valid state transitions with deterministic, AI or human provenance.
- `makesafe_intake_case_sources`: append-only source message evidence, including
  Graph and internet message ids, conversation/thread ids and received time.
- `makesafe_intake_case_attachments`: append-only attachment evidence snapshots,
  linked to the current private email attachment store when available.
- `makesafe_intake_case_lineage`: append-only revision, duplicate, cancellation,
  sibling and reopen edges.

Composite foreign keys keep child evidence in the case org. Triggers also reject
job and legacy intake-draft links from another org. All five tables use the
existing backend-owned make-safe posture: RLS is enabled, anon/authenticated
have no grants or policies, and service role has the only policy.

## State and lineage rules

The four outcomes are:

1. `confirmed_live_job`
2. `blocked_live_job` with named `blocking_reasons`
3. `exception` with one approved closed-set `exception_reason_code`
4. `accounted_non_wo` with a non-empty accounting reason

The database validates each state's required job and reason shape. It records
initial classification and each valid transition automatically. Transition,
source, attachment and lineage rows reject update/delete.

Hierarchical lineage edges reject self-links and cycles. An org-scoped advisory
lock closes the practical concurrent-insert race around the recursive cycle
check. A partial unique index allows only one `duplicate_of` parent per duplicate
case. Sibling edges are stored once in UUID order.

## Later consumers

### Deterministic adapters

A later unit can parse source messages and insert or upsert cases using only the
source-instruction uniqueness key. It must add source and attachment evidence in
the same transaction. Deterministic parse results write per-field provenance.
Optional AI can only add attributed secondary evidence; it cannot determine
whether the source is accounted.

### Job creation

A later unit can resolve an exception or create a blocked/confirmed make-safe job
through the existing shared approval gate. It then transitions the case and sets
`result_job_id` in one transaction. Exceptions that concern an existing job use
`related_job_id`; the exception case itself does not own a newly created job.
This migration does not bypass or modify the existing approval boundary.

### Read models and board views

A later read-model unit can project current cases plus append-only transition and
lineage history. It should query by `(org_id, current_state, source_received_at)`
and use lineage to group revisions/re-sends without treating shared PO/reference
values as proof of sameness. No board view is created here.

## Apply and rollback procedure

### Up

1. Obtain the Captain's named G4 approval for the exact reviewed migration.
2. Use the approved release migration process from the canonical release branch.
3. Verify only schema objects, policies, constraints and indexes were created.
4. Confirm all five tables are empty and no runtime path references them.
5. File the apply evidence. Do not enable adapters or backfill under G4.

This PR does not perform any of those steps.

### Down

1. Stop before rollback if any later adapter has written data.
2. Export all five tables and obtain the Captain's named approval.
3. Run the manual down script as one transaction.
4. Verify existing `jobs`, `makesafe_intake_drafts`, `emails`,
   `email_attachments` and event records remain unchanged.
5. File rollback evidence.

The down script is destructive only to this new isolated seam. Once runtime
adapters exist, code rollback should normally leave these audit tables in place;
dropping them is an emergency schema rollback with an export first.

## Tests

Run the isolated model and migration contract tests:

```bash
deno test --allow-read \
  supabase/functions/_shared/makesafe_intake_case_model_test.ts \
  supabase/functions/_shared/makesafe_intake_case_migration_test.ts
```

The tests cover valid and invalid transitions, all state shapes, lineage cycles
and duplicate parentage, raw/canonical retention, org scoping, replay
idempotency and separate-deliverable keys. The migration contract test also
checks RLS, append-only triggers and rollback isolation without applying the
migration.
