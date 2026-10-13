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
  MLB's "Rapid Repair" header, or a work order PDF's declared type.
- Claim reference, purchase order, customer name and site address are read.
- Nothing conflicts. The only gap allowed is the customer's phone, which does
  not hold a make-safe today either.
- Exactly one ex-GST value is read from the work order PDF.
- It is a first-issue order, not an amendment, a reattendance or a cancellation.

Anything else is written as a review draft and waits, as before. The run
report's `repair_intake.parked_for_review` counts each reason.

The job is a `repair` job (SWR- number) in WO In, with the builder, claim,
purchase order and site on it, and the builder's value in
`metadata.builder_work_order_value_ex_gst`.

That value is the **builder's order value, not our quote**, and every field it
writes says so:

| Where | Field | Says |
|---|---|---|
| Job | `metadata.builder_work_order_value_source` | `builder_work_order_pdf_not_our_quote` |
| Repairs card | `builder_work_order_value_ex_gst` | The builder's figure, always shown when stamped. |
| Repairs card | `value` | Filled (inc GST) only where the job has no price of ours. |
| Repairs card, with a filled `value` | `value_source`, `value_is_our_price`, `value_note` | `builder_work_order_value`, `false`, "Builder's work order value (inc GST), not our quote" |

Our own price always wins, and then none of the three markers is present.

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

In every landed case the work order PDF is attached to the job, one
`repair_work_order_landed_on_existing_job` job event is written, and one "new
work order on existing job" item opens on the intake desk. No second job and no
blank draft.

This applies only to an order that reads as repair work.

### A make-safe on a claim that has a repair job

An order that reads as a make-safe by the existing make-safe test still becomes
a make-safe job automatically, exactly as it does today, even when its claim
has an open repair job. Urgent work never waits for a person to read a notice.

The claim's repair job gets a notice that a make-safe was raised on the same
claim (`noteMakeSafeRaisedOnRepairClaim`): one `make_safe_raised_on_repair_claim`
job event naming the make-safe job, and one item on the intake desk. The repair
job itself is not changed.

So a repair order **misread as a make-safe** is still possible. That is the
Woodvale shape: a second "additional costs" order on a repair claim, with no
repair header, became its own make-safe job. It is **caught by the notice, not
prevented**: a person sees the notice and moves the work to the repair job.

If the notice cannot be written, the make-safe job still stands. The run report
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

A landing (rule 2), a make-safe notice and a collection draft (rule 3) send no
message at all. A make-safe job raised on a repair claim sends exactly what any
make-safe job sends today.

## Tests

- `repair_intake_auto_test.ts`: the pure rules.
- `makesafe_deterministic_intake_runtime_test.ts`, tests named
  `repair intake: ...`: scan replays in the real mail shapes, all details
  invented.
- `repair_intake_routing_test.ts`: the mint brake, each way.
- Migration contract: `supabase/tests/migration-contracts/20261013110000_repair_intake_auto_flag/`.
