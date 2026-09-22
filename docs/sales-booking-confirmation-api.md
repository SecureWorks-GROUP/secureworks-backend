# Booking confirmation read and approval storage

Contract: merged UX `docs/booking-confirm-contract.md` and wiki
`harness/ops/skills/secureworks-scope-booking/CALENDAR-STEPS.md`, read from GitHub
main on 2026-09-22. Implementation: `sales_booking_confirmation.ts`, composed by
`sales_booking_read` after the existing pack overlay.

This release joins the read and independent approval **storage** contracts.
It does not execute a booking or message, enable a provider, connect the runtime
availability adapter, or supply a model. No production behavior was observed.
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
Old publishers remain compatible and yield held models until they send this
additive bundle. This backend does not fetch local runtime files.

Read matching requires the current case's exact GHL contact and opportunity,
and a unique contact in the census. The read carries producer proposal/window,
confirmation requirement, evidence, validation, separate channel state and
receipts. Missing models yield a versioned skeleton with null proposal,
pack revision, evidence, expiry, calendar preview, locked template and route.
`unavailable_fields` documents each missing source; AI alternate text is always
null. Existing arbitrary pack drafts are never promoted into locked templates.
Missing validation checks remain null, never manufactured passes.

The envelope includes `resource.id` and
`booking_flow:{version:"booking-confirm.v1",approval_write:"separate-v1",
calendar_read:{state:"could_not_read",provider:"ghl",reason:
"person_wide_calendars_and_prior_offer_ledger_not_connected"},commitments:null}`.
The current diary alone cannot attest all calendars, operational leave and the
active offer/agreement ledger. **Positive approvals therefore remain held on
this production read path**, even if the publisher supplies a complete model.
Refusals of an exact, current, hashed model can be recorded. `send_hold` stays
true. No outcome completeness is claimed; that is a separate integration.
`separate-v1` advertises the two independent record paths, never provider execution.

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
Approvals additionally need complete current person availability, well-formed
commitments, source quotes and fresh validation (at most 60 seconds old), with
all checks passed. Required check labels for this handoff are `calendar`,
`protected_band`, `hours`, `travel`, `daily_capacity`. The calendar operation
must start at earliest arrival and end after latest arrival (including visit
length). Message routes must have both explicit E.164 numbers. Pending, unknown
and succeeded channels cannot be newly approved. Refusal requires a reason.

The private, service-role-only `sales_booking_approvals` table follows the pack
store's append/read pattern. It records actor ID/email, time, exact snapshot,
step, decision and expiry. Expiry is at most 15 minutes after the decision and
never after proposal expiry. The unique binding key makes concurrent identical
retries converge; retries return the original actor/time/expiry. A conflicting
decision on the same content refuses. Expired content needs a new proposal
revision. UPDATE and DELETE are not granted to the service role.

Returns `{ok:true,approval:{state,reason,snapshot,...audit_fields}}`. Reads attach
only matching, unexpired receipts as `channel.approval.ui_snapshot`, retaining
producer approval fields. They never overwrite pending/unknown execution or
invent a successful receipt. Unreadable approval storage explicitly disables
approval capability; it is not silently treated as an empty ledger.

A future executor must revalidate the current pack, availability, approval and
expiry at execution. Calendar notifications must stay off. Message execution
requires its own stamp and a matching successful calendar receipt and must
respect the send hold. This recording action deliberately has no execution
capability and does not replace that executor contract.

## Local proof

`deno test --allow-env --allow-read --allow-net=127.0.0.1
supabase/functions/ops-api/sales_booking_confirmation_test.ts` exercises the
projection, manifest handoff, both independent decisions, exact-byte tampering,
expiry, identity, actor checks, idempotency and legacy isolation with synthetic
readers and an in-memory store. It includes a production-shaped unavailable
ledger refusal. Existing sales-booking read/pack tests remain in the harness.
The registered migration contract checks RLS/privileges, unique retry binding,
channel separation and expiry against disposable local Postgres; its deliberate
break proves UPDATE privilege would be detected. No live credentials needed.

Validation on 2026-09-22: 11 confirmation tests passed with type checking; 77
existing read/pack tests passed under the repository's monolith `--no-check`
harness. New module/test lint and diff whitespace checks passed. The full
registered migration-contract runner passed against throwaway localhost
Postgres 17, including the deliberate failure case. Test processes used a
cleared environment and network permission restricted to loopback.
