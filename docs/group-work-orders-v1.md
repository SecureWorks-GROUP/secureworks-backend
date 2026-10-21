# Group work orders and client job sign-off

Backend contract for the trade app and the office. Schema:
`supabase/migrations/20261021141000_group_work_orders.sql`. It depends on
the client sign-off migrations from PR #1110
(`20261020170000_job_media_signature_voice_note_phases.sql` and
`20261020170100_job_client_signoffs.sql`), which this branch includes.
Rules: `supabase/functions/ops-api/group_work_order.ts`. Nothing in this
slice sends a text, an email, or a review request.

## Master switch

`feature_flags.group_work_order_v1` is seeded off. Missing or unreadable
is off. While it is off, every group action refuses 409
`group_work_order_disabled` ("Feature off. Group work orders are
switched off."): create, join, hours (submit and delete), my share, crew
sign, client sign-off (on-site capture and the public page), the public
read, public feedback, the client-link preview, freeze, and unfreeze.
A normal invoice still returns after the `feature_flags` read:
`submit_trade_invoice` and `submit_work_order_invoice` do not read the
group tables while the switch is off. A share-shaped line on
`generate_trade_invoice` or `save_trade_invoice_draft` is 409
`group_work_order_disabled` before any group-table read and before any
invoice write. The invoice-line trigger still refuses a second payment
if a group row already exists, and it does not read the switch. Staff
revoke, void, re-key, removing a participant, the office read, and the
feedback read stay available so an already-open group can be cleaned up.

The sender flag `group_work_order_client_link_send_v1` stays off. This
build has no sender: `send: true` returns 409 and does not call GHL.

## What already existed, and what this reuses

The trade app already has a completion wizard (`trade.html`): the client
signs on the trade's phone and gives one 1–5 satisfaction score. This
slice does not call `complete_my_job` or `send_review_request`, and it
does not change `jobs.status`.

The client drawing is one store, `job_client_signoffs` (PR #1110). A
group sign-off inserts a `job_media` row with `phase = 'signature'` and
points `job_client_signoffs.signature_media_id` at it. The public page
writes method `share_link`, `captured_by` null, `captured_by_actor`
`'client link'`. A participant's phone writes method `on_site`,
`captured_by` that trade's user id, actor `user:<id>`. Crew signatures
stay in `group_work_order_signatures` and are not the invoice gate.
Revoke inserts a newer `revoked` row (append-only) and clears the group's
`client_signed` status. The newest row wins (`created_at`, then `id`
collate C). There is no second client-signature store, so the two
records cannot disagree: the group status is a cache of that newest
counting row, and freeze reads `group_client_signoff_counts`, which
reads the same table. For the ordinary invoice gate, `office_waiver`
counts and a `revoked` row does not. For a group freeze, a counting
sign-off is a drawn signature (`on_site` or `share_link`, with
`signature_media_id`), not an office waiver and not revoked, and its
`created_at` is after the latest hours entry on the group. That group
rule lives in `group_client_signoff_counts`, not in
`trade_client_signoff.ts`. PR #1110 should merge first:
`trade_client_signoff.ts` and the two #1110 migrations on this branch
are the #1110 copies.

The Google URL is `group_work_order_settings.google_review_url`, seeded
`https://share.google/AFyfkE7jLfCZcxanV`. The happy threshold is
`client_signoff_settings.min_happy_rating` (default 4).
`group_work_order_settings.review_prompt_min_rating` stays seeded at 4
and is not the authority.

## Confirmed rulings

- The pot is `work_orders.agreed_labour_ex` on the job's sealed job work
  order (`kind = 'job'`, `status = 'approved'`, `sealed_content_hash` set,
  amount above zero). The group row stores no dollar amount. A null,
  unsealed, or zero pot is `group_pot_missing`. The browser never sends
  the pot.
- `group_work_order_write_split` is the only writer of the split. TypeScript
  `allocatePotCents` / `entryPointsMicro` are the test oracle and must
  match it. Floor to cents. Leftover cents go to the largest remainders,
  and an equal remainder goes to the smaller `user_id` (collate C). Shares
  sum to the pot. Worked case: 2h at $40 and 2h at $20 on pot 482.15 is
  321.43 and 160.72. After the first person's hours become 7.5 the same
  pot is 425.43 and 56.72.
- Hours count only on a date the person is assigned to that job (live,
  non-ghost, non-observer, non-cancelled). An upsert on an unassigned
  date is `group_hours_not_assigned`. Freeze requires every participant
  and every installer currently assigned to the job to have at least one
  such hour, not a hour on every assigned day. The office can remove a
  participant before freeze (`remove_group_work_order_participant`);
  that drops their hours and their participant row and writes
  `remove_participant`. It does not cancel the assignment, so someone
  still assigned is still named. After freeze the same action is
  `group_split_frozen`. A participant with hours and no `trade_rates` row
  is `group_share_rate_missing` and names that user. A rate that rounds
  to 0 cents is `group_participant_needs_rate`. Neither is a silent drop,
  and neither writes share rows.
- My-share keys are `{ pot_total, my_share, needs_hours, client_signed,
  group_id, awaiting }`. `awaiting` is `needs_hours`, `awaiting_signoff`,
  `awaiting_others`, `awaiting_rate`, `ready`, or `frozen`. `pot_total`
  is null only while `awaiting` is `needs_hours`. `my_share` is set only
  when `awaiting` is `frozen`. A share read never freezes and never calls
  `project_group_work_order_split`. `project_group_work_order_split` quotes
  and stores nothing. A non-participant is refused before any price is
  read. A trade's my-share says `awaiting_rate` without naming anyone
  else. The office payload lists the user ids who still need hours or a
  rate.
- A job is paid either as normal pay or as this split, not both. Normal
  pay is every trade time type (`TRADE_INVOICE_TIME_LINE_TYPES`: labour,
  fencing, patio, make safe, general labour, decking), plus hours and a
  work order. `group_work_order_line_is_normal_pay` is that set: case,
  underscores and spaces do not make a second type, and an unknown type
  with `source_work_order_id` still counts. Commission, travel, materials,
  equipment, adjustments and a group share do not. Commission stays in
  `WORK_ORDER_LOCK_LINE_TYPES` and outside this fence. The check runs
  both ways and does not read the switch: a share line is refused when
  normal pay already exists (`group_share_blocked_by_work_order_claim`),
  and opening a group is refused when normal pay already exists
  (`group_open_blocked_by_work_order_claim`). Both take an advisory lock
  on the job before the row lock, so the two writes cannot pass each
  other. The duplicate-share rule is stricter than the never-both fence:
  a draft holds the share; only `ops-reject` releases it. Unfreeze is
  refused once a share invoice is `acknowledged` or later, or carries any
  Xero bill id or push stamp (`group_split_has_live_invoice`). The
  never-both TypeScript list is `draft` and `ops-reject` only. The
  global `RELEASED_INVOICE_STATUSES` list is a different lock and still
  includes `failed`.
- The share line matches the invoice owner. A second live line for the
  same share is `group_share_already_invoiced`. A line whose
  `group_share_id` is another person's share is
  `group_share_owner_mismatch`. Amounts match to the cent.
- The invoice-line trigger watches `INSERT OR UPDATE OF group_share_id,
  line_total_ex`. A job-work-order stamp that updates another column does
  not re-enter it. The trigger locks the group row, requires a counting
  sign-off, and calls `write_split(true)` when the marker is null, in the
  same statement as the line. A failed insert rolls the freeze back. An
  explicit freeze that then fails its invoice stays frozen.
- Crew-charges lists show a group share only to its owner and to staff.
  The lead cannot acknowledge or override someone else's share. Group
  shares are excluded from negative-charge selectors.

## DEFAULT, owner to confirm

Pending Marnin's call. Built as the safe default.

- Freeze needs one counting hour from every participant and from every
  installer currently assigned to the job, not a hour on every assigned
  day. The office can remove a participant, audited, only before freeze.
- Commission sits outside the never-both fence.
- The client signature reuses `job_client_signoffs` and its happy
  threshold. A group freeze does not accept an office waiver: the
  signature is drawn, not revoked, and dated after the latest hours on
  the group. The ordinary invoice gate still accepts `office_waiver`.
- Unfreeze removes only the share line and recalculates that invoice's
  totals. It does not reject the trade's week. It is allowed only before
  acknowledgement, and any Xero id or push stamp blocks it.
- Voiding stays permanent. A void group cannot be opened again.
- PR #1110 should merge first. This branch's `trade_client_signoff.ts`
  and the two sign-off migrations match #1110.
- Break minutes come off finish minus start, the same rule as a trade
  invoice time entry.

## Actions

Trade JWT, while the switch is on. The caller is the signed-in user.

| Action | Result |
| --- | --- |
| `create_group_work_order` | Opens the group on `jobs.work_order_id`, or joins the caller. Refused when the job already has normal pay. No dollars. The public token is not on this card. |
| `join_group_work_order` | The caller must be allocated, unless they are staff. After freeze, `group_split_frozen`. |
| `sign_group_work_order` | Crew signature. PNG or JPEG data URL whose decoded bytes are between 3 and 150000 and match that format, or omitted. SVG is refused. Not the invoice gate. |
| `submit_group_work_order_hours` / `delete_group_work_order_hours` | Own hours, only before freeze, only on an assigned date. |
| `group_work_order_my_share` | The closed object above. |
| `capture_group_client_signoff` | On-site client drawing. Records the trade user id. |
| `freeze_group_work_order` | Explicit freeze after every participant and every currently assigned installer has counting hours, and a drawn client sign-off is newer than the latest hours. |
| `group_work_order_preview_client_link` | Draft only. `send: true` is 409. |

Public, no account, while the switch is on. The token is only for the
link sent to the client.

| Action | Result |
| --- | --- |
| `group_work_order_public` | Job number, suburb, type, whether the client has signed. No prices. |
| `group_work_order_client_sign` | Requires a drawn signature. Method is `share_link`. Idempotent once a counting row exists. |
| `group_work_order_submit_feedback` | Five integer ratings, 1–5. A second post cannot change the first ratings. |

Office. A trade JWT is 403 before the handler.

| Action | Switch | Result |
| --- | --- | --- |
| `group_work_order_feedback` | open | The feedback row. |
| `group_work_order_office` | open | Pot, every participant, who needs hours or a rate, feedback, `split_frozen`. |
| `unfreeze_group_work_order` | gated | Clears the marker. Deletes only the share lines and recalculates those invoices. Refused at acknowledgement or when the invoice has a Xero id or push stamp. |
| `remove_group_work_order_participant` | open | Before freeze only. Deletes that person's hours and participant row and writes `remove_participant`. Does not cancel the job assignment. |
| `revoke_group_signoff` | open | Newest `revoked` row. Does not itself unfreeze. |
| `void_group_work_order` | open | Unfreeze first, then status `void`. A paid share blocks it. Leaving `void` is refused. |
| `rekey_group_work_order` | open | Points at the current approved sealed `jobs.work_order_id`, only while not frozen and not void. |

`generate_trade_invoice` is the only door for a share, and only while the
switch is on. The server sets quantity 1, rate = that person's frozen
share, `source_work_order_id` null, `group_share_id` set. A client amount
that is not the snapshot is `group_share_amount_mismatch`. The same
invoice cannot mix the share with hours or work-order pay for that job.

## Feedback

Five ratings, each an integer 1–5, optional comment (2000), plus
`free_text` (4000): `sales_process`, `communication`, `cleanliness`,
`punctuality`, `crew`. Names are 1–120 characters. A signature is a
PNG or JPEG data URL. SVG and any other payload are refused. The
service-report email and the completion pack render a signature only
through `signatureImageTag`, which accepts that data URL or an escaped
https storage URL and omits anything else. The public page shows: "These ratings go
to the office. They are not viewed by the installers." When every saved
rating is at least `client_signoff_settings.min_happy_rating`, the
response sets `prompt_google_review: true` and includes
`google_review_url` from the group settings row only.

## Draft the client would be sent

`Hi {first}, your work at {site} is finished. Please open this link to sign the job off and tell the office how it went. The installers do not see what you write. {link} Thanks, Shaun`

## Open

- The sender is not built. Turning the sender flag on does not send anything.
- The master switch stays off until the owner turns it on.
- Withheld quote PDFs and the trade app's price-free extract are a different
  fence. This slice does not change them.
