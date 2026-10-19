# Quote builder data contract (v1)

Backend for the quote builder: the single-page app Hugo uses on his iPad to
scope a job, price what it costs us, price what we charge, attach site photos,
and keep the client quote PDF as its own document. This file is the contract the
app builds against. The app itself lives elsewhere.

Status: v1, implemented. Code: `supabase/functions/ops-api/quote_builder.ts`. Migrations:
`supabase/migrations/20261009120000_quote_builder_versions.sql` and
`supabase/migrations/20261013160000_quote_builder_pricing_and_documents.sql`
(pricing settings, line types, the filed scope of works and the Repairs card
value: sections 2b to 2d and 5.6). Making a draft crew work order and draft
purchase orders from an issued quote is built and switched off (section 6).
The switch is `quote_builder_orders_v1` in `public.feature_flags`, seeded off
by `supabase/migrations/20261014140000_quote_builder_orders.sql`.

No pricing number is written in this file, in the app or in `ops-api` code. The
owner's numbers live in one database table (section 2c) and reach the app only
inside a signed-in staff response.

## 1. Access: edge-function actions, not browser tables

The app calls `ops-api` actions with the staff member's own Supabase session.
This is the same shape the fence and patio tools use today (`ghl-proxy`
`save_scope`: browser sends its user JWT, the function checks it and writes with
its own server credential).

- Sign in with the existing Supabase staff login (`supabase.auth.signInWithPassword`
  or the existing magic link). No service key, shared key or `SW_API_KEY` ever
  goes to the browser.
- Every call: `Authorization: Bearer <session.access_token>`. The
  `apikey: <project anon/publishable key>` header is optional: ops-api allows it
  (and `x-client-info`) in its CORS preflight, so a plain `fetch` and
  `supabase.functions.invoke` both work from the browser. Send no other custom
  header; the preflight allows only `Content-Type`, `Authorization`,
  `x-api-key`, `apikey` and `x-client-info`.
- Base URL: `https://<project>.supabase.co/functions/v1/ops-api?action=<name>`.
- Reads are `GET` with query params. Writes are `POST` with a JSON body.
- CORS is open (`*`), so the app can be served from any origin, including a
  page opened on the iPad.
- Who may call, every action: staff roles
  `admin`, `owner`, `ops_manager` (Hugo is `ops_manager`). Any other signed-in user gets `403 operator_access_required`.
  No session or an expired one gets `401` (the app should send the user to sign
  in again). The make-safe routine key and the agent read key are refused.
- The new table `quote_builder_versions` has row-level security ON with no
  policy and is revoked from `anon` and `authenticated`, so the browser cannot
  read or write it directly, even with a valid session. Only `ops-api` reads it.

Why actions instead of RLS tables: internal cost lines must never be readable by
a trade session, the stage move must go through the existing
`update_repair_stage` writer, and the issue step has to write four tables
together. A server action does all three in one place; RLS on six existing tables
would not.

## 2. What is stored where

| Thing | Where | Notes |
|---|---|---|
| Scope and its versions | `quote_builder_versions` (new) | One row per version. Cost lines, charge lines, narrative, totals. |
| Internal cost lines ("what it costs us") | `quote_builder_versions.cost_lines` | Never on the client PDF, never sent to trades. |
| Client charge lines ("what we charge") | `quote_builder_versions.charge_lines` | What the client PDF shows. |
| Site photos + captions | `job_media` (`phase='quote_builder'`, `type='photo'`, caption in `label`) | Files in Storage bucket `job-photos`. Their own phase (`20261009120000`) keeps them internal: `isApplicablePackPhoto` drops it for SES packs, curated bind, the draft pack and roof report photo sets and the final-submit photo floor, and the mailer photo route drops it too. The make-safe board photo count does not filter the phase; it never sees these photos because the board excludes repair and private jobs. The builder lists and accepts only photos in that phase. |
| Client quote PDF | Storage bucket `job-pdfs` + one `job_documents` row (`type='quote'`) | Its own document, linked from the version. |
| Scope of works PDF | Storage bucket `job-pdfs` + one `job_documents` row (`type='other'`, `metadata.quote_builder_document = 'scope_of_works'`) | Filed at issue beside the quote when the app sends it, on an insurance repair-family job only (5.6). It carries no prices. Never visible to trades. |
| Material order list | Not filed anywhere | It prints our costs, and `job-pdfs` is a public bucket (read in production, 13 Oct 2026), so the server gives it no upload slot and files no document. The app shows and prints it on demand from the version's saved cost lines (5.6). |
| Pricing settings (labour rate, materials multiplier, target margin) | `quote_builder_settings` (section 2c) | Read only by `ops-api`. |
| The money on the Repairs card | Stored nowhere (section 2d) | Worked out from the issued versions each time the Repairs board is read. The builder never writes `jobs.pricing_json`. |
| Variations | `job_variations` (existing) + a `kind='variation'` version chain | The variation row is created when Hugo issues it. |
| Client details on a private job | `jobs` (`client_name`, `client_phone`, `client_email`, `site_address`, `site_suburb`) | Copied into each version's `client_snapshot`. |
| Builder / customer (e.g. ML Builders) on a repair job | `makesafe_job_details.requesting_company_id` -> `makesafe_companies` | Read only. Adding Ambrose Construct Group is the intake worker's job. |

Not reused, on purpose:

- `quote_revisions`: it is the SENT-quote release ledger for `send-quote`
  (`released_via` is limited to the send-quote paths, `recipient_email` and a
  release manifest are required, rows are immutable). The builder sends nothing,
  so writing there would claim a send that never happened.
- `jobs.scope_json`: owned by the fence and patio scoping tools, and the
  `ghl-proxy` scope cursor guards it. A second writer would fight them.
- `jobs.expected_costs`: frozen once, at acceptance, by `send-quote`, behind a
  write-once trigger. The builder does not write it.

### 2a. Versions

Each job has one **scope chain**, and each variation has its own **variation
chain**. A chain is a list of versions 1, 2, 3 ...

- The latest version of a chain is either `draft` (editable) or `issued` (frozen).
- Saving edits the draft in place. Saving after an issue starts the next version
  as a new draft, so every issued quote stays exactly as it was.
- Issuing freezes the draft, attaches the client PDF, and (on a repair job) moves
  the Repairs board stage.
- An issued version can never be changed or deleted (database trigger).

"What he allowed versus what we quoted" is any issued version: `cost_lines`
(allowed) beside `charge_lines` (quoted). "Expected versus actual" comes later:
every line carries a stable `line_id` that the app keeps across versions, so a
future actual-costs record can point at the line it is an actual for. v1 stores
no actual costs.

### 2b. Line shapes

The server recomputes every total; whatever totals the app sends are ignored.
Money is AUD, rounded to cents. Quantities may be decimals (e.g. 12.5 m).

Cost line (internal):

```json
{
  "line_id": "c-6f1c",
  "description": "Remove and dispose damaged fascia",
  "qty": 12.5,
  "unit": "m",
  "unit_cost_ex_gst": 18,
  "supplier_or_trade": "Bunnings"
}
```

Stored back with `line_total_ex_gst` (= qty x unit cost).

A cost line may carry `line_type`: `material`, `labour` or `other`.

```json
{ "line_id": "c-6f1c", "line_type": "labour", "description": "Carpenter on site", "qty": 8, "unit": "hr", "unit_cost_ex_gst": 50, "supplier_or_trade": "Dave" }
```

- One of the three values is kept and returned on every read of the version.
  Anything else, or no value, stores the line with no `line_type` key. A line is
  never refused for its type, so an older cached page still saves.
- A line read back with no `line_type` is an "other" line. Stored lines are
  never rewritten, and an issued version stays as it was.
- A Labour line is in hours: the app sends `unit: "hr"`, `qty` is the hours
  allowed and `unit_cost_ex_gst` is what an hour costs us.
- Totals do not change with the type. "Labour allowed" (hours and cost of the
  Labour lines) is worked out by the app when shown.
- The type is what the order actions read (section 6): Labour lines as work
  order hours, Material lines as purchase order lines. The server acts on it
  only while `quote_builder_orders_v1` is on. While that flag is off, missing
  or unreadable, nothing reads the type to make an order.

Charge line (client):

```json
{
  "line_id": "q-1a2b",
  "description": "Replace fascia, 12.5 m, supply and install",
  "qty": 1,
  "unit": "item",
  "unit_price_ex_gst": 650,
  "gst_applies": true
}
```

Stored back with `line_total_ex_gst`, `gst_ex` (10% when `gst_applies`, which
defaults to true) and `line_total_inc_gst`.

Rules: `description` is required (max 2000 chars); `qty` and unit amounts must be
numbers, zero or more (a negative unit amount is refused; record a credit as its
own description with a positive amount for now). `line_id` is optional on input;
the server assigns one when missing and keeps the one given. At most 200 lines of
each kind.

Totals on every version: `cost_total_ex_gst`, `charge_total_ex_gst`,
`charge_gst`, `charge_total_inc_gst`, `margin_ex_gst`
(= charge ex GST minus cost) and `margin_pct` (margin over charge ex GST, null
when the charge is zero).

### 2c. Pricing settings

`quote_builder_settings` (`20261013160000`) holds one row per number:

| `setting_key` | Meaning |
|---|---|
| `insurance_labour_rate_ex_gst` | Dollars per hour charged for labour on an insurance repair, ex GST |
| `insurance_materials_multiplier` | Client price of a material = our cost times this |
| `target_margin_pct` | Target gross margin, percent |

The first two are seeded by the migration with the owner's starting values of
13 Oct 2026. The target has no row until the owner names one. The numbers are
changed by a database update; there is no settings write action yet, so
`can_edit_settings` is always `false`. The table checks the setting's name and
keeps one row per setting. It holds no rule about a number's size: the owner
may set any number.

The table has row-level security on with no policy and is revoked from `anon`
and `authenticated`, like `quote_builder_versions`. It is not `org_config`:
that table is readable by every signed-in user of the organisation, trades
included, and what we charge a builder per hour is not a trade's to read.

`quote_builder_get_job` returns them as `settings` (5.2) for an insurance
repair-family job. A missing row, or a value that is not a number, is `null`.
The server has no fallback number.
If the settings read itself fails, the job still opens: every value is
`null` and the reply adds `settings_unavailable: true`, so the app hides the
goal note instead of saying "not set". A settings fault never refuses the job.

A private job (section 4) gets no `settings` and no `can_edit_settings` key at
all, and the settings table is not read for it: the figures are the insurance
lane's goal, and the private quote lane opens exactly as it did before this
table existed. Line types on a saved cost line are kept and returned on either
lane.

**The settings are a goal, not a rule.** The scoper decides his own markups;
the rate, the multiplier and the target margin are what the owner is aiming
for, shown to him as a guide. The server never refuses, clamps or rewrites a
charge line, a total or a margin for differing from them: save, issue and the
Repairs card value take the charge lines exactly as sent, and a quote priced under the
goal (or at a loss) saves and issues like any other. How the app uses the goal
(suggesting labour at the rate and materials at cost times the multiplier, and
showing the margin against the target) is the app's own business.

### 2d. The money on the Repairs card

**The builder never writes the job's own pricing** (`jobs.pricing_json`, and so
`jobs.quoted_value`, which the database works out from it). Too many existing
paths treat that pricing as authority: `completeAndInvoice` prices an invoice
from it when given no lines, the deposit invoice works a deposit out of it, and
both quote send paths (`send-quote` `/send` and `send_quick_quote_email`) send
any job whose pricing holds a total above zero. A repair or private job quoted
in the builder keeps empty pricing, so every one of those paths answers for it
exactly as it did before the builder existed: no invoice without lines or an
amount from the person raising it, and no quote email from the ordinary send
buttons.

The Repairs card gets its money at read time instead. When the Repairs board is
read (`pipeline&type=repair`), each card is given:

    card value = latest issued scope version's charge total inc GST
               + the latest issued version of each variation that counts

It is worked out on every read and stored nowhere, so it cannot go out of date:
a variation approved or rejected with the ordinary ops button, or declined by
the customer on their link, changes the card on the next read with no builder
action. A quote issued before this change shows on the card the same way.

Which cards get it:

- only a card whose job has **no pricing of its own** (`pricing_json` null or
  `{}`). A job priced by the fence or patio tool, or carrying a CRM value,
  keeps its own figure and its row is exactly what it was (the live examples
  are the two fencing-typed repair cards, Woodvale and Pingelly);
- only a job with an issued scope version. A draft shows nothing.

A card that takes the builder's figure carries it in `value`, the field the card
already reads, and gains no other field. Every other row is exactly what it
was, and every other board (`pipeline` with any other `type`, or none) is read
without touching the quote builder. Only the client total rides on the row:
cost lines, cost totals and margins are never read for the card.

If the quote builder read fails, no card is given a builder figure (never a
part figure, such as the scope without its approved variation), the board still
loads, and the response says so: `degraded: true` with
`pipeline.quote_builder_value` in `enrichment_errors`.

A variation counts once the office approves it, keeps counting after an
approved one is sent to the client, and counts once the client accepts it:

| `job_variations.status` | Counts |
|---|---|
| `approved` | Yes. |
| `accepted` | Yes: the client's acceptance counts, with or without an office approval first. |
| `sent` | Only if the newest event about it is an approval (below). |
| `draft`, `pending_approval`, `rejected`, `declined`, `cancelled`, anything else | No. |

`sent` does not say whether anyone approved the variation: the ops "send
variation" action sets it from any status, so a variation can be sent without
ever being approved. That case is not counted until the client accepts it. Nor
can `approved_at` settle it, because the approval path stamps it on a rejection
as well. The record that does is the job event trail naming the variation
(`job_events`): the approval path writes `variation_approved` or
`variation_rejected` on every decision, and every issue of the variation writes
`variation_requested`. For a `sent` variation the newest of those three must be
`variation_approved`. So a sent variation with no approval is not counted, and
neither is one that was approved, re-issued as a new version and sent again
without a fresh approval: the issue came after the approval, and nobody has
approved the new version.

If the `variation_requested` event of a variation issue cannot be written, the
issue still stands and the failure is logged with the variation id: until that
variation is next issued or decided, an earlier approval of it would still read
as its newest event.

## 3. Repair jobs and the Repairs board

The Repairs board stages are fixed in `INSURANCE_REPAIR_STAGES`
(`ops-api/insurance_repairs_board.ts`): `wo_in`, `scoping`, `quoted`,
`variation`, `approved`, `materials`, `scheduled`, `on_site`, `complete`. The
builder moves a card only through the existing `update_repair_stage` writer
(same guard, same `repair_stage_changed` audit row), and **only forward**: a card
already past the target stage is left where it is and the response says why.

| Builder event | Stage moved to |
|---|---|
| Issue a scope version | `quoted` |
| Issue a variation | `variation` |
| Approve a variation (`quote_builder_decide_variation`, approved) | `approved` |
| Reject a variation | no move |

No new stage was added: "variation" and "approved" already exist, so an approved
variation lands in `approved`. Private jobs (section 4) have no repair stage and
are not moved.

## 4. Private (miscellaneous) quotes

`quote_builder_create_private_job` creates a job for a private client with no
insurance work behind it. It uses the existing job type `miscellaneous`, which
already numbers as `SWM-26xxx` through `next_job_number`, so there is no schema
change to job types or numbering. Not chosen: `renovation`, because it shares the
`SWR-` prefix with insurance repairs and would read as a repair job. The kind of
work (default `private_renovation`) is recorded in
`jobs.metadata.quote_builder.category`. The job starts at status `draft`; the
builder does not move a private job's status.

## 5. Actions

All responses are JSON. Errors are `{ "error": "...", "code": "..." }` with HTTP
400 (bad input), 403, 404 (no such job or version), or 409 (conflict: stale
version, wrong job type, frozen version). Read the `code`, not the text.

### 5.1 `GET quote_builder_list_jobs`

Params: `lane` = `repair` (default) or `private`; for repair, `stages` = comma
list, default `wo_in,scoping`; `limit` default 100, max 200.

```
GET /functions/v1/ops-api?action=quote_builder_list_jobs&lane=repair&stages=wo_in,scoping
```

```json
{
  "lane": "repair",
  "stages": ["wo_in", "scoping"],
  "jobs": [
    {
      "id": "uuid",
      "job_number": "SWR-26123",
      "type": "repair",
      "repair_stage": "scoping",
      "status": "processing",
      "client_name": "J Smith",
      "site_address": "12 Example St",
      "site_suburb": "Morley",
      "builder_name": "ML Builders",
      "builder_work_order": "MLB-27093",
      "builder_purchase_order": "PO-56481",
      "created_at": "2026-10-01T02:00:00Z",
      "latest_scope": { "version": 2, "status": "draft", "charge_total_inc_gst": 715, "updated_at": "..." }
    }
  ]
}
```

`latest_scope` is null when the job has never been scoped in the builder.

### 5.2 `GET quote_builder_get_job`

Params: `job_id`.

Returns everything the app needs to open a job:

```json
{
  "settings": { "labour_rate_ex_gst": 0, "materials_multiplier": 0, "target_margin_pct": null },
  "can_edit_settings": false,
  "job": { "id": "...", "job_number": "...", "type": "repair", "status": "...",
           "repair_stage": "scoping", "client_name": "...", "client_phone": "...",
           "client_email": "...", "site_address": "...", "site_suburb": "...",
           "builder_name": "...", "builder_work_order": "...", "builder_purchase_order": "...",
           "category": null },
  "scope": { "chain_id": "...", "versions": [ /* version objects, oldest first */ ] },
  "variations": [
    { "chain_id": "...", "variation_id": "uuid or null until issued",
      "variation_number": 1, "variation_status": "pending_approval",
      "versions": [ /* version objects */ ] }
  ],
  "photos": [ { "id": "...", "url": "https://...", "caption": "...", "taken_at": null, "created_at": "..." } ],
  "documents": [ { "id": "...", "quote_number": "SWR-26123-Q2", "url": "https://...", "version_id": "...", "created_at": "..." } ]
}
```

- `settings` is present on every insurance repair-family job (section 2c): each
  value a number or `null`. Its presence is what switches the app's line types
  and pricing bar on. The values shown above are placeholders, not the real
  numbers. A private job's reply has no `settings` key.
- `settings_unavailable: true` is sent only when the settings read failed
  (section 2c); every `settings` value is then `null`. Absent otherwise.
- `can_edit_settings` is sent with `settings` and is `false` for everyone until
  a settings write action exists. A private job's reply has no such key.
- `documents` is the client quote PDFs only. A scope of works PDF filed at issue
  (5.6) is on the job as a document but is not listed in this reply: no app page
  reads such a list (the app's code was read on 13 Oct 2026), so none is sent
  and no extra read runs when a job is opened. The material order list is not
  filed at all.
- A private job's reply has exactly the keys it had before pricing settings
  existed: `job`, `scope`, `variations`, `photos`, `documents`.

A version object:

```json
{
  "id": "uuid", "job_id": "uuid", "kind": "scope", "chain_id": "uuid",
  "version": 2, "status": "draft",
  "title": "Storm damage repairs", "narrative": "Hugo's write-up ...",
  "cost_lines": [ ... ], "charge_lines": [ ... ],
  "cost_total_ex_gst": 410, "charge_total_ex_gst": 650, "charge_gst": 65,
  "charge_total_inc_gst": 715, "margin_ex_gst": 240, "margin_pct": 36.92,
  "photo_media_ids": ["uuid"], "client_snapshot": { ... },
  "variation_id": null, "client_pdf_document_id": null, "quote_number": null,
  "created_by": "uuid", "created_at": "...", "updated_at": "...",
  "issued_by": null, "issued_at": null
}
```

A version carries no `work_order` or `purchase_orders` key: no order is made
from a quote yet (section 6), and the app reads a missing key as "none made".

### 5.3 `POST quote_builder_create_private_job`

```json
{
  "request_id": "a fresh uuid made by the app, reused on retry",
  "client_name": "Jane Citizen",
  "client_phone": "0400 000 000",
  "client_email": "jane@example.com",
  "site_address": "5 Sample Rd",
  "site_suburb": "Bayswater",
  "category": "private_renovation",
  "notes": "Bathroom refresh"
}
```

`client_name` and `request_id` are required. Retrying with the same `request_id`
returns the job already made (`"created": false`) instead of a second job. Two
requests with the same `request_id` at the same moment still mint one job: the
unique index `ux_jobs_quote_builder_request_id` (`20261009120000`) refuses the
second insert, and that request returns the first job (`"created": false`).

```json
{ "created": true, "job": { "id": "...", "job_number": "SWM-26001", "type": "miscellaneous", "status": "draft", ... } }
```

### 5.4 `POST quote_builder_save`

Saves the draft of one chain.

```json
{
  "job_id": "uuid",
  "kind": "scope",
  "chain_id": null,
  "base_version_id": null,
  "title": "Storm damage repairs",
  "narrative": "Free text write-up",
  "cost_lines": [ ... ],
  "charge_lines": [ ... ],
  "photo_media_ids": ["uuid"]
}
```

- `kind`: `scope` or `variation`.
- `chain_id`: omit for the job's scope (the server uses the job's scope chain).
  For a NEW variation omit it; the server makes a new chain and returns its id.
  To keep editing an existing variation, send its `chain_id`.
- `base_version_id`: the id of the latest version the app loaded for that chain,
  or null when the chain is empty. If someone else saved or issued since, the
  save is refused `409 stale_version` and nothing is written; reload and retry.
- `photo_media_ids`: photos (from `job_media`) chosen for this version, in order.
  Each must be one of this job's quote builder photos (`phase='quote_builder'`);
  anything else is `409 photo_not_on_job`.

Allowed jobs: repair-family jobs (`jobs.type='repair'` or the repair family
markers the Repairs board reads) and `miscellaneous` jobs. Anything else is
`409 job_not_quotable` (make-safe cards stay with the SES pack system).

Returns `{ "version": <version object> }`. A save clears the draft's
`quote_number`, because any PDF made before the edit no longer matches it: ask
for a fresh PDF upload slot (5.6) after the last edit and before issuing.

### 5.5 `POST quote_builder_photo_upload_url` then `POST quote_builder_photo_register`

1. Ask for an upload slot:

```json
{ "job_id": "uuid", "file_name": "IMG_0042.jpg", "content_type": "image/jpeg" }
```

`content_type` must be `image/jpeg`, `image/png` or `image/webp` (the bucket
refuses anything else; iPad Safari sends JPEG from the camera roll). Max 10 MB.
Returns `{ "path": "...", "signed_url": "...", "token": "...", "public_url": "..." }`.

2. Upload the bytes: `PUT <signed_url>` with the file as the body and
   `Content-Type` set (or `supabase.storage.from('job-photos').uploadToSignedUrl(path, token, file)`).

3. Register it:

```json
{ "job_id": "uuid", "path": "<path from step 1>", "caption": "Water damage, rear eave" }
```

Returns `{ "photo": { "id": "...", "url": "...", "caption": "..." } }`. The server
checks the file is really in Storage before writing the row, and registering
the same path twice returns the same photo. Optional `taken_at` (ISO time).
Photo URLs are public links in the existing `job-photos` bucket, the same as
every other job photo today.

Change a caption later with `POST quote_builder_photo_caption`
`{ "photo_id": "uuid", "caption": "..." }`.

### 5.6 `POST quote_builder_pdf_upload_url` then `POST quote_builder_issue`

The app renders the client quote PDF itself (charge lines only, no internal
costs), uploads it, then issues.

1. `{ "version_id": "uuid of the draft" }` -> `{ "path", "signed_url", "token", "public_url", "quote_number" }`.
   Upload with `PUT <signed_url>`, `Content-Type: application/pdf`, max 20 MB.
   Print `quote_number` on the PDF (e.g. `SWR-26123-Q2`, or `SWR-26123-V1.2` for
   version 2 of variation 1).
2. `{ "version_id": "uuid", "pdf_path": "<path from step 1>" }`.

To file the scope of works on the job as well (insurance repair-family jobs
only, and optional; an issue without it works as before):

- Ask for its slot: `{ "version_id": "uuid", "document": "scope_of_works" }`.
  `document` defaults to `quote`. It returns its own `path`; the two slots can
  be asked for in either order, and only the quote's slot stamps the quote
  number.
- Upload the PDF to its slot, then name it on the issue:

```json
{ "version_id": "uuid", "pdf_path": "<quote path>",
  "extra_documents": [
    { "document": "scope_of_works", "pdf_path": "<its path>" }
  ] }
```

An entry with an unknown `document`, a `document` named twice or a `pdf_path`
that is not the slot's is `400 invalid_input`; a PDF not yet in Storage is
`409 upload_missing`. All are checked before anything is written.

A private job files the client quote alone, as it always has. Its upload slot
answers `400 invalid_input` to `document: "scope_of_works"`, and its issue does
not read `extra_documents` at all: whatever the field holds, nothing extra is
filed, nothing is refused for it and the reply is the one a private job has
always had.

The scope of works PDF sits beside the client quote in a public bucket, so the
app must print no cost, rate, multiplier or margin figure on it. The server
stores none on its `job_documents` row: no lines, no totals, no settings.

**The material order list is not filed.** It prints our costs, and every file
in `job-pdfs` has a public address that can be worked out from the client quote
link. So the server gives it no slot, stores no file and files no document:

- the upload slot answers `400 invalid_input` to
  `document: "material_order_list"`, so the PDF can never reach the bucket;
- an issue whose `extra_documents` names `material_order_list` is **not**
  refused for it. That entry is skipped (its `pdf_path` is not read), the quote
  issues as normal, and the reply carries
  `"extra_documents_not_filed": [ { "document": "material_order_list", "reason": "internal_costs_not_filed" } ]`.
  The key is absent when the issue named no such document, and always absent
  on a private job.

The list stays available in the app on demand, built from the version's saved
cost lines, which are already on the job. Filing it waits on private storage
with signed links, a separate change that needs the owner's say.

Issue refuses with nothing written when: the draft has no charge lines
(`409 no_charge_lines`), no PDF slot was asked for since the last save
(`409 pdf_not_prepared`), the PDF is not in Storage (`409 upload_missing`), the
quote number moved since the slot was issued (`409 quote_number_changed`; ask
for a new slot and re-render), or the variation is already decided.

Then it:

- writes a `job_documents` row (`type='quote'`, `quote_number`, `storage_url`,
  `pdf_url`, `visible_to_trades=false`, metadata names the version) under
  `run_label = 'qb:<chain_id>'` (`_shared/quote_builder_run_label.ts`), after
  retiring (`superseded_at`) the same chain's earlier live unsent document. So
  each chain (the scope, each variation) keeps one live document, a scope and its
  variations stay live side by side, and none of them ever takes the job-wide
  draft slot (`job_contact_id` and `run_label` null) that `ghl-proxy`
  `prepare_quote` reuses under `ux_job_docs_live_unsent_quote`;
- files the scope of works, when sent, as its own `job_documents` row
  (`type='other'`, `visible_to_trades=false`, under the same `run_label`,
  `metadata` naming the version and `quote_builder_document`), and retires the
  one an earlier version of the chain filed. It carries no `quote_number` column
  (it is unique and belongs to the quote row); the number is in
  `metadata.quote_number`. A version holds at most one
  (`ux_job_docs_quote_builder_extra`), so a retried or double-submitted issue
  reuses the row;
- freezes the version (`status='issued'`, `issued_at`, `issued_by`, PDF linked);
- for a variation: creates (first issue) or updates (re-issue while still
  pending) its `job_variations` row: `amount` = charge total inc GST,
  `cost_estimate` = cost total ex GST, `status='pending_approval'`. A variation
  already approved or rejected cannot be re-issued (`409 variation_decided`;
  start a new variation instead);
- on a repair job, moves the stage forward per section 3.

Issue is safe to retry: a retry after a partial failure reuses the
`job_documents` row already filed for that version (refreshed to this attempt's
quote number, PDF and lines) and the variation already linked to it, so it never
files a second document or a second variation. If a save lands between a first
variation issue creating its `job_variations` row and linking it to the draft,
that new row is deleted before the `409 stale_version`, so the retry reuses the
same variation number and no unlinked variation is left open.

The quote document is filed with `sent_at` empty and `sent_to_client=false`, so
nothing that counts sent quotes (`job_quote_values`, the job dossier) reads it
as sent, and send-quote's "every party accepted" rule skips `qb:` documents, so
they never hold a job at `partially_accepted`. Nothing is emailed or texted to anyone. Sending the PDF is a separate step
outside this contract.

Returns:

```json
{
  "version": { ...frozen version... },
  "document": { "id": "...", "quote_number": "SWR-26123-Q2", "url": "https://..." },
  "variation": null,
  "stage": { "moved": true, "from": "scoping", "to": "quoted" },
  "extra_documents_not_filed": [ { "document": "material_order_list", "reason": "internal_costs_not_filed" } ]
}
```

The reply lists no filed extra documents: a scope of works named on the issue
is filed on the job or the issue fails, and no app page reads such a list.
`extra_documents_not_filed` is present only when a repair job's issue named a
document that was not filed.

The reply carries no `job_value`: issuing stores no value on the job, and the
Repairs card works its figure out when the board is read (section 2d).

`stage` is `{ "moved": false, "reason": "not_a_repair_job" | "already_past_stage", ... }`
when nothing moved. A stage write that loses a race returns
`moved: false, reason: "stage_write_failed"` and the issue still stands.

### 5.7 `POST quote_builder_decide_variation`

```json
{ "variation_id": "uuid", "approved": true, "notes": "Builder approved by email 9 Oct" }
```

Records the decision on `job_variations` through the existing variation approval
path, re-reads the variation, then moves a repair job to `approved` when approved.
If the variation does not read back as `approved` (or `rejected`), nothing moves
and the call is refused `409 variation_decision_not_recorded`; try again. Returns
`{ "approved": true, "variation_id": "...", "stage": { ... } }`. It carries no
`job_value`: the decision shows on the Repairs card at the board's next read
(section 2d), where an approval adds the variation and a rejection takes it off
when it had been counted.

## 6. Draft work order and purchase orders, built and switched off

**Two switches (19 Oct 2026).** `quote_builder_make_purchase_orders` also needs
its own switch, `quote_builder_purchase_orders_v1` (seeded off, migration
`20261019183000`). Off, missing or unreadable, it returns
`409 quote_builder_purchase_orders_off` whatever `quote_builder_orders_v1`
says. Supplier orders for repair and private jobs go through Dispatch, so
turning on the crew work order never turns supplier ordering from a quote
back on.

The owner asked for the quote to carry "information that we can use ... so we
can create the work order from that". That is built. It stays off until the
owner turns the switch on.

**Switch (acceptance item 17).** Name: `quote_builder_orders_v1`. Location:
`public.feature_flags` (column `enabled`). Seeded `false` by
`supabase/migrations/20261014140000_quote_builder_orders.sql`. The quote builder
reads that row itself and fails closed: missing, unreadable or any value other
than `true` is off. It is not cached. While off:

- `quote_builder_make_work_order` and `quote_builder_make_purchase_orders`
  return `409` `quote_builder_orders_off` and write nothing;
- `quote_builder_get_job` is unchanged: no `work_order` or `purchase_orders`
  keys are added (acceptance item 19, the "no new keys" form);
- job acceptance does not filter on `quote_builder_version_id`, and
  `pushPOToXero` does not refuse a blank or placeholder supplier (items 28
  and 29 run only while the flag is on);
- the app in this change has no make-WO / make-PO button (the button lives in
  the quote-builder app, which this change does not touch).

While on, both actions take `{ "version_id": "uuid" }`. A `job_id` on the body
is ignored; the job is the version's job. A draft version is
`409 version_not_issued`. A missing version is `404`. Only staff
(`admin` / `owner` / `ops_manager`) or the privileged ops key may call them.

From an issued version:

- one draft crew work order (`work_orders.kind = 'crew'`, `status = 'draft'`,
  never `kind = 'job'`): one scope item per sentence of the narrative, then one
  item per Labour line (`description`, `hours`, `unit: "hr"`). No dollar figure
  on the work order. Material lines are not on it;
- one draft purchase order per supplier group of the Material lines, with
  quantity and our unit cost (`unit_price`). Lines with no supplier go on one
  draft named `Supplier to be named`, which staff rename;
- a second press of either action returns what the first made and inserts
  nothing, and writes no second event. Presses at the same instant are held by
  the database, not only by the read before the insert: one work order per
  version (`uq_work_orders_one_quote_builder_version`) and one set of purchase
  orders per version (`uq_purchase_orders_quote_builder_version_seq`, on the
  version and `quote_builder_po_seq`, the supplier group's place 1, 2, ...;
  migration `20261019183000`). The losing press's insert is refused whole and
  it returns the winner's rows. A refused insert that leaves the version with no
  order is a `500 read_failed`, never an empty success. Before any order, the
  press writes the version's lasting marker (`quote_builder_order_marks`,
  version and kind); only the press that writes it makes the orders. A press
  that finds the marker but no rows after a short wait gets
  `409 purchase_orders_unsettled` / `409 work_order_unsettled`: the orders are
  being made or were removed, and staff reconcile the job's orders before
  making any by hand. A set missing a row comes back with
  `purchase_orders_incomplete: { expected, present, missing_seq }` and is
  never re-made. Known limit: a make that fails part way keeps its marker, so
  that version's orders are then made by hand (the safe side; the feature is
  switched off and makes drafts only).

With the switch on, `quote_builder_get_job` adds these keys on every version
(drafts included): `work_order: {id, wo_number, status} | null` and
`purchase_orders: [{id, po_number, supplier_name, status}]`. Each make action
returns that same shape, plus `hidden_lines` (the sentences and labour
descriptions the crew read will blank).

The rows carry `quote_builder_version_id`. That column is the idempotency key.
`created_by` is the signed-in user's uuid (`null` for the ops key). The email
is only on the job event (`quote_builder_work_order_made` /
`quote_builder_purchase_orders_made`, `detail_json.operator_email`). Neither
action sends anything or calls Xero.

`create_work_order` and `create_po` are unchanged.

How the five open points are settled:

1. **Money words.** The work order is one scope item per sentence, not one
   blob. A sentence or labour description that `tradeTextHasMoneyToken` matches
   (`_shared/trade_quote_pack/pack_trade_quote.ts`) is still stored, and the
   reply names it in `hidden_lines`. There is no second money check.
2. **Supplier rename.** Purchase orders are not keyed on the supplier name.
   Once any purchase order exists for that version, including a cancelled,
   deleted or renamed one, the next press returns those rows and inserts
   nothing. The work order is unique per version.
3. **Acceptance leaves them alone, while the switch is on.** `updateJobStatus`,
   when a job becomes `accepted`, reads `quote_builder_orders_v1` the same way
   the quote builder does: missing or unreadable is off. Only while that flag
   is on does it approve draft crew work orders and push draft purchase orders
   where `quote_builder_version_id` is null. A quote-made row stays draft and
   is not pushed. While the flag is off, those queries do not filter on
   `quote_builder_version_id` at all: acceptance is the same as before this
   change.
4. **No Xero contact from a placeholder, while the switch is on.**
   `pushPOToXero` refuses `409 po_supplier_required` when the supplier is blank
   or a placeholder (including `Supplier to be named`), before it reads the job
   and before `getToken`, and only while `quote_builder_orders_v1` is on. The
   flag is the same fail-closed read, and the refusal covers every purchase
   order, not only a quote-made one. While the flag is off, `pushPOToXero`
   does not refuse a blank or placeholder supplier.
5. **Who made it.** `created_by` is the user's uuid. The email is only on the
   event. `createWorkOrder` and `createPO` are not changed.

Also not built: **a private (miscellaneous) quote shows no money on any
board.** Its job is not on the Repairs board, and the builder writes no pricing
on it (2d), so the figure is seen only in the quote builder itself and on the
filed quote PDF.

## 7. Out of scope for v1

GHL, Xero, sending anything to a client, builder, supplier or trade, intake
changes, the Ambrose Construct Group builder record, actual-cost capture, moving
a private job's status, changing the pricing settings from the app, and the
approved job work order (`work_orders.kind = 'job'`). Draft crew work orders
and draft purchase orders from an issued quote are section 6: built, and
switched off.
