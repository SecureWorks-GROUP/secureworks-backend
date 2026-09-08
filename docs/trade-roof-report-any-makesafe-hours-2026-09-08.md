# Trade roof report on any make-safe + one-tap hours (2026-09-08)

Marnin: "there should be an ability for them to do a custom roof report if
required ... we need it for 151 Deanmore Road Scarborough" and "they mark it as
complete, put the 2 hours on their invoice, and we see it is done on our end".

## Roof report on any make-safe

- `submit_roof_report` and `render_roof_report` no longer 409 on a make-safe
  without `report_type` / a report family. The SecureWorks letterhead PDF is
  rendered, attached as `job_documents.type = 'roof_report'`, and the fill is
  persisted as `submitted`.
- The reporting checklist is advanced ONLY on a report-type job (persisted
  `makesafe_job_details.report_type` or `jobs.metadata.makesafe_job_family`).
  On a normal make-safe `board_sync = { skipped: true, reason: 'not_report_type' }`
  and the substatus, `report_received_at` and `portal_verified_*` are untouched:
  the real make-safe report still moves the card. Client flags are still ignored.
- `roof_report_submitted` job event carries `report_type_job: boolean`.
- `mark_makesafe_portal_report_done` is unchanged (still report-type only).

## `log_my_job_hours` (trade JWT)

Body `{ job_id, hours, source? }`. Hours 0.25..24, rounded to the quarter hour,
REPLACE `job_assignments.hours_worked` on the caller's own assignment for the
job (in_progress > latest scheduled/confirmed > latest complete; observers and
`makesafe_open` rows never qualify). The assignment becomes `complete`
(`completed_at` stamped) and gets `scheduled_date = today AWST` when it had
none, so `my_hours` lists it in the week. An assignment already stamped
`invoiced_in` is refused (409). A make-safe where the caller has no assignment
gets the same completing-trade binding `submit_makesafe_report` mints; any
other job without an assignment is refused (the office allocates). Audit:
`job_events.trade_hours_logged { assignment_id, hours, previous_hours, source }`.
Response: `{ ok, hours, assignment: { id, status, scheduled_date, hours_worked, created }, week_ending }`.

Tests: `roof_report_flow_test.ts` (normal make-safe renders without board
advance), `trade_access_tier_test.ts` (log_my_job_hours + pickHoursAssignment).
