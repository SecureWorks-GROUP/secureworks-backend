# Stored Job Profit source refresh

P0-09.4, Scope A confirmed by FirstMate: source marks and refresh timers only.
The old P0-09.5 read-view/story-book work belongs to a parallel worker. This
change does not complete that ticket's original Do list.

Merge adds private storage and functions, and seeds `job_profit_refresh_v1`
off. It installs no trigger, starts no timer, changes no existing function,
and makes no Xero call. `job_profit_stored_read_v1` and
`job_profit_expected_from_job_budget` are left unchanged.

A source trigger appends one event per affected job to `job_profit_change_events`
and calls the existing shared `job_mark_changed`. It does not update the
refresher's dirty rows or acquire its advisory locks. A failed lookup, mark or
queue insert rolls back that helper's work, emits a warning containing only the
table and SQLSTATE, and lets the business write stand. The daily pass recovers
missed marks. This is eventual recovery, not proof of a five-minute refresh when
a mark failed. Source marking has a 25 ms lock wait limit.

`job_profit_refresh_due()` folds at most 200 events into the existing dirty
marks, deletes those exact event ids, and calls the existing
`job_profit_refresh_many` once for at most 200 jobs. Source jobs have priority;
spare capacity goes to the oldest dirty jobs. A daily backlog cannot put a newly
changed source behind all nightly jobs. Failed reads and refused refreshes roll
back the fold and deletion together. Prior stored rows stay intact and the next
minute retries. NULLs and money calculations belong to the existing writer.
No caller reads the private event queue as financial truth.

`job_profit_daily_mark()` pages through all jobs, 500 keys per transaction, once
per Perth day from 01:20, continuing on later minute ticks. It includes closed
jobs as the net for date-based holds and tables not covered by a source trigger.
It overwrites one cursor row; it never loops through the whole company in one
transaction. A failed page retains the cursor. The normal refresh worker drains
the resulting dirty marks in bounded batches. No full-table total runs on either
timer. Source events are trimmed by their successful fold; no run history grows.

The two background functions share a try-only advisory lock, used by no business
writer. Both return `busy` if the other is running. With the switch off they
return `off`. They do not refresh, acknowledge or remove work in that state.

Install and activation are separate director actions. `job_profit_refresh_install()`
requires the bounded-refill overload from
https://github.com/SecureWorks-GROUP/secureworks-backend/pull/1529 and pg_cron,
then installs the eleven source triggers and two minute timers with a caller
statement timeout of 120 seconds. It does not enable any switch. Before installing,
the director must prove the live reference/view equality and one ZZTEST refresh,
fill the store in separately committed batches, and check the compare is clean.
The director then decides when to enable `job_profit_refresh_v1`.

Source tables are materials facts, crew lines and invoice headers, purchase
orders, budgets, Xero invoice copies, supplier-credit allocations, jobs, work
orders, group shares and their parent group. Old and new jobs are marked on a
move. Header cascades are covered by the direct child or parent trigger too.
Xero timestamp-only updates do nothing. Job updates listen only to columns the
reference views read: id, org_id, job_number, client_name, type, status, metadata,
expected_costs, pricing_json, completed_at, created_at, legacy. The migration
lists remaining reference sources caught by the daily pass. A future cost-line
cutover still needs its own source-trigger coverage. Policy-switch changes need
a full refill before a stored reader is considered current.

`job_profit_refresh_remove()` removes only this lane's triggers and schedules;
it retains source events, dirty marks, cursor and stored rows. Rollback calls
that remover, drops this lane's functions and keeps queued evidence for reapply.
To pause promptly the director can turn the worker switch off; existing live
readers and Xero paths are unchanged. This change adds no stored reader and makes
no claim about the reader's fallback when stored data is missing or stale.

Proof lives in
`supabase/tests/migration-contracts/20261118000101_job_profit_source_refresh/`.
The SQL contract rolls back every fixture and prerequisite reapply. It checks
off-state parity, old/new source jobs, timestamp noise, private access, unknown
figures, failure/retry, office edits, daily pagination and native index plans.
The director's baseline in `reports/db-load-17nov-night.md` is one-job
`v_job_profit` averaging 7.4 seconds over 62 calls and page refresh averaging
5.7 seconds over 297 calls. No production speedup is claimed here.

The explicit diagnostic overload `job_profit_stored_compare(p_job_ids uuid[])`
compares only the named jobs (at most 500 array entries). Pass an explicit
`uuid[]` cast in SQL, or the `p_job_ids` RPC parameter. NULL, empty and all-NULL
arrays compare zero jobs; duplicates are ignored. The integer/no-argument
company diagnostic is unchanged. The new overload is service-role only and
has no automatic caller or financial side effect.

The reference is filtered before materialization. Profit columns and both event
count/sum comparisons use the requested ids, including requested stored-only
jobs and orphan events. Unrequested drift is excluded. A missing stored row or
column is reported, NULL stays distinct from zero, and a reference read error
propagates rather than reporting equality. Repeating after a fault is safe.
The stored profit primary key and both existing stored-event job_id indexes
serve the bounded reads. This does not change the reference views' inherited
internal source scans or claim every source read is index-bound. The contract
proves scoped materialization with an unrelated-row refusal and native plans
on the fixture sources and stored tables; production timing remains unmeasured.

Corrected baseline (director, 18 Nov, one quiet-database read per step on the
slowest recent job): page build 16.5 seconds, written-story stale check 15.8
seconds, its book 14.7 seconds, and one-job Job Profit 0.3 seconds. The earlier
averages above do not establish the cause of page-build latency. This diagnostic
change claims no page-build speedup and does not alter the story/book functions.
