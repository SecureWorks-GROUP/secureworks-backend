# Booking confirmation read and approval storage

Contract: merged UX `docs/booking-confirm-contract.md` and wiki
`harness/ops/skills/secureworks-scope-booking/CALENDAR-STEPS.md`, read from GitHub
main on 2026-09-22. Implementation: `sales_booking_confirmation.ts` and
`sales_booking_visits.ts`, composed by `sales_booking_read` after the existing
pack overlay. Press results overlay after approvals and before visits:
`docs/sales-booking-executor.md` "What the read shows".

This release joins the read and independent approval **storage** contracts.
It does not execute a booking or message, enable a provider, or supply a model.
Published availability evidence and durable visit records are composed below. No production behavior was observed.
Apply `20260922150000_sales_booking_approvals.sql` before deploying these handlers.
The legacy `sales_booking_stamp_write/read` path remains available, deprecated;
legacy KEEP/CUT never translates into either independent approval.

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
and at most 366 days. Pending/sending requests never count as bookings.

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
