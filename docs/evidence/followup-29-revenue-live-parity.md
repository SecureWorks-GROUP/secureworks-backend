# Follow-up 29: revenue matches the director's live read

Items 1 to 3 only. No live connection, migration, switch, Xero call or message was made by this worker.

## Result and provenance

The director supplied these live hashes on 18 Nov 2026, taken in UTC:

| View | Director, on live | Disposable registered stack before repair |
| --- | --- | --- |
| v_job_revenue_events | cea985aadcb59a2f751b1f403176a39c | b8354d49625e92fdb4a52d81df3a761a |
| v_job_cost_events | c2e9632718dfa057703f1ee36b97322e | c2e9632718dfa057703f1ee36b97322e |
| v_job_profit | 578270db501761330fad0b46412aac95 | 578270db501761330fad0b46412aac95 |

The fresh-stack observation used PostgreSQL 17 and every registered folder's setup and migration, in name order, before running any contracts. This is the schema CI builds, including its existing stand-ins. It is not a replay of every unregistered repository migration, nor a copy of production data. In particular, the existing stack uses a table standing in for Bookkeeping's evidence view.

The ordering theory is disproved for these files. `20261104091000_job_revenue_credit_division.sql` patches one division expression and preserves ledger evidence when present. It explicitly accepts both the evidence and no-evidence preimages. `20261103200000_job_revenue_follows_ledger_evidence.sql` has no registered contract folder, so `run.sh` never applies it. The office-variation migration then explicitly accepts the no-evidence branch. This accounts for the measured CI hash without any migration wiping a join.

## Historical replay on disposable PostgreSQL

Within a transaction on the fresh database, the four historical preimages were stood up from the exact dollar-quoted definitions retained in `20261103200000_job_revenue_follows_ledger_evidence_down.sql`. The newer profit view was dropped inside that transaction to permit its historical, shorter column list. The transaction rolled back all rehearsal changes.

| Step | Revenue hash |
| --- | --- |
| Historical preimage | ac208427bcf489ec12086cc08e3b9289 |
| Execute the complete 20261103200000 migration | aeb851cd8d3d6e807cd7a5d620e020a8 |
| Execute the complete 20261104091000 migration | 2191799f0f51ef34b5fe90879e8387cb |
| Execute 20261111100000's first DO block, which owns revenue | cea985aadcb59a2f751b1f403176a39c |

The office migration's other blocks concern profit and the story signature, so they were not replayed over the earlier historical profit schema. This is an exact revenue-path proof, not a claim that all three complete migrations can run adjacent with no intervening prerequisites.

A second rolled-back rehearsal applied the credit migration first, then attempted the complete ledger migration. It refused its credit-only preimage `18c6f924719d2c53ca537e8d58d7555f`, as its guard requires. It did not silently replace it. The worker cannot establish historical production apply order from this local proof; the final reconstructed revenue text matches the director's live hash exactly.

## Repair and contract

`20261118010401_job_revenue_live_parity.sql` does nothing at the verified live hash, replaces only the measured fresh-stack hash, and refuses every other definition. It restates the verified revenue text only, preserving the view identity, access grants and options. Existing invoice job links take precedence over evidence. Unlinked invoice lines require evidenced job allocation; an applied credit follows evidence only when every nonzero invoice line names one job. The office-variation branch is retained.

The new contract owns all new assertions. It re-applies its migration first, exercises both accepted hashes, preserves cost/profit text and view access, and checks real synthetic invoice rows through the view. Missing evidence contributes nothing; an office job link wins; removal of evidence removes unlinked income on the next read; repeat reads do not duplicate it. Unknown definitions refuse before replacement. PostgreSQL read failures propagate as errors, with no new fallback to an empty result. There is no new switch or writer.

Local command (a new disposable localhost cluster, UTC):

```sh
MIGRATION_CONTRACT_ADMIN_DATABASE_URL=postgresql://postgres@127.0.0.1:55439/postgres \
MIGRATION_CONTRACT_DISPOSABLE_ACK=I-confirm-this-is-disposable-local-postgres \
PGTZ=UTC bash supabase/tests/migration-contracts/run.sh 20261118010401_job_revenue_live_parity
```

Result: **16 checks, 16 passed**, expected unknown-preimage refusal passed, and `PostgreSQL migration contracts passed`. Only this contract was selected; the runner builds its complete prerequisite stack. The broader shards belong to GitHub. No tests were deleted or weakened.

The reference now contains the three current view definitions and director-supplied live hashes. Cost is the switch/cutover wrapper introduced by `20261117210402`; its legacy and cost-line definitions remain in their owning migrations. Its full definition, rather than the old legacy view, is what the reference must hash. The reference export is explicitly UTC because profit contains a timestamp literal.

## Release boundary

On the director-observed live hash this migration is a no-op, so no person's live figures or any Xero request changes. It introduces no read, index, growing table, trigger or schedule on live. Fresh CI databases gain the ledger-evidence join already present on live. No new production performance claim is made.

Director, on live: confirm the preimage still matches before merge; a different hash is a refusal to investigate, never permission to broaden the guard. The stored Job Profit fill remains held to the single ZZTEST job under the director's existing authority. Whole-schema comparison (item 4) and the migration-number CI check (item 5) are separate slices and are not completed here.
