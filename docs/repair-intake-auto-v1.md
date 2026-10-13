# Automatic repair intake (v1)

Owner's word, 13 Oct 2026: a repair work order that MLB or Ambrose emails in
becomes a job in the insurance repair pipeline without a person approving it.

Rules: `supabase/functions/ops-api/repair_intake_auto.ts`. Wiring: the
per-order loop in `makesafe_deterministic_intake_runtime.ts` and the mint
brake in `approveIntakeDraft` (`index.ts`).

## The switch

One flag: `feature_flags.repair_intake_auto_v1`, seeded **off** by
`20261013110000_repair_intake_auto_flag.sql`.

- Off, missing or unreadable: intake behaves exactly as before.
- The scan reads it once per run. The mint reads it again, so switching it off
  stops the next approval.
- Turn it on only on the owner's word.

Switching it on does not act on what was already waiting:

| Already there | With the flag on |
|---|---|
| A repair draft waiting for review | Still waits. It carries no automatic stamp. |
| An order that already has a draft | Not landed on a job. The person holding the draft decides. |
| A collection order parked as "reattendance target not found" | Stays that exception. |

## Rule 1: a clean repair order becomes one repair job

A repair plan crosses the same guarded approval a make-safe does when all of
these hold (`decideRepairAutoIntake`):

- The builder is MLB or Ambrose, and known to the system.
- The **builder declared** the repair: Ambrose's "regarding repairs required",
  MLB's "Rapid Repair" header, or a work order PDF's declared type
  (`builderDeclaredRepair`).
- Claim reference, purchase order, customer name and site address are read.
- Nothing conflicts. The only gap allowed is the customer's phone, which does
  not hold a make-safe today either.
- It is a first-issue order, not an amendment, a reattendance or a cancellation.

Anything else is written as a review draft and waits, as before. The run
report's `repair_intake.parked_for_review` counts each reason.

The builder's declaration decides. Ordinary repair wording in the scope
("remove and replace", "supply and install") never parks a declared order: a
Rapid Repair order worded that way is read as declared by the builder, not as
a repair inferred from scope words. Scope wording with no declaration, and a
repair reached by elimination, stay supervised.

**Declared-only is the rule for this first switch-on** (owner's decision,
13 Oct 2026). A "clean repair order" means one the builder itself labelled as
repair work. An MLB or Ambrose order that only reads as a repair from its scope
wording, or by elimination, stops as a draft for a person even with every field
read. This is the first thing to widen once real orders have run through the
automatic path: the run report's `repair_intake.parked_for_review` count of
`repair_not_declared_by_builder` shows how many orders that would move.

The job is a `repair` job (SWR- number) in WO In, with the builder, claim,
purchase order and site on it.

### The builder's order value

The work order's ex-GST value is read off the PDF when it states exactly one.
It never decides whether the job is made: an order whose value cannot be read
still becomes a job, with the value left empty and marked as not read.

It is the **builder's order value, not our quote**. It is its own named field
and is never put in the card's `value`, so nothing that adds up `value` counts
a builder's figure as our price.

| Where | Value read | Value not read |
|---|---|---|
| Job `metadata.builder_work_order_value_ex_gst` | The figure | `null` |
| Job `metadata.builder_work_order_value_source` | `builder_work_order_pdf_not_our_quote` | `builder_work_order_value_not_read` |
| Repairs card `builder_work_order_value_ex_gst` | The figure | `null` |
| Repairs card `builder_work_order_value_note` | "Builder's work order value (ex GST), not our quote" | "Builder's order value not read" |
| Repairs card `value` | Unchanged: our price only | Unchanged |

A repair job nobody read a work order for (raised by hand) carries none of
these fields.

A trade never reads the figure. The Trade App's `my_jobs` returns the job's
metadata, so for every viewer below the quote tier the card is projected
through `withoutBuilderOrderValue`: `builder_work_order_value_ex_gst` and each
`builder_additional_work_orders[].value_ex_gst` are removed. The purchase order
numbers stay. `trade_job_detail` returns no metadata at all.

### What the 28 Aug 2026 rule guarded, and how it is still guarded

The rule said every repair mint needs a person, because a repair job's type and
number can never be changed afterwards. The risk was a **misread** work order
minting a card that cannot be undone.

That is still guarded, by a narrower check:

- A repair read from scope words or by elimination is never automatic.
- The draft must carry the stamp a flag-on run wrote (`extraction_json.repair_auto_intake`).
- The mint re-reads the flag and re-judges the draft. Only the two
  deterministic scan lanes can ask; the backlog sweep and the late-PDF lane
  cannot, and their own repair brake is untouched.
- If the guarded approval refuses (a possible duplicate, an identity conflict),
  the draft stays in the review queue and nothing fails.

## Rule 2: never a duplicate

Before a job or a draft is made from an order that reads as **repair** work,
the scan looks for an open repair job with the same builder and claim reference
(`matchOpenRepairJob`). The older duplicate check could not see repair jobs at
all.

| The repair job on that claim | What happens |
|---|---|
| Holds no purchase order | The order's purchase order and value are recorded on it. |
| Holds this purchase order | Left as it is. |
| Holds a different purchase order | The new one is listed under `metadata.builder_additional_work_orders`. The first is never written over. |
| More than one open repair job, none holding this order | A binding review card names them. A person picks. |

What the job "holds" is read the same way by the match and by the write: its
metadata, and the purchase order inside its detail row's `external_ref`
(`MLB-25147PO-56236`). A job whose own purchase order sits only in that
reference still holds it, so a new order is listed and never takes its slot.

In every landed case the work order PDF is attached to the job, one
`repair_work_order_landed_on_existing_job` job event is written, and one "new
work order on existing job" item opens on the intake desk. No second job and no
blank draft.

This applies only to an order that reads as repair work.

An order whose work order PDF cannot be staged (a storage read or write that
fails, or no uploaded PDF) is **not landed**: nothing is written to the job,
the case stays `awaiting_job_creation`, and the next scan tries the whole
landing again. A landing is final, so it is never made without its PDF.

A job holds one active work order document per file name
(`ux_job_documents_makesafe_attach_key`), and builders reuse one name for every
order (Ambrose: `Purchase Order.pdf`). So when the job already holds that name
for a different PDF, the landed order's PDF is attached under a name of its
own, the purchase order in front of the original
(`PO-2099930108 Purchase Order.pdf`), and both PDFs are on the job. A PDF
already on the job is not attached again.

### Further orders on the Repairs card

A job's first purchase order stays in the card's `builder_po_number`,
unchanged. Every further order recorded on the job is in one read-only list on
the Repairs card row, `builder_additional_purchase_orders`, in the order they
arrived (an empty list when there are none):

| Field | Value |
|---|---|
| `purchase_order` | The order number. |
| `builder_work_order_value_ex_gst` | The builder's ex-GST figure for that order, or `null` when it was not read. Never our price. |
| `received_at` | When the order's email arrived, or `null` when not kept. |

The card shows all of them. It does not choose which order governs and does not
add the figures up: that is the owner's pending decision. None of it enters
`value`, and none of it reaches a trade (the trade feed strips each order's
figure; see "The builder's order value").

**Not drawn yet.** The ops screen (`ops.html`, in the `secureworks-ux` repo)
does not read this field today, so a second order shows only in the job's
events, documents and the intake desk notice until that screen changes. What it
needs: under the order number on the Repairs card and in the job panel, a short
list of the further orders, each as its order number, the date it arrived and
the builder's figure labelled as the builder's, with no total. The Trade App
needs no change: a trade reads the purchase order numbers from the job and
never the figures.

### How a landed order is accounted

A job holds one intake case (`uq_makesafe_intake_cases_job`, live in
production), and the job's own order already holds it. So a landed order's case
does **not** take `job_id`:

| Case field | Landed order |
|---|---|
| `state` | `accounted_non_wo` (outside both live-identity indexes) |
| `reason_code` | `revision` |
| `job_id` | `null` |
| `recovery_cursor.landedOnRepairJob` | `jobId`, `jobNumber`, `purchaseOrder`, `purchaseOrderRelation` |
| `last_decision_reason` | `deterministic landed_on_existing_repair_job <job id>` |

The desk item is written before the case takes that fate. If the PDF staging,
the item, the PDF attach or the job event fails, the case stays
`awaiting_job_creation` and the next scan repeats the whole landing; every step
can run twice. A landed case
keeps its fate on later scans and with the flag off.

### The auto-file brakes hold the landing

With an auto-file brake on (environment or database), nothing is written to the
live job. The order falls back to a waiting review draft, as any order does
under the brake. That draft is then a person's to decide: releasing the brake
neither lands it nor approves it.

That holds because the draft carries no automatic stamp. Whenever the claim has
an open repair job and the order is not landed (a brake is on, or the order
already has a draft), the order is counted under `parked_for_review` as
`claim_has_open_repair_job` and never stamped, so no later scan can approve it
into a second repair job on the claim.

### A make-safe on a claim that has a repair job

An order that reads as a make-safe by the existing make-safe test still becomes
a make-safe job automatically, exactly as it does today, even when its claim
has an open repair job. Urgent work never waits for a person to read a notice.

The claim's repair job gets one plain job event saying a make-safe was raised
on the same claim (`noteMakeSafeRaisedOnRepairClaim`, event
`make_safe_raised_on_repair_claim`, naming the make-safe job). Nothing opens on
the intake desk and the repair job itself is not changed.

So a repair order **misread as a make-safe** is still possible. That is the
Woodvale shape: a second "additional costs" order on a repair claim, with no
repair header, became its own make-safe job. It is **not prevented**; the job
event on the repair job is the only trace.

If the event cannot be written, the make-safe job still stands. The run report
records the reason and the caveat `make_safe_on_repair_claim_notice_unwritten`;
it is not retried.

Open follows the Repairs board stage (anything before Complete), not the job
status. The board stage and job status are never moved by a landing.

Limits:

- Only `jobs.type = 'repair'` jobs with a make-safe detail row are matched. A
  repair job that carries no builder reference cannot be found by it.
- Two repair purchase orders on one claim land on one job, with a notice.
  Raising a second job for the second order stays a person's call.

## Rule 3: never dropped

A collection or reattendance order whose original job cannot be found used to
become an exception with nothing to act on. When it carries a first-issue
purchase order with its PDF, it now opens a review draft
(`orphanLifecycleOrderOpensReviewDraft`). The draft is never approved
automatically: it carries `missing_fields: ["original_job_for_collection"]`,
which also keeps the backlog sweep off it.

## Messages

Automatic creation sends nothing that manual approval of the same draft does
not send.

| What fires when a repair job is created automatically | To | Same as manual approval | Switch |
|---|---|---|---|
| Post-board "new job" text, once per job | Hugo (staff) | Yes | `makesafe_notify_settings.notify_enabled` |
| `makesafe_created` job event | Nobody | Yes | None |
| Intake case bound to the job, draft marked approved | Nobody | Yes | None |
| Work order PDF attached to the job | Nobody | Yes | None |
| Address geocode | Nobody | Yes | None |

Not sent: the make-safe manager text (suppressed for every deterministic
draft), any crew assignment (repair jobs stay unassigned), anything to a
customer or a builder.

A landing (rule 2), a make-safe job event and a collection draft (rule 3) send
no message at all. A make-safe job raised on a repair claim sends exactly what any
make-safe job sends today.

## Tests

- `repair_intake_auto_test.ts`: the pure rules.
- `makesafe_deterministic_intake_runtime_test.ts`, tests named
  `repair intake: ...`: scan replays in the real mail shapes, all details
  invented.
- `repair_intake_routing_test.ts`: the mint brake, each way.
- Migration contract: `supabase/tests/migration-contracts/20261013110000_repair_intake_auto_flag/`.
