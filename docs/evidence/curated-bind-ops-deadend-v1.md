# Curated bind ops dead-end v1

Date: 2026-08-04

Concise in-repo caller contract for the operable PR 543 bind recovery.
The durable full diagnosis, acceptance ledger and terminal status live in the
secondmate home at `/Users/marninstobbe/.treehouse/kun-agent-workspace-8bf1b0/5/kun-agent-workspace/data/curated-bind-ops-deadend-v1/report.md`
(not in this repository).

## Summary

PR 543 closed curated-report trust correctly, but left two operator dead ends:

1. existing documents with stopped-sweep / raw provenance could never bind even
   when exact curated PDF bytes already matched served storage;
2. ordinary attach could not establish current-cycle attribution, so a fresh
   document could not bind either.

The fix keeps every substantive evidence gate, derives server-owned cycle /
renderer / artifact / input-hash values, establishes cycle attribution inside
the bind, and preserves superseded snapshot provenance on the immutable
`ses_curated_report_source_bind_validated` audit event.

## Action

`POST ops-api?action=bind_current_cycle_curated_makesafe_report`

Auth: privileged ops key, make-safe reporting routine, or admin/owner JWT.

### Ops supplies

- `job_id`, `document_id`
- `pdf_base64`, `pdf_sha256`
- `report_job` (including materials/photo evidence accounting)
- `curation_revision_id`, `curation_artifact_id`

### Server derives

- current attendance cycle
- authoritative renderer provenance
- domain-framed artifact content hash
- canonical `report_input_hash`
- cycle attribution (`bound` on the current cycle)

### Canonical SHA-256 form

Every remaining caller hash field uses exactly:

```text
sha256:<64 lowercase hex>
```

Fields: `pdf_sha256`, every `report_job.photos[].content_sha256`.

### Document handling

- Existing poisoned stopped-sweep snapshots: supersede only after all evidence
  gates pass; prior snapshot is preserved on the audit event.
- Newly attached visible reports without cycle attribution: bind establishes
  current-cycle `attendance_cycle_id` + `cycle_attribution='bound'`.
- Exact trusted snapshot with drifted cycle columns: cycle-only CAS repair.
- PDF bytes are never rewritten by this action; served bytes must already match.
- Residual product boundary: this is privileged attestation that the served PDF
  is the curated artifact for verified current-cycle materials/photos, not a
  re-render proof of those bytes.

### Idempotency / concurrency

Exact same trusted snapshot + already cycle-bound document →
`skipped: true`, `writes: 0`. Cycle reservation via stable
`job_events` identity; document write is version compare-and-swap.

### Safe follow-up only

`prepare_ses_docket_revision` (draft/dry-run). No send, approval, invoice,
stage or trade-evidence mutation.

## Acceptance card

Munster `SWMS-261065` only. Curated raw SHA-256 begins `8891cba8`. Do not mutate
the other five candidates from this release lane.
