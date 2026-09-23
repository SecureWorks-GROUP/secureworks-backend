# Debt follow-up: exact-message approval and one send executor

Code: `supabase/functions/ops-api/debt_followup_approval.ts` (rules),
`debt_followup_approval_live.ts` (production reads, ledger, transports),
`debt_followup_approval_test.ts` (proof). Ledger:
`supabase/migrations/20260924213000_debt_followup_approvals.sql`.

## Why

The Clear Debt screen used to send a debtor text or invoice email after a
browser confirm only. Nothing on the server recorded that the captain approved
that exact message, to that person, about those invoices, at that balance. The
payment-link text picked the job's latest invoice, the paid thank-you text went
out automatically, and `send_invoice_email` without `to_email` asked Xero to
email the invoice directly.

## The rule

Every debtor text or invoice email goes through one executor. Nothing reaches a
provider unless all of these hold at the moment of the press:

1. The captain approved this exact proposal (`debt_followup_approve`, an
   allow-listed captain session only; `DEBT_FOLLOWUP_CAPTAIN_EMAILS`, default
   the captain). The approval binds the body and its SHA-256, the destination
   identity (GHL contact and phone, or email to/cc), the selected Xero invoice
   ids, the email subject and attachment identity, the Xero snapshot of each
   invoice (status, amount due, amount paid, total, contact, last update), the
   debt-desk hold state (classification, blocker) and a 30-minute expiry.
2. The press re-reads everything and rebuilds the proposal. Any failed read, any
   moved coordinate, any hold, an expired approval or a hash mismatch refuses
   and names what changed.
3. `DEBT_FOLLOWUP_SEND_EXECUTE` is exactly `"true"` AND an allow-listed captain
   session pressed. The switch is unset: nothing in code, env or flags sets it,
   and a test fails if code ever assigns it. Turning it on is the captain's call.

Otherwise the press is a dry run: every check runs, a `debt_followup_executions`
row records the result (`mode = dry_run`), and no provider send call is made.

One approval sends at most once. The live claim atomically closes the approval
and inserts its unique live execution before the provider call. Approvals move
only from `open` to `closed`; expiry closes an open row when its binding is
approved again. A unique partial index and the atomic create function make
concurrent identical approvals return the same open row. The execution settles once: `sent` (with provider proof),
`failed` (the transport refused before sending) or `unknown` (the provider may
have sent). A second press of a sent approval replays its proof; any other
second press is refused. A new send needs a new approval.

Nothing here writes Xero, allocates money, voids, or changes a payment.

## Actions

Who may call them (captain's standing ruling: one staff access level; identity
recorded, not restricted): a signed-in staff/operator session whose profile org
is the SecureWorks org, or the privileged ops key. Other-org staff get 403
`operator_org_required`; trades, crew, anonymous callers and the shared browser
key get 403 `operator_access_required`. The gate (`debtFollowupCallerRefusal`,
through `debtFollowupActionEntry`) runs before any read or ledger dependency is
built. An approval records the captain's email and user id.

| Action | What it does | Writes |
|---|---|---|
| `debt_followup_propose` (POST `{request}`) | Builds the exact proposal from fresh reads; returns `binding_hash`. | Nothing |
| `debt_followup_approve` (POST `{request, expected_binding_hash}`) | Captain only (403 otherwise). Rebuilds; refuses `proposal_changed` if the hash moved. Re-approving an open approval returns it atomically. | One `debt_followup_approvals` row |
| `debt_followup_execute` (POST `{approval_id, dry_run?}`) | The press. | One `debt_followup_executions` row |

`request`: `{kind, xero_invoice_ids[], ghl_contact_id?, message?, to_email?, cc?, subject?}`.

One job per approval (v1): every selected invoice must be linked to the same
single job. A selection spanning two jobs, or any invoice with no job, is
refused `single_job_scope_required` before any provider read, at approval and
again at the press. Every confirmed send therefore carries that one job id and
appears once in that job's conversation.

| kind | Invoices | Body | Destination |
|---|---|---|---|
| `chase_sms` | 1 to 20, one debtor, one job, AUTHORISED with a balance, not on hold | The operator's exact `message` | The job's GHL contact, else the org-scoped `contact_matches` binding (every row checked; two contacts or too many rows refuse) |
| `payment_link_sms` | Exactly 1, same rules | Composed from the Xero online-invoice URL | Same |
| `thank_you_sms` | Exactly 1, PAID | Composed from Xero's amount paid | Same |
| `invoice_email` | Exactly 1, same rules as chase | The exact Outlook HTML, including the default mailbox signature, plus the Xero PDF | Xero contact emails and verified anchors only; default the Xero primary email |

Composed texts carry no em dashes.

## The old actions

`send_chase_sms`, `send_payment_link`, `handle_payment_event` (its thank-you
text) and both `send_invoice_email` branches route through
`debtFollowupLegacySend`:

- With `approval_id` (`thank_you_approval_id` for `handle_payment_event`) they
  press that approval. The approval must be of the same kind and every
  coordinate the old body restates must match it.
- Without one they record a dry run of the exact message they would have sent
  and return HTTP 409 `success: false` with the `binding_hash`, so callers such
  as the daily-digest deposit chaser record "reminder NOT sent".

`send_payment_link` needs `xero_invoice_id`; a job-only call is refused rather
than guessing the job's latest invoice. The Xero-direct `/Invoices/{id}/Email`
route is no longer used by the debt-follow-up `send_invoice_email` path;
approved sends from that path use the verified Outlook transport. Ordinary
invoice-issue email remains outside this executor in `approve_and_send_invoice`,
`createInvoice`, and `update_invoice`. Those existing paths are a named follow-up
for a separate ordinary-invoice email design; they are not debtor follow-up.
`handle_payment_event` still stops the chase workflow, resolves follow-ups and
logs the payment; only its text needs an approval.

## Proof and the timeline

A confirmed SMS stores the GHL message id and ghl-proxy's evidence outcome; the
canonical message row is written by ghl-proxy `send_sms` through
`capture_business_event` (keyed `ghl:<id>`), so it appears once in the
conversation. A confirmed email stores the Outlook acceptance, recipients,
subject and the SHA-256 of the attached PDF. Its `invoice.emailed` event is
written through `capture_business_event` under the writer's existing contract,
keyed `outlook-accepted:<approval_id>` (one approval sends at most once), with
`capture_mode: live`; the writer owns the event time and attribution. The
approved subject and HTML sit in the payload (`subject`, `email_body_html`,
never `body`, so the ladder's words stay the digit-free preview), and
`getJobConversation` shows the event once as an outbound email with a proof
block labelled "accepted by Outlook". If that capture write fails, the
conversation projects the confirmed `outcome = sent` execution row instead;
provider identity deduplication prevents showing both copies. The same fallback
uses `ghl:<id>` for a confirmed SMS. Graph `sendMail` returns no message id,
so email proof is acceptance, not delivery. If the evidence write does not land
after Outlook accepts the send, the send stays confirmed and the result carries
`timeline_write_failed: true`.

## Known follow-ups (not in this change)

- `trigger_chase_workflow` now refuses with
  `chase_workflow_trigger_disabled` and makes no GHL call. Replacing it with an
  approved workflow handoff needs its own design. `stop_chase_workflow` remains
  available to remove the chase tag and clear its fields.
- A new debtor reply since approval is not yet a refusal reason.
- The Clear Debt screen (secureworks-ux) still calls the old actions without an
  approval; those calls are now recorded dry runs until the screen gains the
  approve and press flow.
