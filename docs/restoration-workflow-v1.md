# Restoration work on the SES board (v1)

Owner's word, 12 Nov 2026: we accept restoration work. It arrives at
ses@secureworkswa.com.au like a make-safe and sits under the insurance side.
A restoration job is one card on the make-safe (SES) board, with an `SWMS-`
number and the family **Restoration**. It keeps the whole existing pack path
(report, photos, invoice, SEND IT) and adds a quote stage for the jobs that
need one.

Code: `supabase/functions/ops-api/restoration_workflow.ts` (rules, pure),
`restoration_workflow_store.ts` (reads and writes),
`restoration_quote_render.ts` (the quote PDF). Intake:
`makesafe_pdf_declared_type.ts`, `makesafe_intake_gate.ts`,
`makesafe_builder_work_order_identity.ts`.

## The two shapes of job

| Mode | What it is | How it runs |
|---|---|---|
| `do_and_charge` | The builder says what to do ("remove the cabinetry"). | Attend, do the work, send report + photos + invoice. Nothing new. |
| `assess_and_quote` | The builder asks us to look and price ("inspect ... provide a quote for structural drying"). | Attend and inspect. Send the report and a quote. Wait for the builder's yes. Do the works over as many attendances as it takes. Invoice. |

The mode is read off the work order's own scope (`readRestorationScope`): a
request for a quote is `assess_and_quote`, anything else is `do_and_charge`.
A person can correct it with `restoration_set_plan`. The same read picks up the
builder's **authority limit** for the initial attendance (ML Builders write it
as "DAL ... $1k") and a cap on hired equipment days when the scope states one.

## Where a job is at

`restoration_plan` returns a `phase` and a plain `next_step`:

| Phase | Meaning |
|---|---|
| `attend_and_charge` | Do and charge, no quote on file. |
| `assess` | Assess and quote, no quote yet. |
| `quote_drafted` | A quote is saved and has not gone to the builder. |
| `awaiting_approval` | The quote is with the builder. **Quoted works must not start.** |
| `approved_works` | The builder approved. Do the works, then invoice the quote. |
| `declined` | The builder said no. Only the attendance already made is billable. |

The phase is separate from the board column. The board column still comes from
the evidence engine (report in, pack built, invoice raised, pack sent), exactly
as for a make-safe. A card whose quote is with the builder sits in whatever
column its current attendance has earned.

## The quote

- `restoration_save_quote` takes the person's own lines (kind, description,
  quantity, unit, unit price ex GST). The server works out every total.
  `dry_run: true` validates and totals and writes nothing.
- A draft is edited in place. Once a quote has been sent or decided it is never
  rewritten: saving starts the next revision. Revising an **approved** quote
  needs `revise_approved: true`, and the earlier approval keeps standing until
  the builder approves the new revision.
- Saving renders the quote PDF on our letterhead and files it on the job.
- `restoration_mark_quote_sent` records that a person sent it. **This system
  does not send the quote.** The sealed release graph is the only builder pack
  transport and it has no quote route. A person emails the PDF (reply on the
  work order thread, cc ses@), then records it.
- `restoration_record_quote_decision` records the builder's answer. An approval
  needs `decided_by` (the builder's person) and `evidence_ref` (the email
  subject and date, the call time, or the new purchase order number). Recording
  the same decision twice changes nothing.

### Where the quote is stored, and why

A trade can read `jobs.metadata` and `job_events`. A trade sees no money. So:

| Thing | Where | Holds money? |
|---|---|---|
| The plan record | `jobs.metadata.restoration` | No. Mode, limits, and per revision: number, status, who sent, who decided, document id, content hash. |
| The priced content (lines, totals, scope, exclusions) | `job_documents.data_snapshot_json.restoration_quote` on the quote's own row | Yes. |
| The quote PDF | Storage bucket `job-documents`, one `job_documents` row, `type = 'other'`, `metadata.restoration_document = 'quote'`, `visible_to_trades = false` | Yes. |
| One row per move | `job_events` (`restoration_plan_set`, `restoration_quote_saved`, `restoration_quote_sent`, `restoration_quote_approved`, `restoration_quote_declined`) | No. |

The content hash binds the record to the document: an approval is an approval
of exactly that content. If the filed document no longer hashes to what the
record says, every read and write refuses `restoration_quote_mismatch`. The one
exception is a **draft** whose save was interrupted between its two writes:
saving the quote again puts it right.

The row is `type = 'other'` on purpose (as the quote builder's scope of works
is): no customer-quote reader, close-out reader or SES pack pointer counts it.
`sent_at` on the row stays null. `toggle_document_visibility` refuses to switch
a restoration quote on for trades.

## The hand-off to an invoice

Nothing in this module prices an invoice. Once a quote is approved **and** the
docket for the completed works is prepared, `restoration_plan` returns

```json
"invoice_handoff": { "ready": true, "quote_number": "SWMS-261999-Q1",
  "total_ex_gst": 1680, "commercial_quantity_override": { ... } }
```

`commercial_quantity_override` is the existing staff-locked figure
(`ses_commercial_quantity_override.ts`). Pass it unchanged to
`prepare_ses_invoice_obligation`. The invoice then carries the approved quote's
lines word for word, and every existing guard still runs: the duplicate guard,
the sealed labour schedule check, the human APPROVE INVOICE, the money fence.
Labour at a rate other than the sealed schedule rate rides as a
`labour_rate_override` naming the quote and the builder's approval.

That instrument has two limits, and a quote that does not fit is refused with
the reason (`ready: false`), never bent:

- `quote_has_no_labour_line`: an SES invoice must show its labour. Make labour
  its own line.
- `quote_labour_rates_differ`: one labour rate per card. A quote with two
  hourly rates needs a person to invoice it.

Other reasons: `no_approved_quote`, `docket_not_prepared`,
`authorised_by_required`.

`authority_limit` in the same read puts the builder's limit beside the current
invoice proposal (`within_limit`, `over_limit`, `not_priced`, `no_limit`). It
reports only. Holding an invoice over the limit is a person's call.

## Invoicing an assess-and-quote job

The SES path invoices per attendance cycle, and a release needs an invoice. So:

1. **Initial attendance** (cycle 1). Report + photos + invoice for the
   attendance itself, inside the builder's authority limit, through the normal
   pack. The quote PDF goes to the builder by email alongside.
2. **Quoted works** (after approval). `reattend_makesafe` opens the next cycle.
   The trade reports the works. Prepare the docket, read `restoration_plan`,
   pass `invoice_handoff.commercial_quantity_override` to
   `prepare_ses_invoice_obligation` with `post_release_disposition:
   "second_invoice"`, then mint, approve and send as usual.

Step 2 is the designed path and is covered by unit tests against the real
override builder. It has not been run on a live card yet: prove it on the first
approved quote with a `dry_run` docket before trusting it.

Sending the first report with **no** invoice (one invoice at the very end) is
not supported by the release path today: `no_additional_charge` exists only for
a later attendance of an already invoiced card. If the owner wants one invoice
at the end, that is a release-path change (five route-shape sites and the
`commit_ses_release_revision_v1` RPC), not a setting here.

## Intake

- A work order whose "Allocation Work Order" header reads `Restoration` with no
  other type line and no `Make Safe` sub-line declares the **restoration**
  family (`extractPdfDeclaredType`). `Restoration` + `Make Safe` is still a
  make-safe (Ruling 9). Restoration read from scope prose alone still parks
  (Ruling 15). AJ work is still always a make-safe.
  Read-only production check, 12 Nov 2026: 5 of 399 distinct work order PDFs
  carry that header, and all 5 are restoration work.
- `MLR-` is ML Builders' restoration job-number series (first seen 9 Nov 2026,
  work order `MLR-41228PO-64545`). It is a second claim prefix of the one MLB
  scope: the claim keeps its `MLR-` spelling and the instruction key stays
  `MLB:PO-<n>`.
- A clean restoration draft is filed like a clean make-safe (no supervised
  brake) and mints an `SWMS-` job with `metadata.makesafe_job_family =
  'restoration'`.

Not done here, needs the owner's word and a migration: adding `MLR` to the ML
Builders row's `parsing_rules.ref_prefixes` and widening its `external_ref`
template regex. The deterministic planner reads `MLR-` without it; the subject
reference readers that take the company-loaded prefix set do not.

## Actions

All on `ops-api`. Give `job_id` or `job_number`. A job that is not a
restoration family card on the make-safe board is refused
`not_a_restoration_job`. A repair job (`SWR-`) has the Repairs board and the
quote builder instead.

| Action | Method | Who | Writes |
|---|---|---|---|
| `restoration_plan` | GET | staff session, ops key, reporting routine | nothing |
| `restoration_set_plan` | POST | staff session, ops key | the plan record, one event |
| `restoration_save_quote` | POST | staff session, ops key | the quote document, the plan record, one event |
| `restoration_mark_quote_sent` | POST | staff session, ops key | the plan record, one event |
| `restoration_record_quote_decision` | POST | staff session, ops key | the plan record, one event |

A server caller names the person in `operator_email`; a write with nobody named
is refused `operator_required`. Every write is a compare-and-set on
`jobs.updated_at` and answers `job_changed` (409) when the job moved underneath.
None of them sends anything, touches Xero, writes an invoice obligation, a
docket, a board stage or a make-safe substatus.

SecureSuite tools (secureworks-jarvis): `sw_restoration_plan`,
`sw_restoration_set_plan`, `sw_restoration_save_quote`,
`sw_restoration_mark_quote_sent`, `sw_restoration_record_quote_decision`.

## On the board card

Every restoration card on the ops `makesafe_board` feed (card and full shape)
carries `restoration`, from `restorationBoardStatus` over the price-free
record on `jobs.metadata.restoration` (or the work order's words when nothing
is stored). It uses the same phase and next step rules as `restoration_plan`:

```json
"restoration": { "version": "restoration-workflow/v1", "readable": true,
  "reason": null, "stored": true, "mode": "assess_and_quote",
  "phase": "awaiting_approval", "phase_label": "Quote with builder",
  "next_step": "Quote SWMS-261709-Q1 is with the builder. ...",
  "quote_number": "SWMS-261709-Q1", "quote_status": "sent",
  "quote_sent_at": "2026-11-12T03:00:00.000Z", "approved_quote_number": null }
```

Every other card carries `restoration: null`. It holds no line, price, total,
authority limit or PDF link. A stored record the reader cannot read is
`readable: false` with its `reason`, never a failed board. It is presentation
only: it never feeds `canonical_stage` or any gate, and the trade projection
leaves it out.

## Not built yet

- Sending the quote from this system (an audited quote route).
- A report titled for restoration: the pack's report is still the make-safe
  report. Its renderer refuses money wording, which is why the quote is its own
  document and not a section of the report.
- The plan in the Trade screens. (The Ops board card carries it: see below.)
- One invoice at the end with an uninvoiced first report (see above).
- Equipment-day cap enforcement. The cap is read and returned; nothing checks a
  quote against it.

Tests: `restoration_intake_test.ts`, `restoration_workflow_test.ts`,
`restoration_workflow_store_test.ts`, and the restoration cases in
`makesafe_pdf_declared_type_test.ts` and `makesafe_intake_gate_test.ts`.
