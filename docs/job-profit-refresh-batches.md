# Stored Job Profit refill (FU21)

This changes only the explicit stored-profit writer. No reader, trigger, timer or
switch is installed or enabled. The public checking views and Xero writes are
unchanged. `job_profit_stored_read_v1` remains off until separately proved.

The old no-argument `job_profit_refresh_all()` now refuses with
`job_profit_refresh_all_requires_batch_cursor`. A database function cannot
commit its own batches. A loop inside it would retain every advisory lock until
the whole company finished. Use the cursor overload, one call per transaction:

```sql
SET statement_timeout = '120s';
-- In an autocommit client, this is one transaction of at most 500 jobs.
SELECT public.job_profit_refresh_all(NULL::uuid, 500);
-- After that transaction commits, pass its next_after in the next call.
-- Continue until done=true. Do not wrap these calls in one outer transaction.
```

The reply keeps `refreshed`, `changed`, `ms` and adds `next_after` and `done`.
The cursor is the last **selected** job, even if that job is absent from the
profit view. A second page in the same transaction refuses before taking more
locks. A failed page returns no cursor: retry the previous one. Earlier committed
pages stay stored, and a retried page replaces its rows rather than adding copies.
Jobs inserted behind a cursor require the next full refill or the dirty queue.

Set `statement_timeout` before the refresh statement starts, in the same session.
Every refresh refuses a missing/unlimited deadline or one over 120 seconds.
Changing that setting inside a running function would not start a statement timer.
The writer also limits lock waits to five seconds. A timeout or failed source read
rolls the batch back, including its dirty-mark deletion and page notifications.
The next explicit retry reads the office's current records.

Each batch evaluates the cost and revenue streams once into transaction-local
tables. The writer takes the current `v_job_profit` SELECT and substitutes those
two relations with the batch snapshots, keeping its financial expressions and all
public views unchanged. The current view groups and joins both streams by job id.
This removes the repeated bill/credit build inside the profit SELECT; it does not
claim that the rest of that SELECT or the first event build is cheap. No persistent
history is added. Temporary snapshots are dropped after success or at transaction end.

The existing store contract and
`supabase/tests/migration-contracts/20261117220001_job_profit_refresh_batches/`
prove full-column equality on the real checking views for supplier and customer credits, an
unverified job and a no-cost job. They also count cost and revenue stream evaluations, exercise
an office edit, a failed read and retry, two committed pages with no retained
advisory locks, an actual statement cancellation, and an unlimited-deadline refusal.
This is disposable PostgreSQL proof, not a production timing or live equality proof.

Before any timer or stored reader, the director still needs to compare the live
view MD5s with `scripts/job-profit-view-md5.sql`, count jobs and inspect
`max_locks_per_transaction` and `max_connections`, time a single ZZTEST refresh
with the 120-second deadline, fill using separate batches of at most 500, then run
`job_profit_stored_compare()` on live. Date-driven holds still need the planned
daily open-job refresh, and toggling the budget, patio or cost policy needs a full
refill. Budget columns still require the existing redaction at each future reader.
