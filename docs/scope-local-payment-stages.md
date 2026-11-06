# Local payment stages

RQ-15. This replaces the proposed Xero-writing installation and council
consumers with local payment children of each retained payer draft. There is
no new whole-quote invoice, accounting entry, issue, send, payment link or flag.

The Scope producer seals `pricing_json.local_invoice_stages`, version 1, AUD,
terms version `2026-11-06`. Each stage has its stable id, label, printed terms,
exact amount, basis, trigger, due rule and payer allocations. The first stage
is the deposit on full quote acceptance. Every later stage uses an explicitly
selected installation, exact council step or staff-confirmed trigger.

The server reads this only from the accepted frozen source. It checks all
stage sums, each stage's payer split and every payer's sum across stages in
integer cents against the existing payer drafts. Missing or invalid money
does not become zero. An absent schedule opts nothing in. A malformed one is
held without failing acceptance or bookings. No legacy free-text payment
schedule or `billing_milestones` is consumed or backfilled.

## Events and retained identity

- Acceptance consumes the parent draft's once-only release, so partial
  acceptance creates no payment children.
- A dated genuine `assignment_type = install` row records the installation
  event. Ghost, observer and cancelled assignments are excluded. Rescheduling
  cannot create another child for the same stage.
- Only the explicit `updateCouncilStatus(... status: complete)` handler
  consumes a council stage, after its successful durable write. It rereads the
  exact submission, step id, name and completed time. Overall completion and
  workflow jumps do not call this consumer. Recompletion retains the first
  event and draft identities.
- An event on an already prepared source before acceptance is retained and
  consumed only if that exact source is accepted. Its original event time is
  retained, including retries. A different revision cannot reinterpret it.

`scope_payment_plans` retains the sealed accepted schedule. Child identity is
job + payer + stage, linked to the existing payer invoice id. The first
consumed event retains its exact trigger identity and time. Amount, source,
due rule and due time are never refilled from current working pricing.

Installation booking alone leaves work/material-based children held. Council
completion alone does not prove materials supplied. An identified staff
session can record actual work/material evidence, clearing only the hold,
never changing the frozen amount or due date. An `unconfirmed` contractual
basis stays held even after evidence is recorded. This applies conservatively
to every such stage; it never declares a home-building payment collectible.
Every row remains a local draft.

## Actions

POST `ops-api?action=read_scope_payment_stages` with
`{job_id, scope_revision_id}`. Staff and org binding match the parent draft
reader. It returns persisted `stages`, `prepared` and the same false safety
flags: `xero_writes`, `sent`, `payment_links`. Each stage has `id`, `payer_id`,
`payer_invoice_id`, `stage_id`, `scope_revision_id`, `status: draft`,
`amount_inc_gst`, exact `trigger`, `due_rule`, `due_at`, and `held_reason`.
No prepared plan means `prepared: false` and an empty stage list, not zero debt.

POST `ops-api?action=confirm_scope_payment_stage` with
`{job_id, scope_revision_id, stage_id, evidence_kind, note}`. Evidence kind is
`work_done` or `materials_supplied`, and a non-empty evidence note is required.
Only an identified staff JWT can record it; the caller cannot supply an actor,
amount, event time or acceptance claim. The note, actor and recorded time are
retained once. This is a stage evidence record, not a work-order approval,
customer sign-off or an accounting operation. It returns the persisted read.

## Production, undo and proof

The additive migration creates private plans, raw event signals, consumed
events, child drafts and staff confirmations. It installs acceptance and
installation triggers and the council/read/confirmation functions. Existing
acceptance and bookings survive a stage-consumer error. No rows are backfilled.

Undo: revert the matching function code first, then apply
`supabase/rollbacks/20261106044806_scope_local_payment_stages_down.sql`.
Producers and readers are removed; every plan, event, confirmation and draft
is retained privately. Nothing is deleted.

Local SQL proof covers two payers across four stages, pre-acceptance booking,
partial acceptance, ghost exclusion, held work, explicit staff evidence,
exact council identity, repeated events, unchanged amounts after mutable
pricing changes, invalid schedule refusal, unknown basis and payer totals.
Connected live journey proof remains in the shared test round.
