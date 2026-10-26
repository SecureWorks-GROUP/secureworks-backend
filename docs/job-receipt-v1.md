# Paid-invoice receipt for fencing and patio jobs (v1)

Captain, 20 Oct 2026: when a client sales invoice of a fencing or patio job
turns PAID, Xero emails that paid invoice to the customer. The customer gets
Xero's own paid invoice email: "View Invoice", no Pay button, $0.00 due. Every
paid invoice counts, deposits included, not only each payer's final. One email
per invoice, ever. It sits beside the paid close-out
([job-closeout-v1.md](job-closeout-v1.md)) and uses the same switch table, but
it fires per invoice, not when the job closes.

Code: `supabase/functions/ops-api/job_receipt.ts` (every rule, the claim, the
Xero call), `supabase/functions/xero-sync/index.ts` (calls in). Migration:
`20261021100000_job_receipt_sender.sql` (rollback in `supabase/rollbacks/`).
Tests: `job_receipt_test.ts` and the migration contract
`supabase/tests/migration-contracts/20261021100000_job_receipt_sender/`.

## An exception to the 30 Sep 2026 money-messages ruling

The 30 Sep 2026 ruling keeps our automated money messages off
(`ops-api/debt_autotexts_off.ts`). The captain made one exception on 20 Oct
2026: **these paid-invoice receipts only**. Everything that file lists stays
off: the GHL chase workflow, the payment thank-you text, the Pay Now text on
quote acceptance and the deposit chasers. A receipt asks for no money: it
confirms money already paid.
A second exception came on 26 Oct 2026, the deposit received text
(`docs/job-deposit-advance-v1.md`).

## What the customer gets, and from whom

- The API cannot send Xero's own "Receipt" (that is a web-app action only).
  `POST /Invoices/{InvoiceID}/Email` sends the invoice with the organisation's
  **default invoice email template** (Xero > Settings > Email settings). For a
  PAID invoice it shows "View Invoice", $0.00 due and the due date.
- Xero sends it to the invoice's Xero contact: the primary email plus every
  contact person marked IncludeInEmails.
- It is sent **from the Xero user who authorised the connection** (ops-api
  holds a custom-connection token, `grant_type=client_credentials` in
  `getToken`), not from the person who ran the sync.
- Xero allows it for ACCREC invoices that are SUBMITTED, AUTHORISED or PAID, up
  to 1,000 a day per organisation. The token already holds
  `accounting.transactions`.

## Which invoices

An invoice is emailed only when all of these hold (`requestInvoiceReceipt`):

1. The switch is `dry_run` or `live` (below). Off reads nothing and writes
   nothing.
2. The invoice is ACCREC, PAID and linked to a job (`xero_invoices.job_id`).
3. The job is fencing or patio (`isCloseoutJobType`), and not a sealed SES
   card (`ses_money_sealed_at`). Builder, insurance, make-safe and repair jobs
   are never receipted.
4. **The window.** It was fully paid on or after the Perth day the switch's
   current mode began (`receipt_sender_mode_since`); on that day itself, only
   when Xero last changed the invoice after that instant. And it was fully paid
   within 30 days (`PAID_WITHIN_DAYS`, the close-out's limit). History is never
   caught up. A payment bank-reconciled late but dated before the start day is
   skipped on purpose.
5. No claim exists for it yet (one email per invoice, ever).
6. **The customer paid money on it.** A receipt confirms money the customer
   paid, so the mirrored `amount_paid` (Xero's AmountPaid) must be above zero.
   A PAID invoice settled wholly by credit (a credit note, a write-off) is
   skipped as `credit_settled`. Xero reports a prepayment or overpayment
   allocated to the invoice as credit too, so an invoice paid only that way is
   skipped as well: staff send those receipts by hand. The catch-up reads only
   invoices with `amount_paid` above zero; the paid trigger records the skip.
7. The job is not held: status `rectification`, or `is_callback` (the
   close-out's holds).
8. **The wrong-party guard** (`receiptPartyCheck`), on every job. The invoice
   must have a Xero contact. Whenever the invoice names a party
   (`job_contact_id`), and on every invoice of a job with two or more paying
   parties (`job_contacts`, the close-out's `payingParties`), the invoice's own
   party is found as the close-out finds it (`invoicePartyKey`: its
   `job_contact_id`, the share letter in its reference, its Xero contact, else
   the client). That party must be a paying party (a named party that is
   removed or has a zero share is refused), it must have its own
   `xero_contact_id`, that must equal the invoice's Xero contact, and no other
   paying party may share it. So B's invoice sitting on A's Xero contact is
   refused, never emailed to A, and so is a one-payer job's invoice that names
   its party but sits on another Xero contact. An invoice on a one-payer job
   that names no party goes to its own Xero contact.
9. ops-api's own send guards pass: the sealed SES money fence and the synthetic
   live-fire gate (`assertLegacySesInvoiceActionAllowed`, as every Xero invoice
   email path runs them).

A refusal of ours (6 to 9) claims nothing. It is recorded once as a
`receipt_not_sent` job event (`status` refused, `reason` the code:
`credit_settled`, `held_rectification`, `held_callback`, `no_xero_contact`,
`party_unmatched`, `party_unknown`, `party_xero_contact_unknown`,
`xero_contact_mismatch`, `xero_contact_shared`, `guard_<code>`). Once staff fix it (put the invoice on
the right Xero contact, link the party), the next run sends it, inside the
30-day window.

## The claim, and outcomes that are never retried

Xero sends an email every time `/Email` is called, so the claim comes first:
one `job_receipt_claims` row per `xero_invoice_id` (unique), inserted before the
call. Its id is the call's `Idempotency-Key`. The call goes through ops-api's
shared Xero cooldown fetch with a 20 second deadline and no retry.

| Xero's answer | Claim | Job event | Retried? |
| --- | --- | --- | --- |
| 2xx | `sent` | `receipt_sent`, plus evidence | never needed |
| other 4xx (for example no email on the contact) | `refused`, with Xero's message | `receipt_not_sent`, reason `xero_refused` | no: staff send it by hand |
| 5xx, timeout, lost connection, a thrown error | `unconfirmed` | `receipt_not_sent`, reason `unconfirmed` | **no**: it may have gone |
| 429, 401, 403, shared cooldown refused before any request, no token | deleted | none | yes, next run |

A claim still `claimed` an hour after it was taken never finished: the live
catch-up records it as `unconfirmed` (`stuck_claim`), never re-sent. An
`unconfirmed` or `refused` claim is for staff to read; to send that one again,
do it by hand in Xero.

Evidence: each sent receipt writes one `business_events` row through
`capture_business_event` (event type `invoice.receipt_emailed`, source
`ops-api/job_receipt`, channel `email`, outbound, `provider_message_id`
`xero:invoice:<id>:receipt`, capture mode `live`). Every job event carries the
invoice number, Xero contact id and name, the paid day, the trigger and the
party.

## How it is triggered

- **On payment.** xero-sync, for each invoice it mirrors as PAID on a fencing
  or patio job, posts `ops-api?action=job_receipt_paid` with the
  `xero_invoice_id` (only while the switch is `dry_run` or `live`, read once a
  run). ops-api decides everything.
- **Catch-up.** After each run xero-sync posts `job_receipt_catch_up`: every
  in-window PAID fencing or patio invoice with `amount_paid` above zero and no
  claim goes through the same
  sender. That covers a payment another writer mirrored first and a post that
  failed.

Both actions are server key only (`api_key` with the server secret) and POST
only. The manual Send review button (`send_review_request`) never sends a
receipt, and the review text never mentions one.

## The switch and the turn-on order

`job_closeout_settings.receipt_sender_mode`: `off` (seeded) | `dry_run` |
`live`. The database switch alone decides; there is no env lock (captain, 20
Oct 2026). A trigger stamps `receipt_sender_mode_since` whenever the mode
changes and keeps it otherwise (it cannot be set by hand), so scope always
starts when the **current** mode began: going live never sends for invoices
paid during the dry run, which staff were still sending by hand. A mode with no
start instant reads as off.

1. `UPDATE job_closeout_settings SET receipt_sender_mode = 'dry_run', updated_by = ..., note = ... WHERE id = 1;`
   Each invoice that would be emailed, or refused, gets one `receipt_dry_run`
   job event (`would` is `send` or the refusal code) naming the invoice number
   and the Xero contact. Nothing is sent and nothing is claimed.
2. Read those events, and check the refusals with staff.
3. Open Xero > Settings > Email settings and read the **default invoice email
   template**: it is what every customer will get.
4. Tell staff to **stop sending receipts by hand from Xero**, or customers get
   two.
5. `UPDATE job_closeout_settings SET receipt_sender_mode = 'live', ... WHERE id = 1;`

To stop: set it back to `off`. Claims stay, so nothing already emailed is ever
emailed again.

## Live numbers (read only, 20 Oct 2026)

PAID ACCREC invoices linked to a job, total and in the last 30 days: fencing
570 / 52, patio 147 / 22 (makesafe 374 / 60 and repair 5 / 3 are excluded).
No receipt event existed. The mirror holds no contact emails, so a Xero contact
with no email is only found when Xero refuses the call (kept as `refused`). The
scout found 3 party-linked invoices on a different Xero contact from their
party, and 4 multi-payer jobs with every invoice on one Xero contact: the cases
the wrong-party guard exists for.
