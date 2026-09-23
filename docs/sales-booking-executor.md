# Booking executor: `sales_booking_book` and `sales_booking_send`

The owner's press on one recorded approval is the trigger. Each action takes a
single `sales_booking_approvals` binding hash, re-checks everything on the
server at the moment of the press, and then books the exact approved GHL
appointment or sends the exact approved text. Nothing else acts on an approval.

Code: `supabase/functions/ops-api/sales_booking_execute.ts` (logic),
`sales_booking_execute_live.ts` (production adapters),
`supabase/functions/_shared/booking_approval_gate.ts` (the approval check shared
with the GHL writer). Tests: `ops-api/sales_booking_execute_test.ts`,
`ghl-proxy/calendar_appointment_test.ts`.

## Request and result

`POST ops-api?action=sales_booking_book` or `sales_booking_send` with
`{"approval_id": "<64 hex binding_hash>", "dry_run"?: true}`.

Result (HTTP 200, except `press_requires_captain` which is 403):

```json
{"status": "booked" | "sent" | "dry_run" | "refused", "reason": "...",
 "appointment_id" | "message_id" | "would_write" | "would_send": ...}
```

`booked`/`sent` also carry `replayed` (true when a second press returned the
first result). `refused` may carry `detail` (for example the clashing Outlook
events).

## Switches (default: dry run)

| Switch | Effect |
| --- | --- |
| `SALES_BOOKING_BOOK_EXECUTE` | Exactly `true` lets a captain press book. Anything else: dry run. |
| `SALES_BOOKING_SEND_EXECUTE` | Exactly `true` lets a captain press send. Anything else: dry run. |
| `GHL_CALENDAR_APPOINTMENT_WRITE_ENABLED` | Unchanged. The GHL writer's own switch; off still previews even when the book switch is on (`reason: appointment_writer_flag_off`). |

A dry run performs every check below and returns exactly what would be written
or sent. It writes and sends nothing: the writer is called with `dryRun: true`,
no ledger row is claimed, no SMS call is made. An ops API key caller always gets
a dry run (`api_key_press_is_dry_run`); only an allow-listed captain JWT
(`SALES_BOOKING_CAPTAIN_EMAILS`) can execute. `dry_run: true` in the body forces
a dry run for anyone.

## Checks at the press, in refusal order

Both actions:

1. `method_not_allowed`, `press_requires_captain`, `approval_id_required`.
2. `approval_not_found`, `approval_unreadable`, `approval_step_mismatch`.
3. Already ran: a second press returns the first result and never writes or
   sends twice. A book uses the GHL writer's own ledger, keyed on the approval
   hash; a send uses `sales_booking_message_sends`. An unsettled earlier attempt
   refuses `execution_outcome_unknown` and is never repeated.
4. `approval_not_approved` (a refusal decision), `approval_not_by_captain`
   (approver email not in `SALES_BOOKING_CAPTAIN_EMAILS`),
   `content_hash_mismatch` (the stored snapshot no longer hashes to its binding
   hash or content hash, or does not produce the approved fields),
   `approval_expired` (15 minutes from `approved_at`, capped by `expires_at`).
5. Thread tail: `thread_unreadable`, or `customer_replied_since_approval` when
   the customer wrote after the owner approved.

`sales_booking_book` then:

6. The owner's Outlook primary calendar for the approved window, read through
   Microsoft Graph `calendarView` with the mail app's existing credential
   (`_shared/graph_client.ts`, mailbox from `SALES_BOOKING_GHL_USERS`). Any busy
   event refuses `outlook_calendar_clash`, naming subject and times; a failed
   read refuses `outlook_unreadable`. Free and cancelled events never block.
7. The existing GHL writer (`ghl-proxy?action=create_calendar_appointment`),
   which re-reads the person's GHL diary plus every assigned calendar and
   refuses `ghl_calendar_clash`, and re-checks the approval itself.

`sales_booking_send` then:

6. `sender_not_line_776` unless the approved sender is `+61489267776`.
7. `recipient_changed` unless the contact's GHL phone is still the approved
   recipient.
8. `text_already_in_thread` if the exact text was already sent since approval.
9. Claim the send, call ghl-proxy `send_sms` with the exact text, settle.
   An unclear provider answer settles `unknown` and refuses
   `send_outcome_unknown`; it is never re-sent.

A text that names no time ("does Friday suit?") is fully supported: sending
needs no calendar booking or receipt.

## The GHL writer refuses without an approval

`create_calendar_appointment` now requires, for any real write, that its
`idempotencyKey` is the binding hash of a live captain approval of exactly the
requested calendar, assignee, contact, start, end, title and address. Otherwise
it refuses HTTP 409 `approval_required` with the failed check as `reason`. So no
caller can book around the executor. Previews never refuse on approval; they
report `approval: {state, reason}`. See `docs/ghl-calendar-appointment-write.md`.

## Credential between ops-api and ghl-proxy

ops-api calls ghl-proxy server to server with the project
`SUPABASE_SERVICE_ROLE_KEY` as `Authorization: Bearer`, which ghl-proxy
classifies as `service_role` (`ghl-proxy/hardening_helpers.ts`
`classifyAuthCredential`). This is the path ops-api already uses for proposed
SMS sends. It never uses the shared browser key, so removing the shared-key
`send_sms` path does not affect it.

## Approval write change

`sales_booking_approval_write` no longer requires an availability check under
60 seconds old from the external engine; that engine only runs in a terminal,
so the buttons could never enable live. The executor's server re-check at the
press replaces it. An exact-text (`message`) approval no longer requires a
calendar operation, availability or validation checks, so a text with no time
can be approved. The calendar approval keeps every other check.

## Storage and deploy order

Apply `20260923181500_sales_booking_message_sends.sql` before the matching
`ops-api`. The table is service-role only, claimed before the provider call,
settles once (trigger), references the approval row, and is never deleted.

## Out of scope

Outlook writes (the mirror event), stage moves, the screen UI, Stratco intake,
Luna, and retiring the old booking paths. Prior-offer census across other leads
is not re-read at the press.
