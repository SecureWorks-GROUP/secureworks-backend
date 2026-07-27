# SES Reporting U1 intake accounting build

## Contract sections read

- Sealed U1 design: `ses-u1-intake-accounting-design-v1/report.md`, complete
  document, lines 1-860.
- Mission contract section 3 unit `U1 — One canonical lineage and intake
  handoff`.
- Mission checkpoint `CP1 — Source and board truth`.
- Mission contract SHA-256:
  `d076dedb8e5c92932ae386084dac256d9bc1c02668acd760b0eaba34aef95d52`.

## Result in plain terms

Cancellation is now a deterministic lineage action instead of an exception-only
classification. An unambiguous builder cancellation creates its case and source
fact first, resolves one existing job through authoritative identity, calls the
existing `cancelMakesafe` command boundary, and closes as `cancellation` only
after the job reads back as cancelled. No match, several matches, a live invoice,
a conflicting terminal state, a failed command, and a failed read-back remain
visible as separate typed dispositions. None guesses a job.

Sources included in a deterministic run can no longer be absent from both the
case ledger and the exception ledger. Run caps, PDF caps, attachment limits,
lineage quarantine, missing parents, attachment recovery failures and persistence
failures write one non-PII source issue before the run can claim accounting or
advance its cursor. The reporting pass now rejects a scan unless its durable
evidence proves `checked = final + transient`; it does not advance clean drafts
after an accounting failure.

Legacy dead-extraction drafts now drain through exact source replay only. Draft
fields are never treated as authority. A source or lineage that is missing,
ambiguous, duplicated or write-failed remains in its current state and gains an
explicit source issue. Human rejection evidence is preserved.

## Captain board seam

U1 emits the requested `IntakeOperationalFact` inputs through
`makesafe_intake_operational_facts.ts`. The loader pages cases, sources,
case-events, classifier exclusions and source issues to exhaustion, keeps pre-job
facts with `job_id = null`, and rejects duplicate open issues. It does not derive
board stages, labels or a second state machine.

The 752 existing exceptions become board-visible only when island 2 imports this
loader into the sole U2 projector/operational read and releases the matching
schema projection. That U2 consumption is not present in this branch, so this U1
commit alone does not put the 752 rows on the Captain's board. The integration
contract is:

```ts
loadIntakeOperationalFacts(client, { orgId })
  -> Promise<IntakeOperationalFact[]>
```

The U2 projector must preserve facts whose `job_id` is null and must derive their
operator label/next action from its one canonical state model.

## Schema and rollout order

`20260727012426_makesafe_intake_accounting_u1.sql` adds cancellation target
lineage, cancellation reason codes, source-issue organisation/idempotency guards,
draft-to-case linkage, and the legacy rejected-status repair. It changes no job,
assignment, invoice, communication or board state.

Apply that migration before deploying the matching `ops-api`; the runtime selects
the new columns. No migration, deploy, send, closure, board correction or other
production mutation was run from this worktree.

## Validation evidence

- U1 focused suite: 140 passed, 0 failed.
- Existing deterministic-intake migration/static guard suite after the
  canonical-obligation compatibility repair: 24 passed, 0 failed.
- `deno check --config deno.jsonc supabase/functions/ops-api/index.ts`: passed.
- Targeted lint over all changed TypeScript except the repository-excluded
  `index.ts`: passed, 19 files.
- Targeted formatting: passed for all 19 changed TypeScript files and the canary
  SQL. Repository configuration excludes `index.ts`.
- `git diff --check`: passed.

The full `deno task test:ops-api` cannot provide a green repository baseline in
this checkout. Typechecking stops on two untouched test errors in
`makesafe_board_test.ts:158` and `makesafe_intake_recapture_test.ts:529`.
Running the whole suite with `--no-check` exposed 35 failures; one U1 compatibility
guard was repaired and passed independently, leaving 34 failures in untouched
attendance-cycle, pack/send, reattendance and report-submit tests whose fakes do
not match the current base implementation. These failures are outside U1 and are
not presented as green.

The read-only live canary was not executed. The connected Supabase probe returned
`Unauthorized` because `SUPABASE_ACCESS_TOKEN` was unavailable, and this machine
has no local Docker/Supabase stack. The canary is committed at
`scripts/makesafe-intake-accounting-canary.sql`; it starts a read-only transaction,
preflights the required schema, reports zero/double-accounting counts, and checks
that closed cancellation cases read back against cancelled jobs without exposing
PII.

## Design correction found while building

The design's legacy-drain selection lists only open draft statuses, while its
required migration repairs contradictory `rejected_at IS NOT NULL` rows to
`status = 'rejected'`. Selecting only open rows after that repair would strand
the very contradictions U1 must drain. The implementation therefore includes
rejected dead-extraction rows, preserves their rejection evidence, links their
deterministic fate, and never re-approves them.

## Integration and release holds

- Serialize the minimal `index.ts` wiring with
  `hugo-makesafe-submit-userid-fix-v1` before cherry-pick or merge.
- Merge U2's projector consumption of `loadIntakeOperationalFacts` before
  claiming the 752 exceptions are on the Captain's board.
- Apply the U1 migration before the matching edge code.
- Run the committed read-only canary with authorised production read access.
- CP1 still requires independent source/state validation and normal full-suite
  typecheck/tests green; this island does not claim checkpoint closure.
