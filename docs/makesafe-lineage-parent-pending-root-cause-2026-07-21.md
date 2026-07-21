# `lineage_parent_pending` rerun root cause

## Conclusion

The first run did persist its review-exception case correctly. The rerun failed because the moving capped source window rebuilt the **same exact allowlisted source as a different instruction and as a sibling child**, while selection dropped that child's unallowlisted parent. The runtime then looked up persistence by the new instruction key, did not recognise the already-accounted source, ranked it as fresh, and threw because the newly computed parent key did not exist.

This was plan-identity drift across cursor pages, not a missing first-run write or a database foreign-key failure.

## Production proof

| Observation | First run | Failing-window reproduction |
|---|---|---|
| Exact source allowlist | 1 | 1 |
| Selected case/source count | 1 / 3 | 1 / 3 |
| Case-key SHA-256 | `be7cf646...3432dc` | `ee4cb2ff...311313` |
| Parent relation | `null`, lineage root | `sibling_of` |
| Outcome | `adapter_parse_failure` | `adapter_parse_failure` |
| Missing field | `client_name` | `client_name` |
| Sweep cursor | window head | `2026-06-05...` partial sweep |

The persisted database row still has key hash `be7cf646...3432dc`, `parent_relation=null`, and creation time `05:54:03 UTC`. The post-rollback diagnostic dark observe, at the same partial cursor position as the failed rerun, produced `ee4cb2ff...311313` with `parent_relation=sibling_of`.

Three source links were inserted with the first case. A fourth correlated resend/twin became visible and was attached by a later cursor window at `05:57:03 UTC`. The changed visible correlation set explains why successive capped windows did not produce one stable plan. It also explains the later unapproved draft: a subsequent window swung back to a plan that matched the persisted key closely enough to resume it, but with newly visible evidence. This was not an idempotent settled rerun.

Evidence:

- `docs/evidence/makesafe-activation-first-scan-2026-07-21.json`
- `docs/evidence/makesafe-activation-idempotent-rerun-2026-07-21.json`
- `docs/evidence/makesafe-lineage-rerun-diagnostic-observe-2026-07-21.json`
- `docs/evidence/makesafe-lineage-rerun-persisted-case-2026-07-21.json`
- `docs/evidence/makesafe-lineage-rerun-source-timeline-2026-07-21.json`

## Exact code divergence

1. `readInputs` builds each plan from a moving oldest/recent capped window and seeds only the exact allowlisted post IDs (`makesafe_deterministic_intake_runtime.ts:494-568`, `1496-1509`). It does not seed a stable closure of every source already assigned to the canonical case.
2. The planner correlates every source currently visible in that partial window (`makesafe_deterministic_intake.ts:1150-1206`). Instruction fingerprints include the set of currently visible strong-source content hashes (`1245-1296`). Adding or removing a correlated resend can therefore change the instruction key.
3. The first instruction encountered becomes the lineage root; every later group becomes its sibling/revision child (`1297`, `1358-1370`). Changing partial cluster membership can therefore change both key and parent relation.
4. `selectedPlan` retains only cases containing an exact allowlisted source or instruction key (`makesafe_deterministic_intake_runtime.ts:705-725`). When that source moved into a computed sibling child, its parent plan was discarded because the parent did not contain the allowlisted source.
5. Persistence lookup is keyed only by the newly computed instruction key (`1672-1689`). The changed key did not match the existing `be7...` row, so the rerun was ranked `fresh` despite its source already being canonical-accounted.
6. `insertCaseAndSources` then looked up the dropped parent by its newly computed key and threw `lineage parent is not persisted yet; retry child later` (`1326-1336`).

## Proposed fix

1. **Make persisted source accounting authoritative on rerun.** Resolve exact allowlisted post IDs through `makesafe_intake_case_sources` before ranking. If a source already belongs to a canonical case, bind rerun identity, lineage, cycle and instruction key to that persisted case. A changing sweep page must never make an accounted source look fresh.
2. **Build a stable selected-case closure.** Seed all persisted sources for that case and process newly discovered twins/resends as evidence on the same stable case without recomputing its key. A distinct PO/revision must become a separately identified case only from its own explicitly authorised source, not because it happened to share the current 500-row page.
3. **Remove moving-set content from canonical key identity.** The instruction key should be anchored to stable canonical instruction identity plus cycle. Content hashes can identify evidence/revision candidates, but the set of all currently visible correlated content hashes must not re-key an existing instruction.
4. **Validate lineage dependencies before all business writes.** If a selected child needs a parent, that parent must already exist or be selected under explicit authority. Otherwise return a fail-closed, zero-write `lineage_parent_unselected` result before creating cases, sources, artifacts or drafts.
5. **Add the missing regression.** Run the same exact source twice with a cursor advance that introduces a fourth same-identity twin and an earlier sibling group. Assert identical persisted instruction identity/lineage, zero second-run writes, zero failures, and no new draft/job.

## Current safety state

Deterministic mode remains disabled. Final consistency verification shows effective mode `legacy`, one preserved exception case, four source links, two artifacts, one unapproved review draft, and zero deterministic jobs or approved deterministic drafts. The later `last_scan_model_calls=1` belongs to a legacy scan after rollback; the diagnostic dark observe itself reports zero AI calls and zero business writes.
