# P2-01 Follow-up 8: shadow cost lines

This corrects P2-01.2 to .6 before the new read in .7. Applying the migration installs no business trigger or schedule and changes no switch. The retry table is service-role only. This is shadow storage, not a change to the books or the live cost read.

The writer rule in P2-01.2 now includes both cases:

- A source line returning after `line_removed` is a new unresolved placement even when its source hash is unchanged. Coverage exclusions and the person's decision identity remain protected.
- A document follower uses current source lines, excluding `line_removed` history. A direct line follower still waits when its named source is removed. Changing a bill's placement re-runs followers in the same transaction. Line children run before whole-document followers. Unchanged state and allocations retain their stored row identities.

A bill with no stored lines retains its header subtotal. A stated employer contribution follows its base lines under the existing employer-super switch. Withheld worker super is excluded, as in the old cost view. The old six-place contribution formula is rounded to the cost table's existing cents precision at storage; the table is unchanged.

Trade source reads take no invoice-header lock. The document lock is a try-lock, and the guarded trigger uses a short lock timeout for private shadow contention. Both conservation triggers are forced immediate before the guarded block returns, so a failed check rolls back shadow work and queues a retry without rejecting the trade's write. A statement timeout is not caught: installation still requires the timing proof below.

Failed writes append requests with no business-row foreign key or invoice-unique key. The drain attempts one invoice per transaction. It removes successful requests and folds at most 100 redundant failures for that invoice per run; requests arriving during the attempt remain queued. Failed attempts back off. The due and invoice indexes bound those reads. The drain never sums the request table.

## Director steps before installation

1. On a disposable database copy, run the PostgreSQL contract and concurrent proof. Time the real sync with representative invoice sizes and the intended caller's statement timeout; retain the timings. The local builder did not run a database or apply a migration.
2. Only after that proof, call `job_cost_lines_install_trade_triggers()` on the chosen destination. Verify all four named triggers and the `job-cost-lines-shadow-retry` cron job exist. The install warns when pg_cron is unavailable; that is not a complete installation. The cron command attempts one invoice per transaction.
3. Exercise a synthetic trade write and a forced shadow refusal. Read back the business line, the queued retry and the successful drain. Repeat the same sync and verify allocation row identities stay unchanged.
4. `job_cost_lines_remove_trade_triggers()` removes the four triggers and the retry schedule. Rollback restores the previous function bodies and refuses while retry requests remain, so pending failures cannot be silently deleted.

Proof files: `supabase/functions/xero-sync/cost_lines_test.ts`, `cost_lines_shadow_test.ts`, and `supabase/tests/migration-contracts/20261117173001_job_cost_lines_followup8/`. The older writer contract's assertion that a removed historical line poisons a document follower is corrected to the new required behaviour; no test is deleted.
