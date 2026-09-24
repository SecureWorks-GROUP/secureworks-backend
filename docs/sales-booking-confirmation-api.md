# Booking confirmation read and approval storage

Contract: merged UX `docs/booking-confirm-contract.md` and wiki
`harness/ops/skills/secureworks-scope-booking/CALENDAR-STEPS.md`, read from GitHub
main on 2026-09-22. Implementation: `sales_booking_confirmation.ts` and
`sales_booking_visits.ts`, composed by `sales_booking_read` after the existing
pack overlay. Owner-authored approvals:
`sales_booking_owner_approval.ts` ("Owner-authored approvals" below).
Press results overlay after approvals and before visits:
`docs/sales-booking-executor.md` "What the read shows".

This release joins the read and independent approval **storage** contracts.
It does not execute a booking or message, enable a provider, or supply a model.
Published availability evidence and durable visit records are composed below. No production behavior was observed.
Apply `20260922150000_sales_booking_approvals.sql` before deploying these handlers.
`sales_booking_stamp_write` was retired on 23 Sep 2026 (unknown action);
`sales_booking_stamp_read` still returns stored legacy stamps, and legacy
KEEP/CUT never translates into either independent approval.

## Producer handoff

The existing API-key-only `sales_booking_pack_publish` accepts the additive
`booking_read_models: {index, files}`. `index` is the producer's exact
`booking-read-model/index.json`: `{schema:"scope-booking-lead.v1",
leads:[{id,contact_id,file}]}`. `files` maps each manifest filename to its parsed
JSON. Only manifest-selected files are read; extra stale files are ignored.
Duplicate contact/model identities, mismatched entries, invalid revisions or a
mixed revision generation refuse publish. No files are globbed. The publisher
must send the complete current generation alongside its pack, never combine
models from different runs. The complete pack revision is producer-owned.
Old publishers remain compatible and yield awaiting_approval skeletons until
they send this additive bundle. This backend does not fetch local runtime files.

Read matching requires the current case's exact GHL contact and opportunity,
and a unique contact in the census. The read carries producer proposal/window,
confirmation requirement, evidence, validation, separate channel state and
receipts. Missing models yield a versioned skeleton with null proposal,
pack revision, evidence, expiry, calendar preview, locked template and route.
`unavailable_fields` documents each missing source; AI alternate text is always
null. Existing arbitrary pack drafts are never promoted into locked templates.
Missing validation checks remain null, never manufactured passes.

The live server read (`docs/sales-booking-live-availability.md`) now replaces
`calendar_read` and `commitments` below on every read and every approval
press; a fresh engine census only adds holds.

The envelope includes `resource.id` and `booking_flow` version
`booking-confirm.v1`, with `approval_write:"separate-v1"`. Each matched model
may publish `validation.availability:{state,occupied_intervals,reason}` where
state is `read`, `could_not_read`, or `not_configured`. A read requires an
explicit interval array; each interval has `start`/`end` (or `start_iso`/`end_iso`)
with offsets. The producer owns whole-person source coverage, including leave.
The backend never promotes the GHL diary to that authority.

Models publish their complete prior-offer census as `prior_offers`. Each entry
has `id` (or `slot_id`), `contact_id`, `state:offered|agreed`, and
`start_iso`/`end_iso` (or `start`/`end`). These project to `booking_flow.commitments`.
A published empty array is a complete empty census; absence or malformed entries
remain null with `commitments_read.state:"could_not_read"`. Only exact contact
and opportunity matches in the current resource/profile contribute. Across
matched models, occupied intervals are combined conservatively and commitment
IDs deduplicate; conflicting entries refuse census completeness.

Both projections carry `as_of` from the persisted pack's publish timestamp and
`stale`. At any contributing model's expiry, state becomes `stale`, retaining
the evidence for display. Missing/future publish time or missing expiry also
holds freshness. `calendar_read.occupied_intervals` stays null when unavailable.
Positive approval still requires the exact model, fresh passed validation,
complete commitments, evidence and channel hash checks. `send_hold` stays true;
`separate-v1` advertises records only, never execution.

## Booked visits and correction history

`sales_booking_visits.ts` composes successful (`state=complete`) rows from
`ghl_calendar_appointment_requests` for the mapped GHL scoper. The selected
week is combined with `visit_outcomes_from`/`visit_outcomes_to` (default: the
last seven days). Outcome window inputs require offsets, positive duration,
and at most 366 days. Pending, sending and released requests never count as bookings.

The appointment ledger has no contact column. Its `idempotency_key` joins the
executor's own press record for the lead (`sales_booking_executions`, see
`docs/sales-booking-executor.md` "What the read shows"), the contact-bound
model's `calendar_write.receipt.booking_key` or `.idempotency_key`, or an
existing current outcome's `booking_key`. Each visit names its join in
`bound_by` (and `execution` when that join is the press), and diary events of
a booked visit (GHL event or Outlook mirror) carry `booked_visit`. GHL contact
ID then joins the lead, never name/address. A ledger row without a unique lead
binding is reported as unresolved, never guessed or silently dropped from
completeness.

All `visit_outcomes` rows for each booking key are read, including corrections
outside the date window. Pages are 500 rows, bounded at 10,000 per read, with
URL-budget chunks of 50 keys. Errors or caps cannot claim complete empty data.
`currentVisitOutcome` requires one connected, acyclic correction chain and uses
its unsuperseded tip, never latest timestamp alone.

Top-level `booked_visits` feeds the UI's amber missing-outcome list;
`visit_outcomes` carries full history for the UI's correction control. Each
visit carries its current outcome and history. Each case carries `booked_visits`,
`visit_outcome` (latest visit), `visit_outcome_history`, and
`visit_read_complete`. `booking_flow.booked_visits_read` and
`visit_outcomes_read` distinguish `complete`, `partial`, and `could_not_read`.
Only complete composition advertises `visit_outcome_write:"append-only-v1"`.
`visit_read` records the actual window, read time, reason, and unresolved count.
Store failures return null data; successful empty queries return empty arrays.
This census covers the durable appointment ledger, not unrelated manual calendar
entries. Cases absent from the current lead roster cannot acquire invented
identity: affected ledger rows keep the response partial.

The schema preflight declares both existing appointment/outcome migrations and
every selected field as ops-api dependencies. No new migration or live write is
needed for this composition. Local proof includes an occupied published model,
missing availability, expiry, a missing-outcome booking, two corrections,
501-row history pagination, identity mismatches, and store failures. Production
behavior has not been observed as part of this change.

## Exact-content hash and approval request

POST `sales_booking_approval_write` with
`{snapshot,decision:"approved"|"refused",reason}`. The snapshot is exactly the
merged UI `approvalSnapshot()` object, including schema, step, case/contact,
resource/scoper/week, model id/profile, complete pack revision, content hash and
channel content. Calendar content includes provider, calendar and assigned user,
event start/end, arrival window, title and address. Message content includes
exact template bytes, sender, recipient and `variant:"template"`.

`content_hash` (both preview `content_hash` and routing `message_sha256`) is
SHA-256 of UTF-8 canonical JSON of that snapshot **excluding `content_hash`**.
Object keys are recursively sorted; arrays keep order and strings keep exact
bytes. `bookingContentHash` is the executable reference. This is a binding hash,
not a bare SHA-256 of the text. `binding_hash` additionally hashes the complete
snapshot including `content_hash`. Publish hashes using the actual case/scoper/
week values shown by the UI. No trimming, newline conversion or rewording.

The handler uses the existing allow-listed captain JWT policy
(`SALES_BOOKING_CAPTAIN_EMAILS`) and requires a verified user ID. Request actor
fields are ignored. API keys, routine callers and other JWTs cannot approve.
Only the Stratco/Marnin profile is supported. One request names exactly one step;
neither channel can trigger or grant the other.

Before recording, the handler re-reads the current workspace and compares the
entire snapshot semantically, verifies the computed hash and proposal expiry.
Calendar approvals additionally need complete current person availability,
well-formed commitments, source quotes and passed validation. There is no
60-second freshness gate any more (23 Sep 2026): the executor re-checks GHL and
Outlook on the server at the press (`docs/sales-booking-executor.md`). An
exact-text (`message`) approval needs only the snapshot, hash, expiry and an
exact E.164 route, so a text with no time can be approved. Required check labels for this handoff are `calendar`,
`protected_band`, `hours`, `travel`, `daily_capacity`. The calendar operation
must start at earliest arrival and end after latest arrival (including visit
length). Message routes must have both explicit E.164 numbers. Pending, unknown,
succeeded and failed channels require reconciliation before any new approval or
refusal is recorded. Refusal requires a reason.

The private, service-role-only `sales_booking_approvals` table follows the pack
store's append/read pattern. It records actor ID/email, time, exact snapshot,
step, decision and expiry. A write stamps `expires_at` at most 15 minutes after
that row's own `approved_at` and never after proposal expiry. The unique binding
key makes concurrent identical retries converge; retries return the original
actor/time/expiry. A conflicting decision on the same content refuses. Expired
content needs a new proposal revision. UPDATE and DELETE are not granted to the
service role.

Returns `{ok:true,approval:{state,reason,snapshot,...audit_fields}}`. Only a
matching, unexpired `sales_booking_approvals` row grants channel display
authority. Publisher `approved`/`held`/`refused` fields are diagnostics only:
without such a row the channel projects `awaiting_approval`. Read authority
lasts at most 15 minutes from that row's own `approved_at` (capped by the
stored `expires_at`) and is never derived from pack or proposal expiry.
Matching receipts attach as `channel.approval.ui_snapshot`. They never
overwrite pending/unknown/succeeded/failed execution or invent a successful
receipt. An unreadable store returns `awaiting_approval` with
`approval_write:null` and `approval_read_error`; it is not treated as an empty
ledger.

The executor is `sales_booking_book` / `sales_booking_send`
(`docs/sales-booking-executor.md`): it revalidates the approval, thread and
calendars at the press, defaults to dry run, and keeps calendar notifications
off. A message send needs its own approval and no calendar receipt, so a text
with no time can be sent. This recording action itself still has no execution
capability. After a live press, `sales_booking_read` overlays what that press
did; owner: `docs/sales-booking-executor.md` "What the read shows".

## Owner-authored approvals (`owner-authored-v1`, 23 Sep 2026)

The engine path above needs a terminal-published model that has not expired,
a snapshot equal to the published template, and for a calendar approval the
engine's full-population coverage, validation checks and prior-offer ledger.
None of that exists without the terminal engine. The owner-authored path
records an approval from what the owner wrote or chose on the booking screen,
with no engine publish, and checks it on the server at the moment he presses.
The engine path is unchanged and keeps working. Code:
`supabase/functions/ops-api/sales_booking_owner_approval.ts`; tests:
`sales_booking_owner_approval_test.ts`.

Stratco (resource `marnin`, profile `fencing-stratco-marnin`) only. Same
`sales_booking_approvals` table, same 15-minute life, same captain-only rule,
same executor. `binding_hash` is the `approval_id` the executor takes.

### Two presses: preview, then decide

Both are `POST ops-api?action=sales_booking_approval_write`. A body carrying
`owner_input` takes this path; a body carrying `snapshot` takes the engine
path; both at once is 400 `owner_input_and_snapshot_are_exclusive`.

**1. Preview** (captain JWT, or the ops API key; reads only, writes nothing):

```json
{"owner_input": {...}, "dry_run": true}
```

Returns `{ok:true, dry_run:true, source:"owner", snapshot, content_hash,
approval_id, checks}`. Every check below runs. Show the owner
`snapshot.content` exactly: that is what he approves.

**2. Decide** (captain JWT with a user id only):

```json
{
  "owner_input": {..., "prepared_at": "<snapshot.prepared_at from the preview>"},
  "decision": "approved" | "refused",
  "reason": "<required for refused, 1..1000 chars>",
  "content_hash": "<content_hash from the preview>"
}
```

The server rebuilds the snapshot from the same input and current server
truth. If anything moved since the preview (the contact's phone, name,
street, the workspace week), the hash differs and it refuses
`owner_snapshot_changed` with the new snapshot in `detail`: preview again.
A preview is good for 15 minutes (`owner_preview_expired`). Returns
`{ok:true, source:"owner", approval, approval_id, checks}`. Pressing the same
decision again returns the same row; a different decision on the same content
refuses `approval_decision_already_recorded`. A refusal decision records the
refusal without running the calendar checks.

### `owner_input`

Common fields: `step` (`"message"` or `"calendar"`), `case_id` (the case
`id`), `contact_id` (GHL contact id), `week_start` (the screen's Monday),
optional `resource` (must be `"marnin"`), `prepared_at` (decide only).

- **Message:** `text` (the exact text the owner wrote or edited, 1..1600
  characters, bytes kept exactly; no em or en dashes), optional `offer`
  (the visit the text offers, same shape as `visit`). An offer is checked like
  a calendar choice and, once approved, blocks that slot for other leads
  until it expires or that lead is booked.
- **Calendar:** `visit: {window_start_iso, window_end_iso, end_iso}`: the
  arrival window and the visit end, each `YYYY-MM-DDTHH:MM:00+08:00`.

### What the snapshot binds

`schema:"scope-booking-approval.v1"`, `source:"owner"`,
`version:"owner-authored-v1"`, `step`, `case_id`, `contact_id`, `resource`,
`scoper_user_id`, `week_start`, `id:"opp:<opportunity>"`, `profile`,
`pack_revision:null`, `prepared_at`, `content_hash`, `content`.
`content_hash` is `bookingContentHash` (canonical JSON of the snapshot less
`content_hash`), exactly as on the engine path.

- Message `content`: `{text, sender:"+61489267776", recipient, variant:"owner",
  offer}`. `recipient` is the GHL contact's current phone as E.164, read at the
  press; `sender` is always the 776 line.
- Calendar `content`: `{provider:"ghl", calendar_id:"dEQKVKHthsjSYaen1fiE",
  assigned_user_id:"3S20LGVTjsVYy9vTJ9wM", start_iso:<window start>,
  end_iso:<visit end>, window_start_iso, window_end_iso,
  title:"Scope visit: <name>", address:"<street>, <suburb>"}`. Name is the GHL
  contact's; street is the contact's address line, else the recorded job
  site's (`checks.address_street_source`); suburb is the one the booking read
  publishes. The executor and the GHL writer read this shape unchanged.

### Checks and named refusals

Refusals are HTTP 409 unless shown (400 for a malformed request) with body
`{error, reason, detail}`. Order is the order reported.

Request and identity: `sales_booking_approval_write requires POST` (405),
`invalid_dry_run`, `stamp_write_requires_captain` (403),
`approval_actor_required` (403), `invalid_owner_input`,
`stratco_profile_required`, `invalid_independent_approval`,
`refusal_reason_required`, `owner_prepared_at_required`,
`owner_content_hash_required`, `booking_case_identity_ambiguous` (the contact
must be exactly one case on the Stratco roster for that week and its case id
must match), `owner_preview_expired`, `contact_unreadable`.

Content: `owner_message_text_required`, `owner_message_text_has_dash`,
`contact_phone_missing`, `contact_name_missing`, `contact_street_missing`
(the address line has no house or unit number, e.g. only a suburb; a leading
Unit/Apt/Shop or comma before the number still counts),
`contact_suburb_missing`, `owner_snapshot_changed`.

Rulebook (no reads; `STRATCO_BOOKING_RULEBOOK`, from the engine's profile
JSON `fencing-stratco-marnin.json` and the calendar target in its GO-LIVE.md):
`owner_visit_required`, `owner_visit_times_invalid`,
`owner_visit_not_future`, `owner_visit_spans_days`,
`owner_visit_day_not_permitted` (Tue and Fri), `owner_visit_window_length`
(60 to 90 minutes), `owner_visit_window_not_inside_visit`,
`owner_visit_too_short` (visit ends at least 30 minutes after the latest
arrival: 30 minutes on site, owner's rule of 24 Sep 2026), `owner_visit_outside_hours` (window start at or after 08:00, visit
end by 16:30), `owner_visit_protected_band` (Tue 13:00 to 15:30 Stratco /
Canning Vale, including the 30-minute travel buffer).

Open offers and presses (both steps, read from `sales_booking_executions`
claimed in the last 21 days joined to the approvals they ran, plus live
unexpired owner-authored rows on `sales_booking_approvals` that carry an
offer or visit):
`system_offers_unreadable`; `booking_step_requires_reconciliation` when a text
to this lead may or may not have been sent (message step) or a booking for
this lead is mid-press (calendar step); `text_already_in_thread` /
`thread_unreadable` (message step: the exact text is already outbound in the
thread).

Availability, read at the press for the visit's whole Perth day (calendar
step, and a message with an `offer`). The visit runs from window start to
visit end; a neighbouring GHL booking or open offer needs a gap of the travel
time between its location and the lead's suburb
(`sales_booking_travel.ts`, `docs/sales-booking-live-availability.md`), and
an Outlook event (which carries no location here) needs 30 minutes:
`owner_calendar_unreadable`; `owner_calendar_unknown` (the STRATCO FENCING
calendar must be active, list the owner's GHL user, and that user must be the
one roster entry for marnin@secureworkswa.com.au); `ghl_calendar_unreadable`
(the owner's diary by user id plus every calendar he is on; any incomplete
read); `contact_already_booked_that_day`; `ghl_calendar_clash` (other
assignees and cancelled rows do not block); `outlook_unreadable`;
`outlook_calendar_clash` (busy events on his Outlook primary calendar);
`system_offer_clash` (a slot this system offered another lead in a sent text,
a live unexpired owner approval, or a booking mid-press; this lead's own
same slot, other offers to this same lead from a sent text, and offers to a
lead since booked do not count); `daily_capacity_reached` (GHL events that
day plus other leads offered that day plus this visit over 6).

Texts sent by hand outside this system cannot be checked by the machine. The
path does not guess at them and does not block on them: every result carries
`checks.hand_sent_texts:"not_machine_checked"` and a plain note, and
`checks.system_offers.unverified_texts` lists texts this system sent whose
record names no slot (every engine-path text). The executor still re-checks
GHL, Outlook, the thread and the recipient at its own press.

### What the read returns

`sales_booking_read` adds `booking_flow.owner_approval_write:
"owner-authored-v1"` (null off the Stratco resource), `booking_flow.owner_rulebook`,
and `hand_sent_texts` / `hand_sent_texts_note`. Each case carries
`owner_booking`:

```json
{
  "version": "owner-authored-v1",
  "eligible": true,
  "reason": null,
  "engine_proposal": false,
  "engine_window": null,
  "rulebook": {"days": ["Tue","Fri"], "bookable_dates": ["2026-09-25", "..."],
    "day_start": "08:00", "day_end": "16:30", "window_min_minutes": 60,
    "window_max_minutes": 90, "visit_minutes": 30, "travel_buffer_minutes": 30,
    "travel": {"version": "straight-line-v1", ...},
    "max_per_day": 6, "protected_bands": [...], "sender": "+61489267776",
    "calendar": {...}, "timezone": "Australia/Perth", "utc_offset": "+08:00"},
  "approvals": [{"approval_id", "step", "state", "reason",
    "approved_by_email", "approved_at", "expires_at", "content"}]
}
```

`engine_proposal` is true when a current engine model with a proposal is
matched to the lead (`engine_window` is its window). `approvals` lists live
owner-authored rows for that case (under 15 minutes old); it is null when the
store could not be read (`booking_flow.owner_approval_read_error`) or the lead
is not eligible. `bookable_dates` are the next 14 days' Tue/Fri dates whose last
arrival has not passed.

## Local proof

`deno test --allow-env --allow-read --allow-net=127.0.0.1
supabase/functions/ops-api/sales_booking_confirmation_test.ts` exercises the
projection, manifest handoff, both independent decisions, exact-byte tampering,
expiry, identity, actor checks, idempotency, live-store-row authority and
legacy isolation with synthetic readers and an in-memory store. It includes a
production-shaped unavailable ledger refusal plus publisher-approved-without-row,
expired-row, mismatched-hash and throwing-store cases. Existing sales-booking
read/pack tests remain in the harness. The registered migration contract checks
RLS/privileges, unique retry binding, channel separation and expiry against
disposable local Postgres; its deliberate break proves UPDATE privilege would
be detected. No live credentials needed.

Validation on 2026-09-22: 13 confirmation tests passed with type checking; 77
existing read/pack tests passed under the repository's monolith `--no-check`
harness. New module/test lint and diff whitespace checks passed. The full
registered migration-contract runner passed against throwaway localhost
Postgres 17, including the deliberate failure case. Test processes used a
cleared environment and network permission restricted to loopback.

Follow-up safety checks: `scripts/edge-function-schema-requirements.txt` declares
the approval migration, table and every field the store reads/writes. The local
`bash scripts/test/test-edge-schema-preflight.sh` consumer test refuses both a
missing approval migration and a missing expiry column, without remote SQL or
credentials. Failed calendar/message attempts refuse decisions with HTTP 409
`booking_step_requires_reconciliation`, leaving the approval store unchanged.

The follow-up run passed all 13 confirmation tests (with type checking), all 11
local schema-preflight cases, module/test lint and whitespace checks. The new
failed-channel test was observed failing before the guard fix and passing after.

Read-composition validation on 2026-09-22: 29 confirmation/visit/outcome tests
passed with type checking; 78 existing booking read/pack tests passed using the
repository's monolith `--no-check` harness. All 12 local schema-preflight tests
passed, including missing appointment-result and outcome-supersedes refusals.
Formatting, focused lint and diff whitespace checks passed. Readers were
synthetic, test environments cleared, and network access restricted to loopback.
