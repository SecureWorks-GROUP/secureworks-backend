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

## Trade pay

A restoration job's trade is paid against the job's work order (the one
`work_orders` row of kind `job`), with an agreed labour amount the office sets:

- `POST ops-api?action=restoration_set_work_order` `{job_id | job_number,
  agreed_labour_ex, breakdown}` sets the amount (dollars ex GST) and what it is
  for (e.g. "Jean Crous: 2 h on site + 2 h travel at $40/h", shown on the work
  order) and approves it through `approve_job_work_order`. A signed-in approver
  (`owner_approval_authority`) may call it; an agent with the server key names
  the approver with `owner_email` + `owner_statement` under the owner-directed
  fence (`ses_owner_directed_approval.ts`). An approved work order is sealed:
  the same amount again is `unchanged`, a different one is refused
  (`work_order_sealed`). Rules: `restoration_work_order.ts`.
- `trade_invoice_mode.ts`: a restoration job whose job work order is approved
  with its agreed labour is invoiced as a work order (reason
  `restoration_work_order`), billed at that amount like any work-order job.
  With none it stays hourly at the trade's office rate.
- The agreed amount is the trade's gross labour, as hours x rate would be.
  Super is worked out on it by the trade invoice money rules, never taken out
  of it.

## Report

The restoration report is the PDF a builder's claims team reads after we
attend: what we were asked to do, what we found, what we did in order, what we
used, and the photos. It is rendered by `restoration_report_render.ts` on the
shared report design (`report_design.ts`), which the make-safe report, the roof
report and the restoration quote use too, so every document reads as one family.

`POST ops-api?action=restoration_render_report` (staff session or the ops key;
never the routine key, the agent key or a trade):

- `job_id` or `job_number`. A job that is not a restoration card is refused
  (`not_a_restoration_job`).
- `report`: the words. `subtitle` (the headline), `attended_on`, `arrived_at`,
  `crew_line`, `outcome`, `work_order_instruction`, `approved_quote_note`,
  `findings` and `works_completed` (each `{paragraphs, bullets, closing}` or one
  string; both are required; the bullets of `works_completed` are drawn as
  numbered steps), and `materials`. Our job number, the builder's name and
  references, the site address and the policyholder are read from the job.
- Photos: by default this attendance's site photos in upload order, captioned
  from each photo's label (receipts and quote builder photos are never used).
  `photo_media_ids` names them and their order; `photos` (`[{media_id, caption,
  area, stage, cover}]`) also sets a caption, a room, `before` / `during` /
  `after`, and the one cover photo. A caption that starts "Before" or "After"
  sets the stage by itself. With at least one of each, the first before and the
  first after are shown side by side.
- `dry_run` (default `true`) returns `pdf_base64`, `pages`, `bytes`,
  `file_name` and the job facts it printed, and writes nothing. `dry_run:
  false` uploads the PDF and files it as the job's `makesafe_report` document
  through `attachMakesafeDocument`; the file name is stable per job
  (`Restoration Report - <job number> - <builder reference>.pdf`), so making
  it again replaces the same document. It returns `document_id` and `url`.

It sends nothing, moves no stage and touches no invoice. It is a price-free
document: wording that carries money, or our internal words, is refused
(`report_wording_not_allowed`), because the document is filed where a trade can
read it. A photo that cannot be read refuses the whole report
(`photo_unreadable`) so a report never quietly leaves one out; more than 60
photos, or more than 24 MB of them, is refused with the reason. Tests:
`restoration_report_render_test.ts`.

## Xero

SWRESTO- jobs book to their own Business Unit tracking option, `SW - RESTORATION`
(`trackingCategoryForJob`). `POST ops-api?action=ensure_xero_tracking_option
{option: "SW - RESTORATION"}` (server key, allow-listed names only) adds the
option in Xero when it is missing. xero-sync's builder-reference matcher reads
it as make-safe-side work. Older restoration cards numbered SWMS- still book to
`SW - MAKESAFE` by their number.

## Who restoration mail goes to

To the builder's restoration contact (`restoration_recipients`, named by the
operator), with ses@ and every address in the builder's `restoration_cc`
copied, on both routes: the report and photos (`send_mailer_ops_visibility` on
a restoration card) and the invoice and quote (`send_restoration_document`).
ML Builders: To Amber Rollo, copied to its Prime mailer and ses@ (owner,
12 Nov 2026). Rule: `restorationCcFor` in `ses_mailer_ops_send.ts`.

## What changed elsewhere

- The ops make-safe board (`makesafe_board`, ops projection) leaves restoration
  cards out, as it leaves repairs out. Internal readers (intake notification,
  SES packs, the trade board) still see them.
- A trade who submits a restoration report no longer cancels the rest of the
  crew's bookings for that attendance (the make-safe rule stays for make-safes).
