## Office sign-off update, 27 October 2026

Owner supersedes the earlier no-waiver default: a reasoned, attributed office override now counts for a group. It uses the existing staff-only `waive_client_signoff` action and append-only `job_client_signoffs` with method `office_waiver`. It does not fabricate a drawing or satisfaction rating. It must be newer than the latest hours change; a later revoke still wins. The group read exposes the method/reason/actor to office only. The screen shows the office override separately. No automatic freeze, invoice or payment is triggered.

Both office and trade job-detail responses now supply `group_work_order_enabled` from the live feature flag, failing closed if unreadable, so enabled cards can actually appear.

# Group work orders and client job sign-off

Backend contract for the trade app and the office. Schema:
`supabase/migrations/20261022050000_group_work_orders.sql`. It applies
after the client sign-off migrations already on main
(`20261020170000_job_media_signature_voice_note_phases.sql` and
`20261020170100_job_client_signoffs.sql`).
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
if a group row already exists, and it does not read the switch. Ordinary
pay on `save_trade_invoice_draft` for a job that already has a non-void
group is 409 `group_job_uses_share` ("This job is on a group work
order. Save your share, not ordinary hours.") even while the switch is
off: the line trigger would otherwise raise
`work_order_claim_blocked_by_group_share` and the draft save would
return 500. `my_hours` leaves those jobs out. A failed read of the
group rows is 503 `group_work_order_unreadable`, so a group job is
never shown as ordinary hours. A share-shaped line on that draft is
still 409 `group_work_order_disabled` before any group-table read.
Staff revoke, void, re-key, removing a participant, the office read,
and the feedback read stay available so an already-open group can be
cleaned up.

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
`created_at` is strictly newer than the latest hours on the job. That
instant is the later of every remaining hour row (later of `created_at`
and `updated_at`) and `group_work_orders.hours_changed_at` on each
non-void group. `hours_changed_at` is `clock_timestamp()` when hours are
inserted, really changed, or deleted, and when a participant is removed.
An identical re-save moves neither the hour row nor that stamp.
Deleting the last hour still leaves the group stamp, so the old drawing
does not count. The comparison is `max()` over both stamps:
`GREATEST` of a null and a stamp is null. That group
rule lives in `group_client_signoff_counts`, not in
`trade_client_signoff.ts`. The shared helper treats a newest `revoked`
row as not signed, and an office waiver still counts for ordinary
invoicing.

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
- A job is paid either as normal pay or as this split, not both. On a
  group job every invoice line counts as pay unless it is travel,
  materials, equipment, an adjustment, a final-payout deduction,
  commission, or the share itself. That includes `Other` and any unknown
  type, with or without `source_work_order_id`. Live `Other` lines are
  labour. Pending Marnin. Case, underscores and spaces do not make a
  second type. Commission stays in `WORK_ORDER_LOCK_LINE_TYPES` and
  outside this fence. The check runs both ways and does not read the
  switch: a share line is refused when normal pay already exists
  (`group_share_blocked_by_work_order_claim`), and opening a group is
  refused when normal pay already exists
  (`group_open_blocked_by_work_order_claim`). Both take an advisory lock
  on the job before the row lock, so the two writes cannot pass each
  other. A draft share line does not freeze the split and does not count
  as invoiced. The database duplicate rule releases `draft` and
  `ops-reject`. The never-both TypeScript list is the same two statuses
  and stays its own check. Unfreeze is refused while a weekly submit
  holds the invoice lock (`group_split_busy`, "The weekly invoice is
  busy, try again."). Once a share invoice is
  `pending_acknowledgment` or later, or when it carries any Xero bill id
  or push stamp, the refusal is `group_split_has_live_invoice`. Draft and
  queried can still be stripped. On the way through, a recurring deduction
  that is larger than the reduced payable is cleared in that same money
  update, with the office note; a payable of 0 clears the note too; a
  deduction that still fits stays off gross. The global
  `RELEASED_INVOICE_STATUSES` list is a different lock and still includes
  `failed`.
- The share line matches the invoice owner. A second live line for the
  same share is `group_share_already_invoiced`. A line whose
  `group_share_id` is another person's share is
  `group_share_owner_mismatch`. Amounts match to the cent.
- The invoice-line trigger watches `INSERT OR UPDATE OF group_share_id,
  line_total_ex`. A job-work-order stamp that updates another column does
  not re-enter it. A non-draft share line locks the group row, requires a
  counting sign-off, and calls `write_split(true)` when the marker is
  null, in the same statement as the line. A failed insert rolls the
  freeze back. A draft line stores the share text and leaves the marker
  and the share id empty. An explicit freeze that then fails its invoice
  stays frozen. A later save or a submit replaces that draft's own lines
  in one transaction.
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
  threshold. A group freeze does not accept an office waiver or a revoked
  row: the signature is drawn, and its time is strictly after the latest
  hours on the job. That instant is the later of each remaining hour
  row's `created_at` and `updated_at`, and the group's
  `hours_changed_at` (insert, a real update, delete, and removing a
  participant). An identical re-save does not move it. The ordinary
  invoice gate still accepts
  `office_waiver` and refuses a newest `revoked` row. This check does
  not call that helper.
- Unfreeze removes only the share line and recalculates that invoice's
  totals from the lines that remain, the same split as a trade invoice.
  A weekly work order also rewrites its three headers: final-payout
  deductions stay a positive magnitude, to-be-paid is the remaining line
  sum, and the job grand is that sum plus those deductions. A recurring
  deduction stays on the payable and is not taken off gross, unless the
  reduced payable is below it. Then the deduction columns are cleared in
  that same update and the invoice carries the office note. A payable of
  0 clears the note. A deduction that still fits is left unchanged. It
  does not reject the trade's week. A weekly submit already holding the
  invoice lock is `group_split_busy` ("The weekly invoice is busy, try
  again."), which is not a live invoice. A share on
  `pending_acknowledgment` or later, and any Xero id or push stamp, are
  `group_split_has_live_invoice`. Draft and queried can still be stripped.
- Voiding stays permanent. A void group cannot be opened again. Void
  takes the weekly invoice lock, then the job lock, then the row, the
  same order as every other path. It does not lock the row before that.
- The down migration does not delete sign-off rows and does not disable
  the append-only trigger. The widened method check
  (`on_site`, `office_waiver`, `share_link`, `revoked`) stays.
- Break minutes come off finish minus start, the same rule as a trade
  invoice time entry.

## Actions

Trade JWT, while the switch is on. The caller is the signed-in user.

| Action | Result |
| --- | --- |
| `create_group_work_order` | Opens the group on `jobs.work_order_id`, or joins the caller. Refused when the job already has normal pay. No dollars. The public token is not on this card. |
| `join_group_work_order` | The caller must be allocated, unless they are staff. After freeze, `group_split_frozen`. |
| `sign_group_work_order` | Crew signature. PNG or JPEG data URL whose decoded bytes are between 3 and 150000 and match that format, or omitted. SVG is refused. Not the invoice gate. |
| `submit_group_work_order_hours` / `delete_group_work_order_hours` | Own hours, only before freeze, only on an assigned date. Saving the same day with the same times, break and hours does not move the row's `updated_at` or the group's `hours_changed_at`. |
| `group_work_order_my_share` | The closed object above. |
| `capture_group_client_signoff` | On-site client drawing. Records the trade user id. |
| `freeze_group_work_order` | Explicit freeze after every participant and every currently assigned installer has counting hours, and a drawn client sign-off is newer than the latest hours, including a delete or a participant removal. |
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
| `unfreeze_group_work_order` | gated | Clears the marker. Deletes only the share lines and recalculates those invoices, including weekly headers. A recurring deduction stays off gross. If the reduced payable is below the deduction, those columns are cleared in the same update and the invoice carries the office note; a payable of 0 clears the note; a deduction that still fits stays. A weekly lock already held is 409 `group_split_busy` ("The weekly invoice is busy, try again."), which is not `group_split_has_live_invoice`. Also refused from `pending_acknowledgment`, or when the invoice has a Xero id or push stamp. |
| `remove_group_work_order_participant` | open | Before freeze only. Deletes that person's hours and participant row, bumps `hours_changed_at`, and writes `remove_participant`. Does not cancel the job assignment. |
| `revoke_group_signoff` | open | Newest `revoked` row. Does not itself unfreeze. |
| `void_group_work_order` | open | Unfreeze first, then status `void`. A paid share blocks it. Leaving `void` is refused. |
| `rekey_group_work_order` | open | Points at the current approved sealed `jobs.work_order_id`, only while not frozen and not void. |

`generate_trade_invoice` is the only door for a share, and only while the
switch is on. A draft save stores the share line and does not freeze.
Once the split is frozen the server sets quantity 1, rate = that
person's frozen share, `source_work_order_id` null, `group_share_id`
set. A client amount that is not the snapshot is
`group_share_amount_mismatch`. The same invoice cannot mix the share
with pay for that job. Pay is every line except travel, materials,
equipment, an adjustment, a final-payout deduction, commission, and the
share.

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
- The completion-pack client email (`completion_pack_client_email_v1`)
  stays off. While it is off the pack is generated and nothing is emailed.
  The email text needs Marnin's okay before that flag is turned on.
- `Other` counting as pay on a group job is the safe default, pending Marnin.
- The master switch stays off until the owner turns it on.
- Withheld quote PDFs and the trade app's price-free extract are a different
  fence. This slice does not change them.
