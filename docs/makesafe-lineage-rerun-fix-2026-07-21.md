# Make-safe lineage rerun fix

This patch fixes the production-reproduced `lineage_parent_pending` rerun failure documented in `makesafe-lineage-parent-pending-root-cause-2026-07-21.md`.

## Behaviour

- Exact sources already present in `makesafe_intake_case_sources` resolve to their persisted canonical case before planning.
- Every source already assigned to that case seeds the capped read, providing a stable case closure across cursor pages.
- The selected plan is rebound to the persisted instruction key, fingerprint, cycle and parent relation. A moving page can enrich the case but cannot re-key or re-parent it.
- Side-effect and artifact idempotency keys are rebound with the canonical instruction key.
- When a partial page re-keys a persisted parent back to its stable key, any in-plan child parented to that page-local key is relinked to the stable parent key, so the lineage guard does not misread it as an orphan.
- A fresh exact-selected `sibling_of` review exception becomes the root when its ambient sibling parent is outside exact authority and not persisted. Live candidates still fail closed. This preserves N=1 authority without writing the unallowlisted case.
- True semantic ancestry remains strict: revision, cancellation and reopen children still require a selected or persisted parent.
- Lineage normalisation and missing-parent classification run before the dry-run return, so dark observe and live cron report the same executability result.
- Before any case, source, artifact, draft or job write, required lineage parents must either already exist or be included in the selected authorised plan. A missing semantic dependency returns `lineage_parent_unselected`, writes only degraded health in live mode, and performs zero business writes.

## Regression proof

The runtime regression recreates the production shape with a one-row source cap:

1. run one sees an exact source alone and persists it as a root review exception
2. the cursor advances and exposes an earlier distinct-PO sibling that would previously re-key the exact source as a child
3. runs two and three retain the first case key and root relation
4. both reruns create zero cases, sources, drafts or jobs and report zero write failures

A live-shaped integration test now covers the full production sequence: fresh exact mail arrives as an ambient sibling, cron creates one pending review exception, an immediate rerun is inert, a changed-content resend for the same instruction arrives, only its source evidence is added, and the final rerun is inert. The sequence retains one stable case key/root and reports zero business-write failures throughout, so removing either fresh-sibling normalisation or persisted-source binding reopens a covered production seam.

A separate semantic guard test selects an unpersisted revision while its parent is filtered out. It proves dark/live parity and zero case, source, artifact and draft writes before degraded live health.

The full deterministic intake suite passes 120 tests. Production remains in `legacy`; this patch does not deploy or alter rollout state.
