# SES adjudicated job recovery (2026-08-01)

This is the reviewed recovery surface for the two missed instructions proved in
`data/ses-shadow-adjudicate-v1/report.md` section 6.1. Both actions require the
privileged ops key or an admin/owner session and `POST`.
The server pins the exact authorized source identities and expected values shown
below; the ruling cannot be reused for another source, family, reference, date,
company, or invoice.

## Deterministic exact rescan

`ops-api?action=makesafe_deterministic_intake_exact_rescan` accepts exactly:

```json
{
  "post_id": "<one exact persisted emails.post_id>",
  "expected_job_family": "roof_report"
}
```

The source must already have one canonical `exception` fate with no job and no
corrected target-job binding. The action delegates to the existing exact
deterministic intake, guarded approval, settlement, source lineage, and Hugo
notification path. It requires one created job and one recorded and accepted
Hugo notification before appending captain provenance. Standing intake and PDF
drain behavior are unchanged. For a `roof_report`, the created job must also
have exactly one current attendance cycle, and that cycle must be inside the
immutable cycle set with `cycle_attribution = 'bound'`; a newly minted job must
have cycle number 1. The action refuses the result if this postcondition is not
met.

## Exact source-persistence recovery

`ops-api?action=makesafe_source_persist_recovery` is the bounded, no-send
recovery for the single adjudicated obligation `MLB-RR-26836` / `PO-57602`.
It is API-key-only and `POST`-only, and the server rejects every other
external-reference or purchase-order pair. Before recovery it requires the
single canonical `adapter_parse_failure` exception with the recorded
`deterministic source_persist_failed case_insert` reason, no authoritative case
or job, and at least one source row. The recovery must create exactly one
unassigned authoritative job, suppress and record no Hugo notification, and
leave invoices, assignments, communications, and outbound queue rows at zero.
It also fingerprints the unrelated exception queue before and after the write;
any drift fails the action. The action is source-only for deploy recognition
and must never be exercised by a deploy smoke probe.

## Exact five-card roof cycle binding recovery

`ops-api?action=makesafe_roof_cycle_binding_recovery` is a separate,
operator-invoked, API-key `POST`-only repair for the exact five-card scope
approved for the roof attendance-cycle defect. It requires an explicit dry-run
plan token before a single-card apply. Apply is idempotent and skips on drift;
it refuses non-null or out-of-set pointers, multiple or mismatched candidates,
missing or ambiguous canonical intake authority, terminal cards, and
evidence-bearing missing-cycle state. The sealed 2026-08-03 portal receipts are
also a hard gate: only SWMS-261079, SWMS-261114, and SWMS-261116 are proved
submitted and locked. SWMS-261113 and SWMS-261123 refuse with
`portal_not_submitted_locked` and remain unbound pending trade completion. The
caller cannot override those verdicts. The action never invents a cycle: cycle
one may be materialized only from the persisted initial counter, canonical mint
authority, and zero operational evidence. Production recovery remains outside
this document's execution scope.

## Historical Builderwest backfill

`ops-api?action=makesafe_adjudicated_historical_backfill` accepts exactly:

```json
{
  "post_id": "<one exact persisted emails.post_id>",
  "invoice_number": "INV-0754",
  "external_ref": "BWCWA-6648",
  "invoice_date": "2026-06-24",
  "requesting_company_slug": "bw",
  "expected_job_family": "general_makesafe"
}
```

The action verifies the complete persisted source lineage and exact Xero-synced
ACCREC invoice evidence before any write. It uses the normal make-safe job
constructor with manager notification and geocoding suppressed, marks the card
as captain-accepted legacy incomplete evidence, binds all source transports via
the append-only authority-correction ledger, links the local invoice mirror, and
appends `new -> archive` only through `apply_makesafe_board_status`.

This historical path has no Hugo callback and makes no client, builder, GHL,
Xero-provider, SMS, or email call. The operational `jobs.status` remains under
its normal authority; `ARCHIVED` is the display-ledger stage.

Both paths pin the captain ruling date `2026-08-01` and adjudication reference
`data/ses-shadow-adjudicate-v1/report.md#6.1` in durable provenance.
