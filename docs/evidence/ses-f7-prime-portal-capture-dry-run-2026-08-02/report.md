# F7 Prime portal observer - production dry run

Generated: 2026-08-02T05:14:00.934Z
Generation: `sha256:b07887d5904c68fa74aa`
Observer: `ses-prime-portal-observer/2026-08-02.2`

## Result

The ruled design is a deterministic observer against the board, outside the reporting skill, with the trade button preserved as an independent channel (`/Users/marninstobbe/kun-agent-workspace/data/decisions/2026-08-02-card-identity-and-portal-capture.md:27-53`). This run read **111 active board cards carrying 236 genuine portal links**. It performed **zero production writes and zero stage moves**; every database query used the Management API with `read_only: true` (`dry-run.json:7-16`; `scripts/ses-f7-prime-portal-observer.ts:212-241,711-761`).

Link outcomes:

- submitted/locked: **9**
- in progress: **6**
- not started: **4**
- cannot observe: **217**

These totals are the manifest's exhaustive 236-row partition (`dry-run.json:13-23`). The classifier maps completion only from observed locked/submitted language, maps answered counts without that language to in-progress/not-started, and maps expired, failed, empty, or unclassifiable pages to `cannot_observe` (`scripts/ses-f7-prime-portal-observer.ts:244-360`).

Across all families, **17 links are exact capture-revision candidates**: 3 `done`, 1 `not_done`, and 13 `unreachable`; the other 219 cannot be recorded because the current card lacks a canonical cycle/reference/role binding (Q4 below). Production still contains **zero existing capture rows**, so no candidate was an idempotent no-op in this first run (`dry-run.json:23`; Q4).

## Roof answer

**2 of 60 active roof cards would become screenshot-provable: `SWMS-261019` and `SWMS-26980`. The other 58 remain unprovable.** Both passing rows are current-cycle roof captures with an observed lock, non-empty builder reference, screenshot hash/size, and `create_revision` plan (`dry-run.json:36-65,5462-5491`; Q5).

Primary reasons the 58 roof cards remain unprovable:

- no genuine portal link: **9**
- missing current attendance cycle: **6**
- missing canonical builder reference: **36**
- expired or inactive link: **6**
- reachable but in progress, not submitted: **1**

The primary-reason counts are mutually exclusive and sum to 58; precedence is cycle, canonical reference, typed role, unfinished state, expiry/unavailability (`dry-run.json:24-33`; `scripts/ses-f7-prime-portal-observer.ts:1133-1158`). This is a stricter answer than the pre-F7 audit's 46 unproved roof jobs: direct observation found completed forms, but a completion is not called provable unless the whole ledger binding and screenshot contract can accept it. The earlier baseline was 60 roof cards, 51 with a share link, and zero screenshot capture rows (`/Users/marninstobbe/kun-agent-workspace/data/ses-portal-completion-truth-audit-v1/report.md:23-36,68-76`).

`SWMS-26934` is confirmed locked at **21 of 23**, with a redacted, hash-bound screenshot, but it remains unrecordable because the canonical U4 builder reference is empty. Calling it provable would make the existing endpoint reject the row; this is a real identity blocker, not unfinished portal work (`dry-run.json:5315-5344`; `supabase/functions/ops-api/ses_portal_capture_evidence.ts:221-280`).

## Privacy and write safety

The observer blanked Prime's `prime-object-summary` job-details component and then covered the viewport with an opaque evidence-only frame before each screenshot. It fails closed unless every panel is blank, the white frame covers sampled viewport corners and centre, and the frame is still opaque (`scripts/ses-f7-prime-portal-observer.ts:410-458,578-632`). It then verifies PNG signature, minimum dimensions, byte size, and SHA-256 before accepting the file (`scripts/ses-f7-prime-portal-observer.ts:634-685`).

The frame contains only job reference, builder reference, the classified Prime status phrase, field count, observation time, and the redaction notice. Raw page text and share URLs are omitted from this artifact; only SHA-256 fingerprints remain (`scripts/ses-f7-prime-portal-observer.ts:410-458,1006-1041,1083-1111`). All **19** generated screenshots were hash-reverified against the manifest and visually inspected together; every one showed the opaque evidence frame, every one reported exactly one redacted job-details panel, and none exposed client/contact/address data (Q6-Q7).

The dry run planned the existing `record_ses_portal_capture_evidence` contract but did not call it. That existing endpoint re-reads the canonical job/cycle/reference/typed URL, requires PNG evidence for `done`/`not_done`, forbids a screenshot for `unreachable`, uploads content-addressed bytes, and commits through the append-only ledger RPC (`supabase/functions/ops-api/ses_portal_capture_evidence.ts:210-280,283-418`; `supabase/migrations/20260728500000_makesafe_portal_capture_bridge_u4.sql:53-106,108-247`). Unchanged observations already present in the ledger are `idempotent_noop`; changed or absent observations are `create_revision` candidates. The stable idempotency identity excludes timestamped screenshot bytes but requires a valid stored screenshot hash for reachable no-ops (`scripts/ses-f7-prime-portal-observer.ts:362-380,1043-1081`).

## Board connection

The canonical board loader now reads the existing `makesafe_portal_capture_revisions` ledger and fails closed to no new evidence if that additive read fails (`supabase/functions/ops-api/index.ts:15243-15257,15354-15386`). The read model accepts only the exact current job/cycle/role/URL, approved producer and result/status shape, non-empty builder reference, valid source hash, and screenshot floor for `done`/`not_done`; it deduplicates newest-first by role plus URL (`supabase/functions/ops-api/makesafe_board_read_model.ts:155-270`).

Accepted revisions supersede any older embedded detail capture for the same role and URL, feed the existing evidence computation, and expose sanitized revision provenance. `canonical_stage` remains the existing declared/display value; no placement-authority cutover was made (`supabase/functions/ops-api/makesafe_board_read_model.ts:590-659,660-723`). This closes the exact disconnection identified by the reconciliation audit without inventing a second store or weakening the screenshot floor (`/Users/marninstobbe/kun-agent-workspace/data/ses-stage-engine-reconcile-audit-v1/report.md:147-184`).

## Per-link result

| Card | Builder ref | Role | Outcome | Fields | Planned action | Reason |
|---|---|---|---|---:|---|---|
| SWMS-261019 | MLB-27037 | roof_report | submitted_locked | 22/24 | create_revision | new_or_changed_observation |
| SWMS-261024 | MLB-27093 | unbound | in_progress | 6/6 | cannot_record | unbound_capture_role |
| SWMS-261051 | WB69684 | unbound | cannot_observe | - | cannot_record | unbound_capture_role |
| SWMS-261057 | (unavailable) | unbound | in_progress | 21/23 | cannot_record | unbound_capture_role |
| SWMS-261079 | MLB-27148 | roof_report | submitted_locked | 22/24 | cannot_record | missing_attendance_cycle |
| SWMS-261081 | MLB-27100 | roof_report | in_progress | 21/23 | cannot_record | missing_attendance_cycle |
| SWMS-261103 | BWCWA-6781 | unbound | cannot_observe | - | cannot_record | missing_attendance_cycle |
| SWMS-261113 | MLB-19475 | roof_report | not_started | 0/22 | cannot_record | missing_attendance_cycle |
| SWMS-261114 | RR-26836 | roof_report | not_started | 0/22 | cannot_record | missing_attendance_cycle |
| SWMS-261116 | MLB-27387 | roof_report | in_progress | 17/23 | cannot_record | missing_attendance_cycle |
| SWMS-261123 | MLB-27309 | roof_report | in_progress | 19/23 | cannot_record | missing_attendance_cycle |
| SWMS-26618 | (unavailable) | roof_report | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26632 | (unavailable) | roof_report | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26660 | (unavailable) | roof_report | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26706 | (unavailable) | roof_report | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26708 | (unavailable) | assessment | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26708 | (unavailable) | photos | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26708 | (unavailable) | scope | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26709 | (unavailable) | roof_report | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26710 | (unavailable) | assessment | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26710 | (unavailable) | photos | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26710 | (unavailable) | scope | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26711 | (unavailable) | assessment | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26711 | (unavailable) | photos | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26711 | (unavailable) | scope | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26712 | (unavailable) | assessment | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26712 | (unavailable) | photos | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26712 | (unavailable) | scope | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26713 | MLB-26122 | roof_report | cannot_observe | - | create_revision | new_or_changed_observation |
| SWMS-26713 | MLB-26122 | roof_report | cannot_observe | - | create_revision | new_or_changed_observation |
| SWMS-26715 | (unavailable) | roof_report | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26717 | (unavailable) | assessment | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26717 | (unavailable) | photos | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26717 | (unavailable) | scope | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26718 | (unavailable) | assessment | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26718 | (unavailable) | photos | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26718 | (unavailable) | scope | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26719 | MLB-24404 | roof_report | cannot_observe | - | create_revision | new_or_changed_observation |
| SWMS-26720 | (unavailable) | roof_report | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26721 | (unavailable) | assessment | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26721 | (unavailable) | photos | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26721 | (unavailable) | scope | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26721 | (unavailable) | roof_report | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26722 | (unavailable) | assessment | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26722 | (unavailable) | photos | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26722 | (unavailable) | scope | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26722 | (unavailable) | scope | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26722 | (unavailable) | roof_report | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26723 | (unavailable) | assessment | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26723 | (unavailable) | photos | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26723 | (unavailable) | scope | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26724 | (unavailable) | assessment | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26724 | (unavailable) | photos | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26724 | (unavailable) | scope | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26725 | (unavailable) | assessment | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26725 | (unavailable) | photos | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26725 | (unavailable) | scope | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26726 | (unavailable) | assessment | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26726 | (unavailable) | photos | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26726 | (unavailable) | scope | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26727 | (unavailable) | roof_report | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26728 | (unavailable) | assessment | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26728 | (unavailable) | photos | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26728 | (unavailable) | scope | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26729 | (unavailable) | roof_report | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26729 | (unavailable) | roof_report | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26730 | (unavailable) | assessment | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26730 | (unavailable) | photos | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26730 | (unavailable) | scope | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26731 | (unavailable) | assessment | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26731 | (unavailable) | photos | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26731 | (unavailable) | scope | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26732 | (unavailable) | assessment | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26732 | (unavailable) | photos | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26732 | (unavailable) | scope | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26733 | (unavailable) | assessment | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26733 | (unavailable) | photos | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26733 | (unavailable) | scope | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26734 | (unavailable) | assessment | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26734 | (unavailable) | photos | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26735 | (unavailable) | assessment | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26735 | (unavailable) | photos | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26735 | (unavailable) | scope | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26735 | (unavailable) | roof_report | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26736 | (unavailable) | assessment | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26736 | (unavailable) | photos | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26736 | (unavailable) | scope | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26736 | (unavailable) | roof_report | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26737 | (unavailable) | assessment | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26737 | (unavailable) | photos | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26737 | (unavailable) | scope | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26738 | (unavailable) | assessment | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26738 | (unavailable) | photos | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26738 | (unavailable) | scope | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26739 | (unavailable) | assessment | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26739 | (unavailable) | photos | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26739 | (unavailable) | scope | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26740 | (unavailable) | assessment | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26740 | (unavailable) | photos | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26740 | (unavailable) | scope | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26741 | (unavailable) | assessment | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26741 | (unavailable) | photos | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26741 | (unavailable) | scope | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26742 | (unavailable) | assessment | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26742 | (unavailable) | photos | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26742 | (unavailable) | roof_report | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26744 | (unavailable) | assessment | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26744 | (unavailable) | photos | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26744 | (unavailable) | scope | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26747 | (unavailable) | assessment | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26747 | (unavailable) | photos | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26747 | (unavailable) | scope | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26748 | (unavailable) | assessment | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26748 | (unavailable) | photos | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26748 | (unavailable) | scope | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26749 | (unavailable) | assessment | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26749 | (unavailable) | photos | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26749 | (unavailable) | scope | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26750 | (unavailable) | assessment | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26750 | (unavailable) | photos | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26750 | (unavailable) | scope | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26751 | (unavailable) | assessment | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26751 | (unavailable) | photos | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26751 | (unavailable) | scope | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26752 | (unavailable) | assessment | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26752 | (unavailable) | photos | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26752 | (unavailable) | scope | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26753 | (unavailable) | assessment | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26753 | (unavailable) | photos | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26753 | (unavailable) | scope | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26754 | (unavailable) | roof_report | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26755 | (unavailable) | assessment | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26755 | (unavailable) | photos | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26755 | (unavailable) | scope | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26755 | (unavailable) | scope | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26755 | (unavailable) | roof_report | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26756 | MLB-25769 | assessment | cannot_observe | - | create_revision | new_or_changed_observation |
| SWMS-26756 | MLB-25769 | photos | cannot_observe | - | create_revision | new_or_changed_observation |
| SWMS-26756 | MLB-25769 | scope | cannot_observe | - | create_revision | new_or_changed_observation |
| SWMS-26756 | MLB-25769 | scope | cannot_observe | - | create_revision | new_or_changed_observation |
| SWMS-26756 | MLB-25769 | roof_report | cannot_observe | - | create_revision | new_or_changed_observation |
| SWMS-26757 | (unavailable) | assessment | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26757 | (unavailable) | photos | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26757 | (unavailable) | scope | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26759 | (unavailable) | assessment | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26759 | (unavailable) | photos | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26759 | (unavailable) | scope | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26759 | (unavailable) | roof_report | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26762 | (unavailable) | roof_report | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26763 | (unavailable) | roof_report | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26766 | (unavailable) | assessment | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26766 | (unavailable) | photos | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26766 | (unavailable) | scope | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26769 | (unavailable) | assessment | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26769 | (unavailable) | photos | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26769 | (unavailable) | scope | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26770 | (unavailable) | assessment | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26770 | (unavailable) | photos | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26770 | (unavailable) | scope | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26772 | (unavailable) | assessment | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26772 | (unavailable) | photos | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26772 | (unavailable) | scope | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26773 | (unavailable) | roof_report | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26775 | (unavailable) | assessment | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26775 | (unavailable) | photos | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26775 | (unavailable) | scope | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26779 | (unavailable) | assessment | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26779 | (unavailable) | photos | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26779 | (unavailable) | scope | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26780 | (unavailable) | assessment | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26780 | (unavailable) | photos | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26780 | (unavailable) | scope | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26781 | (unavailable) | assessment | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26781 | (unavailable) | photos | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26781 | (unavailable) | scope | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26783 | (unavailable) | roof_report | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26785 | (unavailable) | assessment | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26785 | (unavailable) | photos | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26785 | (unavailable) | scope | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26786 | (unavailable) | roof_report | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26787 | (unavailable) | assessment | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26787 | (unavailable) | photos | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26787 | (unavailable) | scope | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26788 | (unavailable) | assessment | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26788 | (unavailable) | photos | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26788 | (unavailable) | scope | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26789 | (unavailable) | assessment | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26789 | (unavailable) | photos | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26789 | (unavailable) | scope | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26791 | (unavailable) | assessment | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26791 | (unavailable) | photos | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26791 | (unavailable) | scope | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26792 | (unavailable) | assessment | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26792 | (unavailable) | photos | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26792 | (unavailable) | scope | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26793 | (unavailable) | roof_report | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26795 | (unavailable) | roof_report | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26803 | (unavailable) | roof_report | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26805 | (unavailable) | roof_report | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26810 | (unavailable) | roof_report | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26814 | (unavailable) | roof_report | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26844 | (unavailable) | roof_report | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26846 | MLB-25898 | roof_report | cannot_observe | - | create_revision | new_or_changed_observation |
| SWMS-26847 | MLB-26060 | roof_report | cannot_observe | - | create_revision | new_or_changed_observation |
| SWMS-26848 | MLB-26549 | roof_report | cannot_observe | - | create_revision | new_or_changed_observation |
| SWMS-26849 | MLB-26499 | roof_report | cannot_observe | - | create_revision | new_or_changed_observation |
| SWMS-26851 | (unavailable) | assessment | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26851 | (unavailable) | photos | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26851 | (unavailable) | scope | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26852 | (unavailable) | assessment | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26852 | (unavailable) | photos | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26852 | (unavailable) | scope | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26853 | (unavailable) | assessment | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26853 | (unavailable) | photos | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26853 | (unavailable) | scope | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26855 | (unavailable) | assessment | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26857 | MLB-26177 | assessment | cannot_observe | - | create_revision | new_or_changed_observation |
| SWMS-26858 | (unavailable) | assessment | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26861 | (unavailable) | roof_report | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26863 | (unavailable) | roof_report | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26865 | (unavailable) | roof_report | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26902 | (unavailable) | unbound | not_started | 0/4 | cannot_record | unbound_capture_role |
| SWMS-26928 | MLB-26705 | roof_report | in_progress | 19/23 | create_revision | new_or_changed_observation |
| SWMS-26933 | (unavailable) | roof_report | submitted_locked | 19/22 | cannot_record | missing_builder_reference |
| SWMS-26933 | (unavailable) | roof_report | submitted_locked | 19/22 | cannot_record | missing_builder_reference |
| SWMS-26934 | (unavailable) | roof_report | submitted_locked | 21/23 | cannot_record | missing_builder_reference |
| SWMS-26946 | AJBR-69191 | roof_report | submitted_locked | 13/15 | create_revision | new_or_changed_observation |
| SWMS-26953 | (unavailable) | unbound | not_started | 0/4 | cannot_record | unbound_capture_role |
| SWMS-26957 | (unavailable) | roof_report | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26964 | (unavailable) | roof_report | submitted_locked | 21/23 | cannot_record | missing_builder_reference |
| SWMS-26980 | MLB-26567 | roof_report | submitted_locked | 20/23 | create_revision | new_or_changed_observation |
| SWMS-26981 | (unavailable) | unbound | submitted_locked | 5/5 | cannot_record | unbound_capture_role |
| SWMS-26998 | (unavailable) | roof_report | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26998 | (unavailable) | roof_report | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26998 | (unavailable) | roof_report | cannot_observe | - | cannot_record | missing_builder_reference |
| SWMS-26998 | (unavailable) | roof_report | cannot_observe | - | cannot_record | missing_builder_reference |

## Query and code evidence

- **Q1:** active board cards plus exact current cycle and genuine portal-link source facts. The SQL is reproduced in `scripts/ses-f7-prime-portal-observer.ts:718-740`; the Management API wrapper rejects non-SELECT statements and sends `read_only: true` at `:212-241`.
- **Q2:** existing `makesafe_portal_capture_revisions` rows for idempotency comparison. SQL: `scripts/ses-f7-prime-portal-observer.ts:743-748`.
- **Q3:** live/blocked intake cases and current identity authority used to reproduce U4's canonical builder-reference selection. SQL and deterministic grouping: `scripts/ses-f7-prime-portal-observer.ts:749-803`; selection rule: `:477-498`.
- **Q4:** `jq` over `dry-run.json` grouped all 236 results by planned action/result. Output: `create_revision=17` (`done=3`, `not_done=1`, `unreachable=13`); `cannot_record=219`.
- **Q5:** `jq` selected unique roof rows where `outcome == "submitted_locked"`, `recordable == true`, and a screenshot exists. Output: `SWMS-261019`, `SWMS-26980`.
- **Q6:** 19 manifest screenshot paths were independently SHA-256 checked with `shasum -a 256`; output: `screenshots_checked=19 hash_failures=0`. Manifest facts also grouped to `job_details_panels_redacted={1:19}`, `opaque_frame_verified=19`, dimensions `1200x800=9` and `1200x2029=10`.
- **Q7:** an `ffmpeg` contact sheet normalized both screenshot dimensions and displayed all 19 images for visual inspection. An `rg` privacy scan over the generated text artifacts returned `raw_urls=0` and `email_shapes=0`; the observer's production queries do not select client/contact/address columns (`scripts/ses-f7-prime-portal-observer.ts:718-759`).
- **Q8:** focused validation passed: observer classifier/privacy/read-only/idempotency suite **9/9** (`scripts/test/ses-f7-prime-portal-observer_test.ts:17-147`); canonical board read-model suite **25/25**, including exact-cycle acceptance, newest-ledger precedence, stale cycle/wrong URL/missing reference/missing screenshot rejection, unchanged canonical stage, and loader wiring (`supabase/functions/ops-api/makesafe_board_read_model_test.ts:124-301`).

Detailed sanitized results and screenshot hashes are in [dry-run.json](dry-run.json:1). The raw share URLs and raw page text are deliberately not present.
