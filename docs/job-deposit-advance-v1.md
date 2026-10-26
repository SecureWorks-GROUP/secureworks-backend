# Deposit advance for fencing and patio jobs (v1)

Captain, 26 Oct 2026: the pipeline moves a fencing or patio job along by its
deposit, so nobody tracks each job by hand.

- Accepted with no deposit invoice: the job stays in **Accepted**.
- Its deposit invoice went out: it moves to **Awaiting Deposit**.
- Every paying party has a deposit invoice and every live deposit invoice is
  paid in full: it moves to **Order Materials**.
  A patio job goes to **Approvals** instead while council is needed or not
  decided.

This builds the 12 Aug ruling ("When Xero recognises the deposit as paid,
fencing work moves from Awaiting Deposit to Order Materials"). Investigation:
`data/deposit-flow-s1/report.md` (firstmate home).

Code:
- `supabase/functions/_shared/job_deposit_paid.ts`: the rules, pure.
- `supabase/functions/ops-api/job_deposit_advance.ts`: reads, moves, the text
  and the flag.
- `supabase/functions/xero-sync/index.ts`: calls in after its deposit stamp.

Migration: `20261026160000_job_deposit_advance.sql`.

## The two moves

**Deposit invoice sent -> Awaiting Deposit.** These ops-api paths call
`depositInvoiceSent` after a deposit invoice was emailed successfully:

- `send_acceptance_invoice` (the online accept, from send-quote), only when the
  branded Pay Now email went out;
- `approve_and_send_invoice`, after the branded or the plain Xero email;
- `send_invoice_email`, after the Xero or the enhanced send;
- `create_deposit_invoice` (MCP `sw_create_deposit_invoice`), when Xero accepted
  the email it was asked to send;
- `create_unified_invoice`, after the branded email or the Xero email it was
  asked to send.

The move happens only when:
- the job is in `accepted`;
- the sent invoice is one of the job's deposits, AUTHORISED or PAID;
- the job has no draft deposit left.

It goes through `update_job_status` with `expected_statuses: ['accepted']`,
under the calling path's own source name. A failed send never calls it, so that
job stays in Accepted, and so does a job with no deposit invoice.

**Deposit paid -> Order Materials or Approvals.** After xero-sync's deposit
stamp, any change to a client sales invoice of a fencing or patio job posts
`job_deposit_paid`. That covers paid, authorised (a payment removed), voided and
deleted. ops-api then re-reads our Xero copy (`xero_invoices`) and moves the job
only when it is in `accepted` or `awaiting_deposit` and the paid rule holds. The
move uses `expected_statuses: ['accepted', 'awaiting_deposit']` and source
`xero_deposit_paid`. A job someone already moved on is never moved, and nothing
here moves a job backwards.

Where it goes (`depositPaidTargetStatus`):

| Job type | `council_required` | Moves to |
| --- | --- | --- |
| fencing | any | `order_materials` |
| patio | `false` | `order_materials` |
| patio | `true` or `null` (undecided) | `approvals` |

After each run, xero-sync also posts `job_deposit_catch_up`. It makes the same
paid move for every waiting card, which covers a deposit paid before the switch
was on or before the card reached Accepted. It also checks the flag for every
job this module moved.

## What counts as a deposit, and as paid

A deposit invoice is any ACCREC invoice on the job that matches either:
- its reference ends in `DEP` with up to three digits (`SWF-261369-DEP50`,
  `SWF-26535-B-DEP50`, the Debt tab's ending in `debt_ws_rules.ts`); or
- it is the job's own pointer, `jobs.deposit_invoice_id`.

The pointer alone is not enough. It is overwritten per invoice on a shared
fence, and it never names a deposit made by hand in Xero.

Paid means every paying party has a live deposit invoice of its own, and every
live deposit invoice (not voided or deleted) is PAID with nothing left due. So:
- a part payment never counts, and neither does a draft;
- a job with no live deposit invoice is not paid;
- on a shared fence, every party's deposit must be paid (captain answer 3). A
  party whose deposit invoice was never raised holds the job back
  (`party_without_deposit:<label>`).

The paying parties, and which party an invoice belongs to, are the paid
close-out's rule (`_shared/job_paid_closeout.ts`, `payingParties` and
`invoicePartyKey`): `job_contacts` rows not removed whose share is not an
explicit 0, or the job's client when there are none. An invoice belongs to the
party its `job_contact_id` names, else the share letter on its reference, else
its Xero contact, else the job's own client.

## The switch

`job_closeout_settings.deposit_advance_mode` is `off`, `dry_run` or `live`. It
ships `off`. The database switch alone decides. Both the landing and the paid
move sit behind it.

- `off`: nothing is read, moved, texted or logged.
- `dry_run` (watch only): each move that would happen writes one `job_events`
  row, `deposit_advance_dry_run`, once per job, from-status and target. The row
  carries `would_move_to`, `would_text_client` and the deposits. Nothing moves
  and nobody is texted.
- `live`: jobs move.

Turn on, in this order:

1. `UPDATE public.job_closeout_settings SET deposit_advance_mode = 'dry_run', updated_by = '<who>', updated_at = now() WHERE id = 1;`
   Read the `deposit_advance_dry_run` job events for one week.
2. Shaun switches it live: `UPDATE public.job_closeout_settings SET deposit_advance_mode = 'live', updated_by = '<who>', updated_at = now() WHERE id = 1;`

## The client text

The text goes only:
- in live mode;
- on an automatic move to Order Materials;
- once per job, ever.

It says: "Hi {first name}, Thanks, we've received your deposit. We're now
ordering your materials and we'll be in touch to book your install. Cheers,
Shaun". This is the old client-comms `deposit_paid` template reworded with no em
dashes. Only the automatic move sends it: a hand `send_client_update`
`deposit_paid` keeps its own words and footer, unchanged.

How it is sent:
- `job_deposit_advance_state.text_status` is claimed before the send.
- It goes through ghl-proxy `send_sms`, the shared sender policy and contact
  guard.
- It is logged in `email_events` under comms trigger `deposit_paid`, so a hand
  `send_client_update deposit_paid` afterwards is refused as already sent.
- If one was already sent by hand, the automatic one is skipped.

It is not sent when:
- the move is a patio move to Approvals. Council comes before materials there,
  so "we're now ordering your materials" would not be true yet, and nothing in
  this flow texts the client later when the patio reaches Order Materials;
- a person moved the job;
- the job has no GHL contact.

Outcomes on `text_status`: `sent`, `refused` (a 4xx: nothing went), `unconfirmed`
(may have reached GHL, never retried), `no_contact`, `prior_send_unreadable`
(the earlier sends could not be read, so nothing was sent) or `already_sent`.
Each one writes one `deposit_received_text` job event.

This is the second recorded exception to the 30 Sep 2026 money-messages ruling
(`ops-api/debt_autotexts_off.ts`). Like the receipts, it asks for no money.

## Voided or refunded after the move: a flag, never a move back

Captain answer 8: the job is not moved back. A person decides. The deposit is
flagged on the job when the job is in Approvals, Order Materials or a later
working stage (`DEPOSIT_FLAG_STATUSES`) and one of the reasons below holds.

The flag reason is one of:
- `deposit_voided`: a deposit that counted for the move is voided or deleted,
  and its party has no other live deposit paid in full. On a job a person moved
  on, any voided deposit counts, once xero-sync's deposit stamp had marked it
  paid.
- `deposit_unpaid`: a counted deposit is no longer paid in full, for example a
  payment taken off for a refund.

A void whose replacement deposit for the same party is paid in full flags
nothing. A party that never had a deposit holds the move back but is never a
flag. Each flag writes
one `deposit_flagged` job event. The flag is recorded in `dry_run` and in `live`,
because it is a record, not a move. xero-sync's existing
`job.deposit_stamp_contradicted` event is unchanged.

### Field contract for the Ops Dash (follow-up screen work)

For staff callers, on fencing and patio jobs only:

- **`pipeline` rows:** `deposit_flag` is present only while the job has an open
  flag. Every other row is byte-identical to before. When the flag read fails,
  `enrichment_errors` gains `pipeline.deposit_flag`, which means unknown, not
  "no flag".
- **`job_detail`:** `deposit_flag` is the open flag, or `null` when there is
  none. `deposit_flag_unreadable: true` appears only when the read failed.

The flag shape:

```json
{
  "reason": "deposit_voided",
  "invoice_number": "INV-1749",
  "invoice_status": "VOIDED",
  "flagged_at": "2026-10-27T01:02:03.000Z"
}
```

`reason` is `deposit_voided` or `deposit_unpaid`. Suggested words:
"Deposit voided after move - check" and "Deposit no longer paid after move -
check".

**Clearing a flag:** `POST ops-api?action=clear_job_deposit_flag` with
`{ "job_id": "<uuid>" }`, signed-in staff (admin, owner, ops_manager) or the
server key. It answers `{ ok, job_id, action: "cleared" | "no_open_flag" }` and
writes a `deposit_flag_cleared` job event. A cleared flag stops showing and is
never raised again for the same reason and invoice, however many flags the job
has had (`job_deposit_advance_state.cleared_flags` keeps every earlier cleared
flag when a new one replaces it). A later change to the
deposits (another invoice voided or unpaid, or another reason) can raise a new
one.

## Actions

| Action | Caller | What it does |
| --- | --- | --- |
| `job_deposit_paid` | server key (xero-sync) | `{ job_id, xero_invoice_id?, source? }`: the paid move, or the flag check for a job already moved on |
| `job_deposit_catch_up` | server key (xero-sync) | waiting cards whose deposits are paid; moved cards whose deposit was voided or unpaid |
| `clear_job_deposit_flag` | staff or server key | a person has dealt with a flag |

All three are POST only. A staff caller is refused 403 on the first two.

## GHL

Captain answer 7: leave GHL alone. These moves pass `skip_ghl_push`, so the GHL
opportunity is not moved, and no new GHL mapping is added.

Because GHL can now stay at Accepted while the job moves on, both GHL stage
readers rank every stored status in the board's order
(`_shared/job_status_rank.ts`): the ghl-webhook stage event and ghl-proxy
`sync_ghl`. An unranked status used to read as 0, so a GHL stage mapped to
Accepted pulled an Awaiting Deposit or Order Materials card back to Accepted.

## Live jobs on the day it goes live

There is no separate catch-up script. Jobs move on the first run of the switch
they qualify under:

- **Vicky Zhang (SWF-261369, fencing, INV-1749 paid 26 Oct)** moves from
  Accepted to Order Materials.
- **Will Gethin (SWP-261126, patio, INV-1701 paid 23 Oct)** moves from Awaiting
  Deposit to Approvals, or to Order Materials if council is recorded as not
  needed.

Both are recorded as `deposit_advance_dry_run` rows on the first `dry_run` run,
and move on the first `live` run of the xero-sync catch-up. A move to Order
Materials texts the client then; Will Gethin's move to Approvals sends nothing.

A job already in Accepted whose deposit invoice went out before the deploy (for
example SWF-261410) does not land in Awaiting Deposit. The landing runs only at
the send. Such a job moves straight from Accepted to Order Materials when its
deposit is paid.

## Known gaps

- On a shared fence, if one party's deposit invoice could not be created but
  another party's was sent, the job still lands in Awaiting Deposit. It does not
  move on until the missing party has a deposit of its own, paid in full.
- A deposit emailed by hand from Xero, or one sent before the deploy, does not
  land the job in Awaiting Deposit; the job moves on when it is paid. Closing
  this waits on our Xero copy keeping Xero's sent flag (PR #1166); an
  AUTHORISED deposit alone is never read as sent.
- A deposit refunded through a credit note (the invoice stays PAID) is not
  flagged; only a void or a payment taken off is.
- The flag is checked only when xero-sync sees one of the job's invoices change,
  and on the catch-up for jobs this module moved. A job a person moved on is
  flagged only on a void of a deposit xero-sync had stamped paid
  (`jobs.deposit_at`).

## Rollback

`supabase/rollbacks/20261026160000_job_deposit_advance_down.sql`. Roll back the
matching ops-api and xero-sync first, because they read the column and the
table. The job events stay as history.

## Tests

- `supabase/functions/_shared/job_deposit_paid_test.ts`: the rules.
- `supabase/functions/ops-api/job_deposit_advance_test.ts`: moves, switch, text,
  flag and the action door, against an in-memory fake.
- `supabase/functions/ghl-webhook/stage_rank_test.ts`: the rank.
- The migration contract
  `supabase/tests/migration-contracts/20261026160000_job_deposit_advance/`.
