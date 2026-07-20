# Deterministic make-safe intake case seam

## Status and authority

This is the inert U1 structural slice for the approved deterministic make-safe
intake mission. The migration is drafted but has not been applied. No current
adapter, scan, draft, approval, auto-file, job creation, board, notification or
AI path imports or writes this model.

Up migration:

`supabase/migrations/20260720000001_makesafe_intake_cases.sql`

Manual pre-cutover down migration:

`supabase/rollbacks/20260720000001_makesafe_intake_cases_down.sql`

Apply and rollback remain Captain-gated under G4.

During parallel observe, `makesafe_intake_drafts.status` stays authoritative and
case rows are shadow records. The service-role-only
`makesafe_intake_case_divergence` view compares case state, draft state and job
existence per attached source post. At a later gated cutover, cases become the
classification and lineage authority, drafts become extraction artifacts, and a
subordinate draft-to-case link is added. The runtime authority switch must be a
DB single-row flag following `makesafe_cron_settings`, not an environment flag.
This U1 migration does not add or flip that runtime switch.

## Ownership boundaries

- `emails`, `email_attachments` and `email_events_raw` remain the capture and
  immutable evidence estate. Intake decisions never mutate them.
- `makesafe_intake_cases` is the future sole classification, canonical identity,
  lineage and decision authority.
- `makesafe_intake_drafts` remains the current extraction/approval artifact until
  cutover. Its current schema and runtime behavior are untouched here.
- `makesafe_companies` is the only existing table this migration alters. Legacy
  rows predate org scoping and carry a null `org_id`, which would make them
  permanently unlinkable once the case org check is strict, so they are
  backfilled to the single existing tenant and the column is closed with NOT
  NULL. No column DEFAULT is added: an insert that omits `org_id` must fail
  loudly rather than silently land in a hardcoded tenant. Callers that already
  supply `org_id` are unaffected.
- `jobs` remains execution state. A case points directly to one job, independent
  of whether best-effort `makesafe_job_details` creation succeeded. No new case
  identity is copied to `jobs.metadata`.

After cutover this seam explicitly subsumes these current truth surfaces:

1. `buildIntakeDedupIndex` and `isDuplicateIntake` become advisory classifiers;
   database instruction/source/live-identity keys become identity authority.
2. Capped heuristic reconcile counters are replaced by the uncapped structural
   `makesafe_intake_email_accounting(org_id)` function. `emails` carries no org,
   so accounting is answerable only for a named tenant and is parameterised
   rather than exposed as an org-pinned view. The existing 500/1,000-row truncation
   hazard is explicitly routed to U7; U1 does not edit that active reader.
3. Ref/message-grain `makesafe_notify_log.dedup_key` is replaced by Mission 2's
   lineage-grain notification ledger.
4. Board `known_refs` draft joins are replaced by case-to-job/source joins.

Those runtime sunsets are later units. None is edited or activated in this PR.

## Case grain and source accounting

A case is one source instruction. `instruction_key` is deterministic instruction
content plus a stable deliverable discriminator plus the case cycle, so a reopen
whose content and deliverable match the original still gets its own row. Its
unique key is:

`(org_id, instruction_key)`

Twin Graph posts, dual-capture `AAMk...`/`mailbox_<hash>` rows, re-sends and late
PDFs resolve the same instruction key and attach as N source rows to one case.
The source junction structurally accounts each email once per tenant with:

`UNIQUE (org_id, post_id)`

A source FK to `emails(post_id)` is `ON DELETE RESTRICT`. Email PII can still be
tombstoned by the existing retention flow, while case identity and the source
link survive. Source rows preserve Graph/internet/conversation/thread ids,
received and observed time, raw evidence, provenance and attachment references.
They store no bytes, public URLs or signed URLs.

Separate POs and deliverables produce separate instruction keys. Claim/external
reference is never unique. Candidate identity indexes are non-unique.

## Identity and live uniqueness

Raw builder, external reference, builder WO, builder PO and deliverable values
are separate from canonical values. Once present, raw values cannot be replaced
or cleared. Canonical changes require append-only per-field provenance.
Provenance supports `deterministic`, `ai`, `human`, `maverick` and `backfill`.

Known builders use `company_id` as the stable profile identity. `company_key` is
derived from that UUID, so live slug drift such as `aj`/`ajs`/`ajbr` does not
split the key. `normaliser_version` records the one normaliser version used for
all canonical identity fields. Later adapters must import the shared normaliser
rather than reproduce ref rules.

The normaliser folds separators to a single hyphen so `WO#12345`, `WO 12345` and
`WO-12345` are one builder identity. Folding `/` and `:` also keeps them out of
canonical components, which is what makes the `wo:<wo>/po:<po>` composition
injective. The separator class is per field, not shared: `.` and `_` are
separators inside a builder WO (`WO.12345` equals `WO-12345`), but significant
inside a builder PO, so `PO-1.2` and `PO-1-2` stay two identities. The accepted
consequence on the WO side is that suffix punctuation is noise (`WO-1234.1`
equals `WO-1234-1`) while distinct suffix values (`WO-1234.1` versus
`WO-1234.2`) stay distinct, so revision/stage numbering survives. A builder WO is
treated as a claim-ref family only when a known prefix actually matches;
otherwise it stays an opaque builder identity, so `WO 12345` and `REF 12345` are
never salvaged down to the same bare number.

The S13-safe live unique key is:

`(org_id, company_key, wo_po_identity_key, cycle)`

It applies only to confirmed/blocked cases with known company and WO/PO identity.
Claim ref is deliberately absent. Different builders and separate POs do not
collide. `wo_po_identity_key` is not free text: a DB check requires it to be
exactly the WO/PO precedence composition of the canonical columns, so a
mis-stamped key cannot silently split or collapse live identity.

The live identity floor also admits a claim-ref-only live case, which carries no
`wo_po_identity_key`. Those cases fall back to:

`(org_id, company_key, external_ref_canonical, coalesce(deliverable_ref_canonical, ''), cycle)`

so claim-only live work still cannot duplicate, while separate deliverables and
reopens under one claim stay separate. Claim-only family ambiguity across
builders still receives no constraint decision and stays a server classification
decision.

## Lineage and reopen cycle

A root case has `lineage_id = id`. Every non-root case has exactly one typed
`parent_case_id` plus `parent_relation`:

- `revision_of`
- `duplicate_of`
- `cancellation_of`
- `sibling_of`
- `reopen_of`

Parent and relation are both set or both null. The parent must already exist in
the same org. The child inherits its lineage and lineage fields are immutable.
This forms a forest and prevents cycles without a recursive edge table.
`duplicate_of` must point directly to a non-duplicate lineage root, preventing
ambiguous duplicate chains.

U1 defines reopen cycle itself: every `reopen_of` child is
`parent.cycle + 1`, regardless of the current path-dependent legacy behavior for
reattend versus cancel/reopen. Cycle is in the live unique key. Earlier portal
or job-cycle invalidation is later U5/U4 wiring and is not hidden in a trigger.

## State and audit

The four outcomes are:

1. `confirmed_live_job`
2. `blocked_live_job` with named `blocked_reasons`
3. `exception` with one approved reason code
4. `accounted_non_wo` with one approved reason code

Database checks enforce live job/identity floor, named blocked reasons,
reason-coded exception/non-WO outcomes, and no job on cancellation or any
exception/non-WO case. A partial unique index permits one case to own a job.
Job and company triggers enforce org scope; a linked job must be `type=makesafe`.

`makesafe_intake_case_events` is trigger-fed in the same transaction for initial
classification, state transitions, authority promotion and canonical identity
updates. Events and source rows reject UPDATE/DELETE. Cases reject DELETE and
lineage re-parenting. Transition legality is structural; actor authority remains
with later route-gated server commands.

Backfill decisions require `provenance='backfill'` and
`side_effects_suppressed=true`. Natural-key `ON CONFLICT DO NOTHING` means a
second run writes no case, source or event rows. U1 has no notification/domain
emitter, and the helper contract proves zero effect writes.

## Later consumers

### Deterministic adapters

A later adapter computes the shared versioned canonical identity and instruction
key, upserts one case by `(org_id, instruction_key)`, then attaches every source
post by `(org_id, post_id)`. Exact DB conflicts are authority; fingerprints and
family/revision judgment remain server classifiers. Optional AI can append
attributed secondary evidence only.

### Job creation and lineage commands

A later unit resolves blocked/confirmed cases through the existing shared
approval gate, sets `case.job_id` and adds the future details backlink/view in
one transaction. Cancellation, revision and reopen commands create the typed
case/parent shape, append case events, and explicitly flag the target job at the
server boundary. No cross-table U1 trigger performs those visible mutations.

### Read models

Later board/card reads join case to job, sources and events. They query
`(org_id, state, received_at)`, use `lineage_id` for grouping and notification
grain, and never infer sameness from claim ref alone.

## Test kit and hostile fixtures

Focused pure and migration-contract tests cover the inert U1 part of Fable's
hostile set:

- MLB-26567 twin post ids and dual capture converge to one instruction case with
  two source rows.
- MLB-26118 resend x4 creates no cases or notifications and four source links.
- MLB-27037 PO variants share lineage but retain separate live keys.
- Same numeric ref across builders does not collide.
- Claim-only different-family work is not constraint-collapsed.
- Ref-less mail is accounted as `exception(below_identity_floor)`.
- Self-parent, contradictory parent shape, duplicate chain and re-parent fail.
- Cancellation with a job fails; cancellation and late revision attach to the
  existing lineage without resurrecting work.
- Reattend and cancel/reopen inputs both use the same case-defined next cycle.
- A details-less job remains directly reachable through `case.job_id`.
- Same-post/concurrent replay is idempotent and cross-case accounting is loud.
- Backfill run two performs zero case/source/event/effect writes.
- Raw/canonical retention, provenance, org scope and slug drift are covered.
- Per-field separator folding holds: WO separator style folds while distinct WO
  suffix values stay distinct, and PO dot/underscore stays significant.

The disposable clone SQL additionally exercises actual constraints, trigger-fed
append-only events, N:1 sources, PO siblings, cycle-in-key reopen and run-twice
backfill. U4/U5 later own hostile fixtures requiring actual approval races, live
job flag mutation, portal invalidation or notification emitters. U8/U10 own the
60-day replay, runtime RLS probes and full current-pipeline byte-parity test.
Their fixture names remain listed in the Fable review; U1 does not fake those
runtime proofs.

Adjacent findings are routed, not silently repaired here: the ignored
`suppress_notifications` input and manager SMS belong to the later notification
seam; SWMS fallback job-number concurrency belongs to job creation hardening; the
residual dropped-after-extraction path belongs to health/reconcile; and the
best-effort `reopen_candidate` draft insert belongs to reopen wiring.

Run local isolated tests:

```bash
~/.deno/bin/deno test --allow-read \
  supabase/functions/_shared/makesafe_intake_case_model_test.ts \
  supabase/functions/_shared/makesafe_intake_case_migration_test.ts
```

Before G4, run apply/re-apply and SQL contract checks against a disposable clone
of the current production schema:

```bash
MAKESAFE_PROD_SCHEMA_CLONE_URL='postgres://...' \
MAKESAFE_PROD_SCHEMA_CLONE_ACK=I-confirm-this-is-a-disposable-prod-schema-clone \
  scripts/test-makesafe-intake-case-migration.sh
```

The harness refuses the live project reference. It is not run by this PR without
a supplied disposable clone.

## Staged rollback

### Before cutover

1. Obtain Captain G4 approval.
2. Confirm no case has `is_authoritative=true`.
3. Optionally export shadow rows.
4. Run the manual down script. It drops only the new views, three tables and
   helper functions. Capture, drafts, jobs and existing events remain untouched.
   The `makesafe_companies.org_id` backfill and NOT NULL are deliberately not
   reverted: every row already carries the single tenant org, and reopening the
   null-org hole would be a regression rather than a rollback.

### After cutover

Do not run the down script. It refuses when authoritative case evidence exists.
Rollback is the later G5/G6 DB single-row flag flip back to the old pipeline.
The case ledger remains inert for audit. Physical removal is a separately
approved archive/rename operation after evidence retention review, never DROP.
