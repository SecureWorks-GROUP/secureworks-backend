# GHL appointment write contract

`POST /functions/v1/ghl-proxy?action=create_calendar_appointment` is the one new
appointment write. The implementation is `supabase/functions/ghl-proxy/calendar_appointment.ts`;
its Supabase adapter is `calendar_appointment_ledger.ts`. The agent-side caller
is in another repository and is outside this change.

## Request and authority

Use JSON with exactly these fields (unknown fields are refused):

```json
{
  "calendarId": "exact-calendar-id",
  "assignedUserId": "exact-ghl-user-id",
  "contactId": "exact-existing-contact-id",
  "startTime": "2026-10-01T10:00:00+08:00",
  "endTime": "2026-10-01T11:00:00+08:00",
  "title": "Site visit",
  "address": "1 Example Street, Perth",
  "idempotencyKey": "persisted-unique-booking-request-key"
}
```

Optional `"dryRun": true` forces a preview even when writes are enabled; any
other `dryRun` value is refused. It can only remove a write. Optional
`"executorClaim"` is the executor's per-press UUID; a real write requires it
to match the live `sales_booking_executions` calendar claim. Any other
`executorClaim` value is refused.

All other fields are required strings. IDs accept letters, digits, underscore and
hyphen, up to 200 characters. Title is 1–200 characters, address 1–1000,
and idempotencyKey 1–200; these three reject leading/trailing whitespace and
control characters. Times require a real ISO date, seconds and explicit `Z` or
`±HH:MM` offset, with optional 1–3 fractional digits. End must follow start;
a new appointment must start in the future. The idempotency key must be persisted
by the caller before the first request and reused with the identical payload.
Never substitute a new key after an uncertain result.

The configured `GHL_LOCATION_ID` is authoritative. Contacts are fetched by exact
ID and must report that ID and location. No name lookup or contact creation occurs.
The calendar must be active in the location directory, assigned to the requested
user, and that user must exist in the location roster. Missing calendar assignment
evidence makes the read incomplete, not permission to guess.

Existing proxy credential verification runs first. The action accepts the
service-role credential, or a verified user JWT with a same-organisation database
profile in `admin`, `estimator`, `sales`, `ops_manager`, or `division_ops`.
The browser-distributed `SW_API_KEY` is refused even while the general browser JWT
rollout flag is off. `OPS_AGENT_SERVER_KEY` remains dedicated to existing provider
read actions; this change does not grant it appointment-write authority. The agent
integration must use an already-authorized server credential. Credentials never go
in the JSON body or client code.

## Captain approval and executor claim required for a real write

A real write requires `idempotencyKey` to be the binding hash of a live
`sales_booking_approvals` calendar approval, made by an allow-listed captain
(`SALES_BOOKING_CAPTAIN_EMAILS`), unexpired, untampered, and approving exactly
this calendar, assignee, contact, start, end, title and address. It also
requires the ops-api executor to have claimed that hash in
`sales_booking_executions` for this press: optional request field
`executorClaim` must match the row's `press_token`, the row must be
`step=calendar` and not yet booked, and `claimed_at` must be within the last
two minutes. Otherwise the action refuses HTTP 409
`{ok:false, code:"approval_required", reason}` before reserving or posting;
`reason` is one of `approval_not_found`, `approval_unreadable`,
`approval_step_mismatch`, `approval_not_approved`, `approval_not_by_captain`,
`content_hash_mismatch`, `approval_expired`, `executor_claim_missing`,
`executor_claim_mismatch`, `executor_claim_expired`,
`executor_claim_unreadable`. A live approval without the executor's claim is
not enough: no caller can book around the executor. Replays of a completed key
and recovery of a `sending` key never post and are unaffected. Previews never
refuse on approval or claim; they report
`approval: {state:"live"|"missing", reason}`. The ops-api executor is the
intended caller: `docs/sales-booking-executor.md`.

## Default-off preview and provider payload

Only the exact server environment value
`GHL_CALENDAR_APPOINTMENT_WRITE_ENABLED=true` enables writes. Unset, false,
other values, and every `testMode=true` route remain dry run. After input,
contact, directory, roster and complete window validation, a dry run returns HTTP
200:

```json
{
  "ok": false,
  "code": "flag_off",
  "dryRun": true,
  "wouldWrite": {
    "method": "POST",
    "path": "/calendars/events/appointments",
    "version": "2023-02-21",
    "body": {
      "calendarId": "exact-calendar-id",
      "assignedUserId": "exact-ghl-user-id",
      "contactId": "exact-existing-contact-id",
      "startTime": "2026-10-01T10:00:00+08:00",
      "endTime": "2026-10-01T11:00:00+08:00",
      "title": "Site visit [SW booking:<64 lowercase hex characters>]",
      "address": "1 Example Street, Perth",
      "locationId": "server-configured-location",
      "appointmentStatus": "confirmed",
      "toNotify": false,
      "ignoreDateRange": false,
      "ignoreFreeSlotValidation": false
    }
  }
}
```

The response contains the actual deterministic marker, not the example placeholder.
It hashes location plus idempotency key and is appended to the provider-visible
title because GHL documents title on event reads, but no native create-idempotency
key. The marker is visible to staff and in any later owner-controlled rendering of
the appointment. Keep it intact: it is the recovery identity for a lost POST response.
No request ledger read/write, appointment write, notification, or configuration
write is performed in dry run. Validation refusals take precedence over `flag_off`.
Caller fields cannot override location, status, notification or availability flags.

## Responses for the caller

Successful creation or replay is HTTP 200:

```json
{
  "ok": true,
  "appointmentId": "provider-event-id",
  "calendarId": "exact-calendar-id",
  "startTime": "2026-10-01T10:00:00+08:00",
  "endTime": "2026-10-01T11:00:00+08:00",
  "reused": false
}
```

Times are the provider's returned ISO strings, representing the requested instants.
`reused: true` means the first result was returned from the ledger or recovered
from GHL. Completed retries remain readable even after the start time passes.

Refusals have `{ "ok": false, "code": "...", "reason": "..." }`;
`reason` is optional and fixed by the server. No raw provider or database text is
returned.

| Code | HTTP | Meaning / caller response |
| --- | --- | --- |
| `flag_off` | 200 | Validated preview only. Do not report a booking as made. |
| `dry_run` | 200 | Same preview, because the caller sent `dryRun: true` while writes are enabled. |
| `approval_required` | 409 | No live captain approval of these exact fields, or no matching executor claim for this press. Do not book. |
| `overlap` | 409 | Person already busy or a durable reservation holds the window. Do not book. |
| `read_failed` | 502 | Contact/directory/roster/window could not be read completely. Retry the same key; never call it free time. |
| `contact_not_found` | 404 | Explicit contact 404 or no exact contact in the configured location. |
| `invalid_window` | 400 | Invalid, reversed or past new-booking window. |
| `invalid_request` | 400 | Missing/invalid/extra input, or `reason: calendar_user_not_available`. |
| `invalid_request` | 409 | `reason: idempotency_key_reused`: different payload under the same key. |
| `provider_error` | 502/503 | Provider or ledger failure. Retry the same key only. |
| `method_not_allowed` | 405 | Use POST. |
| `forbidden` | 403 | Caller lacks appointment-write authority. |

Fixed optional `provider_error` reasons are `request_in_progress`,
`reservation_lost`, and `outcome_unknown`. Existing proxy authentication failures
retain their existing 401/403 envelope. `provider_error` without a reason also
requires same-key retries; it is not proof that GHL did nothing.

## Overlap, concurrency and partial failures

Immediately before POST, the action reuses `fetchGhlCalendarEvents` to read the
user diary and every assigned calendar separately, including the requested one.
All reads must succeed with an explicit events array. Missing arrays, malformed
entries/times and explicit incomplete receipts refuse. The stricter wrapper is
local to this action; legacy read-only responses are unchanged. Non-cancelled,
non-invalid events with intersecting `[start,end)` intervals block the person.
Other explicitly assigned users are excluded; missing assignee is conservative
busy evidence. Adjacent appointments do not overlap.

The service-only, RLS-enabled `ghl_calendar_appointment_requests` ledger scopes
keys by location. A database transaction locks the key and the person, across
calendar IDs, and reserves the window for 90 seconds. The final transition to
`sending` uses the same person lock, a per-attempt UUID and the database clock.
Expired workers cannot send after another reservation. Two concurrent requests
through this action cannot both reserve an overlapping person/window.

Pre-send refusals release the lease. Pre-send crashes become resumable when the
90-second lease expires, always re-reading the provider window. A `sending` row
never expires or automatically re-posts: the provider may have accepted a request
even if the response was lost. Retry reads the selected calendar and recovers only
one exact stamped title plus calendar/contact/user/start/end match. Successful
recovery completes the ledger; a failure to persist a known result follows this
same path. An empty or ambiguous recovery window returns `outcome_unknown` and
retains the fence. This also covers a crash after marking sending but before POST.
Such unresolved cases require owner-authorized investigation; this action has no
reset, new-key fallback, deletion, or operator reconciliation write. The one way
out is the separate captain release below.

Completed reservations conservatively continue to block another key for that
person/window, even if an owner later cancels the provider appointment. Cancellation,
rescheduling and releasing completed reservations are outside this version.

The local reservation serializes this action only. It cannot transactionally lock
external GHL UI/API writers. GHL's own slot validation stays enabled; simultaneous
external writes, provider-linked calendars, buffers and availability policies
remain subject to the owner's provider configuration. This change does not claim
a production-proven global booking guarantee or alter those settings.

## Releasing a stuck sending row

`POST /functions/v1/ghl-proxy?action=release_calendar_appointment_request`
exists because a `sending` row never expires: one lost provider answer used to
freeze that person's window forever. Only the service-role credential or a
same-organisation user JWT whose email is on `SALES_BOOKING_CAPTAIN_EMAILS`
may call it; every other caller gets 403
`{ok:false, code:"forbidden", reason:"captain_or_service_role_only"}`.

```json
{ "idempotencyKey": "the stuck key", "reason": "Checked GHL by hand: no appointment exists.", "commit": true }
```

Unknown fields are refused. `reason` is 10 to 500 characters with no control
characters. Without `commit: true` the call is a read-only preview:
`{ok:true, dryRun:true, wouldRelease, blocker?, request}` where `blocker` is
`already_released`, `not_sending` or `too_recent`, or HTTP 404 `not_found`.
With `commit: true`, the service-only database function
`release_ghl_calendar_appointment_sending` takes the same key and person locks
as a reservation and moves the row from `sending` to the terminal `released`
state, recording `released_at`, `released_by` (the captain's email or
`service_role`) and `release_reason`. It acts only when the post started more
than ten minutes ago (the lease ended over ten minutes back), so a live worker
is never cut off; otherwise HTTP 409 `too_recent`. A `reserved` or `complete`
row answers 409 `not_sending`; a second release answers 200 with
`alreadyReleased: true` and the first record. A ledger fault is 503
`ledger_error`, never a release. Nothing is deleted and nothing is posted to GHL.

Release only after checking GHL: the fence exists because the post may have
landed. A released row stops blocking that person's window, while GHL's own
slot validation and the pre-post window read still see any appointment that did
land. The released key is terminal: a later create with that key answers 409
`invalid_request` with `reason: request_released` and never recovers, reserves
or posts. Book the slot again under a new captain approval.

## Notification evidence and owner workflow boundary

The provider POST sets exactly `toNotify: false`, `ignoreDateRange: false`,
`ignoreFreeSlotValidation: false`, and `appointmentStatus: confirmed`.
GHL's [create appointment API](https://marketplace.gohighlevel.com/docs/2023-02-21/ghl/calendars/create-appointment/)
documents `toNotify: false` as suppressing automations. The two false ignore flags
retain provider scheduling notice/date-range and slot validation. There is no
separate invented SMS flag and no call to a messaging endpoint.

GHL also documents an [AppointmentCreate webhook](https://marketplace.gohighlevel.com/docs/webhook/AppointmentCreate/).
This code cannot audit, disable or guarantee suppression of the owner's independent
Appointment Created/Customer Booked Appointment or Appointment Status workflows,
webhook consumers, integrations, or subsequent status-change automations. Those
could still trigger downstream messages according to GHL-side configuration.
Production notification behavior was not observed. Owner review of those existing
automations is necessary before enabling; no workflow, calendar or availability
configuration changes are included, and no customer text is approved by this code.

## Deployment notes for the PR body

This change is backend preparation, disabled by default. No deploy, live GHL call,
live database migration, SMS or configuration change was performed. The agent-side
tool is a separate-repository follow-up.

Before enabling writes, apply
`20260921062158_ghl_calendar_appointment_requests.sql`,
`20260924120000_ghl_calendar_appointment_release.sql` (the stuck-row release) and
`20260923181500_sales_booking_executions.sql` (the executor claim table;
`docs/sales-booking-executor.md`), then deploy `ghl-proxy`
through the existing approved deployment path with `--no-verify-jwt` (the proxy
verifies credentials internally). Keep `GHL_CALENDAR_APPOINTMENT_WRITE_ENABLED`
unset until the owner authorizes activation and reviews the notification/workflow
boundary above. Required GHL permissions include calendar/event reads and writes,
contact reads and location-user reads. No new runtime dependency is added.

Include the four provider fields and owner workflow caveat from the notification
section in the PR body. The ordinary main-branch workflow may auto-apply migrations
and deploy on merge, so review deployment sequencing before an authorized merge.
Turning the flag off makes new calls dry runs without deleting the retry ledger.

## Verification

Fake GHL only, no live calls:

```sh
deno test supabase/functions/ghl-proxy/calendar_appointment_test.ts \
  supabase/functions/ghl-proxy/calendar_events_test.ts \
  supabase/functions/ghl-proxy/calendar_directory_test.ts \
  supabase/functions/ghl-proxy/hardening_helpers_test.ts
```

The registered migration contract executes against disposable local PostgreSQL
and covers permissions, lease/CAS behavior, payload conflicts, person overlap,
uncertain-send fencing and saved-result replay. Its `concurrent.sh` runs two real
transactions and requires exactly one acquisition and one overlap refusal. CI
runs it through `supabase/tests/migration-contracts/run.sh` and runs the new fake
GHL tests through `pr-check.yml`.
