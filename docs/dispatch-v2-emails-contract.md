# Dispatch v2: supplier order emails, draft list and split (contract)

Backend for Dispatch v2 slices 5 and 6. The ops screen's Dispatch tab uses it to:

- keep a **draft list** of materials on a job, typed in or suggested from the scope,
- **split** those lines into **supplier boxes** (move a line in, out, or between boxes),
- add **photos**, for example a handwritten list, under 3 MB each,
- **make** a held, editable supplier order email in the template,
- **send** it from `admin@secureworkswa.com.au` through Outlook, with one test copy to admin@ first.

Code: `supabase/functions/ops-api/dispatch_v2_emails.ts` (the rules), `dispatch_v2_store.ts` (the actions), `dispatch_v2_send.ts` (the Outlook sender). Tests: `dispatch_v2_emails_test.ts`, `dispatch_v2_store_test.ts`, and `send-outlook-email/outlook_capture_thread_ids_test.ts`.

Nothing here writes `jobs`, `suppliers` (including `suppliers.email`), `purchase_orders`, Xero, GHL, `job_events`, `business_events` or any SMS.

## How to call

Every action is an ops-api action. The action name goes in the query string: `.../functions/v1/ops-api?action=<name>`.

| | |
|---|---|
| Who | A staff session (admin, owner, ops_manager) or the privileged ops key. Installers, lead installers, the routine key and the agent-read key get 403 `operator_access_required`. None of these actions is on `AGENT_READ_ALLOWED_ACTIONS`, `LEAD_INSTALLER_READ_ACTIONS` or the routine allow-list. |
| Reads | `GET`, with the inputs in the query string. |
| Writes | `POST` with a JSON body. A write sent by `GET` gets 405. |
| Who did it | A staff session is stamped by its own email. With the ops key, pass `operator_email` in the body. `dispatch_v2_send_email` refuses 400 `operator_email_required` without one. |
| Org | Always the SecureWorks org (`00000000-0000-0000-0000-000000000001`). A job in another org is 404. |
| Make-safe jobs | Refused 409 `not_dispatch_work`. A repair job (by type or metadata family) counts as `repair`, whatever its stored type. |

### Errors

Every refusal is JSON with an HTTP status:

```json
{ "error": "This supplier has no approved order email, so Dispatch cannot send to it. Ask Shaun to add one.", "code": "no_approved_email" }
```

Some refusals carry more fields, named in the action below. Every write that edits an existing row needs the row's `expected_updated_at`. If the row changed since, the write is refused 409 (`line_changed`, `email_changed`), usually with the latest row, so the screen can reload.

## The approved supplier order email list

Shaun approved this table on 23 Oct 2026. The To and CC addresses live in the app, never in `suppliers.email`: the 06:55 Xero sync overwrites that column. Dispatch sends only to a supplier linked to an active approved entry.

## Actions

The three reads:

- `dispatch_v2_materials`
- `dispatch_v2_supplier_search`
- `dispatch_v2_photo_url`

The fourteen writes:

| Area | Actions |
|---|---|
| Lines | `dispatch_v2_save_line`, `dispatch_v2_move_line`, `dispatch_v2_delete_line`, `dispatch_v2_suggest_draft` |
| Supplier boxes | `dispatch_v2_add_supplier`, `dispatch_v2_remove_supplier`, `dispatch_v2_set_main_supplier` |
| Photos | `dispatch_v2_upload_photo`, `dispatch_v2_move_photo`, `dispatch_v2_delete_photo` |
| Emails | `dispatch_v2_make_email`, `dispatch_v2_save_email`, `dispatch_v2_discard_email`, `dispatch_v2_send_email` |

Only `dispatch_v2_send_email` sends anything, once per press.

### Shapes used below

**Line**

```json
{
  "id": "uuid",
  "supplier_id": "uuid or null (null = on the draft list)",
  "description": "1800H standard width panels with 2400H posts",
  "quantity": 14,
  "unit": null,
  "detail": "Gate: Pedestrian gate 1270mm",
  "profile": "Neetascreen",
  "colour": "Monument",
  "status": "not_reviewed | to_order | in_stock",
  "source": "manual | scope",
  "position": 3,
  "sent_on_email_id": null,
  "locked": false,
  "updated_at": "2026-10-23T02:00:01.000Z"
}
```

`locked` is true once the line went out on a sent order email, or if it is on a v1 purchase order. A locked line cannot be edited, moved or deleted (409 `line_locked`).

**Photo**

```json
{ "id": "uuid", "supplier_id": "uuid or null", "file_name": "Nithin-list.jpg", "content_type": "image/jpeg", "size_bytes": 812345, "added_at": "...", "added_by_email": "shaun@..." }
```

**Email**

```json
{
  "id": "uuid",
  "job_id": "uuid",
  "supplier_id": "uuid",
  "supplier_name": "Stratco (WA) Pty Ltd",
  "status": "draft | sending | sent | send_unknown | discarded",
  "from": "admin@secureworkswa.com.au",
  "to": ["tradewa@stratcowa.com.au"],
  "cc": ["tony.bacich@stratcowa.com.au", "fencing@secureworkswa.com.au"],
  "team_cc": "fencing@secureworkswa.com.au",
  "subject": "Material Order Ref SWF-261600",
  "body_text": "Hi Team, could we please order the following for delivery:\n\nDate: 4 November 2026\n...",
  "edited": false,
  "delivery_date": "2026-11-04",
  "is_main_supplier": true,
  "standing_lines_included": true,
  "line_count": 4,
  "photo_ids": ["uuid"],
  "empty_detail_lines": [],
  "test": { "sent_at": "...", "sent_to": "admin@secureworkswa.com.au", "sent_by_email": "shaun@..." },
  "sent": {
    "sent_at": "...",
    "sent_by_email": "shaun@...",
    "from": "admin@secureworkswa.com.au",
    "to": ["tradewa@stratcowa.com.au"],
    "cc": ["tony.bacich@stratcowa.com.au", "fencing@secureworkswa.com.au"],
    "internet_message_id": "<abc@...outlook.com>",
    "conversation_id": "AAQkAD..."
  },
  "last_error": null,
  "created_at": "...",
  "updated_at": "..."
}
```

Fields that need explaining:

- `test` and `sent` are null until they happen. A test send never fills `sent`.
- `edited` is true once the body differs from what the template built.
- `empty_detail_lines` lists the Date, Address and Contact lines left blank. While any is blank, the send is refused.
- `line_count` counts the standing lines too.
- If a send was claimed more than 2 minutes ago with no answer, the email reads as `send_unknown`.

### dispatch_v2_materials (GET)

Params: `job_id`. Returns the whole tab for one job.

```json
{
  "job_id": "uuid",
  "job_number": "SWF-261600",
  "work_type": "fencing",
  "team_cc": { "email": "fencing@secureworkswa.com.au", "open_question": null },
  "from": "admin@secureworkswa.com.au",
  "test_send_done": false,
  "main_supplier_id": "uuid of the Stratco box",
  "main_supplier_ticked": false,
  "can_suggest": false,
  "draft_list": { "lines": [Line], "photos": [Photo] },
  "suppliers": [
    {
      "supplier_id": "uuid",
      "name": "Stratco (WA) Pty Ltd",
      "active": true,
      "position": 1,
      "is_main": true,
      "approved_email": { "id": "uuid", "name": "Stratco", "used_for": "fencing+patio", "to": ["tradewa@stratcowa.com.au"], "cc": ["tony.bacich@stratcowa.com.au"] },
      "send_blocked": null,
      "lines": [Line],
      "photos": [Photo],
      "open_email": Email or null,
      "sent_emails": [Email]
    }
  ]
}
```

- `send_blocked` is set when the supplier has no approved order email: `{ "code": "no_approved_email", "message": "This supplier has no approved order email. Ask Shaun to add one before sending." }`. The screen should grey out Make email and Send now for that box.
- `test_send_done` is true once anyone has sent a test copy. Until then, every real send is refused.
- `can_suggest` is true for a fencing or patio job with no lines yet.

### dispatch_v2_supplier_search (GET)

Params:

| Param | Meaning |
|---|---|
| `q` | Optional name filter. |
| `limit` | Optional, 1 to 100. Default 25. Applies to `others` only. |

The approved list comes first, then every other active Xero supplier contact.

```json
{
  "q": "strat",
  "approved": [
    {
      "approved_id": "uuid", "approved_name": "Stratco", "used_for": "fencing+patio",
      "to": ["tradewa@stratcowa.com.au"], "cc": ["tony.bacich@stratcowa.com.au"],
      "has_approved_email": true,
      "supplier_id": "uuid", "name": "Stratco (WA) Pty Ltd", "can_add": true, "note": null
    }
  ],
  "others": [
    {
      "supplier_id": "uuid", "name": "Plain Hardware",
      "approved_id": null, "approved_name": null, "used_for": null, "to": [], "cc": [],
      "has_approved_email": false, "can_add": true,
      "note": "No approved order email: Dispatch will not send to this supplier"
    }
  ]
}
```

- An approved entry that has more than one Xero contact appears once per contact.
- An approved entry with no linked Xero contact appears with `supplier_id: null` and `can_add: false`. Mackson and Palram are like this today: see Open questions.
- A supplier linked only to a retired (inactive) entry appears in `others`.

### dispatch_v2_photo_url (GET)

Params: `job_id`, `photo_id`.

```json
{ "photo": Photo, "url": "https://...signed...", "expires_in_seconds": 600 }
```

### dispatch_v2_save_line (POST)

The body takes the job, the line, and `expected_updated_at` when editing:

```json
{
  "job_id": "uuid",
  "line": {
    "id": "uuid made by the screen",
    "supplier_id": "uuid or null",
    "description": "...",
    "quantity": 14,
    "unit": null,
    "detail": "...",
    "profile": "...",
    "colour": "...",
    "status": "to_order"
  },
  "expected_updated_at": "stamp, only when editing"
}
```

- With no `expected_updated_at`, the line is new. If that id already exists, it is a retried insert: you get back `{ "success": true, "unchanged": true, "line": Line }`, and never a second row.
- With `expected_updated_at`, it edits the line. Leave `supplier_id` out to keep the line in its box.
- `supplier_id: null` means the draft list. A box that is not on the job gives 409 `supplier_not_on_job`.

Field limits:

| Field | Limit |
|---|---|
| `description` | 1 to 300 characters |
| `detail` | up to 300 characters, several lines allowed |
| `profile`, `colour` | up to 80 characters |

Returns `{ "success": true, "line": Line }`.

Refusals:

| Status | Code |
|---|---|
| 400 | `invalid_request` |
| 409 | `line_locked`, `line_changed`, `line_not_on_job`, `supplier_not_on_job`, `too_many_lines` (500 per job) |

### dispatch_v2_move_line (POST)

Body: `{ "job_id", "id", "supplier_id": "uuid or null", "expected_updated_at" }`. Moves a line into a box, between boxes, or back to the draft list. The line goes to the end. Returns `{ "success": true, "line": Line }`, or `unchanged: true` if it was already there. Refusals as for save_line.

### dispatch_v2_delete_line (POST)

Body: `{ "job_id", "id", "expected_updated_at" }`. Returns `{ "success": true }`. A line that is already gone gives `unchanged: true`. A locked line is refused.

### dispatch_v2_suggest_draft (POST)

Body: `{ "job_id" }`. Fills the draft list from the job's scope. It works only on fencing and patio jobs that have no lines yet. These are never suggested, because they never go on supplier copy:

- concrete bags,
- concrete footings,
- tek screws,
- removal,
- labour,
- delivery.

The line ids are fixed by the job and the line's place, so a second press cannot add the lines twice.

Returns `{ "success": true, "added": 3, "lines": [Line] }`.

Refusals, all 409: `no_suggestion_for_work_type`, `lines_exist`, `scope_unreadable`.

### dispatch_v2_add_supplier (POST)

Body: `{ "job_id", "supplier_id" }`. Adds a supplier box.

```json
{
  "success": true,
  "supplier": {
    "supplier_id": "uuid", "name": "Plain Hardware", "position": 3,
    "approved_email": null,
    "send_blocked": { "code": "no_approved_email", "message": "This supplier has no approved order email. Ask Shaun to add one before sending." }
  }
}
```

A supplier with no approved email can still be added, so its lines can be split out. It cannot be sent to. A box already on the job gives `unchanged: true`.

Refusals: 404 `supplier_not_found`, 409 `supplier_inactive`.

### dispatch_v2_remove_supplier (POST)

Body: `{ "job_id", "supplier_id" }`. Returns `{ "success": true }`.

Refusals, both 409:

- `supplier_has_lines`: the box still has lines or photos. Move them out first.
- `supplier_has_emails`: the box has a held, sent or unknown email.

### dispatch_v2_set_main_supplier (POST)

Body: `{ "job_id", "supplier_id": "uuid or null" }`. Ticks the main supplier. `null` clears the tick, and the default applies again.

```json
{ "success": true, "main_supplier_id": "uuid", "main_supplier_ticked": true }
```

**The main supplier rule:**

1. The ticked box, if there is one.
2. Otherwise, the box holding the panels (a line naming panels, fence sheets or infill sheets).
3. Otherwise, the first box.

The fencing standing lines (`4 x bags of quickset`, then `Fixings, Post Caps and Screws as necessary`) go last on the main supplier's email only, and only on fencing jobs.

### dispatch_v2_upload_photo (POST)

Body: `{ "job_id", "supplier_id": "uuid or null", "file_name", "data_base64" }`. A `data:` prefix is allowed.

The screen should shrink the photo first. The server checks the real bytes:

- JPEG, PNG or WebP only;
- under 3,000,000 bytes (Outlook's attachment limit);
- 20 photos per job at most.

Returns `{ "success": true, "photo": Photo }`. The file goes to the private bucket `dispatch-material-photos`.

Refusals:

| Status | Code | Meaning |
|---|---|---|
| 413 | `photo_too_large` | Carries `size_bytes`. The message gives the size in MB and says to take a smaller photo. |
| 400 | `photo_type_not_allowed` | HEIC, PDF and any other kind. |
| 409 | `too_many_photos` | Over 20 on the job. |
| 409 | `supplier_not_on_job` | The box is not on the job. |

### dispatch_v2_move_photo / dispatch_v2_delete_photo (POST)

Move: `{ "job_id", "photo_id", "supplier_id": "uuid or null" }`, returns `{ "success": true, "photo": Photo }`.

Delete: `{ "job_id", "photo_id" }`, returns `{ "success": true }`.

A photo named on any email that is not discarded gives 409 `photo_on_email`. A photo that went out on a sent email is kept.

### dispatch_v2_make_email (POST)

Body: `{ "job_id", "supplier_id", "delivery_date": "YYYY-MM-DD or null", "rebuild": false }`.

Makes the held email for one box:

| Part | What goes in |
|---|---|
| Lines | The box's lines, except In stock lines, lines already sent, and lines on a v1 purchase order. |
| Body | The wiki template, below. |
| To | The approved entry's To. |
| CC | The approved entry's CC plus the team mailbox, without repeats. |
| Photos | The box's photos, three at most. |

The team mailbox depends on the job type:

| Job type | Team CC |
|---|---|
| fencing | fencing@ |
| patio | patios@ |
| repair | ses@, always |
| decking | patios@, flagged open |
| anything else | none, flagged open |

```json
{
  "success": true,
  "email": Email,
  "missing": ["date"],
  "team_cc_open_question": null
}
```

- `missing` lists the Date, Address and Contact lines that came out blank.
- `team_cc_open_question` is set for decking and other job types.
- If the box already has an open email, it comes back unchanged: `{ "success": true, "unchanged": true, "email": Email }`.
- `rebuild: true` on a held email rebuilds it from the lines and loses any edits. The answer then carries `rebuilt: true`.

Refusals:

| Status | Code |
|---|---|
| 409 | `no_approved_email`, `no_lines_to_order`, `supplier_not_on_job`, `email_changed` (on a rebuild) |
| 400 | `invalid_request` (a bad date) |

**The body** follows `secureworks-wiki` `harness/ops/agents/soybean-legacy-import/client-message-templates.md`, material order email, exactly:

```
Hi Team, could we please order the following for delivery:

Date: 4 November 2026
Address: 12 Example Street, Clarkson
Contact: 0400 000 000 (Jeremy)

Materials Needed:

1. 14 x 1800H standard width panels with 2400H posts
Profile: Neetascreen
Colour: Monument

2. 14 x 150mm standard width plinths
Colour: Monument

3. 4 x bags of quickset

4. Fixings, Post Caps and Screws as necessary


Please confirm when you can, thank you.
```

Rules for the body:

- The subject is `Material Order Ref <job number>`. The job number is not repeated in the body.
- There is no sign-off, and the Outlook signature is left off (`signature: none`).
- Long dashes become commas.
- A line reads `<qty>[ <unit>] x <description>`, then its detail lines, `Profile:` and `Colour:`.
- A blank Date, Address or Contact line stays as `Date:` so it is easy to see.

### dispatch_v2_save_email (POST)

Body: `{ "email_id", "expected_updated_at", "to"?, "cc"?, "subject"?, "body_text"?, "photo_ids"? }`. Saves edits to a held email.

| Field | Limit |
|---|---|
| `to` | 1 to 10 addresses |
| `cc` | 0 to 12 addresses |
| `subject` | up to 250 characters |
| `body_text` | up to 20,000 characters |
| `photo_ids` | up to 3, all on the job |

Addresses are lower-cased and duplicates removed. A bad address is refused, never dropped.

Returns `{ "success": true, "email": Email }`.

Refusals:

| Status | Code |
|---|---|
| 409 | `email_not_editable` (not held), `email_changed` (carries `email`), `photo_not_found` |
| 400 | `invalid_request` |

### dispatch_v2_discard_email (POST)

Body: `{ "email_id", "expected_updated_at" }`. Throws a held email away, so the box can be made again. Returns `{ "success": true }`.

Refusals, both 409:

- `email_not_discardable`: the email was sent, or it may have gone (`send_unknown`).
- `email_changed`.

### dispatch_v2_send_email (POST)

Body: `{ "email_id", "expected_updated_at", "test": false, "confirm_resend": false, "operator_email" (ops key only) }`.

Checks, in order. Each refusal happens before anything is sent:

1. The stamp still matches (409 `email_changed`).
2. The email is held. An unknown send needs `confirm_resend: true` (409 `send_unknown`). Anything else gives 409 `email_not_sendable`.
3. The supplier still has an active approved entry (409 `no_approved_email`).
4. The box's orderable lines are exactly the ones the email was made from (409 `order_lines_changed`: make the email again).
5. The Date, Address and Contact lines are filled in (409 `email_details_missing`, with `missing`).
6. The photos are on file and unchanged (409 `photo_not_found` or `photo_changed`).
7. There is an operator email (400 `operator_email_required`).

**Test mode (`test: true`).** It sends the same email to `admin@secureworkswa.com.au` only, with no CC:

- The subject is `TEST ONLY: Material Order Ref ...`.
- The body opens with `TEST ONLY. This copy went only to admin@secureworkswa.com.au.`, says where the real email would go, then a line of dashes, then the real body.

It records `test_sent_at`, `test_sent_to`, `test_sent_by_email`, `test_internet_message_id` and `test_conversation_id`, and nothing else. The email stays held and its stamp does not move, so the same `expected_updated_at` then sends it for real.

```json
{ "success": true, "test": true, "sent_to": "admin@secureworkswa.com.au", "recorded": true, "email": Email }
```

A failed test gives 502 `test_send_refused` or `test_send_unknown`.

**Real send.** It is refused 409 `test_send_first` until someone has sent a test copy (Shaun's rule: one test email to our own address before any supplier send). Then:

1. The email is claimed (`status: sending`), so only one press can send it.
2. ops-api posts to `send-outlook-email` from admin@ with `capture_thread_ids: true` and `signature: none`, and with no `job_id`, so it is not filed as a client email.
3. On success it records the `sent_*` columns, sets `status: sent`, and locks the lines that went (`job_material_lines.dispatch_order_email_id`).

```json
{ "success": true, "test": false, "recorded": true, "email": Email }
```

`recorded: false` means the email went but noting it on the order, or locking its lines, failed. The screen must say so and must not send again.

When the send does not go cleanly:

| Outcome | Status and code | What changes |
|---|---|---|
| Outlook refused before sending | 502 `send_refused` | The email goes back to held, with `last_error`. |
| We cannot tell whether it went | 502 `send_unknown` | The email is set to `send_unknown`. Any ids Outlook gave are kept in the `sent_*` id columns, so a reply can still be matched. Check admin@ Sent Items, then resend only with `confirm_resend: true`. |

## Tables and columns

### Migration 1: `supabase/migrations/20261023214100_dispatch_v2_emails_approved_supplier_store.sql`

**`dispatch_approved_supplier_emails`**: one row per approved supplier.

| Column | Meaning |
|---|---|
| `id`, `org_id` | Row id and org. |
| `name` | Unique per org. |
| `used_for` | `fencing`, `patio`, `fencing+patio` or `any`. |
| `to_emails` | text[], 1 to 10 addresses. |
| `cc_emails` | text[], up to 10 addresses. |
| `active` | Only active entries are used. |
| `approved_by`, `approved_on` | Who approved it, and when. |
| `created_at`, `updated_at` | Timestamps. |

**`dispatch_approved_supplier_email_links`**: one row per Xero supplier contact, linked to one approved entry.

| Column | Meaning |
|---|---|
| `supplier_id` | Primary key; references `suppliers`. |
| `approved_id` | The approved entry. |
| `org_id`, `created_at`, `created_by_email` | Org and audit. |

The migration seeds 26 approved entries (approved_by Shaun, 23 Oct 2026) and 42 links: the 34 known Xero contacts plus 8 more Bunnings contacts. A link is made only where the `suppliers` row exists in the org, and every insert is `ON CONFLICT DO NOTHING`.

### Migration 2: `supabase/migrations/20261023214200_dispatch_v2_emails_draft_list_and_order_emails.sql`

**`dispatch_supplier_order_emails`**: one row per supplier order email. The columns the reply matcher reads:

| Column | Meaning |
|---|---|
| `sent_conversation_id` | Outlook's thread id. Mail capture stores the same value as `business_events` `payload.conversation_id` and `thread_key` `'outlook:<id>'`. **Match on this first.** |
| `sent_internet_message_id` | The Message-ID header. Replies quote it in In-Reply-To or References. **Match on this second.** |
| `sent_graph_message_id` | The Graph id when the message was made. Outlook may re-id the Sent Items copy: do not match on it. |
| `sent_at`, `sent_by`, `sent_by_email`, `sent_from_mailbox`, `sent_to_emails`, `sent_cc_emails` | When it went, who sent it, the mailbox, and the exact addresses. |
| `test_*` | The test copy only. **Never an order**: the matcher must ignore `test_conversation_id`. |

The other columns:

| Columns | Meaning |
|---|---|
| `job_id`, `supplier_id`, `supplier_name`, `approved_email_id` | Which job and supplier, and the approved entry the addresses came from. |
| `work_type`, `is_main_supplier`, `standing_lines_included` | How the email was built. |
| `status` | `draft`, `sending`, `sent`, `send_unknown` or `discarded`. |
| `team_cc_email`, `to_emails`, `cc_emails`, `subject`, `body_text`, `built_body_text` | The email itself; `built_body_text` is the template's version, before edits. |
| `delivery_date`, `order_lines` | The date, and the lines the email was built from: `[{ line_id, updated_at, text, standing }]`. |
| `photo_ids` | Up to 3. |
| `send_claimed_at`, `last_error` | Send bookkeeping. |
| `created_*`, `updated_at`, `updated_by_email` | Audit. |

Keys and indexes on `dispatch_supplier_order_emails`:

| Index | Purpose |
|---|---|
| `dispatch_supplier_order_emails_one_open_idx` | One open (draft, sending, send_unknown) email per box. |
| `dispatch_supplier_order_emails_conversation_idx` | Partial index on `sent_conversation_id`. |
| `dispatch_supplier_order_emails_message_id_idx` | Partial index on `sent_internet_message_id`. |

The migration also changes two existing tables:

**`job_material_lines`**

- `supplier_id` may now be NULL, meaning the draft list.
- New columns: `detail` (up to 300 characters), `profile` (up to 80), `colour` (up to 80).
- New column `dispatch_order_email_id`, which references `dispatch_supplier_order_emails` and is set null if that row goes. Set means the line went out and is locked.

**`job_material_suppliers`**

- New column `is_main_supplier`.
- Unique index `job_material_suppliers_one_main_idx`: at most one tick per job.

**`dispatch_material_photos`**

| Column | Meaning |
|---|---|
| `id`, `org_id`, `job_id` | Row, org and job. |
| `supplier_id` | Null = the draft list. A composite key `(job_id, supplier_id)` points to `job_material_suppliers`. |
| `file_name`, `content_type`, `size_bytes` | jpeg, png or webp; 1 to 3,000,000 bytes. |
| `storage_path` | Unique. |
| `sha256` | Checked before a photo is attached. |
| `created_*` | Audit. |

The private bucket `dispatch-material-photos` (3,000,000-byte limit, images only) is created by the migration. The migration fails if the bucket exists and is public.

For all four new tables, row security is on with no policy, the browser roles are revoked, and only service_role is granted. Only ops-api reaches them.

### Rollbacks

- `supabase/rollbacks/20261023214100_dispatch_v2_emails_approved_supplier_store_down.sql`
- `supabase/rollbacks/20261023214200_dispatch_v2_emails_draft_list_and_order_emails_down.sql`. This one deletes draft-list lines (supplier NULL) before putting NOT NULL back.

### Deploy gate

`scripts/edge-function-schema-requirements.txt` names both migrations' tables, the sent id columns, the new line and box columns, and the two unique indexes. ops-api cannot deploy until both migrations are applied. All 17 actions are in `scripts/_ops-api-required-actions.txt` as `probe=source-only`, so no smoke run calls them against production.

## send-outlook-email change

New opt-in flag: `capture_thread_ids: true`. Without it, the function behaves exactly as before (one `sendMail`, which returns no ids). With it, the function:

1. creates a draft in the mailbox, which gives the `id`, `internetMessageId` and `conversationId`;
2. adds the attachments one at a time;
3. sends the draft.

The 202 answer then also carries `graph_message_id`, `internet_message_id` and `conversation_id`.

If it fails:

| Stage | What happens |
|---|---|
| Draft not made | Nothing went. The answer says not sent. |
| Attachments failed | The draft is deleted (best effort). The answer says not sent, `retry_safe: true`. |
| Send failed | The answer says not sent, or unknown on a timeout. It carries the ids. |

## v1 is left as it was

The v1 actions still work unchanged:

- `dispatch_materials`, `dispatch_materials_*`
- `dispatch_order_*` (purchase order, PDF, and the Resend send from orders@)
- `dispatch_email_link_po`

The v2 screen does not call them. Why v1's Resend send is kept but unused:

- v1 has never sent a real order (0 rows).
- Removing it would break old screens and its tests.
- Shaun chose option B: send from admin@ through Outlook, with the app-kept addresses, so replies land in a watched mailbox and the thread ids are captured.

Retiring v1 is a later, separate change.

Two v1 interactions to know about:

- v1's `dispatch_materials` read lists v2 draft-list lines, with a null `supplier_id`.
- v1's pipeline `dispatch=1` counts draft-list lines among a job's materials lines.

## Not done or not decided

- **Decking team CC.** Decking copies patios@ for now, and every decking email says it is open. Other job types (miscellaneous, insurance that is not a repair) get no team CC and say so. Shaun to rule.
- **Mackson and Palram** are approved but not linked to a Xero contact, so they show `can_add: false`. To link them, add rows to `dispatch_approved_supplier_email_links`. The candidates are:
  - Mackson: `d08cc885-7b45-4411-9d6d-13a5d13ae143` or `20d06d01-dab9-4493-a7d8-c2dcda4f3274` (which one is Shaun's call);
  - Palram: `8f1d2d75-6905-4e02-b266-88a48c628e83`.
- **Signature.** Order emails go with no Outlook signature, because the template has no sign-off. Say if the company card should go on.
- **One open email per box.** A second order to the same supplier on the same job waits until the first is sent or discarded.
- **Ids not checked against live Outlook.** That the draft gives `internetMessageId` and `conversationId` before sending is from Graph's documentation; it has not been tried against live Outlook (no sends from this build). The first test send will show it. `graph_message_id` may change in Sent Items: match on the conversation id or the Message-ID.
- **Records written per send.** send-outlook-email also writes its usual `email_events` log row for each send. No `job_events` or `po_communications` row is written for a v2 send. The job's Emails panel shows the order only when admin@ mail capture picks it up.
- **Deploy order.** send-outlook-email must deploy before, or with, ops-api for the ids to come back. With an old send-outlook-email, the send still works and counts as sent, but the ids are null.
- **Request body size.** The edge function's limit for a 3 MB photo upload (about 4 MB as base64) has not been tested live.
- **Migration contracts.** No Postgres contract case was written for either migration: there is no Postgres on this machine to run one, and an unrun case could break CI. The migrations have not been applied anywhere. They auto-apply on merge to main.
- **The reply matcher** (sibling worktree `be-dispatch-suggested-moves`) should read `sent_conversation_id`, then `sent_internet_message_id`, as above.
