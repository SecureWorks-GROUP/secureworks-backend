# F7 Prime portal observer - production commit run

Generated: 2026-08-06T00:31:54.940Z
Generation: `sha256:5f82163c36fdc6a99ccc`
Observer: `ses-prime-portal-observer/2026-08-02.4`
Mode: `commit`

## Result

The observer retained the wider read-only set and labelled every result with canonical live-board membership. The observed-total population contains 418 of 418 candidate cards; 1 of 418 carry 1 genuine portal links. The canonical-live-board partition contains 281 of 418 observed-total candidate cards; 1 of 281 carry 1 genuine portal links. The off-board-observed partition contains 137 of 418 observed-total candidate cards; 0 of 137 carry 0 genuine portal links.

It performed 1 production writes among 418 observed-total candidate cards and 0 stage moves among 418 observed-total candidate cards. Every write is an append-only `makesafe_portal_capture_revisions` row via `record_ses_portal_capture_evidence`; no revision is ever updated or deleted. Every database read used the Management API with `read_only: true`.

## Population-partitioned outcomes

| Population | Candidate-card denominator | Portal-card denominator | Link denominator | Submitted/locked | In progress | Not started | Cannot observe |
|---|---:|---:|---:|---:|---:|---:|---:|
| canonical-live-board | 281 candidate cards | 1 of 281 candidate cards | 1 links | 1 of 1 links | 0 of 1 links | 0 of 1 links | 0 of 1 links |
| observed-total | 418 candidate cards | 1 of 418 candidate cards | 1 links | 1 of 1 links | 0 of 1 links | 0 of 1 links | 0 of 1 links |
| off-board-observed | 137 candidate cards | 0 of 137 candidate cards | 0 links | 0 of 0 links | 0 of 0 links | 0 of 0 links | 0 of 0 links |

## Roof result

| Population | Roof-card denominator | Screenshot-provable | Remains unprovable |
|---|---:|---:|---:|
| canonical-live-board | 52 roof cards | 1 of 52 roof cards | 51 of 52 roof cards |
| observed-total | 61 roof cards | 1 of 61 roof cards | 60 of 61 roof cards |
| off-board-observed | 9 roof cards | 0 of 9 roof cards | 9 of 9 roof cards |

Why roof cards remain unprovable, with each reason measured against its named population's unprovable-roof denominator:

| Population | Reason | Count and denominator |
|---|---|---:|
| canonical-live-board | no_genuine_portal_link | 51 of 51 unprovable roof cards |
| observed-total | no_genuine_portal_link | 60 of 60 unprovable roof cards |
| off-board-observed | no_genuine_portal_link | 9 of 9 unprovable roof cards |

## Capture-revision plan

| Population | Create revision | Idempotent no-op | Cannot record | Existing ledger rows |
|---|---:|---:|---:|---:|
| canonical-live-board | 1 of 1 links | 0 of 1 links | 0 of 1 links | 5 rows among 281 candidate cards |
| observed-total | 1 of 1 links | 0 of 1 links | 0 of 1 links | 5 rows among 418 candidate cards |
| off-board-observed | 0 of 0 links | 0 of 0 links | 0 of 0 links | 0 rows among 137 candidate cards |

## Privacy and write safety

The observer blanked Prime's `prime-object-summary` job-details component and then covered the viewport with an opaque evidence-only frame before each screenshot. The frame contains only job reference, builder reference, the classified Prime status phrase, field count, observation time, and the redaction notice. Raw page text and share URLs are omitted from this artifact; only SHA-256 fingerprints remain. Screenshot verification covers every screenshot referenced by the 1-link observed-total manifest.

Unchanged observations already present in the ledger are `idempotent_noop`; changed or absent observations are `create_revision` candidates. Expired, inactive, failed, and unclassifiable pages are always `cannot_observe`, never `not_started`.

This run's mode was `commit`. It appended 1 of 1 observed-total links as capture revisions and performed 0 stage moves among 418 observed-total candidate cards. The only write action reachable from this process is `record_ses_portal_capture_evidence`; `assertCaptureWriteAction` refuses every other ops-api action at the single egress point, so no stage, substatus, job status or card placement can be written from here. A `--commit` run requires an exact `--job` and is capped at `--max-writes` (this run: 1); links left unwritten by that cap are reported as `write_skipped_write_cap` rather than dropped silently.

| Population | Dry run | Written | Idempotent no-op | Write refused | Skipped by cap | Write failed |
|---|---:|---:|---:|---:|---:|---:|
| canonical-live-board | 0 of 1 links | 1 of 1 links | 0 of 1 links | 0 of 1 links | 0 of 1 links | 0 of 1 links |
| observed-total | 0 of 1 links | 1 of 1 links | 0 of 1 links | 0 of 1 links | 0 of 1 links | 0 of 1 links |
| off-board-observed | 0 of 0 links | 0 of 0 links | 0 of 0 links | 0 of 0 links | 0 of 0 links | 0 of 0 links |

## Per-link result

| Card | Population | Builder ref | Role | Outcome | Fields | Planned action | Reason | Write outcome | Write reason |
|---|---|---|---|---|---:|---|---|---|---|
| SWMS-261081 | canonical_live_board | MLB-27100 | roof_report | submitted_locked | 21/23 | create_revision | new_or_changed_observation | written | revision_appended |

## Query and code evidence

- Q1: observed-total candidate cards plus exact current cycle and genuine portal-link source facts, labelled by the canonical live-board predicate shared with `loadCanonicalMakesafeBoard`; Management API `read_only: true`.
- Q2: existing `makesafe_portal_capture_revisions` rows for idempotency comparison, Management API `read_only: true`.
- Q3: current intake/identity authority required to derive the exact U4 builder reference, Management API `read_only: true`.
- Detailed sanitized results and screenshot hashes: [dry-run.json](dry-run.json).
