# Quote builder data contract (v1)

Backend for the quote builder: the single-page app Hugo uses on his iPad to
scope a job, price what it costs us, price what we charge, attach site photos,
and keep the client quote PDF as its own document. This file is the contract the
app builds against. The app itself lives elsewhere.

Status: v1, implemented. Code: `supabase/functions/ops-api/quote_builder.ts`. Migrations:
`supabase/migrations/20261009120000_quote_builder_versions.sql` and
`supabase/migrations/20261013160000_quote_builder_pricing_and_orders.sql` (pricing
settings, line types, the two extra documents, the job's value, and the work
order and purchase orders made from an issued quote: sections 2b to 2d, 5.6,
5.8 and 5.9).

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
- Who may call, every action including the two that make orders: staff roles
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
| Scope of works PDF | Storage bucket `job-pdfs` + one `job_documents` row (`type='other'`, `metadata.quote_builder_document = 'scope_of_works'`) | Filed at issue beside the quote when the app sends it (5.6). It carries no prices. Never visible to trades. |
| Material order list | Not filed anywhere | It prints our costs, and `job-pdfs` is a public bucket (read in production, 13 Oct 2026), so the server gives it no upload slot and files no document. The app shows and prints it on demand from the version's saved cost lines (5.6). |
| Pricing settings (labour rate, materials multiplier, target margin) | `quote_builder_settings` (section 2c) | Read only by `ops-api`. |
| The job's value | `jobs.pricing_json`, behind a guard (section 2d) | Written on a scope issue and a variation approval, so the Repairs card shows money. |
| Draft crew work order, draft purchase orders | `work_orders`, `purchase_orders` (`quote_builder_version_id` names the version) | Made only by their own actions (5.8, 5.9), on a button press. |
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
- The type decides what an order takes (5.8, 5.9): Labour lines go on the work
  order as hours, Material lines go on purchase orders.

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

| `setting_key` | Meaning | Allowed |
|---|---|---|
| `insurance_labour_rate_ex_gst` | Dollars per hour charged for labour on an insurance repair, ex GST | above 0, up to 1000 |
| `insurance_materials_multiplier` | Client price of a material = our cost times this | 1 to 10 |
| `target_margin_pct` | Target gross margin, percent | above 0, up to 95 |

The first two are seeded by the migration with the owner's starting values of
13 Oct 2026. The target has no row until the owner names one. The numbers are
changed by a database update (the bounds above are a database check); there is
no settings write action yet, so `can_edit_settings` is always `false`.

The table has row-level security on with no policy and is revoked from `anon`
and `authenticated`, like `quote_builder_versions`. It is not `org_config`:
that table is readable by every signed-in user of the organisation, trades
included, and what we charge a builder per hour is not a trade's to read.

`quote_builder_get_job` returns them as `settings` (5.2). A missing row, or a
value that is not a number, is `null`. The server has no fallback number. How
the app prices with them (labour at the rate, materials at cost times the
multiplier, other lines by the markup the user types, private quotes by markup
only) is the app's rule; the server stores whatever charge lines it is sent.

### 2d. The job's value

`jobs.quoted_value` is a column the database works out from
`jobs.pricing_json.totalIncGST`, and the Repairs card reads the same field. So
the builder writes `pricing_json`:

    job value = latest issued scope version's charge total
              + the latest issued version of each variation whose
                job_variations.status is 'approved'

```json
{ "totalIncGST": 2893.00, "totalExGST": 2630.00, "gst": 263.00,
  "source": "quote_builder",
  "quote_builder": { "scope_version_id": "...", "quote_number": "...", "variation_ids": [], "written_at": "..." } }
```

It is written when a scope version is issued and when a variation is approved.
Issuing a variation, or rejecting one, writes nothing.

The guard (`quoteBuilderMayWriteJobValue`), both halves required:

- the job's current `pricing_json` is null, `{}`, or already carries
  `"source": "quote_builder"`. Anything else belongs to another tool (the fence
  and patio tools, a CRM opportunity value) and is left exactly as it is; the
  reply says `priced_by_another_tool`.
- `jobs.type` is `repair` or `miscellaneous`. A repair card typed `fencing` or
  `makesafe` is never written, even with empty pricing: `createInvoice` prices a
  job from `pricing_json` when it is given no lines, and those types are priced
  by the fence tool and the SES invoice path. Such a card whose pricing is empty
  (or the builder's own) is not priced by another tool, so the reply says
  `job_type_not_valued_here` instead; its Repairs card shows no money from this
  quote.

The write carries the job's row version, so a pricing write by another tool in
between is never overwritten. A value that cannot be written never fails the
issue or the decision; the response says what happened (`job_value`, 5.6).
Quotes issued before this change keep whatever value they had: nothing goes back
and sets one.

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
  "documents": [ { "id": "...", "quote_number": "SWR-26123-Q2", "url": "https://...", "version_id": "...", "created_at": "..." } ],
  "extra_documents": [ { "id": "...", "document": "scope_of_works", "url": "https://...", "file_name": "...",
                         "version_id": "...", "quote_number": "SWR-26123-Q2", "superseded": false, "created_at": "..." } ]
}
```

- `settings` is always present (section 2c): each value a number or `null`. Its
  presence is what switches the app's line types and pricing bar on. The values
  shown above are placeholders, not the real numbers.
- `can_edit_settings` is `false` for everyone until a settings write action
  exists.
- `documents` is the client quote PDFs only. The scope of works PDFs filed at
  issue are in `extra_documents`, one entry per filed PDF (`document` is always
  `scope_of_works`); `superseded` is true once a later version of the same chain
  is issued. The material order list is never in either list: it is not filed.

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
  "issued_by": null, "issued_at": null,
  "work_order": null,
  "purchase_orders": []
}
```

On `quote_builder_get_job` only, each version also says what was already made
from it: `work_order` is `{ "id", "wo_number", "status" }` or `null`, and
`purchase_orders` is a list of `{ "id", "po_number", "supplier_name", "status" }`
(cancelled and deleted orders are left out). The app shows these in place of the
"make" buttons.

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

1. `{ "version_id": "uuid of the draft" }` -> `{ "document", "path", "signed_url", "token", "quote_number" }`.
   Upload with `PUT <signed_url>`, `Content-Type: application/pdf`, max 20 MB.
   Print `quote_number` on the PDF (e.g. `SWR-26123-Q2`, or `SWR-26123-V1.2` for
   version 2 of variation 1).
2. `{ "version_id": "uuid", "pdf_path": "<path from step 1>" }`.

To file the scope of works on the job as well (optional; an issue without it
works as before):

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

The scope of works PDF sits beside the client quote in a public bucket, so the
app must print no cost, rate, multiplier or margin figure on it. The server
stores none on its `job_documents` row: no lines, no totals, no settings.

**The material order list is not filed.** It prints our costs, and every file
in `job-pdfs` has a public address that can be worked out from the client quote
link. So `document: "material_order_list"` is `400 invalid_input` on both the
upload slot and the issue: the server gives it no slot, stores no file and
files no document. The app must not ask for one. The list stays available in
the app on demand, built from the version's saved cost lines, and its data is
already on the job (the version, and the purchase orders of 5.9). Filing it
waits on private storage with signed links, a separate change that needs the
owner's say.

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
- for a scope version, writes the job's value (section 2d), before the stage
  move;
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
  "extra_documents": [ { "id": "...", "document": "scope_of_works", "url": "https://...", "file_name": "..." } ],
  "variation": null,
  "job_value": { "written": true, "total_inc_gst": 715.00 },
  "stage": { "moved": true, "from": "scoping", "to": "quoted" }
}
```

`job_value` is present on a scope issue and absent on a variation issue:

| `job_value` | Meaning |
|---|---|
| `{ "written": true, "total_inc_gst": 715.00 }` | The job's value is now this. |
| `{ "written": false, "reason": "priced_by_another_tool" }` | Left alone: the job's pricing was written by another tool (section 2d). |
| `{ "written": false, "reason": "job_type_not_valued_here" }` | Left alone: the job has no pricing from another tool, but it is a repair card typed `fencing` or `makesafe`, which the builder never values (section 2d). |
| `{ "written": false, "reason": "write_failed" }` | Could not be written just now. The quote is still issued. |
| `{ "written": false, "reason": "nothing_issued" }` | No issued scope to value. |

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
`{ "approved": true, "variation_id": "...", "job_value": { ... }, "stage": { ... } }`.
An approval rewrites the job's value (section 2d) and returns `job_value` in the
shape of 5.6; a rejection writes nothing and returns no `job_value`.

### 5.8 `POST quote_builder_make_work_order`

```json
{ "version_id": "uuid of an issued version" }
```

Makes one **draft crew work order** on the version's job. The job always comes
from the version; a `job_id` in the body is ignored. It is a crew work order
(`work_orders.kind = 'crew'`), never the approved job work order of
`docs/job-work-orders-v1.md`, which this action does not touch. Nothing is sent
to a trade.

`scope_items` is the scope of works text, then one item per Labour cost line
(its description, the hours as `qty`, and its unit, `hr` when the line has
none):

```json
[ { "description": "Scope of works", "notes": "<the version's narrative>" },
  { "description": "Carpenter on site", "qty": 8, "unit": "hr" } ]
```

Only these four keys are written. Each is on the list the Trade app's work
order read keeps (`TRADE_WO_SCOPE_ITEM_ALLOWLIST`), so an allocated trade reads
every line; a key off that list would reach the crew as a blank line. A crew
work order is read by trades, so no cost and no price goes on it.
`special_instructions` is `From quote <quote number>`. `created_by` is the
signed-in user's id.

Marking the job accepted does not approve this work order. The acceptance step
that approves a job's other draft crew work orders leaves out any order made
from a quote builder version; it is approved only by a person, through the
existing work order approval.

Returns `{ "created": true, "work_order": { "id", "wo_number", "status" } }`.
A second call makes nothing and returns the first with `"created": false`
(`ux_work_orders_quote_builder_version`: one live work order per version; a
cancelled one frees it).

Refusals, nothing made: `404 version_not_found`; `409 version_not_issued` (a
draft); `409 nothing_for_work_order` (no scope text and no Labour line);
`409 work_order_text_has_money` (the scope text, or a Labour line's description
or unit, mentions a dollar amount, which must not reach a trade: issue a new
version without it, or write the work order by hand).

### 5.9 `POST quote_builder_make_purchase_orders`

```json
{ "version_id": "uuid of an issued version" }
```

Makes one **draft purchase order per supplier** from the version's Material cost
lines, on the version's job. Supplier names are matched without regard to case.
Each order has `status='draft'`, `reference` = the job number and `line_items`
`[{ "description", "quantity", "unit", "unit_price" }]`, where `unit_price` is our
unit cost ex GST. Material lines with no supplier share one draft named
`No supplier named`, with the note "Supplier not named on the scope". Labour,
Other and untyped lines are on no purchase order. Nothing is emailed to a
supplier and nothing goes to Xero.

Returns `{ "created": 2, "purchase_orders": [ { "id", "po_number", "supplier_name", "status" } ] }`:
`created` is how many this call made, and the list is every live purchase order
of the version. `created_by` on each is the signed-in user's id.

Once any live purchase order exists for the version, a further call makes
nothing, whatever the suppliers are called now. It returns `"created": 0`, the
live orders, and a `message` naming them, for example "Purchase orders were
already made from this quote: PO-123456 (Bunnings), PO-123457 (Reece). Nothing
more was made. ...". So an order renamed since it was made (the unnamed one
given its supplier) is never made a second time. The cost: a first call that
made some orders and then failed is **not topped up** by a second call. Add the
missing order by hand, or cancel the ones made and call again (with no live
order left, the full set is made again). Two calls at the same moment are held
to one order per supplier by `ux_purchase_orders_quote_builder_version_supplier`.

Nothing here reaches Xero without a person's own push:

- Marking the job accepted does not push these orders. The acceptance step that
  pushes a job's other draft purchase orders to Xero leaves out any order made
  from a quote builder version.
- `push_po_to_xero` refuses a quote builder order that still has no supplier
  (`No supplier named`, or a blank name) with `409 po_supplier_not_named`,
  before Xero is asked for anything, so a Xero contact of that name can never be
  made. Set the supplier on the order (`update_po`), then push.

Refusals, nothing made: `404 version_not_found`; `409 version_not_issued`;
`409 no_material_lines`.

## 6. Out of scope for v1

GHL, Xero, sending anything to a client, builder, supplier or trade, intake
changes, the Ambrose Construct Group builder record, actual-cost capture, moving
a private job's status, changing the pricing settings from the app, and the
approved job work order (`work_orders.kind = 'job'`).
