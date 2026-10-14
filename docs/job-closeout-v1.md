# Paid close-out for fencing and patio jobs (v1)

Captain, 13 Oct 2026: when a fencing or patio job is paid, its Ops card goes to
**Get Review** (not Complete), one review text goes out, and 24 hours later the
card is archived. Builder, insurance, make-safe and repair jobs keep the old
Xero rule (`invoiced` -> `complete` once every linked sales invoice is PAID).

Code: `supabase/functions/_shared/job_paid_closeout.ts` (the paid rule, pure),
`supabase/functions/ops-api/job_closeout.ts` (reads, moves, sender, sweeps),
`supabase/functions/xero-sync/index.ts` (calls in). Migration:
`20261013150000_job_closeout_review_archive.sql`.

## What "paid" means

All three, in `evaluateJobPaid`:

1. Every linked sales invoice that is not voided or deleted is PAID, and none is
   a DRAFT.
2. Every paying party has a paid final invoice. Paying parties are
   `job_contacts` rows not removed (`removed_at` null and `status` not
   `removed`, the legacy neighbour sync's removal) whose `share_percentage` is
   not an explicit 0 (a null share counts: the party writer stores null when no
   portions were sent); a job with none has one payer, its client. A final
   needs positive evidence, the Debt tab's rule (`invoiceKindOf` in
   `debt_ws_rules.ts`): a reference ending `FIN`, `FINBAL` or `BAL` (up to
   three digits), `FINAL` or `PRIVATE`, and a first line item starting
   "balance", "remaining" or "remainder" (read as
   `line_items->0->>Description`), and never `jobs.deposit_invoice_id`. An
   unlabelled invoice is not a final, so such a card stays where it is for
   staff to move by hand. An invoice belongs to the party its
   `job_contact_id` names, else the share letter on its reference
   (`SWF-26624-B-FINBAL` is B), else the party with its Xero contact, else the
   client.
3. Money paid covers the sent quote (`job_quote_values` through
   `readJobQuotes`) plus agreed variations (customer accepted or invoiced; one
   approved internally but never accepted is not owed), short by no more than
   $1 (GST rounding).
   No sent quote (`no_sent_quote`) or no recorded quote value
   (`quote_value_not_recorded`): rules 1 and 2 decide. A quote or variations
   read failure (`quote_unreadable`, `variations_unreadable`,
   `quote_read_threw`) decides nothing.

Outcomes: `paid`; `paid_less_than_quoted` (1 and 2 hold, 3 fails: the card
stays where it is and `job_closeout_state.paid_less_than_quoted` is set, for the
Ops card to show); `not_paid`; `undecided` (1 and 2 hold but the quote could not
be read: in that run nothing moves, is texted, archived or recorded, the move
and the sender answer `facts_unreadable`, the backlog list excludes it as
`quote_unreadable`, and the next run asks again).

Holds (never moved, texted or archived): status `rectification`, or
`jobs.is_callback`.

## The flow

- **Paid -> Get Review.** When a linked sales invoice of a fencing or patio job
  turns PAID, xero-sync posts `ops-api?action=job_closeout_paid`. A paid, unheld
  job in `complete`, `final_payment` or `invoiced` moves to `get_review` through
  `update_job_status` with `expected_statuses` (compare and set: a card moved by
  hand meanwhile is left alone). A card moves, from any of the three, only when
  its newest payment is within 30 days: an older one is the backlog, reported
  `stale_payment`, and stays put (xero-sync re-reads an old paid invoice
  whenever Xero touches it, so the window keeps that touch from moving it).
  After every run xero-sync also posts `job_closeout_catch_up`: `invoiced` and
  `final_payment` cards paid before the card got there, under the same 30-day
  window. `complete` cards are never caught up: they are the backlog.
  The catch-up, the sweep and the backlog list read every candidate card (paged
  by id), so cards that stay put never hide newer ones.
- **Review text.** Any fencing or patio card entering `get_review` (by the sync
  or by hand) asks the one sender, `requestJobReview`. It re-checks get_review,
  holds and the paid rule, then texts every paying owner once, in the wording
  the GHL review workflow already used, with the one review link, through
  ghl-proxy `send_sms` (the shared sender policy, +61489267771, and the
  contact/job guard). A `job_review_claims` row is inserted before any text, so
  a job is never texted twice by this system; a contact sent any review text in
  the last 90 days (any source in `business_events`, or our own claims) is
  skipped. Nothing is claimed when nothing could go out, so fixing the cause
  and asking again sends (the next request or sweep, or Send review after the
  card has archived): a job whose newest payment is over 30 days old (the same
  window as the move; `paid_too_long_ago`), a contact not linked yet
  (`no_contact`), or every send refused by a ghl-proxy guard before GHL
  (`refused`; the claim is released, and only the first refusal is logged as
  `review_request_not_sent`). A real send keeps its claim. A text that
  does not answer within 15 seconds counts as unconfirmed, keeps its claim and
  is never retried. Manual `send_review_request` uses
  the same sender and switch (it skips only the status, hold, paid and window
  checks); only a fencing or patio job that passes the paid rule gets the
  "Payment is well received" wording, every other manual request gets a
  neutral text signed "SecureWorks", and a fencing or patio job whose quote
  could not be read is not texted (`facts_unreadable`).
- **24-hour archive.** pg_cron `job-closeout-sweep` (17 and 47 past each hour,
  gated on the `closeout` lane) posts `job_closeout_sweep`. A card archives when
  it entered `get_review` at least 24 hours ago, is still paid, is not held and
  its review claim is finished, or the sender answered `no_contact`,
  `paid_too_long_ago` or `refused` (no claim is kept, so the review can still be
  sent by hand once the cause is fixed), or the sender is not live. A live sweep
  that cannot read the switches archives nothing (`switches_unreadable`). A claim still `claimed` more than an hour
  after it was taken (the finish write failed or the worker died mid-send) is
  recorded `unconfirmed` with reason `stuck_claim`, never re-sent, and counts as
  finished. Compare and set on `get_review`. The sweep also sends a missing
  review first (the backstop).
- **Backlog.** `job_closeout_backlog_preview` (server key or staff, read only)
  lists the fully paid fencing and patio jobs in `complete` that a later step
  may archive, with no review text. It archives nothing.

## What the Ops board and job view read

`job_closeout_state` and `job_review_claims` are service-role only, so screens
read them through ops-api. For a staff caller (the ops key or a staff session;
never the routine key, a trade or a division manager), every fencing and patio
row of `pipeline` and a fencing or patio `job_detail` carry one read-only block
(`ops-api/job_closeout_read.ts`):

```
closeout: {
  paid_less_than_quoted: boolean,
  shortfall_inc: number | null,
  review: { status, reason } | null,
  get_review_entered_at: string | null,
  archive_due_at: string | null,
  held: 'rectification' | 'callback' | null
}
```

- `paid_less_than_quoted` and `shortfall_inc` are the job's last paid check
  (false and null when it was never checked; the shortfall only while the marker
  is on).
- `review` is the job's claim (`claimed`, `sent`, `skipped`, `unconfirmed`, with
  its reason). With no claim it is the newest `review_request_not_sent` row as
  `{ status: 'not_sent', reason }` (`refused`, or the row's reason). With
  neither it is null: not asked yet, sender off, or a send the sender kept no
  claim for and logged nothing about (no linked contact, `paid_too_long_ago`).
  The block only reports what the sender recorded; it never predicts an outcome.
- `get_review_entered_at` is the newest `status_changed` row to `get_review`,
  the sweep's own rule (`loadGetReviewEntries`). `archive_due_at` is that plus
  24 hours while the job is in `get_review`, else null. The sweep still decides:
  it archives only a paid, unheld card whose review is done.
- `held` is the sweep's hold (`closeoutHold`).

Every other job type, and every non-staff caller, gets no `closeout` key. A
draft fencing or patio row gets the empty block without any read (a draft
cannot be paid, claimed or in `get_review`). The reads are one batched wave over
the whole board (chunked `.in()`, each table's chunks read in turn so a full
board holds at most one request per table in flight), never one per row. A failed read gives `closeout: null` on every fencing and patio row, and
`pipeline` lists `pipeline.closeout` in `enrichment_errors`. It writes nothing.

## Switches (all off at deploy) and the turn-on order

1. `UPDATE job_closeout_settings SET get_review_move_enabled = true, updated_by = ..., note = ... WHERE id = 1;`
   Off: fencing and patio keep the old Xero rule exactly.
2. `UPDATE job_closeout_settings SET review_sender_mode = 'dry_run' ...;` then
   read the `review_request_dry_run` job events (one per job: recipients and
   the message).
3. **Someone must switch the old GoHighLevel review workflow OFF** in GHL
   Automation before step 4, or customers can get two review texts.
4. Set `JOB_REVIEW_SENDING_ENABLED=true` on ops-api, then
   `review_sender_mode = 'live'`. Live without the env reads as dry run.
5. `UPDATE automation_switches SET closeout = true ... WHERE id = 1;` (the
   archive sweep). `all_stop` stops it like every other lane.

Then show the captain `job_closeout_backlog_preview`; archiving that list is a
separate, later step.

## Live numbers (read only, 13 Oct 2026)

Rules 1 and 2 only (the quote check needs the per-job quote read), measured
before a final needed positive evidence (any non-deposit invoice counted then),
so the pass counts are an upper bound under the current rule: Complete
holds 62 fencing and 8 patio jobs that pass, 80 fencing and 14 patio with no
linked invoice, 2 fencing not paid. Get Review holds SWF-261227 and SWF-26989,
which are not paid, so the sweep will not archive them. No `invoiced` or
`final_payment` card passes today, so the catch-up moves nothing at turn-on.

## Known differences

- The shadow fencing stage engine (`fencing_stage_engine_v1.ts`) still models
  archive at 7 days after completion. It writes nothing.
- Decking follows the patio stage list in the state machine, as before, so
  `get_review` reads as legal there too (shadow observation only); the close-out
  itself touches fencing and patio only.
- A patio review text signs "SecureWorks" (no patio wording was captured);
  fencing signs "SecureWorks Fencing"; a manual text on any other job, or on a
  job not paid, makes no payment claim and signs "SecureWorks".
