# SecureWorks own-letterhead Roof Report - backend flow (2026-07-22)

Backend half of the trade-filled, own-letterhead roof report. The trade fills OUR
roof report through the app (toggles + inputs + free text + labelled photos) and
ops-api renders a branded PDF on SecureWorks Group letterhead, then advances the
make-safe reporting checklist. On reattendance, the route reads and submits only
the current attendance cycle and current-cycle photos. Mirrors the make-safe report
pipeline.

First consumer: SWMS-26861 (Caversham, MLB-17270PO-54939) and strata jobs where a
builder wants our template on their letterhead.

## ops-api actions added (bind the trade-app UI follow-up to these)

| Action | Method | Auth | Purpose |
|---|---|---|---|
| `roof_report_template` | GET (`?job_id=`) | trade JWT | Returns the field schema, the job header, and any existing draft for resume. |
| `save_roof_report` | POST | trade JWT | Draft-safe, idempotent upsert of the fill. Never renders, never advances the board. |
| `submit_roof_report` | POST | trade JWT | Validates the merged fill, renders OUR letterhead PDF, persists the final fill, advances the reporting checklist (substatus `admin_to_send_report` + cycle-scoped verification). Idempotent. |
| `render_roof_report` | POST | ops key / routine (routine-safe) | Re-render / preview: renders + attaches the PDF from the current draft without submitting or advancing the board. |

Request/response shapes:

- **save_roof_report** body: `{ job_id, fields: {<template keys>}, photos?: [{ url, label?, contentType? }] }`.
  Photo bytes are never persisted on the draft - only URL + label + contentType.
  Returns `{ ok, status:'draft', saved, draft_id, storey, price }`.
- **submit_roof_report** body: `{ job_id, fields?, photos?: [{ url|bytesBase64, label?, contentType? }] }`.
  Merges any request `fields` over the saved draft. Returns
  `{ ok, status:'submitted', draft_id, report_doc_id, file_name, render_hash, price, board_sync, event_sync }`.
- The completion route is selected from persisted server facts: `own_template`
  for an explicit own-template mode or existing roof draft, `builder_portal` for
  a known builder portal, `physical` for ordinary MakeSafe work, and `unknown`
  when a roof mode cannot be resolved. The trade surface is flag-only for any
  post-release billing review and does not choose a disposition.
- **roof_report_template** returns `{ template, job, draft }`.

## Storey pricing (double storey superseded 2026-08-06; see note below)

The `storeys` field is the pricing driver. CURRENT figures:

- Single Storey -> $250 ex GST / **$275 inc GST** (locked 2026-07-16,
  Marnin/Shaun, every builder; unchanged)
- Double Storey -> $300 ex GST / **$330 inc GST** (Captain ruling 2026-08-06,
  every builder)

**Supersession note (2026-08-06).** The original 2026-07-16 lock
(Marnin/Shaun) recorded "Double Storey -> $350 ex GST / $385 inc GST". The
Captain ruled on 2026-08-06 that double-storey roof reports are $300 ex GST /
$330 inc GST, explicitly superseding that $350/$385 figure. Ruling:
`data/decisions/2026-08-06-roof-report-pricing-300-double.md`. Single storey is
NOT superseded: its 2026-07-16 lock at $250 ex / $275 inc still stands. Any
$350/$385 figure elsewhere in this document is a dated 2026-07-22 record, not
the live price. The one authoritative in-repo constant is
`ROOF_REPORT_PRICING` in `supabase/functions/ops-api/roof_report_template.ts`.

Source: `secureworks-makesafe-reporting/references/pricing-and-invoice-rules.md`.
`roofReportPrice()` throws rather than guess an unrecognised storey, so a report
is never priced without the answer. Access/scope beyond a plain double storey is
scaled manually on the docket at release.

On forward make-safe intake, an ordinary roof-report work-order instruction may
provide that answer when it directly qualifies the ordered product (for example,
“single storey roof report”). Intake records that value as the structured
`jobs.metadata.storeys` fact consumed by pricing; the pricing path does not parse
narrative. Instructions with no product-qualified storey, conflicting counts, or
three or more storeys record no fact and remain blocked for a human price. This
is forward-only and does not backfill existing cards.

## Field set

Mirrors an MLB / Prime-portal "Roof Report" (generic + A&G/RAC variants),
grouped into sections: Inspection Details, Property Details (incl. Number of
storeys), Roof Findings (Yes/No toggles + narrative), Maintenance, Summary, and
labelled Photo Evidence. Full definition and types in
`supabase/functions/ops-api/roof_report_template.ts`
(`ROOF_REPORT_TEMPLATE_VERSION`, `ROOF_REPORT_FIELDS`).

## Where things live

- `roof_report_template.ts` - pure template + pricing + validation + field->job mapping (single source of truth).
- `roof_report_render.ts` - TS/jsPDF renderer on SecureWorks Group letterhead (mirrors `makesafe_report_render.ts`; render runs here, in ops-api, not in the wiki Python).
- `index.ts` - the four actions above; `roof_report` added to `attachMakesafeDocument` allowed doc types (NOT subject to the make-safe report-type gate, since generating our own report for report-type jobs is the point).
- Migration `20260722000001_makesafe_roof_report_drafts.sql` - `makesafe_roof_report_drafts` (one row per job, pack_kind `roof`; draft-safe, idempotent, RLS service_role only).

## Audit + safety

Every write records a `job_events` row (`roof_report_saved` / `roof_report_submitted`);
the PDF attach records `makesafe_document_attached`. All writes go through the edge
function's service client (RLS-safe). `--no-verify-jwt` deploy note still applies.
No em dashes in any rendered output (renderer sanitises; static labels are clean).

## Tests (zero production data writes; no network in the flow test)

- `roof_report_template_test.ts` - schema, locked pricing, storey normalisation, validation, field mapping (9 tests).
- `roof_report_render_test.ts` - renderer helpers + live jsPDF render incl. an em-dash byte scan (10 tests).
- `roof_report_flow_test.ts` - save/submit against in-memory fixtures with an injected render stub (8 tests): draft insert/idempotency, submit validation, render-job wiring, checklist advance, submit idempotency, board-sync failure.

## Sample

Rendered from SWMS-26861-style fixture data (Double Storey, $385 inc GST, 3
labelled photos): 4 pages, no em dashes, file name
`Roof Inspection Report - MLB-17270PO-54939-SWMS-26861 - Caversham-WA.pdf`.

The PDF binary is gitignored (repo policy: no `*.pdf` in git). Regenerate it with
the committed, reproducible generator:

```
deno run --allow-net --allow-write scripts/render-roof-report-sample.ts
# -> docs/evidence/roof-report-sample-fixture.pdf
```
