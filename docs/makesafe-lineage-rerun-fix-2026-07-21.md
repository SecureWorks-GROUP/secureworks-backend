# Make-safe lineage rerun fix

This patch fixes the production-reproduced `lineage_parent_pending` rerun failure documented in `makesafe-lineage-parent-pending-root-cause-2026-07-21.md`.

## Behaviour

- Exact sources already present in `makesafe_intake_case_sources` resolve to their persisted canonical case before planning.
- Every source already assigned to that case seeds the capped read, providing a stable case closure across cursor pages.
- The selected plan is rebound to the persisted instruction key, fingerprint, cycle and parent relation. A moving page can enrich the case but cannot re-key or re-parent it.
- Side-effect and artifact idempotency keys are rebound with the canonical instruction key.
- Before any case, source, artifact, draft or job write, lineage parents must either already exist or be included in the selected authorised plan. A missing dependency returns `lineage_parent_unselected`, writes only degraded health, and performs zero business writes.

## Regression proof

The runtime regression recreates the production shape with a one-row source cap:

1. run one sees an exact source alone and persists it as a root review exception
2. the cursor advances and exposes an earlier distinct-PO sibling that would previously re-key the exact source as a child
3. runs two and three retain the first case key and root relation
4. both reruns create zero cases, sources, drafts or jobs and report zero write failures

A separate guard test selects an unpersisted child while its parent is filtered out. It proves zero case, source, artifact and draft writes before the degraded health result.

The full deterministic intake suite passes 118 tests. Production remains in `legacy`; this patch does not deploy or alter rollout state.
