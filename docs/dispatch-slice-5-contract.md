# Dispatch slice 5: a purchase order and its email, back-end contract

What `ops-api` gives the Ops screen's Dispatch tab (and the terminal) to turn one
supplier's To order lines into a purchase order, its PDF and a held email; to
read, change, send or discard that email; to reply to the supplier; to link a
stray supplier email to an order; and to read the job's order and client email
as threads. Two reads and nine writes, plus five more fields on slice 4's
`dispatch_materials` read.

Code: `supabase/functions/ops-api/dispatch_orders.ts` (the rules, pure:
which lines, the order line shape, the draft text, the draft hash, the address
check, the chip, the threads), `dispatch_order_pdf.ts` (the PDF),
`dispatch_order_send.ts` (the email as Resend gets it, and what Resend's answer
means; the transport is passed in), `dispatch_orders_store.ts` (the reads and
writes), the action switch in `index.ts`. Migration:
`supabase/migrations/20261014150000_dispatch_purchase_orders.sql` (rollback
`supabase/rollbacks/20261014150000_dispatch_purchase_orders_down.sql`, contract
case `supabase/tests/migration-contracts/20261014150000_dispatch_purchase_orders/`).
Tests, by outcome (ruling R46): `dispatch_order_pdf_test.ts` (what the
supplier reads on the PDF), `dispatch_orders_store_test.ts` (every read and
write end to end, the send stubbed), `purchase_order_attribution_test.ts` and
`receive-po-email/po_email_tag_test.ts` (the fixes), all in the "Test the Dispatch list and job notes reads" step of
`.github/workflows/pr-check.yml`. Recorded answers (made-up job, supplier and
addresses): `docs/dispatch-slice-5-recorded-answers.json`.

An email goes to a supplier only from `dispatch_order_send` or
`dispatch_order_reply`, each on a person's press (or the ops key naming the
person who gave the yes). Nothing is pushed to Xero. No job status, Dispatch
stage, booking or calendar entry moves. No business event, no `jarvis_event_log`
row, no paid AI read.

## 1. The records

**`purchase_orders`** gains nine nullable columns, so the live orders,
`create_po` and `list_pos` (`select *`) are untouched:

| Column | Meaning |
|---|---|
| `supplier_id` | the `suppliers` contact (Dispatch orders only) |
| `source` | `'dispatch'` or null (check) |
| `created_by_email` | the person who made the order; `created_by` holds a `users.id` or null, never an email |
| `pdf_path`, `pdf_sha256`, `pdf_version`, `pdf_rendered_at` | the newest PDF |
| `last_sent_pdf_version`, `last_sent_at` | the version and time of the last email sent |

Two indexes: unique `(org_id, po_number)`; and unique `(job_id, supplier_id)`
where `source = 'dispatch'`, status not cancelled or deleted, and not in Xero
(one open Dispatch order per job and supplier). `job_material_lines` gains an
index on `purchase_order_id` (this slice is its first writer). A Dispatch order is made with
`status 'draft'`, `po_type 'material'`, `subtotal`, `tax`, `total` 0,
`reference` the job number, and goes to `sent` on its first send.

**Numbers**: `po_number_seq` is moved to 1,000,000 (never backwards), and
`dispatch_next_po_number()` answers `PO-1000001` on. A number once taken is never
reused, even when its create fails.

**`job_order_emails`**: one row per held email until it is sent or discarded,
with the columns in the build note's section 3.4 plus five:

- `order_lines` (jsonb): the order lines this draft's PDF holds, so an update
  email can say which lines were added or taken off since the last one sent;
- `sent_via`: `screen` (a signed-in person pressed Send) or `terminal` (the ops
  key, naming the person in `operator_email`);
- `attempt_to_email`, `attempt_in_reply_to`: the address and threading header
  the current send attempt carries, fixed when it is first claimed (section 5);
- `send_attempt` (default 1): raised only after Resend refused an attempt.

`status`: `draft`, `sending`, `sent`, `send_unknown`, `discarded`. At most one
open (`draft`, `sending`, `send_unknown`) per order. Row security on, no policy,
revoked from `anon` and `authenticated`.

**Three transactions**, service role only, each refusing by the message of a
`P0001` (ops-api maps each to a 409 of the same code):

- `dispatch_commit_order(p jsonb)`: inserts the order, stamps each line's
  `purchase_order_id` only where its `updated_at` is the one the caller read and
  it is still To order on no order, refuses if any To order line under the
  supplier is left behind, inserts the draft and one `job_events` row
  `po_created` (`{po_number, supplier, total: 0, source: 'dispatch',
  operator_email}`). Refuses `lines_changed`, `order_open`, `no_lines_to_order`.
- `dispatch_commit_order_update(p jsonb)`, `mode` `update` or `cancel`: locks
  the order row, then its drafts, before any check, so a send claim cannot slip
  in between; guarded on the order's `updated_at` (`order_changed`) and every
  touched line's (`lines_changed`); refuses `draft_sending` while the order's
  email is sending or not confirmed, and `draft_changed` when the open draft
  moved. Update rewrites `line_items` and the PDF columns, stamps added lines,
  releases taken off lines to To order, then refreshes the open draft or
  inserts one. Cancel sets `cancelled` (only when never sent and not in Xero;
  a `sent` draft counts as sent even when the order's sent stamp did not land,
  refused `order_sent`), releases every line, discards the open draft and
  writes one `job_events` row `po_cancelled`.
- `dispatch_release_unknown_send(p jsonb)`: locks the draft, refuses
  `draft_not_unknown` unless it is `sending` or `send_unknown` and
  `draft_changed` unless its status and `updated_at` are the ones the caller
  read, then releases it to `draft` and inserts its `po_email_send_released`
  `job_events` row in the same transaction. If the audit row cannot be written
  nothing is released: the draft stays locked as it was and the person's retry
  works. Refuses `operator_required` with no person named.

**Storage**: private bucket `dispatch-order-pdfs` (PDF only, 10 MB), path
`<job_id>/<po_number>-v<version>.pdf`. Every version is kept. When that path is
already taken (two updates at once, or a failed commit's file), the new file is
written beside it with a short suffix rather than over it; the commit decides
which file the order names and the loser's own file is removed.

## 2. Who may call

All eleven through `_opsApiCallerIsStaffOperator`, gated in the switch exactly as
slice 4: a staff session (admin, owner, ops manager) or the privileged ops key.
Refused to the routine key, a trade session and a division manager; on neither
`ROUTINE_ALLOWED_ACTIONS` nor `AGENT_READ_ALLOWED_ACTIONS`. The nine writes
need POST (405 otherwise).

The two sending actions also need a named person: the session's user, or, for
the ops key, an `operator_email` that matches a `users` row in the organisation
(case does not matter); else 400 `operator_required`. On a terminal send
`sent_by` is null, `sent_by_email` names the person, `sent_via` is `terminal`,
and the `email_events` metadata and the `po_email_sent` job event carry
`via: 'terminal'`. Desk rule: an agent sends only after an explicit yes from
Shaun (or the person named) for that supplier, address and order.

Every refusal answers `{ error, code, ... }`.

## 3. The reads

### `GET dispatch_order_emails&job_id=<uuid>`

400 missing or malformed; 404 not in the organisation; 409 `not_dispatch_work`
for a make-safe job. Writes nothing; calls nothing outside.

```
{ job_id, job_number,
  drafts: [ { id, purchase_order_id, po_number, supplier_id, supplier_name, kind,
              status, to: { email, state }, subject, body_text, body_edited,
              order_changed_since_edit, pdf: { version, file_name, line_count },
              draft_hash, last_error, created_at, updated_at } ],
  threads: [ { key, tag, po_id, po_number, subject, counterpart, last_at,
               last_preview, can_reply, can_link,
               messages: [ { id, direction, from_email, to_email, subject, text,
                             at, attachments: [ { file_name } ],
                             delivery_status } ] } ],
  orders_for_link: [ { id, po_number, supplier_name } ],
  threads_status: 'ok' | 'failed' }
```

- `drafts`: open drafts, newest first. A `sending` claim older than two minutes
  shows as `send_unknown`. `to` is worked out on every read from the supplier
  contact (a `sending` or `send_unknown` draft shows the address its attempt
  carried, section 5): `missing` (no email), `malformed` (not one address), `not_supplier`
  (our own domains, `example.com/.org/.net`, or `test@`), else `ok`.
  `body_edited`: the stored message is not the one the server last wrote.
  `order_changed_since_edit`: edited, and the message the server would now write
  for the draft's lines differs from the one it wrote before the edit.
- `threads`: the job's `po_communications` rows of type `purchase_order` (by job,
  or on one of the job's orders) and `client` (by job); council rows are left
  out. Never capped (logged over 500). Rows sharing a `thread_id` are one
  thread, and a supplier row also joins every supplier row on the same order
  (section 6, item 1). `key` is `th-<oldest message id>`, stable as messages
  arrive. Newest thread first, messages oldest first. `text` is `body_text`,
  else `body_html` as plain text. `last_preview` is the first 140 characters.
  `counterpart`: the order's supplier name, else the other address; `Client` on
  a client thread. `can_reply`: a supplier thread whose newest inbound sender
  passes the address check. `can_link`: a supplier thread with no order.
- `orders_for_link`: the job's orders that are not cancelled.
- A failed drafts, orders or contacts read is a 500. A failed
  `po_communications` read answers `threads_status: 'failed'` and no `threads`,
  with the drafts.

### `GET dispatch_order_pdf&purchase_order_id=<uuid>[&version=<n>]`

404 for an order not in the organisation, a job not in it, an order with no PDF
(every order made outside Dispatch), or a version that does not exist. One
`createSignedUrl` on the private bucket, nothing written:
`{ url, file_name: '<po_number>.pdf', version, expires_in: 300 }`.

### `dispatch_materials` (slice 4), extended

- `orders[]` gains `updated_at`, `supplier_id`, `source`, `pdf_version`,
  `last_sent_pdf_version`, `last_sent_at`, `in_xero`, and each Dispatch order line
  its `line_id`. `xero_po_id` is read only for `in_xero` and never passed on. An
  order with no `supplier_id` or no `source` was made outside Dispatch: it stays
  in "Orders on this job".
- Each chosen supplier gains `order`: the newest Dispatch order for it on the job
  that is not cancelled, as `{ id, po_number, status, updated_at, chip: { state, text, tone,
  in_xero }, in_xero, pdf_version, last_sent_pdf_version, last_sent_at }`, or
  null. The chip is `dispatchOrderChip` (the note's section 4.2): Not ordered;
  Send not confirmed; Draft email ready; Not sent; Changed, not sent; Replied
  dd/mm; Sent dd/mm; then `· In Xero`.
- Each line on an order gains `po_number`.
- When the job has a Dispatch order, two more reads: its open drafts (id, status,
  time) and its order emails' direction and time (never a body). If the orders
  read or either of these fails: `orders_status: 'failed'` and no `order` key on
  any supplier, never "Not ordered" by mistake.

## 4. The writes

Every answer that changes lines carries `lines` (the supplier's lines in the read
shape) and `counts` (by slice 4's one rule, or null when that read fails).

| Action | Body | Refusals (in order) |
|---|---|---|
| `dispatch_order_create` | `{ job_id, supplier_id, lines: [ { id, updated_at } ] }` (the To order lines shown) | 404 job, `supplier_not_found`; 409 `not_dispatch_work`, `supplier_not_on_job`, `order_open` (an open Dispatch order not in Xero), `no_lines_to_order`, `lines_changed` (with the current lines) |
| `dispatch_order_update` | `{ job_id, purchase_order_id, expected_order_updated_at, lines: [ { id, updated_at } ], remove_line_ids: [] }` | 404; 409 `not_dispatch_order`, `order_cancelled`, `order_in_xero`, `order_changed`, `draft_sending`, `lines_changed`, `order_would_be_empty` |
| `dispatch_order_cancel` | `{ job_id, purchase_order_id, expected_order_updated_at }` | 404; 409 `not_dispatch_order`, `order_cancelled`, `order_sent`, `order_in_xero`, `order_changed`, `draft_sending` |
| `dispatch_order_draft_save` | `{ draft_id, subject?, body_text?, expected_updated_at }` | 400 lengths (subject 1 to 300 after trim, message 1 to 20,000 and not blank); 409 `draft_not_editable`, `draft_changed` (with the stored draft) |
| `dispatch_order_discard` | `{ draft_id, expected_updated_at }` | 409 `draft_not_editable`, `draft_changed` |
| `dispatch_order_release_unknown` | `{ draft_id, expected_updated_at, operator_email? }` | 409 `draft_not_unknown`, `draft_changed`; 400 `operator_required` |
| `dispatch_order_send` | `{ draft_id, expected_draft_hash, operator_email? }` | section 5 |
| `dispatch_order_reply` | `{ job_id, thread_key, reply_to_message_id, body_text, operator_email? }` | section 5 |
| `dispatch_email_link_po` | `{ job_id, thread_key, purchase_order_id }` | 404 `thread_not_found`; 409 `thread_not_supplier`, `thread_has_order`, `order_not_on_job` |

**Create** reserves a number, renders the PDF (version 1, the order's lines in
slice 4's position order, `{ line_id, description, quantity, unit }`, no
price), uploads it, then commits. If the commit fails the file is removed (best
effort) and the number is spent. Answer `{ success, order, draft, lines, counts }`
(`order` in the supplier `order` shape).

A line with no quantity is never given one: the email's line text reads
`<description> (quantity to confirm)` and the PDF's quantity column prints
"To confirm" (Sales SQ-29, 20 Oct 2026).

**Update**: the new line set is the lines on the order, less
`remove_line_ids`, plus every To order line on no order under the same supplier
(`lines` must match that set). Nothing to change answers `unchanged: true` and
writes nothing. Else it renders version n+1 (the order's first date kept), and
commits: an open draft is pointed at the new PDF and, when its message is
unedited, rewritten (`body_kept: true` when the person's message was kept); with
no open draft a new one is made, `kind 'update'` when the order was sent before.
No job event. Take off is this action with that line in `remove_line_ids`.

**Discard** drops the email only; the order and its lines stay. **Link** sets
`po_id` on every message in that thread that has this job, type
`purchase_order` and no order; no event row.

## 5. Sending

**The draft hash** is `sha256` of the JSON
`{ draft_id, purchase_order_id, to_email, subject, body_text, pdf_sha256 }` in
that key order, `to_email` the contact's address when its state is `ok`, else
null. The screen echoes the hash it last read.

**`dispatch_order_send`**, in this order, nothing sent before step 4:

1. 404; 409 `draft_not_sendable` unless the draft is `draft`, `send_unknown`
   (a person's retry) or a `sending` claim older than two minutes; 409
   `draft_changed` when the hash differs (with the current draft);
   409 `supplier_email_missing`, `supplier_email_not_supplier`,
   `supplier_email_malformed`; 409 `order_cancelled`; 400 `operator_required`.
2. The claim: `status` to `sending` only where status and `updated_at` are the
   ones read. Two presses, tabs or terminals: one gets through, the other 409
   `draft_not_sendable`. The order is then read again; if a cancel landed
   before the claim, the draft goes back to its prior status and the answer is
   409 `order_cancelled`, nothing sent.
3. The PDF bytes are read back and checked against `pdf_sha256`; a mismatch puts
   the draft back with `last_error` and answers 409 `pdf_changed`.
4. One POST to Resend: from `SecureWorks Group <orders@secureworksgroup.app>`,
   to the one contact address, `reply_to`
   `orders+<po_number>-<job_number>@secureworksgroup.app`, the subject, HTML
   (the reference banner, the message as paragraphs, the signature with the
   order and job) and the plain text, `<po_number>.pdf` attached,
   `Idempotency-Key: dispatch-draft-<draft_id>` (`-a<n>` added from the second
   attempt). No CC, no BCC. On an update, `In-Reply-To` and `References` carry
   the supplier's newest reply's Message-ID when one is on record (section 6,
   item 2). A first attempt fixes its address and that header on the claim
   (`attempt_to_email`, `attempt_in_reply_to`); a retry after an unknown result
   reuses exactly those, and the read shows that draft's `to` as the attempted
   address, so a reply landing or the contact changing in between cannot change
   the request under the same key.
5. 2xx: a `po_communications` row (outbound, `purchase_order`, the order and
   job, `message_id` the Resend id, `thread_id` the order's existing thread or
   that id, `attachments_json` naming the bucket, path and sha256); an
   `email_events` row (`email_type 'po'`, metadata `{po_number, supplier_id,
   draft_id, communication_id, source: 'dispatch', via, sent_by_email}`); a
   `job_events` row `po_email_sent` in `send-po-email`'s shape plus `draft_id`,
   `operator_email`, `via`; the draft to `sent`; the order's `last_sent_*` and
   `sent` if it was `draft`. Each write reads its error; if one fails the email
   still went: the answer is `success: true, filed: false`.
6. Any other 4xx except 409: refused, nothing went on this call. On a first
   attempt the draft goes back to `draft` with `last_error`, its attempt fields
   cleared and `send_attempt` raised, so the corrected send goes under a new
   key; 502 `send_refused` with the reason. On a retry of a `send_unknown` or
   stale `sending` draft the refusal says nothing about the earlier attempt,
   which may still have gone: the draft goes back to `send_unknown` with
   `last_error`, its attempt fields and `send_attempt` unchanged (the next
   retry uses the same key); 502 `send_unknown`.
7. 5xx, 409, a timeout (20 seconds) or a network failure: it may have gone.
   Draft to `send_unknown`; 502 `send_unknown`. Never sent again on its own. A
   person's retry repeats the same call with the same key and the same payload.
8. **Releasing a send that was not confirmed** is `dispatch_order_release_unknown`,
   only on a person's press after they checked the thread and the supplier's
   mailbox and found it did not go. It takes a `send_unknown` draft, or a
   `sending` claim older than two minutes, back to `draft`: attempt fields
   cleared, `send_attempt` raised (the next send goes under a new key),
   `last_error` naming the person. It sends nothing, and nothing releases a
   draft on its own. One `job_events` row `po_email_send_released` records who
   (`user_id`, `operator_email`, `via`) and when (`released_at`), with the draft,
   the order and the attempt released, written in the same transaction as the
   release (`dispatch_release_unknown_send`), so a draft is never released
   without its record. The person is resolved as for a send. The
   draft is then editable, discardable and sendable again, and the order can be
   updated or cancelled.

**Resend's idempotency, confirmed** in its documentation
(`resend.com/docs/dashboard/emails/idempotency-keys`, read 14 Oct 2026): a key
of 1 to 256 characters is kept 24 hours; a repeat with the same key and payload
answers the first answer and sends nothing; the same key with a different payload
is 409 `invalid_idempotent_request`; a repeat while the first is running is 409
`concurrent_idempotent_requests`. Both 409s are therefore "not confirmed", never
"refused". A retry's payload is built only from the stored draft and the
fixed attempt fields (subject and message cannot change outside `draft`, the
PDF is checked by its sha256), so a retry is the same request.

**Limit, stated plainly: this is not exactly-once for ever.** Resend keeps a
key 24 hours. A person who presses "Try the send again" more than 24 hours after
an unknown result may send a second copy if the first did go. The claim stops
two presses at once and nothing ever retries on its own; past 24 hours the guard
is the person checking the thread (and the supplier's mailbox) before pressing.

**`dispatch_order_reply`**: the same rules and writes with these differences.
The recipient is the sender of the newest inbound message on the thread, which
must pass the address check; 409 `thread_changed` when `reply_to_message_id`
(a `po_communications` id) is not the newest message; 409 `thread_not_supplier`
on a client thread. Subject `Re: <thread subject>`. `In-Reply-To` is that
message's Message-ID when it has one. No PDF, no draft row. `reply_to` is the
tagged address of the thread's order, or the plain orders address when the
thread has none. Key `dispatch-reply-<reply_to_message_id>-<sha256 of the
text>`; before sending, an `email_events` row carrying that key means the reply
already went and answers `unchanged: true` without a send.

**Never, on any send**: a Xero push; a change to `jobs`, the Dispatch stage, a
booking or a work order; a `business_events` row; a call to `reporting-api`,
`ghl-proxy` or `send-po-email`; more than one address.

## 6. Where this differs from the build note, and why

1. **Threads also group by order.** Our sent message is filed under the Resend
   id (a UUID), while a supplier's reply carries the real Message-ID headers, so
   `receive-po-email` cannot match its `In-Reply-To` to our row and their
   `thread_id`s rarely meet. So supplier rows on the same order join one thread
   as well as rows sharing a `thread_id`. On the live proof jobs this gives the
   same counts as the note (P27: one supplier thread of 2 messages; both rows
   have no `thread_id` and share the order).
2. **`In-Reply-To` only from a real Message-ID.** Resend makes the Message-ID
   itself and its send answer gives only its own id, which is not one. An update
   email therefore threads to the supplier's newest reply when one is on record,
   and carries no `In-Reply-To` otherwise.
3. **A send can be retried from `send_unknown`**, which the note's step 1 would
   refuse; its row 26 asks for exactly that retry. A `sending` claim with no
   answer for two minutes (a worker that died) is treated the same way.
4. **Update and cancel refuse `draft_sending`** while the order's email is
   sending or not confirmed: it may have gone, so the order must not change
   under it or be cancelled, until a person releases it (section 5, item 8).
5. **Five extra draft columns**, `order_lines`, `sent_via`, `attempt_to_email`,
   `attempt_in_reply_to` and `send_attempt` (section 1).
6. **`create_po`'s fix** writes `created_by` from the verified session only
   (`authMode === 'jwt'`); a key caller's `operator_email` goes to
   `created_by_email`.
7. **A Dispatch reply moves nothing** in `analyseSupplierQuote`: the status,
   confirmed delivery date and invoice-received writes are skipped, and with the
   status the `po_confirmed` job event that announces it. The classification on
   the message and every review annotation stay.

## 7. Fixes to existing code (named in the PR)

1. `createPO` (`create_po`): `created_by` is the signed-in user's id or null,
   never an email (`purchase_order_attribution.ts`). Every `create_po` from the
   signed-in Ops screen used to be refused by the database. The same pattern in
   `createWorkOrder` is not this slice's and is left.
2. `receive-po-email`'s tag parser (`po_email_tag.ts`): a job number is `SW`,
   one to three letters, an optional hyphen and digits, so a repair tag
   (`PO-1000001-SWR-261499`) parses; the subject fallback reads `PO-?\d{3,}`.
3. `analyseSupplierQuote`: section 6, item 7.
4. Slice 4's `dispatch_materials_remove_supplier`: 409 `supplier_has_orders`
   while the supplier has an order on the job that is not cancelled.
5. `updateJobStatus`'s acceptance push of draft orders to Xero runs only on a
   real move into `accepted`: `accepted` -> `accepted` (a re-save) pushes
   nothing, while a move from another status (for example `scheduled` ->
   `accepted`) still pushes non-Dispatch draft orders. It reads
   `source IS NULL`, so a Dispatch order never auto-pushes: it stays draft
   until its email goes (for good when the supplier has no address), never
   reaches Xero and never shows as in Xero. The crew work order
   auto-approval beside it is unchanged.

`send-po-email` and `update_supplier_email` are unchanged and never called.
Known defects there, for separate work: `send-po-email` accepts only a server
key, finds an address by name with `ilike(...).maybeSingle()` (errors on
duplicate names, wildcards in `%`/`_`), and files a `dry_run` as sent.

## 8. Deploy order

Apply `20261014150000_dispatch_purchase_orders.sql` before the matching
`ops-api` (the schema gate in `scripts/edge-function-schema-requirements.txt`
holds it). `receive-po-email` deploys from the same merge with the tag fix; it
reads no new column.
