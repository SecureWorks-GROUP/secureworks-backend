# Paid close-out for fencing and patio jobs (v1)

Captain, 13 Oct 2026: when a fencing or patio job is paid, its Ops card goes to
**Get Review** (not Complete), one review text goes out, and 24 hours later the
card is archived. Builder, insurance, make-safe and repair jobs keep the old
Xero rule (`invoiced` -> `complete` once every linked sales invoice is PAID).

Code: `supabase/functions/_shared/job_paid_closeout.ts` (the paid rule, pure),
`supabase/functions/ops-api/job_closeout.ts` (reads, moves, sender, sweeps),
`supabase/functions/xero-sync/index.ts` (calls in). Migration:
`20261013140000_job_closeout_review_archive.sql`.

## What "paid" means

All three, in `evaluateJobPaid`:

1. Every linked sales invoice that is not voided or deleted is PAID, and none is
   a DRAFT.
2. Every paying party has a paid final invoice. Paying parties are
   `job_contacts` rows with `removed_at` null whose `share_percentage` is not an
   explicit 0 (a null share counts: the party writer stores null when no
   portions were sent); a job with none has one payer, its client. A final is any sales invoice that is not
   a deposit (`DEP`, `DEP50`, `DEPOSIT`, or `jobs.deposit_invoice_id`) and not a
   `MAT`/`PROG`/`PLAN`/`VAR` stage invoice. An invoice belongs to the party its
   `job_contact_id` names, else the share letter on its reference
   (`SWF-26624-B-FINBAL` is B), else the party with its Xero contact, else the
   client.
3. Money paid covers the sent quote (`job_quote_values` through
   `readJobQuotes`) plus agreed variations (customer accepted or invoiced; one
   approved internally but never accepted is not owed), within the larger of $5
   and 1%.
   Unknown quote or unreadable variations: rules 1 and 2 decide.

Outcomes: `paid`; `paid_less_than_quoted` (1 and 2 hold, 3 fails: the card
stays where it is and `job_closeout_state.paid_less_than_quoted` is set, for the
Ops card to show); `not_paid`.

Holds (never moved, texted or archived): status `rectification`, or
`jobs.is_callback`.

## The flow

- **Paid -> Get Review.** When a linked sales invoice of a fencing or patio job
  turns PAID, xero-sync posts `ops-api?action=job_closeout_paid`. A paid, unheld
  job in `complete`, `final_payment` or `invoiced` moves to `get_review` through
  `update_job_status` with `expected_statuses` (compare and set: a card moved by
  hand meanwhile is left alone). A `complete` card moves only when its newest
  payment is within 30 days: an older one is the backlog (xero-sync re-reads an
  old paid invoice whenever Xero touches it) and is reported `complete_backlog`.
  After every run xero-sync also posts `job_closeout_catch_up`: `invoiced` and
  `final_payment` cards whose newest payment is within 30 days (paid before the
  card got there); a paid card whose newest payment is older is reported
  `stale_payment` and stays put. `complete` cards are never caught up: they are
  the backlog.
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
  skipped; a job whose newest payment is over 7 days old is claimed as skipped
  (`paid_too_long_ago`), however recently it entered Get Review. Nothing is
  claimed while the only blocker is a contact not linked yet (`no_contact`):
  link it and the next request or sweep sends, or press Send review after the
  card has archived. A text that does not answer within 15 seconds counts as
  unconfirmed and is never retried. Manual `send_review_request` uses
  the same sender and switch (it skips only the status, hold, paid and window
  checks); only a fencing or patio job that passes the paid rule gets the
  "Payment is well received" wording, every other manual request gets a
  neutral text signed "SecureWorks".
- **24-hour archive.** pg_cron `job-closeout-sweep` (17 and 47 past each hour,
  gated on the `closeout` lane) posts `job_closeout_sweep`. A card archives when
  it entered `get_review` at least 24 hours ago, is still paid, is not held and
  its review claim is finished, or the sender answered `no_contact` (no claim
  is taken, so the review can still be sent by hand once the contact is
  linked), or the sender is not live. A claim still `claimed` more than an hour
  after it was taken (the finish write failed or the worker died mid-send) is
  recorded `unconfirmed` with reason `stuck_claim`, never re-sent, and counts as
  finished. Compare and set on `get_review`. The sweep also sends a missing
  review first (the backstop).
- **Backlog.** `job_closeout_backlog_preview` (server key or staff, read only)
  lists the fully paid fencing and patio jobs in `complete` that a later step
  may archive, with no review text. It archives nothing.

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

Rules 1 and 2 only (the quote check needs the per-job quote read): Complete
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
