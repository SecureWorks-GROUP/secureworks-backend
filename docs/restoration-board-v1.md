# Restoration board v1

Owner, 12 Nov 2026: restoration is its own kind of work with its own simple
board. A restoration job is no longer shown on the make-safe board; it moves
through seven stages on the Restoration board, and the AI terminal can move it
the same way a person can.

Rules: `supabase/functions/ops-api/restoration_stage.ts`. Reads and writes:
`restoration_stage_store.ts`. Tests: `restoration_stage_test.ts`. The quote,
the plan and the sends are unchanged: `docs/restoration-workflow-v1.md`.

## Stages

| Stage | Label | Means | jobs.status |
| --- | --- | --- | --- |
| `new` | New | Work order in, nobody booked | processing |
| `booked` | Booked | A crew is booked | scheduled |
| `report_due` | Report due | Attended; the report and quote (or invoice) are owed | processing |
| `quote_with_builder` | Quote with builder | Assess and quote: the quote has gone to the builder | processing |
| `works` | Works in progress | Builder approved, or do-and-charge works under way | in_progress |
| `invoiced` | Invoiced | The invoice has gone to the builder | invoiced |
| `closed` | Closed | Paid, or closed by hand | complete |

A do-and-charge job skips `quote_with_builder`.

## Where a card sits

A stage is stored in `jobs.metadata.restoration_stage` (`stage`, `set_at`,
`set_by`, `note`, `auto`) once anything moves the card. Until then it is worked
out from the job: a closed job status, then the quote (with builder, approved),
then a raised invoice (all paid reads closed), then a drafted quote or a
submitted report, then a crew booking, else new. A stored `invoiced` card whose
every raised invoice is PAID shows as `closed` with no write (`stage_source:
paid`).

## Moving a card

- `POST ops-api?action=restoration_set_stage` `{job_id | job_number, stage,
  operator_email, note?, no_charge_reason?}`. Moving back is always allowed.
  Moving into a stage that claims something needs it on record:
  `quote_with_builder` a quote recorded as sent, `works` (assess and quote) the
  builder's approval recorded, `invoiced` an AUTHORISED or PAID invoice on the
  job, `closed` a raised invoice and no open draft, or a `no_charge_reason`.
  It writes the stage and the job status together (compare-and-set on
  `jobs.updated_at`) and one `restoration_stage_changed` job event.
- The restoration actions move the card on by themselves, forward only and
  never failing the action: `restoration_mark_quote_sent` to Quote with
  builder, `restoration_record_quote_decision` (approved) to Works in progress,
  and `send_restoration_document` with an invoice to Invoiced, except while a
  quote is being written or is with the builder (an assessment fee does not
  move the card past its quote).

## Reading the board

`GET ops-api?action=restoration_board` (staff, ops key or the routine key)
returns `columns` (key, label, count) and one `card` per job: stage, label,
source, next step, mode, builder and reference, quote number and status, the
job's sales invoices (number, status, total, amount due), crew, and `moves`
(each other stage, whether it is allowed now, and what it needs). Closed cards
stay for 30 days after their last change; `include_closed=1` returns every
card including cancelled and lost. `job_id` or `job_number` narrows it to one.
It is staff-only because it carries invoice amounts.

## What changed elsewhere

- The ops make-safe board (`makesafe_board`, ops projection) leaves restoration
  cards out, as it leaves repairs out. Internal readers (intake notification,
  SES packs, the trade board) still see them.
- A trade who submits a restoration report no longer cancels the rest of the
  crew's bookings for that attendance (the make-safe rule stays for make-safes).
