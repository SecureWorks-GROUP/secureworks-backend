# Make-safe: report submitter is the attending trade; unlock a submitted report (2026-09-08)

Marnin: "whoever does the actual report, that is who it should be logged as
allocated to, an override of whoever was allocated before" and "they can unlock
something and edit it after it has been submitted, or submit a separate attendance".

## Attribution override (`submit_makesafe_report`, final submit)

Before the assignments on the job are closed, every OTHER trade's genuine
assignment bound to THIS attendance cycle is cancelled
(`overrideMakesafeAllocationToSubmitter`): `status = 'cancelled'`, note
"Overridden by report submitter <date>". A row already stamped `invoiced_in` is
left alone and the response carries `warnings: ['allocation_override_blocked_invoiced']`.
Event `makesafe_allocation_overridden { cancelled, blocked_invoiced }`. The
response's `board_sync.allocation_override` lists both. Ordering matters: the
old flow closed the absent trade's scheduled row to `complete`, which `my_hours`
lists as invoiceable. Prior cycles are never touched. The SES board crew name
already excludes cancelled rows, so it shows the submitter.

Previously `reconcileMakesafeReportBindingWithAllocation` only ever read the
submitter's own rows, so no cross-trade override existed.

## `unlock_makesafe_report` (trade JWT, `{ job_id }`)

Allowed while the office has not sent anything: substatus `admin_to_send_report`,
`report_sent_at` null, no sent docs pack (`buildPackSentMap`), no receivable past
DRAFT on the job. Caller must be the report's `submitted_by`, a make-safe
manager, or office. Writes: `job_service_reports.status = 'draft'`,
`submitted_at = null`; board back to `waiting_on_trade_report` with
`report_received_at = null` through the gated writer; event
`makesafe_report_unlocked`. Assignments are not reopened. A repeat call returns
`{ already: true }`. Re-submit rewrites the same cycle-unique report row.
Refusals name the reason and point to a separate attendance.

## Ops

`job_detail.service_reports[]` now carries `submitted_by_name`; the ops raw
report modal shows it and the signature image.

Tests: `makesafe_submit_report_test.ts` (override with an invoiced row and a prior
cycle, unlock round trip, unlock refused after send).
