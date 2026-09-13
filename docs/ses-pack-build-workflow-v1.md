# SES pack build: one recoverable attempt

Scope: a make-safe card that has reached **Trade Report In** and needs its
builder pack documents built. Backlog `ses-workflow-completion-20260913`.

This is the scoped "How it works" definition, the runtime reader and the
trigger/run-state contract. It is **not** a second overlay: everything below
consumes the existing producer, the existing ledger, the existing pack skill
and the existing stage engine.

---

## How it works

A trade submits a report. That writes a `job_events` row, and the AFTER INSERT
trigger `trg_enqueue_ses_report_trigger_run`
(`supabase/migrations/20260911060000_ses_report_trigger_runs.sql`) files **one
attempt** on `public.ses_report_trigger_runs`.

One attempt per **(job, attendance cycle, source identity)**. That triple is
the `dedupe_key`, it is UNIQUE, and it is composed in exactly one grammar:

```
<job_id>:<attendance_cycle_id or "cycle?">:<source identity>
```

The grammar lives in `sesPackBuildAttemptKey`
(`supabase/functions/ops-api/ses_pack_build_admission.ts`) and must stay
byte-identical to the SQL producer. A surface that composes its own key files a
second row for work that already has one.

A repeat of the same event does not create a second row; it increments
`duplicate_events` on the row that exists.

The attempt is then executed by ONE handler, `run_ses_report_trigger`
(`ses_report_trigger.ts`), whichever door asked for it. The handler:

1. **Claims** the run under a bounded lease (`claim_ses_report_trigger_run`,
   `FOR UPDATE SKIP LOCKED`, a per-claim token, attempt ceiling 6). Every later
   write is compare-and-swapped on that token, so a worker whose lease expired
   cannot overwrite a newer claim.
2. **Re-reads** the job and its current attendance cycle. Nothing is trusted
   from the event.
3. **Admits or refuses** through the admission gate (below).
4. On `admit` only, hands the one card to the existing pack skill,
   `prepare_ses_docket_revision`, with the `dedupe_key` as the idempotency key.
5. **Records the outcome** on the run: state, docket revision, output content
   hash, the admission receipt, and — on any refusal — a `recovery_action` that
   names the operator's next step.

The handler never builds a pack itself, never calls Xero, and never sends.

---

## The admission gate

`admitSesPackBuild` is a pure function. It reads pack truth from the ONE shared
read (`inspect_ses_pack`) and the sibling attempts from the ledger, and returns
one decision. It is checked in this order, and the order is part of the
contract.

| # | Decision | When | Run state | Builds? |
|---|---|---|---|---|
| 1 | `refuse_cross_job` | the pack read came back for another job | `refused_gate` | no |
| 2 | `refuse_cross_tenant` | the request names a different organisation | `refused_gate` | no |
| 3 | `hold_no_cycle` | the card has no attendance cycle | `refused_gate` | no |
| 4 | `hold_stale_cycle` | the report belongs to a closed cycle | `refused_stale` | no |
| 5 | `hold_pack_sent` | the pack has already gone to the builder | `refused_gate` | no |
| 6 | `join` | another attempt holds this cycle under a live lease | *(stays runnable)* | no |
| 7 | `reuse` | a complete pack for this cycle already exists | `done` | no |
| 8 | `hold_already_built` | a sibling completed this cycle, pack incomplete | `refused_conflict` | no |
| 9 | `hold_divergent_pack` | pack unreadable, or present with an owed pointer missing | `refused_conflict` | no |
| 10 | `hold_requirements_unresolved` | the family's document requirements did not resolve | `refused_gate` | no |
| 11 | `admit` | nothing has been built for this cycle | *(proceeds)* | **yes** |

Four properties are load-bearing:

- **Identity first.** A cross-job or cross-tenant request refuses before any
  cycle or pack fact is consulted, so the operator is told the real fault.
- **Reuse before refusal.** A card whose work is genuinely finished completes
  (`reuse`) instead of parking a human with a reconcile. Reuse adopts the
  existing docket revision and hash; it hands nothing to prepare, so a second
  invoice is unreachable rather than merely unlikely.
- **Everything fails closed.** An unreadable pack, an unresolved family and a
  missing cycle all refuse. A read fault is never "there is no pack".
- **`mints_allowed` and `sends_allowed` are structurally `false`** on every
  decision the gate can return.

`join` is deliberately not terminal: the run releases its claim back to
`pending`, gives back the attempt the claim spent, and comes back after 60
seconds. Waiting for somebody else is not an attempt at building.

---

## Trigger surfaces

Every surface reaches the same run, the same eligibility, the same claim and
lease, the same idempotency key, the same receipt and the same document
binding, because they all reach the same `run_ses_report_trigger` handler.

| Surface | How it starts an attempt | Who may drive it |
|---|---|---|
| Cloud interval | pg_cron `ses-report-trigger-drain` posts the next runnable run to `run_ses_report_trigger` | server |
| Manual / terminal | `run_ses_report_trigger` with an exact `job_id` + `attendance_cycle_id` + `source_identity` | privileged ops key |
| UI Refresh | `request_ses_pack_build` files **or joins** one attempt, then returns | ops key, reporting routine, or an operator session |
| Direct prepare | `prepare_ses_docket_revision` builds, and the receipt is recorded on the same ledger | ops key, reporting routine, or admin/owner session |

### Refresh is assess-and-queue, never send

`request_ses_pack_build` **does not build.** It assesses the card, queues the
permitted work as one attempt, and reports progress. It never calls prepare,
never touches Xero and never dispatches mail. Its response carries
`mail_sent: false` on every path, because the one thing a Refresh button must
never imply is that the builder has been emailed.

If an attempt is already open on the cycle, Refresh joins it and files nothing.
If the pack is already complete, Refresh queues nothing and says so. If the
card is on a hold, Refresh queues nothing and hands back the recovery action —
filing a run guaranteed to refuse would only spend the dedupe key and hide the
real answer behind a ledger row.

The driving person is taken from the verified session and written onto the run
as `source.requested_by`. A body-supplied actor never reaches the ledger.

### Direct prepare is recorded, not gated

`prepare_ses_docket_revision` is reachable by the make-safe reporting routine,
the agent seat and any admin/owner session. That door **records** its attempt
(`recordDirectPrepareAttempt`) so the one ledger explains every pack; it is not
gated, because the operator or routine driving it is the authority there and
silently blocking the Captain's own cockpit press would be a worse failure than
a late receipt. The receipt write is fail-open and audible: it logs
`ses_pack_build_direct_receipt_unwritten` rather than turning a completed build
into an error.

Admission **enforces** on the trigger path, where refusal is already the
contract.

The receipt lands `done`, so a later trigger run sees an explained pack and
answers `reuse` rather than `hold_divergent_pack`.

---

## Run states

`public.ses_report_trigger_runs.state`:

| State | Meaning | Re-runnable |
|---|---|---|
| `pending` | filed, waiting for a worker | yes |
| `claimed` | a worker holds it under a lease | on lease expiry |
| `done` | the pack for this cycle is built (or an existing complete pack was adopted) | never |
| `refused_stale` | the report belongs to a closed cycle | by explicit re-file |
| `refused_conflict` | the cycle is already built, or a pack exists that this attempt must not rebuild | by explicit re-file |
| `refused_gate` | a named gate said no; `recovery_action` says which | by explicit re-file |
| `failed` | a transport fault after the claim; retries with backoff | automatically |
| `unknown` | attempts exhausted, or the assembler saw a different cycle; parked for a human | never blindly |

A terminal row is re-run only by an explicit `refile: true` carrying the
person's name. `done` is never refilable.

**This slice adds no new state and no migration.**

---

## Runtime reader

`GET ops-api?action=ses_pack_build_state&job_id=<uuid>`

Read-only. It writes nothing, not even a run row. It returns, for one card:

- the job and its current attendance cycle;
- the pack pointers, owed documents, current docket revision and output hash,
  who prepared it, and the bound invoice;
- `pack_read_failed`, which distinguishes "this card has no pack" from "the
  pack could not be read";
- every run on the card with age, attempts, lease holder, last error, recovery
  action and its admission receipt;
- `attempt.would_decide`: what the admission gate would answer right now;
- the drain's own observed state.

### Reading the drain honestly

`drain_enabled` is a **flag**. `cron_job[].active` is the **job**. They can
disagree, and when they do the flag is the one that lies: a `drain_enabled:
true` with `active: false` means nothing is processing runs at all.

`recent_cron_runs` reporting `succeeded` means the drain query ran and a post
was queued. It does **not** prove ops-api processed anything.

An empty `cron_job` or `scheduler_pulse` only means "not scheduled" when
`cron_visibility` reports `pg_cron_present: true`,
`cron_job_select_denied: false` and `definer_bypasses_rls: true`. Otherwise the
job may be scheduled under another database role and hidden by pg_cron row
security.

`recent_http_responses` are the latest `net._http_response` rows from **every**
pg_net caller. pg_net does not keep the request URL with a response, so a row
there is not proven to be a drain post.

---

## Docs Ready is not sent

Docs Ready means the documents exist and are bound. It never means the builder
has been emailed.

Placement stays with `sesStageDocsReady` (`ses_stage_engine_v2.ts`), which
already treats a sent pack as a **disqualifier** for Docs Ready. Nothing in
this slice moves a card, changes the board layout or alters a family rule.

Sending remains the separate approved release graph:
prepare → approve → execute, with its own approval, its own frozen manifest and
its own route proofs.

---

## Source pins

| Part | File |
|---|---|
| Producer | `supabase/migrations/20260911060000_ses_report_trigger_runs.sql` |
| Ledger, claim, drain | same migration; own-flag `20260911090000`; readers `20260911110000` |
| Handler | `supabase/functions/ops-api/ses_report_trigger.ts` |
| Admission gate | `supabase/functions/ops-api/ses_pack_build_admission.ts` |
| Operations doors | `supabase/functions/ops-api/ses_pack_build_doors.ts` |
| Pack skill | `supabase/functions/ops-api/ses_prepare_docket_revision.ts` |
| Shared pack read | `supabase/functions/ops-api/ses_inspect_pack.ts` |
| Docs Ready placement | `supabase/functions/ops-api/ses_stage_engine_v2.ts` |
| Tests | `ses_pack_build_admission_test.ts`, `ses_pack_build_doors_test.ts`, `ses_report_trigger_test.ts` |
