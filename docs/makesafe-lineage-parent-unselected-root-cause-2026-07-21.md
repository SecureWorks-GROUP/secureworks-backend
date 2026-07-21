# `lineage_parent_unselected` root cause

## Conclusion

PR 347's guard behaved correctly, but it exposed a second selection seam: the planner built a multi-instruction lineage, then the exact source allowlist retained the selected **sibling child only** and discarded its root parent. Dry-run observation returned before validating that dependency, so the same structurally incomplete plan looked healthy in dark observe and failed closed in the live cron.

The earliest structural divergence is exact selection without lineage closure. The earliest observable dry/live divergence is the dry-run return before the parent dependency check.

## Working observation versus failing live pass

Both paths read the same real selected mail as one MLB review-exception instruction with four correlated sources, 100% instruction identity, missing `client_name`, and `parent_relation=sibling_of`.

| Fact | Dark observe | First live cron |
|---|---:|---:|
| selected cases | 1 | 1 |
| selected sources | 4 | 4 |
| result before persistence | `adapter_parse_failure` | `adapter_parse_failure` |
| business writes | 0 | 0 |
| write failures | 0 | 1 |
| lineage result | sibling parent not checked | `lineage_parent_unselected` |

The live guard stopped before attempting any case. Post-reversal case, source, artifact, draft and job counts matched the baseline exactly.

Evidence:

- `docs/evidence/makesafe-reactivation-dark-observe-2026-07-21.json`
- `docs/evidence/makesafe-reactivation-first-scan-2026-07-21.json`
- `docs/evidence/makesafe-reactivation-post-rollback-state-2026-07-21.json`
- `docs/evidence/makesafe-lineage-parent-unselected-comparison-2026-07-21.json`

## Exact code path

1. The pure planner assigns the first instruction group as lineage root and later distinct-PO groups as `sibling_of` children (`makesafe_deterministic_intake.ts:1292-1297`, `1358-1370`).
2. `selectedPlan` filters the already-built full plan to cases that contain an exact source or instruction key (`makesafe_deterministic_intake_runtime.ts:787-807`). It does not retain a selected case's ancestor or normalise an authorised sibling child into a root. The selected real source survived; its parent did not.
3. The report was then built from that incomplete selected plan. Dark observe exited at `if (dryRun) return report` (`makesafe_deterministic_intake_runtime.ts:1853-1856`), before any lineage dependency check. This is why the N=1 observation reported zero failures despite exposing `parent_relation=sibling_of`.
4. The live path continued into `unresolvedParentDependencies` (`1858-1868`). The missing parent was neither in the selected plan nor persisted, so the guard returned `lineage_parent_unselected`, degraded health and made zero business writes.

## Why PR 347 tests did not catch it

The tests proved two seams separately:

- a **persisted** exact source remains anchored when a later cursor page re-keys it
- an unselected parent fails before business writes

They did not run the production lifecycle beginning with a **fresh** exact source that is already a sibling inside the ambient mailbox plan. Single-pass replay measured classification and accounting; dark observe returned before live dependency validation; the parent guard test expected failure rather than proving the selected fresh instruction could establish a stable review-exception case and converge over later mail.

## Fix direction

The correction must preserve exact N=1 authority while making dry and live planning identical:

1. Apply lineage normalisation before both dry-run reporting and live validation.
2. For a fresh exact-selected `sibling_of` case whose computed root is outside authority and not persisted, promote the authorised sibling to the lineage root. Sibling root orientation is arbitrary; this writes only the exact authorised case and does not pull an unallowlisted case into production.
3. Keep true semantic ancestry strict. `revision_of`, `cancellation_of` and `reopen_of` still require an existing or explicitly selected parent and must fail closed otherwise.
4. Once the fresh case persists, PR 347's persisted-source authority must anchor its key, cycle and root across cursor movement and later same-instruction mail.
5. Move dependency analysis before the dry-run return so replay/dark observe and live cron cannot disagree about whether a selected plan is executable.

## Required live-shaped regression

The new integration test must use production ordering and one exact source authority through the whole loop:

1. fresh real-shaped work-order mail arrives as a non-root sibling in the ambient capped plan
2. cron pass persists one `adapter_parse_failure` review-exception case as the authorised root, with zero business-write failures
3. immediate cron rerun converges with zero new cases, sources, artifacts, drafts or jobs
4. a second real-shaped twin/resend for the same instruction arrives
5. next cron attaches only the new source/evidence to the same case, without re-keying or re-parenting it
6. final rerun is inert with zero business-write failures

The test must also retain the earlier capped-cursor persisted-source scenario. Removing either the persisted-source binding or fresh-sibling normalisation must make the full sequence fail, covering both production seams rather than another single pass.

## Safety state

Production remains `legacy`. No re-flip, deploy, migration or business-data mutation is part of this diagnosis.
