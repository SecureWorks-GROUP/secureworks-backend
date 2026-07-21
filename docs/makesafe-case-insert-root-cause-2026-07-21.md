# Make-safe production `case_insert` root cause

## Conclusion

The deployed insert failed because fresh-sibling normalisation removed the parent but retained the planner's inherited cycle 3 instruction key. A root case is cycle 1 by database invariant. Production correctly rejected the row with PostgreSQL `23514` (`check_violation`).

The exact deployed plan shape was:

- selected instruction key suffix: `/cycle:3`
- normalised parent relation: `null`
- discarded ambient parent key suffix: `/cycle:1`
- case insert response: HTTP 400, PostgREST `error=23514`

This is a **code defect**, not a missing migration, permission, environment variable or extension. The database schema is correct and must not be weakened.

## Earliest divergence

The pure planner starts each lineage at cycle 1 and increments the cluster cycle when it encounters reopen instructions (`makesafe_deterministic_intake.ts:1233-1253`). It then embeds that cycle in each instruction key (`1285-1297`). The real four-source cluster reached the exact selected review exception at cycle 3.

PR 349's `resolveSelectedLineage` correctly recognised that an unpersisted ambient sibling was outside exact N=1 authority. It changed:

- `parentInstructionKey` to `null`
- `parentRelation` to `null`

but did not change `cycle` or rebuild the instruction and side-effect keys (`makesafe_deterministic_intake_runtime.ts:1298-1315`). The case therefore became a root in shape while retaining a child/reopen-era cycle 3 key.

`casePayload` sends the instruction key and no explicit cycle (`makesafe_deterministic_intake_runtime.ts:1037-1060`). The live table defaults `cycle=1`. Its enabled before-insert trigger sets root lineage to the new case ID and requires root cycle 1. The live check constraint then requires the instruction key's `/cycle:N` suffix to match the row cycle (`20260720000001_makesafe_intake_cases.sql:265-273`, trigger lines `518-528`). `/cycle:3` versus row cycle 1 produced `23514`.

## Why the local 120-test loop passed

There were two local/deployed differences.

### 1. The fixture did not carry the production cycle shape

The live-shaped fixture had an ambient distinct-PO sibling but no earlier reopen sequence, so its selected instruction was already cycle 1. It covered sibling rooting and persisted re-key convergence, but not rooting a selected review exception inherited from cycle 3.

### 2. The in-memory Supabase double does not enforce case-table SQL

`FakeQuery.run()` implements duplicate behaviour only for case sources, artifacts and drafts. Every `makesafe_intake_cases` insert is accepted by directly appending the payload (`makesafe_deterministic_intake_runtime_test.ts:142-173`). It does not execute:

- `trg_makesafe_intake_cases_enforce`
- root cycle assignment/validation
- `makesafe_intake_cases_instruction_key_cycle_check`
- case/event foreign keys or case check constraints

The test asserted that one in-memory case existed and the loop converged, but never asserted root cycle/key agreement against a real schema.

## Deployed-environment checks

### Schema and migrations

No migration gap was found:

- all seven deterministic case columns exist
- deterministic shape constraint exists
- cycle is non-null with default 1
- lineage ID is non-null
- instruction-key/cycle constraint exists with the migration definition
- enforcement trigger exists and is enabled
- trigger function contains both root rules: lineage ID becomes case ID and root cycle must be 1

### Service-role permissions and RLS

No permission gap was found:

- service role has INSERT on cases, sources, events and health
- service role has UPDATE on health
- all four tables have service-role `ALL` policies
- the failed request reached PostgREST and returned `23514`, not authentication/permission codes `401`, `403` or PostgreSQL `42501`

### Environment variables

No environment divergence was found. Secret values were not inspected. Operational proof is sufficient:

- deployed commit `c283b6a6` read rollout settings successfully
- the case request reached the database
- post-failure health upsert succeeded
- `ops_api_version` matched the deployed commit

A missing/incorrect service key or URL would have failed before the check constraint.

### Extensions

No extension gap was found. Production has `plpgsql 1.0`, `pgcrypto 1.3` and `uuid-ossp 1.1` installed.

## Correct fix

This requires code plus DB-faithful regression coverage, followed by a normal edge deploy. It requires **no migration**.

When an exact-selected review exception is promoted from `sibling_of` to root, the normaliser must atomically:

1. set parent key/relation to null
2. set plan cycle to 1
3. rebuild the instruction key with `/cycle:1`
4. propagate that key to source classifications, recovery cursor, artifact keys, draft/job keys and approval keys
5. preserve the instruction fingerprint and identity discriminator

True revision, cancellation and reopen children remain parent-bound and are not root-normalised.

Regression coverage must add a real-shaped cycle-3 cluster to the full live loop and assert the selected fresh root has `cycle=1`, a matching `/cycle:1` key, and stable rerun/resend convergence. The case insert path also needs a DB-faithful check using the disposable migration/schema-clone harness, or the in-memory fake must explicitly enforce the root cycle/key constraint. Without one of those, future SQL-only divergences can still pass the runtime double.

Changing or dropping the production cycle constraint would hide the defect and violate the canonical lineage invariant. Do not do that.

## Evidence

- `docs/evidence/makesafe-case-insert-live-log-2026-07-21.json`
- `docs/evidence/makesafe-case-insert-live-schema-2026-07-21.json`
- `docs/evidence/makesafe-case-insert-service-role-policies-2026-07-21.json`
- `docs/evidence/makesafe-case-insert-deployed-runtime-2026-07-21.json`
- `docs/evidence/makesafe-pr349-canary-first-cron-2026-07-21.json`
- `docs/evidence/makesafe-pr349-canary-post-rollback-state-2026-07-21.json`

Production remains `legacy`. No further activation was attempted.
