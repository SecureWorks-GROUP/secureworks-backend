# Visit outcome business records

`ops-api` exposes `record_visit_outcome` and `list_visit_outcomes` beside the Sales Booking actions. The authoritative store is `public.visit_outcomes`, introduced by `20260921160000_visit_outcomes.sql`. Handler: `supabase/functions/ops-api/visit_outcomes.ts`.

An outcome is a human-recorded business fact about one booked visit. It is not inferred from a pipeline stage, an appointment's provider status, or message text. Recording it only appends to this store. It sends no customer message, creates no calendar entry, and makes no GHL request or pipeline change.

## Access

Use the existing ops-api endpoint with the action in the URL query string. The Booking screen sends `Authorization: Bearer <Supabase user JWT>`. Existing Booking operator access applies: server-owned `users.role` must be `admin`, `owner`, or `ops_manager`. A caller cannot supply their own role or recording identity.

Writes require a user JWT, including when the caller otherwise holds an internal server secret. Reads also admit the existing distinct server-only credential route for the context reader. The legacy shared browser key alone, routine key, anonymous users, and non-operator JWT callers cannot use these actions. Browser clients have no direct table or RPC permission. No new credential is introduced.

## POST record_visit_outcome

Example request to `?action=record_visit_outcome`:

```json
{
  "booking_key": "booking:scope:123",
  "appointment_id": null,
  "contact_id": "ghl-contact-id",
  "opportunity_id": "ghl-opportunity-id",
  "job_id": null,
  "scoper_user_id": "5862cf1d-0a3b-4836-8fd1-d69f95aa2f73",
  "scoper_name": "Nithin",
  "visit_start": "2026-09-15T10:00:00+08:00",
  "outcome": "happened",
  "reason": null,
  "note": "Measured patio; quote due",
  "quote_owed": true,
  "supersedes": null
}
```

| Field | Request contract |
| --- | --- |
| `booking_key` | Required non-empty string, max 300 characters. Pass the original booking idempotency key unchanged; do not generate a new key per tap or per outcome. |
| `appointment_id` | GHL appointment ID, nullable/omittable until the appointment exists, non-empty string max 300 when supplied. |
| `contact_id` | Required GHL contact ID, non-empty string max 300. |
| `opportunity_id` | Nullable/omittable GHL opportunity ID, non-empty string max 300 when supplied. |
| `job_id` | Nullable/omittable SecureWorks job UUID. |
| `scoper_user_id` | Required SecureWorks user UUID, not a GHL user ID. |
| `scoper_name` | Required display name, non-empty string max 200. |
| `visit_start` | Required real ISO datetime, seconds required, optional 1-3 fractional digits, with `Z` or explicit `±HH:MM` offset. Stored as `timestamptz`; equivalent instants compare equal. |
| `outcome` | Required `happened` or `did_not_happen`. |
| `reason` | Null/omitted for `happened`. Required `customer_not_home`, `we_did_not_attend`, or `rescheduled` for `did_not_happen`. |
| `note` | Optional/null, one line, max 200 Unicode characters. Empty string becomes null. Control characters and line separators are rejected. |
| `quote_owed` | Optional boolean. Defaults to true for `happened`, false otherwise. Explicit false preserves the scoper's untick. It is stored independently of pipeline state. |
| `supersedes` | Null/omitted for the first outcome; UUID of the current outcome for any correction. |

Strings are trimmed and must be one line. Optional text fields other than `note` reject an empty string. Omitted nullable fields are stored as null. Unknown fields are ignored. Client-supplied `id`, `recorded_by_user_id`, `recorded_at`, and `source` are ignored: the database generates the UUID and timestamp, the verified JWT supplies the actor, and the source is always `booking_screen`.

Response: HTTP 200, including a duplicate tap. The returned record always has exactly the following fields; dates are ISO timestamps with an offset, which may be normalized to UTC:

```json
{
  "visit_outcome": {
    "id": "b33c13b4-fcbb-423e-91ed-3554444d21e9",
    "booking_key": "booking:scope:123",
    "appointment_id": null,
    "contact_id": "ghl-contact-id",
    "opportunity_id": "ghl-opportunity-id",
    "job_id": null,
    "scoper_user_id": "5862cf1d-0a3b-4836-8fd1-d69f95aa2f73",
    "scoper_name": "Nithin",
    "visit_start": "2026-09-15T02:00:00+00:00",
    "outcome": "happened",
    "reason": null,
    "note": "Measured patio; quote due",
    "quote_owed": true,
    "recorded_by_user_id": "5862cf1d-0a3b-4836-8fd1-d69f95aa2f73",
    "recorded_at": "2026-09-21T06:00:00+00:00",
    "source": "booking_screen",
    "supersedes": null
  }
}
```

The 30-second sliding double-tap window is enforced inside a PostgreSQL transaction, serialized per booking key. Identical normalized payloads from the same actor return the current row, including retries of a correction. This includes `(booking_key, recorded_by_user_id, outcome, reason, note)` and also compares `quote_owed`, identity fields and `supersedes`, so a changed checkbox or corrected visit detail is never swallowed as a duplicate. Timestamps and IDs supplied by the caller do not affect deduplication.

Corrections send the complete record fields with `supersedes` equal to the last returned current ID. The prior row remains unchanged. A stale/cross-booking pointer, an implicit second outcome without `supersedes`, or a first-outcome retry after the window returns HTTP 409. On conflict, re-read the current row before offering a correction. There is no update/delete endpoint; the database also refuses UPDATE, DELETE and TRUNCATE, and service-role inserts must go through the RPC. Linking a later GHL appointment uses the same explicit correction mechanism, not an update.

## GET list_visit_outcomes

Query parameters:

| Parameter | Contract |
| --- | --- |
| `since` | Required ISO datetime with offset; inclusive `visit_start` lower bound. |
| `until` | Required ISO datetime with offset; exclusive `visit_start` upper bound. Must be after `since`, at most 366 days later. |
| `scoper_user_id` | Optional user UUID; exact filter. |
| `contact_id` | Optional GHL contact ID; exact filter. |
| `include_history` | Optional `true` or `false`, default false. |
| `limit` | Integer 1-500, default 100; counts current bookings, not history rows. |
| `offset` | Integer 0-1000000, default 0. Advance by `limit` while `has_more` is true. |

URL-encode offsets (`+08:00` must encode the `+` as `%2B`), or construct the query with `URLSearchParams`. Example logical query: `action=list_visit_outcomes`, `since=2026-09-14T00:00:00+08:00`, `until=2026-09-21T00:00:00+08:00`, `contact_id=ghl-contact-id`.

```json
{
  "outcomes": [],
  "limit": 100,
  "offset": 0,
  "has_more": false
}
```

`outcomes` contains full records in the response shape above, one current row per `booking_key`, ordered by `visit_start` ascending, then `booking_key` ascending. Current means the row with no successor, enforced by a single correction chain. Supersession is resolved globally before applying any date, contact or scoper filter. A corrected date/contact therefore never resurrects an old record.

With `include_history=true`, an additional `history` array contains **all** records, including current, for bookings on that page, ordered by `booking_key`, `recorded_at`, then `id`. Historical rows are included even if their previous date/contact/scoper values no longer match the query. No history for off-page bookings is returned. An empty successful history read returns `history: []`. A page is a single database snapshot; separate page requests may see concurrent changes, so consumers should deduplicate by record ID and refresh when reconciling an actively edited range.

## Context reader interpretation

Read `list_visit_outcomes` as a business-record source, correlate by `contact_id`, optional `opportunity_id`/`job_id`, and preserve `booking_key`, `visit_start`, actor, record ID and timestamp as provenance. A current `happened` + `quote_owed:true` records that the visit happened and a quote is owed even if the GHL pipeline is stale. Do not reclassify that customer as an unvisited stale lead solely from GHL stage. `did_not_happen` is a recorded non-attendance with its explicit reason, not a guess from a calendar status. Absence of an outcome is unknown, not evidence of a missed visit.

`quote_owed` reflects what the scoper recorded at that time. This endpoint does not monitor quote delivery or automatically clear the flag; use newer quote business records to establish whether the obligation has since been fulfilled. A record is human evidence, not independent attendance verification. Read history only for audit; do not treat superseded outcomes as current facts. This change supplies the reader contract, not a change to the separate context runtime. The CIO-owned context-reader change 170 consumes this record shape.

## Errors

Errors use the existing ops-api JSON envelope (`error` string, optionally its existing `code`). HTTP 400 means invalid input, 401 means missing/invalid user authentication, 403 means insufficient Booking operator access, 405 means wrong method, 409 means correction conflict, and 503 means the outcome store failed or returned no result. A failed read never becomes an empty successful list. Existing front-door auth gates may refuse a request before method validation.

## Booked visits and delivery notes

`list_visits_missing_outcome` is intentionally not supplied as a separate action. `sales_booking_read` composes the durable appointment ledger and outcome histories; owner: `docs/sales-booking-confirmation-api.md`. This document owns only `record_visit_outcome` / `list_visit_outcomes`. Neither a busy diary entry nor a cached proposal proves a booked visit.

Apply `20260921160000_visit_outcomes.sql` before a separately authorised ops-api deployment. **ops-api deploys require `--no-verify-jwt`.** This task neither applies a migration to a live database nor deploys an edge function.

Validation uses the existing Deno test harness (`deno test --allow-read supabase/functions/ops-api/visit_outcomes_test.ts`) and the registered disposable PostgreSQL migration-contract runner (`supabase/tests/migration-contracts/run.sh`). The database contract exercises append-only rules, correction chains, filtered current/history reads, paging, client privilege denial and concurrent double taps. No live fact or deployment is asserted by these tests.

Local implementation validation on 2026-09-21: 123 Deno tests passed across visit outcomes, sales booking read, sales booking packs and ops-api operator auth; `deno check supabase/functions/ops-api/index.ts` and lint of the new handler/tests passed. The full registered PostgreSQL 17 migration-contract suite passed in a task-owned disposable localhost cluster, including the new concurrent-session test and deliberate append-only-trigger break. No production database or deployment was used.
