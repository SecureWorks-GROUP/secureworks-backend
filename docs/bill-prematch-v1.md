# Bill pre-match v1 (JP-06, 15 Oct 2026)

Owner, 15 Oct 2026, 15:53 Perth: "yeah and agent should be able to work it out
based off job numbers on the PO sheet. each PO sheet should have a job number.
otherwise intelligently worked out through the context system right".

Supplier bills in Bills to place (`materials_reconciliation_queue`, status
`open`) get one proposal each, made after every xero-sync materials step.

## Rules, in order

| # | Signal | Result |
|---|---|---|
| 0 | Any money line on account 306 or 301 (subcontractor labour) | left out, no proposal |
| 0b | The same supplier document entered more than once: another live bill sharing a document key (its longest 5+ digit run, or all its digits joined without leading zeros, so "00027773" meets "27773" and "Qute 1449582" meets "1449582"), the same ex-GST amount to the cent, and the same supplier (same contact, or the same name without legal words such as Pty Ltd, so "Metecno" meets "Metecno Pty Ltd" but "National Steel" does not meet "National Hire"). An unknown amount or a bill with no supplier identity holds rather than clears | review, low, rule `duplicate_document`, nothing picked. The hold is written to the queue row (`suggestion_reason = duplicate_document`, a held reason), so it lasts if a copy is voided later. The sync never places it, and takes its own earlier automatic fact (any window) off into a held row. An agent or person placement is left; its new duplicate is held and names it |
| 1 | A job number in the bill reference or any line, or the job of the PO the bill is linked to (`purchase_orders.xero_bill_id`) or names, naming exactly one live job, nothing disagreeing | **placed by the agent** (confidence high) |
| 2 | Invoice email filed on one job, one site street address, supplier plus amount equals one priced PO (2% or $5; an unpriced Dispatch order, subtotal 0, is never an amount), Xero links a real job: all naming the same one job | proposal, medium, one staff press |
| 3 | Two or more jobs from any of the above, a job number not on record or not live, a bill dated more than 14 days before its job existed, more than one rule-1 PO, or a rule-1 PO already linked to or matched by another bill | review, low, candidates listed, nothing picked |
| 4 | Every money line on an overhead account, or every money line tagged Business Unit SW - GROUP | proposal: not job related |
| 5 | Anything else | no proposal |

A PO number counts as written the way suppliers write ours: `PO-1000123`,
`PO1000123`, `PO 1000123` or `PO#1000123`, never inside a longer word or number
and never the bare digits. A PO named in the text places only when it is not
`draft`, is the bill's supplier (same Xero contact, or the same supplier name;
a Dispatch order carries no contact, so only the name can match it, and a name
that differs goes to a person) and sits on one live job. The Dispatch-order cases
are the gold set in `bill_prematch_dispatch_po_test.ts` (INT-25.1).

Live means not cancelled or lost and not a holding job (`metadata.do_not_schedule`,
such as SWF-PDF-BUCKET). Every rule reads the full job population; a failed read
of jobs, purchase orders or filed email attachments stops the matching for that
run. Rules live in `supabase/functions/xero-sync/bill_prematch.ts`; the run in
`bill_prematch_run.ts`.

## What it writes

- `materials_bill_proposals`: one live row per bill (`outcome` `queued_for_review`
  or `assigned`), older rows `superseded` with a reason. The sync never wipes it.
- A rule-1 bill is placed through `assignReconRow` (the staff press path): one
  `job_materials_facts` row with `automation_source = 'agent_prematch'`,
  `confidence = 'high'`, `match_reason = 'agent_prematch:<rule>: <reason>'`,
  `matched_po_id` set to the one PO a PO-path placement rests on (so the job
  profit view stops counting that PO as committed), the
  queue row `assigned` by `agent_prematch`, and a `materials_bill_assigned`
  job event. It only lands on a row still `open` with no fact.
- To undo one: delete that fact and set the queue row back to `open` (leave
  `assigned_by` as `agent_prematch`). The agent then never places that bill
  again; it stays a proposal for staff.
- Bills voided or deleted in Xero: queue row `status = 'void_in_xero'`,
  `closed_reason` `xero_bill_voided` or `xero_bill_deleted`. Nothing else changes.
- No Xero write. At most 150 proposal writes and 25 placements per run.

## Read for the screen

`GET ops-api?action=materials_recon_queue` adds to each row:

- `proposal`: `{ kind, job_id, job_number, confidence, suggestion_confidence,
  rule, reason, candidates[{job_id, job_number, signals[]}], outcome, updated_at }`
  or `null`.
- When the row is open, has no suggested job and the proposal is a job, the
  existing `suggested_job_id` / `suggested_job_number` / `suggestion_confidence`
  are filled from it (high reads as `medium`), with `suggestion_source:
  'agent_prematch'`, so "Use it" (`materials_recon_assign`, `use_suggestion: true`)
  accepts it as a staff press.
- Top level `proposals: 'ok' | 'failed'`; `failed` means the proposals could not
  be read, never "none". `stats.void_in_xero` counts closed voided bills.

## Not in v1

The Bills to place screen changes (secureworks-ux), the subcontractor labour
lane, reading supplier invoice PDFs for the bills with no signal
(`materials_email_enrich.ts`), and jp-9.
