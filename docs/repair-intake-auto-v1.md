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
| More than one open repair job, and not exactly one of them holding this order | A binding review card names them. A person picks. |

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
| Post-board "new job" text, once per job | The repair recipient (see below) | Yes | `makesafe_notify_settings.notify_enabled` |
| `makesafe_created` job event | Nobody | Yes | None |
| Draft marked approved and linked to the job (the intake case is not bound: see "Known gaps") | Nobody | Yes | None |
| Work order PDF attached to the job | Nobody | Yes | None |
| Address geocode | Nobody | Yes | None |

Not sent: the make-safe manager text (suppressed for every deterministic
draft), any crew assignment (repair jobs stay unassigned), anything to a
customer or a builder.

A landing (rule 2), a make-safe job event and a collection draft (rule 3) send
no message at all. A make-safe job raised on a repair claim sends exactly what any
make-safe job sends today.

### Who gets the "new job" text for a repair job

**Before 13 Oct 2026 (as first shipped).** This document said the text went to
Hugo. It did not. A repair job used the make-safe text and the make-safe
recipient: the one phone in `makesafe_notify_settings.arrival_general_phones`,
matched to a user who manages the make-safe vertical. On 13 Oct 2026 that was a
crew member, so the five repair jobs approved that day (SWR-261570 to
SWR-261574) were each texted to him as "SecureWorks: New make-safe SWR-...
(job id)" with an "Assign in Trade" link, and Hugo received nothing. The
automatic switch was turned off that afternoon for this reason.

**Now.** A repair job (`jobs.type = 'repair'`, or a card the board reads as the
repair family) sends its one text to the repair recipient, in repair words:

```
SecureWorks: New repair job SWR-261570, Baldivis. Open in Ops: https://secureworks-group.github.io/secureworks-ux/ops.html#job/<job id>
```

- The suburb is the job's `site_suburb`, left out when the job has none.
- The link is the Ops screen's own job link (`ops.html#job/<job id>`).
- It is the same text whether the scan made the job or a person approved the
  draft: both go through `notifyDeterministicPhysicalJob`
  (`makesafe_hugo_notification.ts`).
- The recipient is the user named in
  `makesafe_notify_settings.repair_new_job_user_ids`
  (`20261013170000_makesafe_notify_repair_recipients.sql`), read by
  `loadRepairNotificationConfig` (`index.ts`). The list holds user ids, never a
  phone number: the phone comes from that user's row when the text is sent. The
  migration names the insurance operations manager (Hugo) once, when it first
  adds the list, in a database that holds his user row. Changing who gets the
  text is an edit to that list, not a code change.
- Exactly one named user with a phone sends. Anything else sends nothing and
  records the reason on the job's `makesafe_intake_hugo_notifications` row:

| The list | Recorded `failure_reason` |
|---|---|
| Empty | `repair_recipient_not_configured` |
| More than one user | `repair_recipient_config_ambiguous` |
| A user id that is not a user | `repair_recipient_user_missing` |
| A user with no phone | `repair_recipient_phone_missing` |
| The setting or the user row could not be read | `repair_recipient_config_read_failed` |

- It never falls back to a role or to the make-safe recipient.
- As with a make-safe text that cannot be sent, the job itself stands: only the
  draft's settlement is left unfinished (`makesafe_intake_job_mints.state`
  `settlement_failed`, with the same reason) and is retried. Once the list is
  right, the retry sends the text once.
- Still one text a job: the unique claim on `makesafe_intake_hugo_notifications`
  (one row per job) holds for repair jobs as it does for make-safes.

Make-safe jobs are unchanged: the same words, the same link and the same
recipient as before, and they never read the repair list.

Not covered: a repair job raised by hand through `create_makesafe_job`, or from
a draft that is not a deterministic intake draft, sends the older make-safe
manager text ("New repair: ...", `notifyVerticalManagersSms`) to the make-safe
managers and no text to the repair recipient.

## Known gaps

Neither is fixed by the staff text change of 13 Oct 2026. Both are written up
here so the next change starts from the cause.

### The intake case is never bound to a repair job

Every repair job intake has made carries a job event
`makesafe_intake_case_bind_failed` with `stage: case_bind` and the error
"current make-safe job not found" (167 events on production on 13 Oct 2026, all
on jobs that were repair jobs when made). The job, its documents and its draft
are all in place; only the case link is missing, so the order's case stays
`awaiting_job_creation` with no `job_id`.

Cause: `bindIntakeCasesToMintedJobs` (`makesafe_intake_settlement.ts`) updates
`makesafe_intake_cases.job_id`. The table's trigger
`trg_makesafe_intake_cases_readiness_invalidate`
(`20260728000001_makesafe_state_authority_u2.sql`) then calls
`invalidate_makesafe_readiness`, which looks the job up with
`type = 'makesafe'` (newest body:
`20260728030000_synthetic_livefire_readiness_cleanup.sql`) and raises for any
other type, rolling the update back. `20260826000001_repair_job_type.sql`
widened the case write check and the money seal for repair jobs and did not
widen this function.

Smallest fix: a migration that patches that one lookup to
`type IN ('makesafe', 'repair')`, written the guarded way
`20260826000001` patches a deployed body. It is not made here because it
changes live case state, not only new jobs: every repair case still waiting
inside the scan's 60-day window would bind on its next settlement retry, each
taking a live identity and the one-case-per-job slot, and each repair job would
gain a `makesafe_readiness_current` row. That needs a read-only count of the
cases it would move and a look at what reads readiness for a repair job first.

### A waiting draft cannot be landed on the repair job its claim already has

Rule 2 lands an order on an existing repair job only when the scan reads new
mail. A draft that is already waiting for review has no such path: approving it
either makes a second job or is refused as a duplicate. On 13 Oct 2026 the
work order for a claim that already had a repair job was recorded by hand for
that reason.

What it needs: a staff action that takes the draft and the repair job, and

1. checks the match the way the scan does (`matchOpenRepairJob`: same builder,
   same claim, exactly one open repair job),
2. calls `landWorkOrderOnRepairJob` with the draft's staged PDF, so the same
   guards hold (a repair job only, a purchase order read, never without the
   PDF) and the same job event is written,
3. settles the draft as approved and linked to that job without a mint, and
4. accounts the order's case the way `accountCaseLandedOnRepairJob` does
   (`accounted_non_wo` / `revision`, no `job_id`).

It sends nothing and never moves the board column or the job status. Steps 3
and 4 are the part that is not small: the draft settlement is built around a
job the draft minted (`settleApprovedIntakeDraft`), the case accounting is
private to the scan and takes the scan's plan, not a stored draft, and the
action needs its own staff gate, tests and a button on the review screen
(`secureworks-ux`).

## Tests

- `repair_intake_auto_test.ts`: the pure rules.
- `makesafe_deterministic_intake_runtime_test.ts`, tests named
  `repair intake: ...`: scan replays in the real mail shapes, all details
  invented.
- `repair_intake_routing_test.ts`: the mint brake, each way.
- `makesafe_hugo_notification_test.ts`, `makesafe_hugo_notification_index_test.ts`:
  the repair text's words, link and recipient, each way it sends nothing, and
  the make-safe text pinned byte for byte.
- `makesafe_intake_settlement_test.ts` (a person approves a repair draft) and
  the scan test `repair intake: a repair job the scan makes automatically
  sends one text ...`: the real notifier on each path.
- `trade_app_visibility_rules_test.ts`, tests named `builder's order value`:
  an allocated trade's `my_jobs` card carries no builder figure.
- Migration contracts: `supabase/tests/migration-contracts/20261013110000_repair_intake_auto_flag/`
  and `.../20261013170000_makesafe_notify_repair_recipients/`.
