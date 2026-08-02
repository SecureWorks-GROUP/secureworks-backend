# F7 Prime portal observer - production dry run

Generated: 2026-08-02T06:45:03.128Z
Generation: `sha256:4625930d912a666fe172`
Observer: `ses-prime-portal-observer/2026-08-02.3`

## Result

The ruled design is deterministic board-side observation, outside the reporting skill, with the trade button retained as an independent channel (`/Users/marninstobbe/kun-agent-workspace/data/decisions/2026-08-02-card-identity-and-portal-capture.md:27-53`). The population correction requires a label rather than a filter: keep observing the wider set, tag each card on-board or off-board from the canonical owner, and publish every count with its population and denominator (`/Users/marninstobbe/kun-agent-workspace/data/ses-f7-portal-capture-engine-v1/decision-f7-001.md:13-36`).

This refreshed run observed 403 of 403 observed-total candidate cards. Of those, 266 of 403 are in the canonical-live-board population and 137 of 403 are in the off-board-observed population. It performed 0 production writes among 403 observed-total candidate cards and 0 stage moves among 403 observed-total candidate cards; every database query used the Management API with `read_only: true` (`dry-run.json:7-18,41-72`; `scripts/ses-f7-prime-portal-observer.ts:238-267,745-814`).

## Population-partitioned outcomes

| Population | Candidate-card denominator | Portal-card denominator | Link denominator | Submitted/locked | In progress | Not started | Cannot observe |
|---|---:|---:|---:|---:|---:|---:|---:|
| canonical-live-board | 266 of 403 observed-total candidate cards | 103 of 266 canonical-live-board candidate cards | 217 of 236 observed-total links | 6 of 217 canonical-live-board links | 6 of 217 canonical-live-board links | 4 of 217 canonical-live-board links | 201 of 217 canonical-live-board links |
| observed-total | 403 of 403 observed-total candidate cards | 111 of 403 observed-total candidate cards | 236 of 236 observed-total links | 9 of 236 observed-total links | 6 of 236 observed-total links | 4 of 236 observed-total links | 217 of 236 observed-total links |
| off-board-observed | 137 of 403 observed-total candidate cards | 8 of 137 off-board-observed candidate cards | 19 of 236 observed-total links | 3 of 19 off-board-observed links | 0 of 19 off-board-observed links | 0 of 19 off-board-observed links | 16 of 19 off-board-observed links |

The previously reported 9 submitted/locked, 6 in-progress, 4 not-started, 217 cannot-observe split is unchanged for the 236-link observed-total population. The canonical-live-board result is materially narrower: 6 submitted/locked, 6 in-progress, 4 not-started, and 201 cannot-observe among 217 canonical-live-board links. The remaining 3 submitted/locked and 16 cannot-observe results belong to the 19-link off-board-observed population (`dry-run.json:14-23,41-50,68-75`).

The observer's wider SQL still excludes only cancelled/lost jobs, while each result is labelled through the shared canonical live-board predicate; the predicate's owner also supplies the board query filter (`scripts/ses-f7-prime-portal-observer.ts:195-208,745-767,1281-1318`; `supabase/functions/ops-api/makesafe_board_read_model.ts:30-57`; `supabase/functions/ops-api/index.ts:14741-14774`).

## Roof result

| Population | Roof-card denominator | Screenshot-provable | Remains unprovable |
|---|---:|---:|---:|
| canonical-live-board | 51 of 60 observed-total roof cards | 2 of 51 canonical-live-board roof cards | 49 of 51 canonical-live-board roof cards |
| observed-total | 60 of 60 observed-total roof cards | 2 of 60 observed-total roof cards | 58 of 60 observed-total roof cards |
| off-board-observed | 9 of 60 observed-total roof cards | 0 of 9 off-board-observed roof cards | 9 of 9 off-board-observed roof cards |

Plain answer: 2 of 51 canonical-live-board roof cards would become screenshot-provable, and 49 of 51 would remain unprovable. Across the wider observed-total population, 2 of 60 roof cards would become provable and 58 of 60 would remain unprovable. The 9 off-board-observed roof cards contribute 0 provable and 9 unprovable cards. The two provable on-board cards are `SWMS-261019` and `SWMS-26980`; both have a current cycle, canonical builder reference, typed roof link, observed lock, and hash-bound screenshot (`dry-run.json:30-38,57-65,82-88,93-123,5751-5779`).

Why roof cards remain unprovable, with each reason measured against its named population's unprovable-roof denominator:

| Population | Reason | Count and denominator |
|---|---|---:|
| canonical-live-board | no_genuine_portal_link | 6 of 49 unprovable roof cards |
| canonical-live-board | missing_attendance_cycle | 6 of 49 unprovable roof cards |
| canonical-live-board | missing_builder_reference | 31 of 49 unprovable roof cards |
| canonical-live-board | expired_or_inactive_link | 5 of 49 unprovable roof cards |
| canonical-live-board | in_progress_not_submitted | 1 of 49 unprovable roof cards |
| observed-total | no_genuine_portal_link | 9 of 58 unprovable roof cards |
| observed-total | missing_attendance_cycle | 6 of 58 unprovable roof cards |
| observed-total | missing_builder_reference | 36 of 58 unprovable roof cards |
| observed-total | expired_or_inactive_link | 6 of 58 unprovable roof cards |
| observed-total | in_progress_not_submitted | 1 of 58 unprovable roof cards |
| off-board-observed | no_genuine_portal_link | 3 of 9 unprovable roof cards |
| off-board-observed | missing_builder_reference | 5 of 9 unprovable roof cards |
| off-board-observed | expired_or_inactive_link | 1 of 9 unprovable roof cards |

Each reason table is a mutually exclusive exhaustive partition of that population's unprovable-roof denominator (`dry-run.json:30-38,57-65,82-88`; `scripts/ses-f7-prime-portal-observer.ts:984-1062`). This corrects the earlier report's mislabeled active population while preserving its wider 60-roof evidence set. The pre-F7 baseline itself reported 60 roof cards, 51 with share links, and 0 screenshot capture rows under its then-stated population (`/Users/marninstobbe/kun-agent-workspace/data/ses-portal-completion-truth-audit-v1/report.md:23-36,68-76`).

`SWMS-26934` remains an important on-board distinction: the portal is observed locked at 21 of 23 with a redacted, hash-bound screenshot, but the row is unrecordable because the canonical U4 builder reference is empty. It is completed portal work, not yet provable ledger evidence (`dry-run.json:5597-5627`; `supabase/functions/ops-api/ses_portal_capture_evidence.ts:221-280`).

## Capture-revision plan

| Population | Create revision | Idempotent no-op | Cannot record | Existing ledger rows |
|---|---:|---:|---:|---:|
| canonical-live-board | 11 of 217 canonical-live-board links | 0 of 217 canonical-live-board links | 206 of 217 canonical-live-board links | 0 rows among 266 canonical-live-board candidate cards |
| observed-total | 17 of 236 observed-total links | 0 of 236 observed-total links | 219 of 236 observed-total links | 0 rows among 403 observed-total candidate cards |
| off-board-observed | 6 of 19 off-board-observed links | 0 of 19 off-board-observed links | 13 of 19 off-board-observed links | 0 rows among 137 off-board-observed candidate cards |

The plan counts are exhaustive per population and production contains 0 existing ledger rows among all 403 observed-total candidate cards (`dry-run.json:25-29,52-56,77-81`). This is a dry-run plan only; the separate authorised write step has not occurred.

## Privacy and write safety

The observer blanks every Prime `prime-object-summary` job-details component, installs an opaque fixed evidence frame, and fails closed unless every details panel is blank and the frame covers the viewport (`scripts/ses-f7-prime-portal-observer.ts:436-483,612-667`). The frame is derived only from job reference, builder reference, classified state/count, observation time, and a redaction notice; it never interpolates arbitrary portal text (`scripts/ses-f7-prime-portal-observer.ts:436-483`; `scripts/test/ses-f7-prime-portal-observer_test.ts:119-141`).

All 19 of 19 observed-total screenshots were independently SHA-256 rechecked and visually inspected. The partition is 16 of 19 screenshots from canonical-live-board links and 3 of 19 from off-board-observed links; all 19 of 19 report exactly one redacted details panel and an opaque verified frame. An `rg` scan found 0 raw URLs, 0 email shapes, and 0 phone/address shapes in the two generated text artifacts. No client/contact/address data is visible in the 19-of-19 screenshot contact sheet (Q7-Q8).

The dry run planned the existing `record_ses_portal_capture_evidence` contract but did not call it. The endpoint re-reads the exact job/cycle/reference/typed URL, requires hash-verified PNG evidence for `done`/`not_done`, forbids screenshots for `unreachable`, and commits through the append-only ledger RPC (`supabase/functions/ops-api/ses_portal_capture_evidence.ts:210-280,283-418`; `supabase/migrations/20260728500000_makesafe_portal_capture_bridge_u4.sql:53-106,108-247`). Unchanged exact observations already in the ledger are `idempotent_noop`; changed or absent observations are `create_revision` candidates (`scripts/ses-f7-prime-portal-observer.ts:390-428,1242-1279`). Expired, inactive, failed, empty, and unclassifiable pages are always `cannot_observe`, never `not_started`; only observed locked/submitted language becomes completion (`scripts/ses-f7-prime-portal-observer.ts:287-380`; `scripts/test/ses-f7-prime-portal-observer_test.ts:18-63`).

## Board connection

The canonical board loader now reads the existing `makesafe_portal_capture_revisions` ledger and fails closed to no new capture evidence if that additive read fails (`supabase/functions/ops-api/index.ts:15244-15258,15355-15387`). The read model accepts only exact current job/cycle/role/URL rows with the approved producer, result/status shape, non-empty builder reference, valid source hash, and screenshot floor for reachable states; newest accepted ledger evidence supersedes the older embedded detail capture for the same role/URL (`supabase/functions/ops-api/makesafe_board_read_model.ts:209-280,627-640`).

Accepted revisions feed the existing evidence computation, while `canonical_stage` remains the declared/display value. No stage derivation or placement authority changed (`supabase/functions/ops-api/makesafe_board_read_model.ts:650-704`; `supabase/functions/ops-api/makesafe_board_read_model_test.ts:126-176,178-295`). This closes the ledger disconnection identified by the reconciliation audit without inventing a second store or weakening the screenshot floor (`/Users/marninstobbe/kun-agent-workspace/data/ses-stage-engine-reconcile-audit-v1/report.md:147-184`).

## Per-link result

| Card | Population | Builder ref | Role | Outcome | Fields | Planned action | Reason |
|---|---|---|---|---|---:|---|---|
| SWMS-261019 | canonical_live_board | MLB-27037 | roof_report | submitted_locked | 22/24 | create_revision | new_or_changed_observation |
| SWMS-261024 | canonical_live_board | MLB-27093 | unbound | in_progress | 6/6 | cannot_record | unbound_capture_role |
| SWMS-261051 | canonical_live_board | WB69684 | unbound | cannot_observe | - | cannot_record | unbound_capture_role |
| SWMS-261057 | canonical_live_board | (unavailable) | unbound | in_progress | 21/23 | cannot_record | unbound_capture_role |
| SWMS-261079 | canonical_live_board | MLB-27148 | roof_report | submitted_locked | 22/24 | cannot_record | missing_attendance_cycle |
| SWMS-261081 | canonical_live_board | MLB-27100 | roof_report | in_progress | 21/23 | cannot_record | missing_attendance_cycle |
| SWMS-261103 | canonical_live_board | BWCWA-6781 | unbound | cannot_observe | - | cannot_record | missing_attendance_cycle |
| SWMS-261113 | canonical_live_board | MLB-19475 | roof_report | not_started | 0/22 | cannot_record | missing_attendance_cycle |
| SWMS-261114 | canonical_live_board | RR-26836 | roof_report | not_started | 0/22 | cannot_record | missing_attendance_cycle |
| SWMS-261116 | canonical_live_board | MLB-27387 | roof_report | in_progress | 21/24 | cannot_record | missing_attendance_cycle |
| SWMS-261123 | canonical_live_board | MLB-27309 | roof_report | in_progress | 19/23 | cannot_record | missing_attendance_cycle |
| SWMS-26618 | canonical_live_board | (unavailable) | roof_report | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26632 | canonical_live_board | (unavailable) | roof_report | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26660 | canonical_live_board | (unavailable) | roof_report | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26706 | canonical_live_board | (unavailable) | roof_report | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26708 | canonical_live_board | (unavailable) | assessment | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26708 | canonical_live_board | (unavailable) | photos | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26708 | canonical_live_board | (unavailable) | scope | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26709 | canonical_live_board | (unavailable) | roof_report | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26710 | canonical_live_board | (unavailable) | assessment | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26710 | canonical_live_board | (unavailable) | photos | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26710 | canonical_live_board | (unavailable) | scope | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26711 | canonical_live_board | (unavailable) | assessment | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26711 | canonical_live_board | (unavailable) | photos | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26711 | canonical_live_board | (unavailable) | scope | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26712 | canonical_live_board | (unavailable) | assessment | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26712 | canonical_live_board | (unavailable) | photos | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26712 | canonical_live_board | (unavailable) | scope | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26713 | canonical_live_board | MLB-26122 | roof_report | cannot_observe | - | create_revision | new_or_changed_observation |
| SWMS-26713 | canonical_live_board | MLB-26122 | roof_report | cannot_observe | - | create_revision | new_or_changed_observation |
| SWMS-26715 | canonical_live_board | (unavailable) | roof_report | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26717 | canonical_live_board | (unavailable) | assessment | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26717 | canonical_live_board | (unavailable) | photos | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26717 | canonical_live_board | (unavailable) | scope | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26718 | canonical_live_board | (unavailable) | assessment | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26718 | canonical_live_board | (unavailable) | photos | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26718 | canonical_live_board | (unavailable) | scope | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26719 | canonical_live_board | MLB-24404 | roof_report | cannot_observe | - | create_revision | new_or_changed_observation |
| SWMS-26720 | canonical_live_board | (unavailable) | roof_report | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26721 | canonical_live_board | (unavailable) | assessment | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26721 | canonical_live_board | (unavailable) | photos | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26721 | canonical_live_board | (unavailable) | scope | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26721 | canonical_live_board | (unavailable) | roof_report | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26722 | canonical_live_board | (unavailable) | assessment | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26722 | canonical_live_board | (unavailable) | photos | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26722 | canonical_live_board | (unavailable) | scope | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26722 | canonical_live_board | (unavailable) | scope | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26722 | canonical_live_board | (unavailable) | roof_report | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26723 | canonical_live_board | (unavailable) | assessment | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26723 | canonical_live_board | (unavailable) | photos | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26723 | canonical_live_board | (unavailable) | scope | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26724 | canonical_live_board | (unavailable) | assessment | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26724 | canonical_live_board | (unavailable) | photos | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26724 | canonical_live_board | (unavailable) | scope | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26725 | canonical_live_board | (unavailable) | assessment | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26725 | canonical_live_board | (unavailable) | photos | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26725 | canonical_live_board | (unavailable) | scope | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26726 | canonical_live_board | (unavailable) | assessment | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26726 | canonical_live_board | (unavailable) | photos | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26726 | canonical_live_board | (unavailable) | scope | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26727 | canonical_live_board | (unavailable) | roof_report | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26728 | canonical_live_board | (unavailable) | assessment | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26728 | canonical_live_board | (unavailable) | photos | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26728 | canonical_live_board | (unavailable) | scope | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26729 | canonical_live_board | (unavailable) | roof_report | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26729 | canonical_live_board | (unavailable) | roof_report | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26730 | canonical_live_board | (unavailable) | assessment | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26730 | canonical_live_board | (unavailable) | photos | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26730 | canonical_live_board | (unavailable) | scope | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26731 | off_board_observed | (unavailable) | assessment | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26731 | off_board_observed | (unavailable) | photos | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26731 | off_board_observed | (unavailable) | scope | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26732 | canonical_live_board | (unavailable) | assessment | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26732 | canonical_live_board | (unavailable) | photos | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26732 | canonical_live_board | (unavailable) | scope | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26733 | canonical_live_board | (unavailable) | assessment | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26733 | canonical_live_board | (unavailable) | photos | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26733 | canonical_live_board | (unavailable) | scope | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26734 | canonical_live_board | (unavailable) | assessment | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26734 | canonical_live_board | (unavailable) | photos | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26735 | canonical_live_board | (unavailable) | assessment | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26735 | canonical_live_board | (unavailable) | photos | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26735 | canonical_live_board | (unavailable) | scope | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26735 | canonical_live_board | (unavailable) | roof_report | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26736 | canonical_live_board | (unavailable) | assessment | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26736 | canonical_live_board | (unavailable) | photos | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26736 | canonical_live_board | (unavailable) | scope | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26736 | canonical_live_board | (unavailable) | roof_report | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26737 | canonical_live_board | (unavailable) | assessment | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26737 | canonical_live_board | (unavailable) | photos | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26737 | canonical_live_board | (unavailable) | scope | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26738 | canonical_live_board | (unavailable) | assessment | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26738 | canonical_live_board | (unavailable) | photos | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26738 | canonical_live_board | (unavailable) | scope | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26739 | canonical_live_board | (unavailable) | assessment | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26739 | canonical_live_board | (unavailable) | photos | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26739 | canonical_live_board | (unavailable) | scope | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26740 | canonical_live_board | (unavailable) | assessment | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26740 | canonical_live_board | (unavailable) | photos | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26740 | canonical_live_board | (unavailable) | scope | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26741 | canonical_live_board | (unavailable) | assessment | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26741 | canonical_live_board | (unavailable) | photos | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26741 | canonical_live_board | (unavailable) | scope | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26742 | canonical_live_board | (unavailable) | assessment | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26742 | canonical_live_board | (unavailable) | photos | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26742 | canonical_live_board | (unavailable) | roof_report | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26744 | canonical_live_board | (unavailable) | assessment | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26744 | canonical_live_board | (unavailable) | photos | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26744 | canonical_live_board | (unavailable) | scope | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26747 | canonical_live_board | (unavailable) | assessment | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26747 | canonical_live_board | (unavailable) | photos | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26747 | canonical_live_board | (unavailable) | scope | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26748 | canonical_live_board | (unavailable) | assessment | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26748 | canonical_live_board | (unavailable) | photos | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26748 | canonical_live_board | (unavailable) | scope | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26749 | canonical_live_board | (unavailable) | assessment | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26749 | canonical_live_board | (unavailable) | photos | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26749 | canonical_live_board | (unavailable) | scope | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26750 | canonical_live_board | (unavailable) | assessment | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26750 | canonical_live_board | (unavailable) | photos | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26750 | canonical_live_board | (unavailable) | scope | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26751 | canonical_live_board | (unavailable) | assessment | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26751 | canonical_live_board | (unavailable) | photos | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26751 | canonical_live_board | (unavailable) | scope | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26752 | canonical_live_board | (unavailable) | assessment | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26752 | canonical_live_board | (unavailable) | photos | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26752 | canonical_live_board | (unavailable) | scope | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26753 | canonical_live_board | (unavailable) | assessment | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26753 | canonical_live_board | (unavailable) | photos | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26753 | canonical_live_board | (unavailable) | scope | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26754 | canonical_live_board | (unavailable) | roof_report | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26755 | off_board_observed | (unavailable) | assessment | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26755 | off_board_observed | (unavailable) | photos | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26755 | off_board_observed | (unavailable) | scope | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26755 | off_board_observed | (unavailable) | scope | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26755 | off_board_observed | (unavailable) | roof_report | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26756 | off_board_observed | MLB-25769 | assessment | cannot_observe | - | create_revision | new_or_changed_observation |
| SWMS-26756 | off_board_observed | MLB-25769 | photos | cannot_observe | - | create_revision | new_or_changed_observation |
| SWMS-26756 | off_board_observed | MLB-25769 | scope | cannot_observe | - | create_revision | new_or_changed_observation |
| SWMS-26756 | off_board_observed | MLB-25769 | scope | cannot_observe | - | create_revision | new_or_changed_observation |
| SWMS-26756 | off_board_observed | MLB-25769 | roof_report | cannot_observe | - | create_revision | new_or_changed_observation |
| SWMS-26757 | canonical_live_board | (unavailable) | assessment | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26757 | canonical_live_board | (unavailable) | photos | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26757 | canonical_live_board | (unavailable) | scope | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26759 | canonical_live_board | (unavailable) | assessment | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26759 | canonical_live_board | (unavailable) | photos | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26759 | canonical_live_board | (unavailable) | scope | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26759 | canonical_live_board | (unavailable) | roof_report | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26762 | canonical_live_board | (unavailable) | roof_report | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26763 | canonical_live_board | (unavailable) | roof_report | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26766 | canonical_live_board | (unavailable) | assessment | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26766 | canonical_live_board | (unavailable) | photos | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26766 | canonical_live_board | (unavailable) | scope | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26769 | canonical_live_board | (unavailable) | assessment | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26769 | canonical_live_board | (unavailable) | photos | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26769 | canonical_live_board | (unavailable) | scope | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26770 | canonical_live_board | (unavailable) | assessment | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26770 | canonical_live_board | (unavailable) | photos | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26770 | canonical_live_board | (unavailable) | scope | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26772 | canonical_live_board | (unavailable) | assessment | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26772 | canonical_live_board | (unavailable) | photos | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26772 | canonical_live_board | (unavailable) | scope | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26773 | canonical_live_board | (unavailable) | roof_report | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26775 | canonical_live_board | (unavailable) | assessment | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26775 | canonical_live_board | (unavailable) | photos | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26775 | canonical_live_board | (unavailable) | scope | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26779 | canonical_live_board | (unavailable) | assessment | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26779 | canonical_live_board | (unavailable) | photos | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26779 | canonical_live_board | (unavailable) | scope | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26780 | canonical_live_board | (unavailable) | assessment | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26780 | canonical_live_board | (unavailable) | photos | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26780 | canonical_live_board | (unavailable) | scope | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26781 | canonical_live_board | (unavailable) | assessment | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26781 | canonical_live_board | (unavailable) | photos | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26781 | canonical_live_board | (unavailable) | scope | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26783 | canonical_live_board | (unavailable) | roof_report | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26785 | canonical_live_board | (unavailable) | assessment | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26785 | canonical_live_board | (unavailable) | photos | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26785 | canonical_live_board | (unavailable) | scope | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26786 | canonical_live_board | (unavailable) | roof_report | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26787 | canonical_live_board | (unavailable) | assessment | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26787 | canonical_live_board | (unavailable) | photos | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26787 | canonical_live_board | (unavailable) | scope | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26788 | canonical_live_board | (unavailable) | assessment | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26788 | canonical_live_board | (unavailable) | photos | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26788 | canonical_live_board | (unavailable) | scope | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26789 | canonical_live_board | (unavailable) | assessment | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26789 | canonical_live_board | (unavailable) | photos | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26789 | canonical_live_board | (unavailable) | scope | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26791 | canonical_live_board | (unavailable) | assessment | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26791 | canonical_live_board | (unavailable) | photos | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26791 | canonical_live_board | (unavailable) | scope | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26792 | canonical_live_board | (unavailable) | assessment | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26792 | canonical_live_board | (unavailable) | photos | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26792 | canonical_live_board | (unavailable) | scope | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26793 | canonical_live_board | (unavailable) | roof_report | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26795 | canonical_live_board | (unavailable) | roof_report | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26803 | canonical_live_board | (unavailable) | roof_report | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26805 | canonical_live_board | (unavailable) | roof_report | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26810 | canonical_live_board | (unavailable) | roof_report | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26814 | canonical_live_board | (unavailable) | roof_report | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26844 | canonical_live_board | (unavailable) | roof_report | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26846 | off_board_observed | MLB-25898 | roof_report | cannot_observe | - | create_revision | new_or_changed_observation |
| SWMS-26847 | canonical_live_board | MLB-26060 | roof_report | cannot_observe | - | create_revision | new_or_changed_observation |
| SWMS-26848 | canonical_live_board | MLB-26549 | roof_report | cannot_observe | - | create_revision | new_or_changed_observation |
| SWMS-26849 | canonical_live_board | MLB-26499 | roof_report | cannot_observe | - | create_revision | new_or_changed_observation |
| SWMS-26851 | canonical_live_board | (unavailable) | assessment | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26851 | canonical_live_board | (unavailable) | photos | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26851 | canonical_live_board | (unavailable) | scope | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26852 | canonical_live_board | (unavailable) | assessment | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26852 | canonical_live_board | (unavailable) | photos | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26852 | canonical_live_board | (unavailable) | scope | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26853 | canonical_live_board | (unavailable) | assessment | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26853 | canonical_live_board | (unavailable) | photos | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26853 | canonical_live_board | (unavailable) | scope | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26855 | canonical_live_board | (unavailable) | assessment | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26857 | canonical_live_board | MLB-26177 | assessment | cannot_observe | - | create_revision | new_or_changed_observation |
| SWMS-26858 | canonical_live_board | (unavailable) | assessment | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26861 | off_board_observed | (unavailable) | roof_report | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26863 | canonical_live_board | (unavailable) | roof_report | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26865 | off_board_observed | (unavailable) | roof_report | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26902 | canonical_live_board | (unavailable) | unbound | not_started | 0/4 | cannot_record | unbound_capture_role |
| SWMS-26928 | canonical_live_board | MLB-26705 | roof_report | in_progress | 19/23 | create_revision | new_or_changed_observation |
| SWMS-26933 | off_board_observed | (unavailable) | roof_report | submitted_locked | 19/22 | cannot_record | missing_builder_reference |
| SWMS-26933 | off_board_observed | (unavailable) | roof_report | submitted_locked | 19/22 | cannot_record | missing_builder_reference |
| SWMS-26934 | canonical_live_board | (unavailable) | roof_report | submitted_locked | 21/23 | cannot_record | missing_builder_reference |
| SWMS-26946 | canonical_live_board | AJBR-69191 | roof_report | submitted_locked | 13/15 | create_revision | new_or_changed_observation |
| SWMS-26953 | canonical_live_board | (unavailable) | unbound | not_started | 0/4 | cannot_record | unbound_capture_role |
| SWMS-26957 | canonical_live_board | (unavailable) | roof_report | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26964 | off_board_observed | (unavailable) | roof_report | submitted_locked | 21/23 | cannot_record | missing_builder_reference |
| SWMS-26980 | canonical_live_board | MLB-26567 | roof_report | submitted_locked | 20/23 | create_revision | new_or_changed_observation |
| SWMS-26981 | canonical_live_board | (unavailable) | unbound | submitted_locked | 5/5 | cannot_record | unbound_capture_role |
| SWMS-26998 | canonical_live_board | (unavailable) | roof_report | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26998 | canonical_live_board | (unavailable) | roof_report | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26998 | canonical_live_board | (unavailable) | roof_report | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26998 | canonical_live_board | (unavailable) | roof_report | cannot_observe | - | cannot_record | missing_builder_reference |

## Query and code evidence

- **Q1:** the observed-total query loaded 403 of 403 observed-total candidates with exact current cycle and genuine portal-link source facts. It deliberately retained archived evidence by excluding only cancelled/lost jobs (`scripts/ses-f7-prime-portal-observer.ts:745-779`). The canonical-live-board label came from the shared predicate used by the board query owner (`supabase/functions/ops-api/makesafe_board_read_model.ts:30-57`; `supabase/functions/ops-api/index.ts:14741-14774`). Every Management API query passed the SELECT-only guard and `read_only: true` (`scripts/ses-f7-prime-portal-observer.ts:238-267`).
- **Q2:** the idempotency comparison read 0 existing ledger rows among 403 observed-total candidate cards from `makesafe_portal_capture_revisions`, using Management API `read_only: true` (`scripts/ses-f7-prime-portal-observer.ts:780-785`; `dry-run.json:25-29`).
- **Q3:** current intake/identity authority was read to reproduce U4's canonical builder-reference selection; those reads are also Management API `read_only: true` (`scripts/ses-f7-prime-portal-observer.ts:503-524,786-814`).
- **Q4:** `jq` over `dry-run.json` proved the population partition and outcome totals. Observed-total: 236 of 236 links, split 9 submitted/locked, 6 in-progress, 4 not-started, 217 cannot-observe. Canonical-live-board: 217 of 236 observed-total links, split 6/217 submitted/locked, 6/217 in-progress, 4/217 not-started, 201/217 cannot-observe. Off-board-observed: 19 of 236 observed-total links, split 3/19 submitted/locked and 16/19 cannot-observe (`dry-run.json:14-23,41-50,68-75`).
- **Q5:** `jq` grouped planned actions by population and capture result. Canonical-live-board has 11 of 217 `create_revision` links (3 done, 1 not_done, 7 unreachable) and 206 of 217 `cannot_record` links. Off-board-observed has 6 of 19 `create_revision` links (all unreachable) and 13 of 19 `cannot_record` links. Observed-total therefore has 17 of 236 `create_revision` links (3 done, 1 not_done, 13 unreachable) and 219 of 236 `cannot_record` links (`dry-run.json:25-29,52-56,77-81`).
- **Q6:** `jq` selected unique roof results where `outcome == "submitted_locked"`, `recordable == true`, and screenshot evidence exists. Output: 2 of 51 canonical-live-board roof cards (`SWMS-261019`, `SWMS-26980`), also 2 of 60 observed-total roof cards, and 0 of 9 off-board-observed roof cards (`dry-run.json:30-38,57-65,82-88,93-123,5751-5779`).
- **Q7:** 19 of 19 observed-total manifest screenshots were independently SHA-256 checked with `shasum -a 256`; output: `screenshots_checked=19 actual_png_files=19 hash_failures=0`. The population split was 16 of 19 canonical-live-board screenshots and 3 of 19 off-board-observed screenshots. Manifest facts were `job_details_panels_redacted={1:19}` and `opaque_frame_verified=19`.
- **Q8:** an `ffmpeg` contact sheet normalized and displayed all 19 of 19 observed-total screenshots for visual inspection. An `rg` privacy scan over the generated text artifacts found 0 raw URLs, 0 email shapes, and 0 phone/address shapes. No prohibited client data was visible. This follows the standing privacy boundary (`/Users/marninstobbe/kun-agent-workspace/data/board-truth-mandate.md:58-66`).
- **Q9:** focused validation passed: observer classifier/population/privacy/read-only/idempotency suite 10 of 10 tests (`scripts/test/ses-f7-prime-portal-observer_test.ts:18-159`); canonical board read-model suite 26 of 26 tests, including exact-cycle acceptance, newest-ledger precedence, stale cycle/wrong URL/missing reference/missing screenshot rejection, unchanged canonical stage, ledger-loader wiring, and shared population ownership (`supabase/functions/ops-api/makesafe_board_read_model_test.ts:126-335`).

Detailed sanitized results and screenshot hashes are in [dry-run.json](dry-run.json:1). Raw share URLs and raw page text are deliberately absent.
