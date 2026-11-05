# Dispatch v2: supplier order emails, draft list and split (contract)

Backend for Dispatch v2 slices 5 and 6. The ops screen's Dispatch tab uses it to:

- keep a **draft list** of materials on a job, typed in or suggested from the scope,
- **split** those lines into **supplier boxes** (move a line in, out, or between boxes),
- add **photos**, for example a handwritten list, under 3 MB each,
- **make** a held, editable supplier order email in the template,
- **send** it from `admin@secureworkswa.com.au` through Outlook. A test copy to admin@ is optional.

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
  "fulfilment": "delivery | pickup",
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
- `empty_detail_lines` lists the Date, Address and Contact lines left blank. While any is blank, the send is refused. A pickup has neither an Address nor a Contact line (Tweak 6), so only its Date can be blank.
- `line_count` counts the standing lines too.
- `fulfilment` is `pickup` when the body's first non-empty line mentions pickup, pick up, pick-up, collect or collection, else `delivery`. It is read from the body every time, so a hand edit to the opening line counts (see "Delivery or pickup" below).
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
  "auto_fill": false,
  "scope_filled": { "filled_at": "2026-10-26T03:00:00Z", "auto": true, "by": "shaun@secureworkswa.com.au" },
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
      "sent_emails": [Email],
      "fulfilment": "delivery | pickup | null"
    }
  ]
}
```

- `send_blocked` is set when the supplier has no approved order email: `{ "code": "no_approved_email", "message": "This supplier has no approved order email. Ask Shaun to add one before sending." }`. The screen should grey out Make email and Send now for that box.
- `test_send_done` is true once anyone has sent a test copy. For information only: a real send does not wait for one (Shaun, 26 Oct).
- `can_suggest` is true for a fencing or patio job with no lines yet.
- `auto_fill` is true for a fencing job with no lines that was never filled from the scope. The screen then calls `dispatch_v2_suggest_draft` with `auto: true` on its own, once (Shaun, 26 Oct: the scope materials go on the list straight away, no button).
- `scope_filled` is the job's fill record (`dispatch_v2_scope_fills`), or null. A list cleared by hand is not filled again on its own.
- `scope_changed` (S08) is null, or the list's scope lines came from an older sealed revision than the one the order follows now (the fill's rule: the accepted revision, else the latest frozen one): `{ "lines_revision_numbers": [1], "revision_id", "revision_number": 4, "can_refill": true, "message" }`. `can_refill` is true when none of those lines went out (no sent order email, no purchase order); the message then says to press Fill from the scope. When one went out, `can_refill` is false and the message says the scope changed since these lines, naming the newer revision, and that the order that went out should be checked against it. A revision that cannot be read is null here, never a guess.
- A box's `fulfilment` is its open email's, else its newest sent email's, else null (nothing made yet; the screen shows Delivery).

### dispatch_v2_supplier_search (GET)

Params:

| Param | Meaning |
|---|---|
| `q` | Optional name filter. Matching ignores case, spaces, punctuation, "&" and "and" (see "Tweak 4" below). |
| `limit` | Optional, 1 to 100. Default 25. Applies to `others` only. |

Since Tweak 4 (5 Nov 2026) the answer has three lists: `approved` (one row per approved supplier, under its approved name, on its main Xero contact), then, for Show more, `more_approved` (the other Xero contacts of those suppliers) and `others` (every other active Xero supplier contact). `ranking` says whether the bill counts were read (`bills`) or not (`unavailable`: the main contact then falls back to the name order, and the search still answers).

```json
{
  "q": "b&d",
  "ranking": "bills",
  "approved": [
    {
      "approved_id": "uuid", "approved_name": "BD Metals", "used_for": "fencing",
      "to": ["orders@example"], "cc": [], "on_account": false,
      "has_approved_email": true,
      "name": "BD Metals",
      "supplier_id": "uuid", "xero_name": "Jaiama Investments Pty Ltd T/A B&D Metals Group Pty",
      "main_reason": "most_bills", "bills_12m": 36, "last_bill_date": "2026-10-30",
      "other_contacts": 2, "can_add": true, "note": null
    }
  ],
  "more_approved": [
    {
      "approved_id": "uuid", "approved_name": "BD Metals", "used_for": "fencing",
      "to": ["orders@example"], "cc": [], "on_account": false,
      "has_approved_email": true,
      "name": "Jaiama Investments T/a B&D Metals", "supplier_id": "uuid",
      "xero_name": "Jaiama Investments T/a B&D Metals",
      "bills_12m": 0, "last_bill_date": null, "can_add": true, "note": null
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

- `main_reason` is `pinned`, `most_bills`, `only_contact` or `no_bills` (null when there is no contact).
- An approved entry with no linked Xero contact appears once with `supplier_id: null`, `can_add: false` and the note "Add to Xero first: this supplier has no Xero contact yet". Seven entries are like this (5 Nov 2026): AB Steel Fabrication, Fielders, Maxicoat, Metric Fencing, QSM Fabrication, Solarspan and Unique Laser.
- A supplier linked only to a retired (inactive) entry appears in `others`.
- `approved` and `others` keep their old shapes, so a screen from before Tweak 4 still works (it shows the approved row and the others, and never the other contacts).

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

Body: `{ "job_id", "auto"? }`. Fills the draft list from the job's scope. It works only on fencing and patio jobs that have no lines yet, or (S08, the press only, never `auto`) whose scope lines came from an older sealed revision than the one the order follows now.

A refill takes the newer revision's lines in the same way as a first fill, then takes the older scope lines off. It runs only while none of those older lines went out on a sent order email or sits on a purchase order: otherwise it is refused `scope_changed`, with the plain words naming both revisions, and no line changes. Lines typed in by hand are never touched, and lines filled before T20 (no revision named) are left as they are. A refill's line ids name its revision. The answer adds `refilled: { "from_revision_numbers": [1], "replaced": 1 }`, and the first note says what was replaced. The job's fill record is updated to the refill's revision.

On a fencing job scoped in the fence tool, the lines go straight into the box of the supplier the scope names, made if it is not there yet. The scope's supplier is typed text ("RNR", "Fence supply centre", "Strato"), matched to an approved order email by name (`dispatchV2MatchScopeSupplier`), then to the active supplier contact linked to it. A name with no approved email, or no linked contact, leaves the lines on the draft list with a note saying so.

With `auto: true` (the screen's own fill) it runs on fencing jobs only, and only once per job ever: it writes the fill record first as a claim, and a job with a record is refused `already_filled`. A fill by the button also writes the record when there is none. These are never suggested, because they never go on supplier copy:

- concrete bags,
- concrete footings,
- tek screws,
- removal,
- labour,
- delivery.

The line ids are fixed by the job and the line's place, so a second press cannot add the lines twice.

Returns `{ "success": true, "added": 3, "lines": [Line], "notes": [string], "supplier": { "supplier_id", "name" } or null }`.

Refusals, all 409: `no_suggestion_for_work_type`, `lines_exist` (the scope lines already follow the order's revision, or every line was typed in), `scope_unreadable`, `scope_changed` (S08: newer revision, but a line went out), `scope_lines_mixed` (lines from both the newer and an older revision), `lines_changed` (two refills at once), and with `auto`: `no_auto_fill`, `already_filled`.

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

Body: `{ "job_id", "supplier_id", "delivery_date": "YYYY-MM-DD or null", "rebuild": false, "fulfilment": "delivery | pickup" }`.

`fulfilment` is optional. Left out on a rebuild, the held email's own value is kept; left out on a new email, it is `delivery`.

Makes the held email for one box:

| Part | What goes in |
|---|---|
| Lines | The box's lines, except In stock lines, lines already sent, lines on a v1 purchase order, and empty rows (a line with no words is not a line). |
| Body | The wiki template, below. |
| To | The approved entry's To. |
| CC | The approved entry's CC plus the team mailbox, without repeats. |
| Photos | The box's photos that have not already gone out, oldest first, three at most (`dispatchV2UnsentPhotoIds`). A photo named on a sent, sending or send_unknown email is left off, so a new email never re-sends a photo the supplier already has. The photos can still be changed on the held email. |

A box needs a line or a photo to make an email (Tweak 5, Shaun 5 Nov 2026). A box with photos and no line makes a **photo-only** email: see "An order that is just a photo" below.

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
  "photo_only": false,
  "team_cc_open_question": null
}
```

- `missing` lists the Date, Address and Contact lines that came out blank.
- `photo_only` is true when the email has no material line and at least one photo (on a new email and on a rebuild).
- `team_cc_open_question` is set for decking and other job types.
- If the box already has an open email, it comes back unchanged: `{ "success": true, "unchanged": true, "email": Email }`.
- `rebuild: true` on a held email rebuilds it from the lines and loses any edits. The answer then carries `rebuilt: true`.
- Changing Delivery to Pickup (or back) on a held email needs `rebuild: true`: without it the held email comes back unchanged.

Refusals:

| Status | Code |
|---|---|
| 409 | `no_approved_email`, `no_lines_to_order`, `supplier_not_on_job`, `email_changed` (on a rebuild) |
| 400 | `invalid_request` (a bad date, or a `fulfilment` other than `delivery` or `pickup`) |

`no_lines_to_order` now means the box has neither a line to order nor a photo that has not gone out. Its message: "This supplier box has nothing to order. Add a line or a photo (In stock lines, and lines and photos already sent, are left out)".

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
- The body has no sign-off of its own. Shaun's signature is added by send-outlook-email (`signature: shaun` from admin@: Kind regards, the logo, Shaun Lee, Operations Coordinator, 0489 267 771, admin@secureworkswa.com.au), on the real send and the TEST copy alike.
- Long dashes become commas.
- A line reads `<qty>[ <unit>] x <description>`, then its detail lines, `Profile:` and `Colour:`.
- A blank Date, Address or Contact line stays as `Date:` so it is easy to see.
- For a pickup the opening line reads `for pickup:` and there is no Address line and no Contact line at all, so neither is ever `missing` (the Date line is then the pickup date). A pickup with no client phone or name can be made and sent. See "No client phone number on a pickup" below.
- With photos as well as lines, the numbered lines are followed by a blank line and `Please also see attached.`
- With photos and no line, the numbered lines are replaced by `Please see attached for materials needed.` (see below).

#### An order that is just a photo (Tweak 5, Shaun 5 Nov 2026)

Sometimes the order is a photo: a drawing, a handwritten list, a picture of the part. A box with at least one photo (not yet sent) and no line can make and send its email. It uses the same template. The `Materials Needed:` heading is kept (Tweak 2's Outlook reader looks for it) and the date format is unchanged:

```
Hi Team, could we please order the following for pickup:

Date: 10 November 2026

Materials Needed:

Please see attached for materials needed.


Please confirm when you can, thank you.
```

A photo-only delivery keeps its Address and Contact lines, like any delivery.

- The fencing standing lines (`4 x bags of quickset`, `Fixings, Post Caps and Screws as necessary`) are **not** added to a photo-only email, even for the main supplier: `standing_lines_included` is false and `line_count` is 0.
- An empty, untyped line row is ignored, so it never turns a photo-only email into a `1. ` with nothing after it.
- With lines and photos, the email is the usual numbered lines (standing lines included where they apply), then `Please also see attached.`
- A photo-only email whose photos are all taken off in the editor cannot be sent (send check 5, `nothing_to_order`). Put a photo back on it, or discard it.
- Once the photo-only email is sent, its photos count as sent, so the box has nothing left to order until a line or a new photo is added. A new photo makes a new order with only the new photo on it.
- When the supplier confirms it and sends no PDF, the photos are saved to the job for the crew, in place of our order sheet (board contract section 3e.4).
- Tweak 2's Outlook reader is unchanged: an order typed by hand in Outlook still needs numbered lines to be read.

#### No client phone number on a pickup (Tweak 6, Shaun 5 Nov 2026)

On a pickup the client is not there to take a delivery, so their phone number is no use to the supplier, and a missing number used to stop the send. Every pickup email now has no `Contact:` line, and a missing client phone or name never blocks a pickup. Delivery emails are unchanged: the Contact line stays, and a blank one still stops the send.

#### Delivery or pickup (Shaun, 29 Oct 2026)

Lysaght's reply on SWR-261597 ("you can collect on 02/11 before 12pm") was suggested as "Lysaght: delivery Mon 2 Nov", but the order was a pickup, and nothing recorded that. There is no new column: the email body is the record. Its first non-empty line says `for pickup:` or `for delivery:`, so an order sent before this change (or edited by hand) reads the same way.

Where it shows:

| Place | What |
|---|---|
| `Email.fulfilment` | read from that email's body |
| `dispatch_v2_materials` box `fulfilment` | open email's, else newest sent email's, else null |
| Board Arrival `orders[].fulfilment` | the box's newest sent email; null for a PO or a box with nothing sent (see the board contract) |
| Reply suggestions | the label reads `Lysaght: pickup Mon 2 Nov` when the order's sent body says pickup, or the reply sentence the date was read from mentions collect or pick up; else `Stratco: delivery Tue 3 Nov` |

### dispatch_v2_save_email (POST)

Body: `{ "email_id", "expected_updated_at", "to"?, "cc"?, "subject"?, "body_text"?, "photo_ids"? }`. Saves edits to a held email. `photo_ids` may be emptied on a photo-only email; the send then refuses it (`nothing_to_order`).

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
5. The email has a line or a photo (409 `nothing_to_order`: "This email has no lines and no photo. Put a photo back on it, or discard it."). Tweak 5.
6. The Date, Address and Contact lines are filled in (409 `email_details_missing`, with `missing`). A pickup has no Address or Contact line, so only its Date is checked (Tweak 6).
7. The photos are on file and unchanged (409 `photo_not_found` or `photo_changed`).
8. There is an operator email (400 `operator_email_required`).

**Test mode (`test: true`).** It sends the same email to `admin@secureworkswa.com.au` only, with no CC:

- The subject is `TEST ONLY: Material Order Ref ...`.
- The body opens with `TEST ONLY. This copy went only to admin@secureworkswa.com.au.`, says where the real email would go, then a line of dashes, then the real body.

It records `test_sent_at`, `test_sent_to`, `test_sent_by_email`, `test_internet_message_id` and `test_conversation_id`, and nothing else. The email stays held and its stamp does not move, so the same `expected_updated_at` then sends it for real.

```json
{ "success": true, "test": true, "sent_to": "admin@secureworkswa.com.au", "recorded": true, "email": Email }
```

A failed test gives 502 `test_send_refused` or `test_send_unknown`.

**Real send.** A test copy first is optional (Shaun, 26 Oct; the old `test_send_first` refusal is gone). Then:

1. The email is claimed (`status: sending`), so only one press can send it.
2. ops-api posts to `send-outlook-email` from admin@ with `capture_thread_ids: true` and `signature: shaun`, and with no `job_id`, so it is not filed as a client email.
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

The migration seeds 26 approved entries (approved_by Shaun, 23 Oct 2026) and 44 links: the 34 known Xero contacts, 8 more Bunnings contacts, and Mackson (`20d06d01-dab9-4493-a7d8-c2dcda4f3274`, MACKSON MANUFACTURING PTY LTD) and Palram (`8f1d2d75-6905-4e02-b266-88a48c628e83`), both ruled on 23 Oct 2026. The duplicate Mackson contact `d08cc885-7b45-4411-9d6d-13a5d13ae143` is deliberately not linked. A link is made only where the `suppliers` row exists in the org, and every insert is `ON CONFLICT DO NOTHING`.

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

## Tweak 4: a simpler supplier picker (Shaun said Go on 5 Nov 2026)

Shaun: "when I search B&D Metals I see 3 of them. Show me the one we use most, and put the other ones under Show more."

### Tweak 4.1 The rules in business words

1. **One row per approved supplier.** The Add supplier search shows each of the 26 approved suppliers once, under its approved name.
2. **The main Xero contact.** Behind each row sits the linked Xero contact with the most Xero bills (not deleted, not voided) dated in the last 12 months (Perth date). A tie goes to the contact with the newest bill. Picking the row makes the box on that contact.
3. **A pin.** A person can pin a contact instead (`pinned_supplier_id`, with `pinned_by` and `pinned_at`). A pin wins while the contact is still linked and active; if the contact is deleted the pin clears. The migration pins CMI to "CMI (Combined Metal Industries / CMI WA)": CMI moved Xero contact in October, so its newest bills land there, though the Trustee contact has more over the year. There is no screen to set a pin yet: it is set in the database.
4. **Show more.** The other Xero contacts of the 26, then every other Xero supplier. A one-off supplier is still found by typing its name.
5. **Search words.** Case, spaces, punctuation, "&" and "and" do not matter, and "RnR" / "R n R" read as "R and R". So "bd", "b&d" and "b and d" all find BD Metals; "rnr", "r&r" and "r and r" all find RnR Fencing. A word with a vowel either side of the n ("and", "one") is left alone.
6. **No Xero contact yet.** An approved supplier with no linked Xero contact still shows, greyed, with "Add to Xero first". It cannot become a box until Xero has it. On 5 Nov 2026: AB Steel Fabrication, Fielders, Maxicoat (powder coating), Metric Fencing, QSM Fabrication, Solarspan, Unique Laser.
7. **Renames.** "B&D Metals Group" is now "BD Metals" and "R&R Fencing" is now "RnR Fencing". The order email body never names the supplier, so suppliers see no change.
8. **Ampelite.** CC warwick@ampelite.com.au is removed. To stays waorders@ampelite.com.au. Ampelite stays pay first.
9. **The name a box shows.** A box whose Xero contact is linked to an active approved supplier shows the approved name ("BD Metals") on the Materials panel, the board's Arrival line and Needs you now tags, the crew pickup line, the supplier documents and our own Material order sheet. The box row itself still stores the Xero contact's name (`job_material_suppliers.supplier_name`); the screen gets the Xero name as `xero_name`.
10. **The scope fill.** A fence scope naming an approved supplier fills a box on the same main contact (a pin, else the most bills). With no pin and no bills, the old name order stands.

### Tweak 4.2 Read at the time, not kept in a table

The bill counts are a view, `dispatch_approved_supplier_contact_bills`, worked out by Postgres on every search: one row per linked Xero contact with `bills_12m`, `last_bill_date` (any age) and `is_pinned`. Chosen over a table refreshed each day because it is always as fresh as the 06:55 Xero sync, needs no cron and nothing can go stale, and it reads in about 5 ms today (44 links, one indexed look-up each). It reads with the caller's rights (`security_invoker`), and only `service_role` may read it. A failed read never stops the search: `ranking` says `unavailable`.

### Tweak 4.3 Kept the same on purpose

- **Stored reply keys.** `supplierKeyOf` (dispatch_v2_replies_rules.ts) reads "RnR" as "R and R", so "RnR Fencing" keeps the stored key `rrfencing` and "BD Metals" keeps `bdmetals`. Stored reply rows and delivery suggestions are not orphaned.
- **The fence tool's typed names.** The scope matcher knows both the new and the old names, so a scope typed "R&R", "RNR", "B&D", "BND" or "BD" still finds the approved entry, before or after the migration.
- **Outlook order matching** goes by the approved entry's addresses, not its name, so the renames do not touch it. Which contact an Outlook order lands on is unchanged (the one boxed on the job, else the only one, else the last used).
- **On account.** The five on-account suppliers are the same five; R&R Fencing is now named RnR Fencing.

### Tweak 4.4 Migration

`supabase/migrations/20261105184500_dispatch_v2_supplier_picker.sql`: the three pin columns, the view, its grants, the two renames (skipped if the new name is taken), the Ampelite CC removal and the CMI pin (only when that contact is really linked). Every data change matches org `00000000-0000-0000-0000-000000000001` and the names as stored. Nothing touches `suppliers` (the 06:55 Xero sync owns it). Rollback: `supabase/rollbacks/20261105184500_dispatch_v2_supplier_picker_down.sql`. Contract: `supabase/tests/migration-contracts/20261105184500_dispatch_v2_supplier_picker/`. The deploy gate names the view and its columns. The ops-api change reads the view, so the migration must be applied before the ops-api deploy (the merge to main does both, migration first).

## Not done or not decided

- **Decking team CC.** Decking copies patios@ for now, and every decking email says it is open. Other job types (miscellaneous, insurance that is not a repair) get no team CC and say so. Shaun to rule.
- **Seven approved suppliers have no Xero contact linked** (Metric Fencing, Solarspan, Maxicoat, AB Steel Fabrication, Fielders, QSM Fabrication, Unique Laser), so they show greyed with "Add to Xero first" (`can_add: false`) until the contact is made in Xero and linked. Mackson and Palram were ruled and are linked in the seed.
- **Signature (decided, changed 29 Oct 2026).** Order emails carry Shaun's signature (`signature: shaun`). Shaun, 29 Oct 2026, after the first real sends went out bare: "Emails have no signature!! Always use my sign". This replaces the 23 Oct ruling of no signature.
- **One open email per box.** A second order to the same supplier on the same job waits until the first is sent or discarded.
- **Ids not checked against live Outlook.** That the draft gives `internetMessageId` and `conversationId` before sending is from Graph's documentation; it has not been tried against live Outlook (no sends from this build). The first send will show it. `graph_message_id` may change in Sent Items: match on the conversation id or the Message-ID.
- **Records written per send.** send-outlook-email also writes its usual `email_events` log row for each send. No `job_events` or `po_communications` row is written for a v2 send. The job's Emails panel shows the order only when admin@ mail capture picks it up.
- **Deploy order.** send-outlook-email must deploy before, or with, ops-api for the ids to come back. With an old send-outlook-email, the send still works and counts as sent, but the ids are null.
- **Request body size.** The edge function's limit for a 3 MB photo upload (about 4 MB as base64) has not been tested live.
- **Migration contracts.** No Postgres contract case was written for either migration: there is no Postgres on this machine to run one, and an unrun case could break CI. The migrations have not been applied anywhere. They auto-apply on merge to main.
- **The reply matcher** (sibling worktree `be-dispatch-suggested-moves`) should read `sent_conversation_id`, then `sent_internet_message_id`, as above.
