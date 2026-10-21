# Group work orders and client job sign-off

Backend contract for the trade app and the office. Schema:
`supabase/migrations/20261021140000_group_work_orders.sql`. Rules:
`supabase/functions/ops-api/group_work_order.ts`. Nothing in this slice sends
a text, an email, or a review request.

## What already existed, and what this reuses

The trade app already has a completion wizard (`trade.html`): the client
signs on the trade's phone (name plus a drawn PNG) and gives one 1–5
satisfaction score. `complete_my_job` then marks the job complete, stores
that one score, and can send a client update. "Client not on site" sends an
SMS that the invoice is coming and skips the signature. A later "Request
Review" step uses a hardcoded Google URL. Separately, a paid fencing or
patio job can get a Google review text from `send_review_request`.

There is no store for the five office-only ratings, and no public link the
client opens to sign the job off.

This slice reuses the signature shape (name plus PNG), the public
`share_token` pattern (`view_shared_report`), and the idea that a rating of
4 or more may ask for a Google review. It does not call `complete_my_job`
or `send_review_request`, and it does not change `jobs.status`. The review
URL is the row in `group_work_order_settings`, seeded from
`supabase/functions/_shared/google_review_link.ts`
(`https://share.google/AFyfkE7jLfCZcxanV`). The trade app's `g.page` TODO
URL is not that seed. Change the row to change the link.

## Confirmed rulings

- The pot is `work_orders.agreed_labour_ex` on the job's sealed job work
  order (`kind = 'job'`, `status = 'approved'`, `sealed_content_hash` set,
  amount above zero). The group row stores no dollar amount. A null,
  unsealed, or zero pot is `group_pot_missing`. The browser never sends the
  pot.
- After a crew member submits their own hours, the my-share response is
  exactly `{ pot_total, my_share, needs_hours, client_signed, group_id }`.
  Before those hours, `pot_total` and `my_share` are null and the work order
  is not read. Other participants' shares, hours, and points are not in the
  response. Only a participant of that group gets it.
- That read is a deliberate narrow exception to "trades cannot read
  `agreed_labour_ex`". PostgREST still hides `kind = 'job'` work orders
  (`work_orders_job_kind_hidden_from_clients`). A non-participant has no
  share row and is refused before any price is read. Another job's price is
  not on this response. Share and time-entry rows are own-row or staff under
  RLS. Feedback and settings are staff-only. Signatures have no authenticated
  SELECT.
- A job is paid either as a normal full work-order or hours claim, or as
  this split, not both. The fence is mutual and job-wide. Travel, materials,
  equipment, and adjustments are not a full claim. Another person's live
  share does not block this person's share. This person's second live share
  does (`group_share_already_invoiced`). A draft, failed, or ops-reject
  invoice holds nothing. `job_work_order_id` on an invoice line is not a
  full claim. A share line leaves `source_work_order_id` null.
- Points are each person's own `trade_rates` rate times their billed hours
  on this group, per day, summed. Share = pot × points / total points.
  Floor to cents. Leftover cents go to the largest remainders, and an equal
  remainder goes to the smaller `user_id`. Shares sum to the pot. A person
  with no rate or no hours is not in the split. Super runs on each person's
  own invoice gross (their share plus their own travel), unchanged in
  `trade_invoice_money.ts`.
- The share can be invoiced only after the client has signed. Crew
  signatures are stored and are not the gate.
- Travel stays each person's own travel extra (quantity 1, rate = the
  amount, no work order id), outside the points.

## DEFAULT, owner to confirm

Break minutes come off finish minus start, the same rule as a trade invoice
time entry (`resolveTradeInvoiceTimeEntry`). Start and finish stay required.
This slice does not copy clock rows or `job_assignment_logged_times`.

The Google prompt minimum is config, not a default in dispute:
`group_work_order_settings.review_prompt_min_rating`, seeded at 4. Every
rating must be at least that number. Change the row to change it.

## Actions

Trade JWT (profile-scoped). The caller is the signed-in user.

| Action | Body | Result |
| --- | --- | --- |
| `create_group_work_order` | `job_id` | Opens the group on `jobs.work_order_id`, or joins the caller to the one that exists. Returns `group_id`, `job_id`, `share_token`, `status`, `client_signed`. No dollars. |
| `join_group_work_order` | `group_id` or `job_id` | Same card. The caller must be allocated, unless they are staff. |
| `sign_group_work_order` | `group_id`, `signer_name`, optional `signature_png` | Crew signature. Not the invoice gate. |
| `submit_group_work_order_hours` | `group_id`, `work_date`, `start_time`, `finish_time`, `break_minutes` | Saves that person's day, then returns my-share. |
| `group_work_order_my_share` | `group_id` or `job_id` | The closed object above. 403 for a non-participant, with no amount in the body. |
| `group_work_order_preview_client_link` | `group_id`, optional `first_name`, `site`, `link`. `send: true` is 409 `client_message_disabled`. | `sent: false`, `send_implemented: false`, the draft, the token. |

Public, no account. The token is the secret. Same static-key door as
`view_shared_report`.

| Action | Body | Result |
| --- | --- | --- |
| `group_work_order_public` | `token` or `share_token` | Job number, suburb, type, whether the client has signed, whether feedback exists, and the office notice. No prices, no token echoed back. |
| `group_work_order_client_sign` | `share_token`, `signer_name`, optional `signature_png`, `signed_via` `on_site` or `share_link` | Signs the job. Idempotent. Does not complete the job. |
| `group_work_order_submit_feedback` | `share_token` plus the five ratings | One row. See feedback. |

Office only (staff JWT or the server key). A trade JWT is 403
`operator_access_required` before the handler. These names are not on the
trade allow-list.

| Action | Result |
| --- | --- |
| `group_work_order_feedback` | The feedback row. |
| `group_work_order_office` | Pot, every participant's hours, points, and shares, and the feedback. |

Invoice: `generate_trade_invoice` accepts an extra item
`type: "group share"` with `group_id` (or `job_id`). The server sets
quantity 1, rate = that person's share, `total_hours` 0,
`source_work_order_id` null, `group_share_id` set. A client amount that
differs by more than one cent is 409 `group_share_amount_mismatch`. The
client must have signed (409 `group_client_signoff_required`). A zero share
is refused. The same invoice cannot mix the share with hours or work-order
pay for that job.

## Feedback

Five ratings, each 1–5, optional comment, plus `free_text`:

`sales_process`, `communication`, `cleanliness`, `punctuality`, `crew`.

The public page shows: "These ratings go to the office. They are not viewed
by the installers." Installer and trade roles cannot read the row (RLS and
the office action). When every rating is at least the configured minimum,
the response sets `prompt_google_review: true` and includes
`google_review_url` from the settings row only. A missing URL omits the
key. The handler does not fall back to the seed constant.

## Draft the client would be sent

Flag `group_work_order_client_link_send_v1` is off. This build has no
sender: `send: true` returns 409 and does not call GHL, even if the flag is
later turned on. Draft, for the owner to approve before any sender exists:

`Hi {first}, your work at {site} is finished. Please open this link to sign the job off and tell the office how it went. The installers do not see what you write. {link} Thanks, Shaun`

## Open

- Two people invoicing the same unfrozen split at the same moment can each
  compute shares before either line is stored. The second invoice then
  freezes whatever it read. There is no cross-call transaction.
- A person who joins after a share is on a live invoice is not added to the
  frozen split (`group_share_not_in_split`).
- The sender is not built. Turning the flag on does not send anything.
- Withheld quote PDFs and the trade app's price-free extract are a different
  fence. This slice does not change them.
