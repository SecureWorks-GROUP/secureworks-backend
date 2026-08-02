# SES test repair tranche A mutation proof

Date: 2026-08-02

Branch: `fm/ses-test-repair-tranche-a-v1`

Scope: every finding in the hollow-test sweep except `ses_stage_engine_v2_test.ts`

## Outcome

The original in-scope baseline was 204 passed and 2 failed across 206 tests.
After this repair, the same files plus four new degradation/defect-documentation
tests are 210 passed and 0 failed. All 27 in-scope hollow claims went red against
the sweep mutant that had previously survived. No mutant remains in the branch,
and no product or stage-engine behavior changed.

The original in-scope denominator is therefore 206 of 206 load-bearing, or 100%.
The expanded tranche-A suite is 210 of 210 passing. The SWMS defect-documentation
test described below is deliberately not presented as proof of correct behavior.

## Mechanical mutation record

Every row below was run as a single targeted `deno test --filter` invocation.
The mutant was applied temporarily, the repaired test returned exit 1, and the
mutant was reversed before the next run.

| Finding | Repaired test claim | Scratch mutant applied | Red proof |
|---|---|---|---|
| H06 | Empty builder reference is independently refused | Removed `!rowBuilderReference` while leaving mismatch rejection | Exit 1: the single-delta row projected instead of returning `[]` |
| H07 | Canonical loader executes the capture-ledger handoff | Replaced the loader handoff with an empty `portalCaptureRowsByJobId` map | Exit 1: projected revision IDs were `[]`, not `['loader-capture-1']` |
| H08 | Observer and loader execute the shared population contract | Replaced both consumers with unrelated lost-only logic | Exit 1: archived/cancelled rows were classified as live |
| H09 | Docs Ready projection excludes money fields | Spread raw `report_pack` into the returned pack | Exit 1: the forbidden money canary became visible |
| H10 | Generation ID is content-derived | Replaced generation ID hashing with a constant | Exit 1: changed card content did not change the ID |
| H11 | Disputed manifest is read-order invariant | Removed disputed-row sorting | Exit 1: forward and reverse manifest hashes differed |
| H12 | Untrusted producer is independently refused | Removed `isTrustedSesPortalCaptureProducer` from ledger projection | Exit 1: an otherwise-valid untrusted attestation projected |
| H13 | Card content cannot forge the attested producer | Preserved `attested_producer` on embedded detail captures | Exit 1: forged typed-roof evidence satisfied current portal capture |
| H14 | Every ledger projection refusal predicate is reachable | Removed the complete role/cycle/reference/URL/producer/user/screenshot refusal block | Exit 1: the first one-field delta, wrong role, projected instead of returning `[]` |
| H15 | Unassigned trade is refused before detail reads | Moved assignment refusal below the make-safe detail read | Exit 1: read log gained `makesafe_job_details` |
| H16 | Unauthenticated caller is refused before reads | Moved authentication refusal below the jobs read | Exit 1: read log gained `jobs` |
| H17 | Screenshot storage path is content-addressed | Replaced the path with `portal-captures/static.png` | Exit 1: exact job/cycle/role/hash path assertion failed |
| H18 | Published role contract is exact and every listed role is recognized | Removed `owner` from the runtime role contract | Exit 1: exact contract assertion reported the missing role |
| H19 | Linked work-order update failure cannot fail parent cancellation | Threw on the injected work-order update error | Exit 1: cancellation rejected with the fixture failure |
| H20 | Reattendance report must match the current cycle | Changed the repaired positive report cycle from 2 to 99; also checked the equivalent accept-any-cycle source mutant | Exit 1: `has_report_record` was false instead of true |
| H21 | Hold requires attendance-cycle identity independently | Removed the attendance-cycle identity requirement | Exit 1: the identity-less bound hold was returned instead of null |
| H22 | Submitted report advances exactly to Trade Report In | Returned `allocated` from the report-advancement branch | Exit 1: exact stage was Allocated instead of Trade Report In |
| H23 | Delivery scope is independently exact | Deleted the delivery-scope refusal predicate | Exit 1: wrong delivery scope was accepted |
| H24 | Reviewed migration contains an executable binding insert | Block-commented the migration `INSERT` | Exit 1: executable-SQL assertion could not find the insert |
| H25 | Portal evidence requires matching content hash and current cycle | Deleted both aggregate-hash and cycle candidate checks | Exit 1: the hash mismatch was accepted as done |
| H26 | South-West route is exclusive to South-West evidence | Forced every matching builder card onto the South-West route | Exit 1: the non-South-West control inherited the route |
| H27 | Missing canonical builder reference is an isolated blocker | Deleted both builder-reference blockers | Exit 1: named blocker count was zero instead of one |
| H28 | Active assignment is required to derive Allocated | Deleted the active-assignment derivation branch | Exit 1: the positive assigned control derived New |
| H29 | Physical report needs the five-photo floor | Removed the `photos >= 5` threshold | Exit 1: the four-photo control derived Trade Report In |
| H30 | Terminal compatibility requires a durably sent pack | Removed the `sent` conjunct | Exit 1: the unsent control became terminal-proven |
| H31 | Synthetic filtering preserves canonical survivors | Replaced the filter with `return []` | Exit 1: the canonical survivor disappeared |
| H32 | Pricing uses only sanctioned structured sources | Added `job.pricing_json` to structured source roots | Exit 1: the forbidden pricing canary populated hours/materials |

## The two original red tests

- The portal writer assertion was stale. The verified producer contract contains
  the deterministic reader and trade confirmation producers. The repaired test
  asserts the exact two-member contract and both trust predicates.
- The assessment triad implementation was correct. The sanitized fixture URLs
  lacked the share/report-style path required by the canonical portal boundary,
  so all roles were correctly filtered out. The fixture now uses sanitized share
  paths and still requires the exact `assessment`, `photos`, and `scope` triad.

## Explicit degradation evidence

- The canonical board loader test injects failures for portal capture, status
  application, own-roof draft, and terminal-proof reads. The board remains visible,
  but each failure must emit the named error and the injected failure text.
- Adapter tests inject source, photo, bundled-report, and bundled-photo recovery
  failures and require their existing typed blockers. A read failure can no longer
  pass these tests as clean absence.

## Named product defect documented, not fixed

`supabase/functions/ops-api/ses_assembler_input_adapter.ts:2407-2431` catches a
stored SWMS recovery failure and returns null, but `resolveSwmsArtifact` is not
consumed by the current preparation path. Stored-but-unrecoverable SWMS evidence
is therefore currently indistinguishable from absent SWMS evidence.

The test named `DEFECT DOCUMENTATION: stored-but-unrecoverable SWMS is
indistinguishable from absent SWMS` pins that current defect so it remains visible.
It does not assert that the behavior is correct. Product repair is intentionally
outside this tranche.

## Verification

Exact 13-file in-scope command, including the unchanged terminal-proof and
migration tests in the tranche denominator:

```sh
/Users/marninstobbe/.deno/bin/deno test --allow-all --no-check scripts/test/ses-evidence-stage-checker_test.ts scripts/test/ses-stage-baseline-contract_test.ts supabase/functions/ops-api/makesafe_board_auth_test.ts supabase/functions/ops-api/makesafe_board_read_model_test.ts supabase/functions/ops-api/makesafe_cancel_test.ts supabase/functions/ops-api/makesafe_cycle_evidence_test.ts supabase/functions/ops-api/ses_assembler_input_adapter_test.ts supabase/functions/ops-api/ses_portal_capture_evidence_test.ts supabase/functions/ops-api/ses_portal_capture_writer_test.ts supabase/functions/ops-api/ses_trade_portal_confirmation_test.ts supabase/functions/ops-api/ses_stage_engine_v2_terminal_proof_test.ts supabase/functions/ops-api/ses_portal_capture_bridge_migration_test.ts supabase/functions/ops-api/ses_trade_portal_confirmation_migration_test.ts
```

Fresh output from the exact command above, rerun in this test phase on 2026-08-02:

```text
ok | 210 passed | 0 failed
```

The command discovered 13 files and 210 tests; the three unchanged files named
in the command are included in that denominator.

The excluded `ses_stage_engine_v2_test.ts` was not modified.
