# Debt desk actions (plan steps 3 and 5)

The ops-api actions behind the Clear Debt desk's drafts, approvals, outcomes and
sends, and Jan's morning text. Plan: [PLAN.md](PLAN.md) sections 4 and 6 steps
3 and 5. The screen's own contract is secureworks-ux `docs/clear-debt-desk.md`.
Code: `supabase/functions/ops-api/debt_desk_actions.ts`, `debt_desk_drafts.ts`,
`debt_draft_templates.ts` and `debt_jan_text.ts`. Schema:
`supabase/migrations/20261001100000_debt_desk_chase_log.sql` (step 5 adds no
schema).

Every write needs a signed-in staff user (admin, owner, ops manager). A server
key passes the front door but is refused with `403 debt_desk_user_required`,
because the desk records who approved and who logged. Trades and the agent key
are refused at the door.

The desk owner approves every message (captain: "shaun" owns the desk), so
`debt_draft_decide` and `debt_draft_send` also refuse anyone else with
`403 debt_desk_owner_required`. The owners are the user ids in the ops-api
secret `DEBT_DESK_OWNER_USER_IDS` (comma-separated) when it is set; a set but
unusable value means nobody. Unset, the owners are the `owner_user_ids` of the
one-row `debt_desk_settings` table, seeded by this change's migration with
Shaun's `users.id` (`9913309f-35ae-4a71-8e1f-f704ecc526ea`,
shaun@secureworkswa.com.au). That is the id ops-api reads from his signed-in
session (`auth.getUser`; `users.id` is the auth user id), so it is the id the
desk stores as `approved_by_user_id` for him. There is never a role fallback:
several users hold `ops_manager`. With no owner, `debt_draft_decide` and
`debt_draft_send` refuse everyone with `403 debt_desk_owner_not_set` ("Desk
owner not set"). To change the owner, set the secret or update that row with
the service role. Any staff user may log an outcome.

`debt_morning_list` carries `desk`: `{ owner_set, viewer_is_owner,
sending_enabled, note }` for the signed-in viewer. `owner_set: false` means
the screen should say "desk owner not set"; `owner_set: null` means the
owner could not be read.

## Drafts on the morning list

`debt_morning_list` items at `friendly_text`, `firm_text` and
`deposit_reminder` carry `draft`; calls, statements, holds and Jan visits carry
`draft: null` (Jan's visits are listed in Jan's one morning text, below). A
firm text whose Xero pay link could not be read has `draft: null` and
`draft_problem` says why. Each item invoice carries its debt
book `kind`; a deposit reminder says "deposit" only when every invoice is a
deposit, and otherwise "the invoice for your job" (a progress claim or
materials invoice before the job's first payment is not a deposit).

```json
{
  "id": "<item id>|<amount due in cents per invoice, item order>",
  "channel": "sms", "to": "client", "step": "friendly_text",
  "text": "the approved or sent text once decided, else the standard wording; see below for a skipped firm text",
  "template_text": "the standard wording; null on an approved, claimed or sent firm text, and on a skipped one with no link read that day",
  "status": "pending | approved | skipped | sending | sent",
  "edited": "true or false against the standard wording; null when it is not known",
  "pay_links": [{ "xero_invoice_id": "uuid", "invoice_number": "INV-1", "url": "https://in.xero.com/..." }],
  "approved_by": "email", "approved_by_user_id": "uuid", "decided_at": "iso",
  "last_send": { "at": "iso", "outcome": "failed | not_confirmed", "reason": "Sending is off until Shaun says start sending" }
}
```

Pay links are read one invoice at a time, at most 10 live Xero reads per list
read, top of the list first. A link once read is kept for the rest of that
Perth day in the ops-api instance's memory, so reading the list again after
each approval spends no more Xero calls on it. A decided firm text (approved,
skipped, claimed or sent) is not read live again. An approved, claimed or sent
one keeps its links inside its text, and its standard wording is not known:
`template_text` and `edited` are null. A skipped one is worded from links
already read that day (`template_text` and `pay_links` set), else shows its
earlier approved text, and is `text: null` only when it has neither, so
un-skipping it never spends a Xero read. A changed amount gives a new draft
id, so an approval never carries over to a text it did not see.

`sending` means a send claimed the draft and did not confirm it: the draft is
never sent again that day, and `last_send.outcome: "not_confirmed"` carries
the reason. Tomorrow's list drafts the step again.

Once a draft is sent, its payer leaves today's list (the step is done), so the
list also carries `sent_today`: `{ draft_id, to, payer_name, invoice_numbers,
step, text, at, by, provider_message_id }` for each draft sent on today's
Perth date. Jan's morning text appears there with `to: "jan"`,
`payer_name: "Jan"` and `step: "jan_text"`.

Each item's `last_outcome` is `{ code, label, at, by }`; `label` is in Jan's
words when the outcome was a Jan visit ("No one home"). The list's `schedule`
carries `outcomes` (the call labels) and `jan_visit_outcomes`, the four
buttons for what Jan reports.

## Jan's morning text (plan step 5)

The captain's ruling (DECISIONS.md round 6, Q7): "Morning text to Jan that I
approve; I record what he reports", "Yeap to Jan's phone number directly".

`debt_morning_list` carries `jan_text`: one draft a morning, to Jan's own
mobile, listing today's Jan visits. A visit is any item at the `jan_visit`
step that is not held, a broken promise at the Jan step included. `jan_text`
is null when there are none.

```json
{
  "id": "<perth date>:jan-<tag>-<names tag>:jan:jan_text|<amount due in cents per invoice>",
  "channel": "sms", "to": "jan", "step": "jan_text",
  "to_phone": "+61411222333 or null", "mobile_source": "staff | null",
  "visits": [{ "item_id": "...", "payer_key": "...", "payer_name": "...",
    "site": "12 Example Street, Exampleton or null", "invoice_numbers": ["INV-1"],
    "xero_invoice_ids": ["uuid"], "amount": 100, "days_overdue": 11,
    "broken_promise": false }],
  "xero_invoice_ids": ["uuid", "..."],
  "text": "...", "template_text": "...",
  "status": "pending | approved | skipped | sending | sent",
  "edited": false, "approved_by": "email", "approved_by_user_id": "uuid",
  "decided_at": "iso", "last_send": null,
  "approvable": true, "problem": null
}
```

The standard wording names each visit's payer, the job's site address when
the job has one, the invoice numbers, the amount owing and how many days
overdue (the oldest, for several invoices), one numbered line each:

```text
Hi Jan, your visits for Thu 1 Oct 2026:
1. Client 1, 12 Example Street, Exampleton: INV-1, $100.00 owing, 11 days overdue.
Please tell Shaun how each visit goes. Thanks
```

- **Jan's mobile.** Only from the staff records: the one staff record
  (`users`, the org's) whose first name is exactly Jan, its phone read as an
  Australian mobile (+614XXXXXXXX); several such records count only when they
  share one mobile. It is never written into the code and there is no other
  setting for it. The list reads it only when there is a Jan text to show,
  and shows it as `to_phone` so Shaun sees the number before he approves.
- **Not set.** When the mobile cannot be found unambiguously, `to_phone` is
  null, `approvable` is false and `problem` starts "Jan's mobile not set in
  staff records" with the reason (or "Jan's mobile not set: the staff records
  could not be read" when the read failed). The wording is still shown. It cannot be approved
  (`409 jan_mobile_not_set`); it can be skipped.
- **Approve or skip** with `debt_draft_decide`, as any draft: the desk owner
  only, `xero_invoice_ids` set to `jan_text.xero_invoice_ids` in that order.
  The draft id's tag is a hash of Jan's number and those invoice ids, so an
  approval is tied to the number and the list Shaun saw: another number, or
  the invoices in another order, is refused `409 debt_draft_invoices_changed`.
  A Jan text may be up to 1600 characters (a client text 1000), and is refused
  when empty, with an em dash or over that length. It goes to staff, not a
  client, so the legal-action words are not checked against the payer names
  and job sites it lists (a street named Court is an address): the names tag
  in the draft id is a hash of those, and while every visit line's
  "<n>. <payer, site>:" part is exactly as drafted, that part is left out of
  the word check. Everything else, the standard wording and anything Shaun
  types, is checked; an edit to a listed name or site has the whole text
  checked. `approvable` and `problem` run the same check on the text shown.
- **Send** with `debt_draft_send`, as any draft: the same switch
  (`DEBT_SENDING_ENABLED`), the same "nothing logged since the approval" rule,
  the same last Xero check of every covered invoice (Jan is never sent to a
  door that has paid since), and the same durable claim. Then the text goes to
  Jan's mobile through the staff SMS path (`ghl-proxy send_sms` with a phone,
  which finds or creates the GoHighLevel contact for that number, from the
  Group Admin sender), never `send_chase_sms`. Jan's mobile is read again
  at the send: `jan_mobile_not_set` when it is not set,
  `jan_mobile_changed` when it is not the number the text was approved for.
  A provider failure keeps the claim (`send_not_confirmed`), so Jan is never
  texted twice.
- **Logged.** Its rows (approval, skip, refusal, claim, sent) are written per
  covered invoice with `method: sms`, no `schedule_step` and no job. They never
  move a payer's ladder, and the older chase-history readers leave them out:
  a text to Jan is not a chase of the payer. The payers stay on today's list
  so Shaun can record what Jan reports. Once a Jan text is sent or claimed
  today, it stays the day's `jan_text` (status `sent` or `sending`, `visits`
  narrowed to the payers still on the list), so recording Jan's reports never
  offers a second text.

## `debt_draft_decide` (POST)

`{ draft_id, decision: "approve" | "skip", text, xero_invoice_ids }`, answered
`{ ok, draft }`. `xero_invoice_ids` are the item's invoices in the item's
order. An edit is an approval carrying the edited text. Refuses a draft from
another day (`409 debt_draft_not_today`), one already sent
(`409 debt_draft_already_sent`) or claimed by a send
(`409 debt_draft_sending`), and a text that is empty, has an em dash, is
over 1000 characters, or mentions legal action, a lawyer, court, debt
collection, credit reporting or a default (`400 debt_draft_text_not_allowed`).

## `debt_log_outcome` (POST)

`{ xero_invoice_ids, outcome_code, promised_amount, promised_date, note,
channel: "call" | "visit", schedule_step: "call" | "builder_call" |
"jan_visit" | null }`, answered `{ ok, logged }` (`logged.label` is the
outcome's words). A `jan_visit` outcome is logged with method `visit`.

**What Jan reports** is a `jan_visit` outcome, using the same codes, so a visit
moves the ladder exactly like a call:

| Jan reports | `outcome_code` | What the desk does |
|---|---|---|
| Visited: paid | `says_paid` | Holds the invoice: "Jan reports paid: check Xero first" |
| Visited: promised | `promised` | Pauses chasing until the date (a promise, below) |
| No one home | `no_answer` | Done for today; back on Jan's list tomorrow |
| Visited: disputed | `disputed` | Holds the invoice: "the payer disputed it with Jan" |

`spoke` is also accepted ("Visited: spoke"), and works like no one home.

**Promises.** A promise needs an amount and a date not before today; the desk
reads each invoice live from Xero, refuses one that is not open or a promise
above what is owed, and stores the total then due as `amount_due_at_promise`,
with `covers_invoice_ids` naming every invoice it covers. On the morning list:

- through its date the promise is open and the payer (homeowner) or invoice
  (builder, deposit) is in `paused`, with `resumes_on` the day after. One
  promise covering several builder invoices or deposits is one `paused` row
  with all of them, never one row per invoice;
- a builder invoice with an open or broken promise stays on the Monday
  statement, marked;
- the morning after the date, it is kept when the amount paid since the
  promise (amount due at the promise less today's amount due, an invoice paid
  off counting as nothing due) covers the promised amount, and the ladder
  carries on. Otherwise, unpaid or short, it returns at the top of the list,
  group `broken_promise`, at the next step: for a homeowner the next ladder
  step (at Jan's step it goes into Jan's text), for a builder Shaun's call, for
  a deposit its reminder (drafted again);
- a step logged after the promise (a text sent, a call or visit logged)
  replaces it.

## `debt_draft_send` (POST)

`{ draft_ids: [...] }` (1 to 20), answered `{ ok, sending_enabled, results,
sent, refused }`, each result `{ draft_id, sent, code, reason,
provider_message_id, logged }`.

- **Off by default.** Unless the ops-api secret `DEBT_SENDING_ENABLED` is
  exactly `true`, every draft is refused `sending_off` and logged as refused.
  No Xero read and no message happens. Switch it on only after step 0 is done
  and Shaun says start sending.
- When on, drafts go one at a time. Each must be approved today, not skipped,
  claimed or sent since, with nothing logged on its invoices since the
  approval. Jan's text goes the same way, to Jan's mobile (above).
- **Last check.** Each invoice is re-read live (`get_xero_receivable`). The
  send is refused, with the reason, when Xero shows it `paid` (nothing due),
  `voided`, not authorised, or `part_paid` with less owing than the amount
  the draft was written against, whether paid, part paid or credited since.
  An older credit note with the drafted balance still owing does not block
  the text. A Xero rate limit stops the rest of the batch
  (`last_check_unavailable`).
- **Claim, then send.** Before the text goes, the draft is claimed: a
  `sending` row per covered invoice, which a unique index allows once per
  draft and invoice. An overlapping send of the same draft is refused
  `already_sending` and never reaches the client. Once the text goes, the
  claim becomes `sent`. If the provider fails, or the `sent` write fails, the
  claim stays (`send_not_confirmed`, or `sent: true, logged: false`), so the
  draft is never texted twice. If `send_chase_sms`'s own guards refuse before
  anything goes to GoHighLevel, the result is `send_refused_by_guard` with the
  guard's reason; the claim stays then too.
- The text goes only through the existing `send_chase_sms` path, to the GHL
  contact on the invoice's job. Each send and refusal is a
  `payment_chase_logs` row per covered invoice. A sent row carries
  `outcome_code: sent`, the provider message id and the approver's user id,
  and moves the chase ladder; approvals, skips, refusals and claims never do.
  `send_chase_sms` also writes its own older-style "SMS sent" row.
- The older chase-history readers (Clear Debt's chase counts and recent
  chases, `job_detail`, `invoice_context` and the debt notes thread) show
  each invoice a desk send covers as chased once, and never an approval,
  skip, refusal or claim. send_chase_sms logs the send with its own
  "SMS sent" row on the first covered invoice; the desk's sent row there
  carries the job id, as that row does, and is left out, while its sent rows
  on the other covered invoices (no job id) are shown.
