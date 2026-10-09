# Quote builder data contract (v1)

Backend for the quote builder: the single-page app Hugo uses on his iPad to
scope a job, price what it costs us, price what we charge, attach site photos,
and keep the client quote PDF as its own document. This file is the contract the
app builds against. The app itself lives elsewhere.

Status: v1. Code: `supabase/functions/ops-api/quote_builder.ts`. Migration:
`supabase/migrations/20261009120000_quote_builder_versions.sql`.

## 1. Access: edge-function actions, not browser tables

The app calls `ops-api` actions with the staff member's own Supabase session.
This is the same shape the fence and patio tools use today (`ghl-proxy`
`save_scope`: browser sends its user JWT, the function checks it and writes with
its own server credential).

- Sign in with the existing Supabase staff login (`supabase.auth.signInWithPassword`
  or the existing magic link). No service key, shared key or `SW_API_KEY` ever
  goes to the browser.
- Every call: `Authorization: Bearer <session.access_token>` and
  `apikey: <project anon/publishable key>`.
- Base URL: `https://<project>.supabase.co/functions/v1/ops-api?action=<name>`.
- Reads are `GET` with query params. Writes are `POST` with a JSON body.
- Who may call: staff roles `admin`, `owner`, `ops_manager` (Hugo is
  `ops_manager`). Any other signed-in user gets `403 operator_access_required`.
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
| Site photos + captions | `job_media` (`phase='scope'`, `type='photo'`, caption in `label`) | Files in Storage bucket `job-photos`. Same table the trade app and boards already read. |
| Client quote PDF | Storage bucket `job-pdfs` + one `job_documents` row (`type='quote'`) | Its own document, linked from the version. |
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
returns the job already made (`"created": false`) instead of a second job.

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
  Each must belong to this job.

Allowed jobs: repair-family jobs (`jobs.type='repair'` or the repair family
markers the Repairs board reads) and `miscellaneous` jobs. Anything else is
`409 job_not_quotable` (make-safe cards stay with the SES pack system).

Returns `{ "version": <version object> }`.

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
checks the file is really in Storage before writing the row.

Change a caption later with `POST quote_builder_photo_caption`
`{ "photo_id": "uuid", "caption": "..." }`.

### 5.6 `POST quote_builder_pdf_upload_url` then `POST quote_builder_issue`

The app renders the client quote PDF itself (charge lines only, no internal
costs), uploads it, then issues.

1. `{ "version_id": "uuid of the draft" }` -> `{ "path", "signed_url", "token", "quote_number" }`.
   Upload with `PUT <signed_url>`, `Content-Type: application/pdf`, max 20 MB.
   Print `quote_number` on the PDF (e.g. `SWR-26123-Q2`, or `SWR-26123-V1.2` for
   version 2 of variation 1).
2. `{ "version_id": "uuid", "pdf_path": "<path from step 1>" }`.

Issue checks the PDF is in Storage, then:

- writes a `job_documents` row (`type='quote'`, `quote_number`, `storage_url`,
  `pdf_url`, `visible_to_trades=false`, metadata names the version);
- freezes the version (`status='issued'`, `issued_at`, `issued_by`, PDF linked);
- for a variation: creates (first issue) or updates (re-issue while still
  pending) its `job_variations` row: `amount` = charge total inc GST,
  `cost_estimate` = cost total ex GST, `status='pending_approval'`. A variation
  already approved or rejected cannot be re-issued (`409 variation_decided`;
  start a new variation instead);
- on a repair job, moves the stage forward per section 3.

Nothing is emailed or texted to anyone. Sending the PDF is a separate step
outside this contract.

Returns:

```json
{
  "version": { ...frozen version... },
  "document": { "id": "...", "quote_number": "SWR-26123-Q2", "url": "https://..." },
  "variation": null,
  "stage": { "moved": true, "from": "scoping", "to": "quoted" }
}
```

`stage` is `{ "moved": false, "reason": "not_a_repair_job" | "already_past_stage", ... }`
when nothing moved. A stage write that loses a race returns
`moved: false, reason: "stage_write_failed"` and the issue still stands.

### 5.7 `POST quote_builder_decide_variation`

```json
{ "variation_id": "uuid", "approved": true, "notes": "Builder approved by email 9 Oct" }
```

Records the decision on `job_variations` through the existing variation approval
path, then moves a repair job to `approved` when approved. Returns
`{ "approved": true, "variation_id": "...", "stage": { ... } }`.

## 6. Out of scope for v1

GHL, Xero, sending to clients, intake changes, the Ambrose Construct Group
builder record, actual-cost capture, and moving a private job's status.
