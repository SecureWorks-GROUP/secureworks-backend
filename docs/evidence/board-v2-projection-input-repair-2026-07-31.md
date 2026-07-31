# Board v2 projection-input repair evidence

Date: 2026-07-31

Environment: production data, read-only queries only

Population: the complete canonical board selection

## Diagnosis

The evidence-stage checker loaded the persisted v2 authority views directly.
Phase 1 intentionally installed those views without backfilling identity,
family-rule, attendance-cycle, or fact version/hash rows, so every one of the
432 cards reached the projector with incomplete bootstrap inputs.

The dormant live seed also had two latent selector defects:

- its case-count CTE selected `c.id` even though `case_candidates` exposes
  `case_id`;
- its family selector did not give the typed restoration authority precedence
  over stale make-safe family metadata.

## Repair boundary

Migration `20260731085928_board_v2_seed_preview.sql` adds the service-role-only,
`STABLE`, `SECURITY INVOKER` preview RPC
`preview_makesafe_state_authority_v2(uuid[])`. It computes the exact
prospective authority inputs without persisting rows. The migration also
repairs the two dormant live-seed selectors.

The evidence checker and the seed/reconcile dry-runs use the prospective
inputs. Ordinary v2 board reads and live post-seed/reconcile acceptance remain
on persisted authority. The earlier seed-scope migration remains the
authoritative repair for restoration eligibility and fact-trigger coverage.

## Read-only production proof

The preview query body was executed as a standalone SELECT against the complete
production selection. No migration, seed, reconcile, or write RPC was invoked.

```json
{
  "requested_job_count": 432,
  "projected_job_count": 432,
  "projection_input_error_job_count": 0,
  "residuals": []
}
```

The proof evaluates the same immutable-input conditions used by
`projectMakesafeStateV2`: source and lineage identity, current attendance-cycle
identity, current-cycle fact version/hash identity, family-rule revision
identity, and current docket artifact identity.
