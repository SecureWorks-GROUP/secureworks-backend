# Debt desk actions (plan step 3)

The ops-api actions behind the Clear Debt desk's drafts, approvals, outcomes and
sends. Plan: [PLAN.md](PLAN.md) sections 4 and 6 step 3. The screen's own
contract is secureworks-ux `docs/clear-debt-desk.md`. Code:
`supabase/functions/ops-api/debt_desk_actions.ts`, `debt_desk_drafts.ts` and
`debt_draft_templates.ts`. Schema:
`supabase/migrations/20261001100000_debt_desk_chase_log.sql`.

Every write needs a signed-in staff user (admin, owner, ops manager). A server
key passes the front door but is refused with `403 debt_desk_user_required`,
because the desk records who approved and who logged. Trades and the agent key
are refused at the door.

## Drafts on the morning list

`debt_morning_list` items at `friendly_text`, `firm_text`, `jan_visit` and
`deposit_reminder` carry `draft`; calls, statements and holds carry
`draft: null`. A firm text whose Xero pay link could not be read has
`draft: null` and `draft_problem` says why.

```json
{
  "id": "<item id>|<amount due in cents per invoice, item order>",
  "channel": "sms", "to": "client | jan", "step": "friendly_text",
  "text": "the approved or sent text once decided, else the standard wording",
  "template_text": "the standard wording",
  "status": "pending | approved | skipped | sent", "edited": false,
  "pay_links": [{ "xero_invoice_id": "uuid", "invoice_number": "INV-1", "url": "https://in.xero.com/..." }],
  "approved_by": "email", "approved_by_user_id": "uuid", "decided_at": "iso",
  "last_send": { "at": "iso", "outcome": "failed", "reason": "Sending is off until Shaun says start sending" }
}
```

Pay links are read one invoice at a time, at most 20 per list read, top of
the list first. A changed amount gives a new draft id, so an approval never
carries over to a text it did not see.

Once a draft is sent, its payer leaves today's list (the step is done), so the
list also carries `sent_today`: `{ draft_id, payer_name, invoice_numbers,
step, text, at, by, provider_message_id }` for each draft sent on today's
Perth date.

## `debt_draft_decide` (POST)

`{ draft_id, decision: "approve" | "skip", text, xero_invoice_ids }`, answered
`{ ok, draft }`. `xero_invoice_ids` are the item's invoices in the item's
order. An edit is an approval carrying the edited text. Refuses a draft from
another day (`409 debt_draft_not_today`), one already sent
(`409 debt_draft_already_sent`), and a text that is empty, has an em dash, is
over 1000 characters, or mentions legal action, a lawyer, court, debt
collection, credit reporting or a default (`400 debt_draft_text_not_allowed`).

## `debt_log_outcome` (POST)

`{ payer_key, xero_invoice_ids, outcome_code, promised_amount, promised_date,
note, channel: "call" | "visit", schedule_step: "call" | "builder_call" |
"jan_visit" | null }`, answered `{ ok, logged }`. A `jan_visit` outcome is
logged with method `visit`. A promise needs an amount and a date not before
today; the desk reads each invoice live from Xero, refuses one that is not
open or a promise above what is owed, and stores the total then due as
`amount_due_at_promise`. `payer_key` is accepted and not stored.

## `debt_promises` (GET)

Every promise logged in the last 120 days: `invoice_numbers`, `payer_name`,
`promised_amount`, `promised_date`, `amount_due_at_promise`,
`amount_due_now`, `status` (`open`, `kept`, `broken`, against the live book),
`current` (false once a later outcome or step replaced it), `logged_at`,
`logged_by`, `note`. The screen builds its Promises tab from the morning list
today and does not need this read.

## `debt_draft_send` (POST)

`{ draft_ids: [...] }` (1 to 20), answered `{ ok, sending_enabled, results,
sent, refused }`, each result `{ draft_id, sent, code, reason,
provider_message_id, logged }`.

- **Off by default.** Unless the ops-api secret `DEBT_SENDING_ENABLED` is
  exactly `true`, every draft is refused `sending_off` and logged as refused.
  No Xero read and no message happens. Switch it on only after step 0 is done
  and Shaun says start sending.
- When on, drafts go one at a time. Each must be approved today, not skipped
  or sent since, with nothing logged on its invoices since the approval.
  Jan's text (`jan_text_not_wired`) waits for plan step 5.
- **Last check.** Each invoice is re-read live (`get_xero_receivable`). The
  send is refused, with the reason, when Xero shows it `paid`, `voided`,
  `credited`, not authorised, or `part_paid` below the amount the draft was
  written against. A Xero rate limit stops the rest of the batch
  (`last_check_unavailable`).
- The text goes only through the existing `send_chase_sms` path, to the GHL
  contact on the invoice's job. Each send, failure and refusal is a
  `payment_chase_logs` row per covered invoice. A sent row carries
  `outcome_code: sent`, the provider message id and the approver's user id,
  and moves the chase ladder; approvals, skips and refusals never do.
  `send_chase_sms` also writes its own older-style "SMS sent" row.
