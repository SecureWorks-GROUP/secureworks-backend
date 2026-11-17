# Job page build cost and fair retries

Ticket: cx-page-speed, P0-01.1 follow-up. No live measurement or write was made.

The migration replaces functions only. Existing installed triggers and schedules
are unchanged. It does not install, remove or activate either. The normal page
payload and Xero paths are unchanged. Busy and changed builds intentionally yield
pending work to the back of the queue.

## Local measurement

PostgreSQL 17.11, disposable local copy of the registered schema. Synthetic data:
2,500 added jobs, 100,000 email events, 200 calls and 200 matching transcripts on
one job, and 10,000 invoice rows without figures. Placement switch off. No live
export, identity, price or pay data. The local build does not reproduce the
reported 6.5 second production build; these timings are local comparisons only.

Five fresh-session EXPLAIN ANALYZE runs per version, with BUFFERS and nested
statement logging and function statistics enabled, with per-node auto_explain
timing disabled. Instrumentation was the same on both sides; uninstrumented
production timing is not established:

| Version | Execution times, milliseconds | Median |
| --- | --- | --- |
| Main | 339.246, 316.675, 316.241, 315.983, 310.808 | 316.241 |
| This change | 252.985, 235.520, 248.206, 234.864, 247.971 | 247.971 |

Median improvement: 68.270 milliseconds, 21.6 percent. An additional isolated
function-attribution run on each version found:

| Function | Main calls / total ms | Changed calls / total ms |
| --- | --- | --- |
| job_page_refresh | 1 / 297.37 | 1 / 240.38 |
| context_job_story | 1 / 235.50 | 1 / 176.52 |
| context_job_story_text_get | 1 / 55.94 | 1 / 58.44 |
| context_ledger_person_placement_enabled | 14,523 / 53.73 | 36 / 0.35 |

The placement-switch check in context_job_record_messages was evaluated per
message in repeated record reads. The scalar subquery makes it an initplan.
The switch is STABLE, so the missing, off and on branches return the same rows
and real story card as main at the same statement instant. The book remains a
material part of the build; this change does not skip it or any evidence.

Retained reproducible SQL is beside the contract:
`profile-seed.sql` creates the synthetic workload on a disposable local schema;
`profile-build.sql` runs the measured build. Both require the explicit disposable
acknowledgement and a localhost server. Run each profile sample in a fresh psql
session against separate copies of the seeded main and changed schema. For
function attribution, reset statistics only on those owned disposable databases,
run one sample, then read pg_stat_user_functions from a separate connection.

## Retry semantics and indexes

A busy or changed build calls job_page_yield. One statement clears only this
job's visible pending event/base flags and appends one `page_retry` mark at the
back. It never writes job_page_marks_seen or claims a page was completed. A
changed build retains its prior page and visible stale state. Work committed
after the yield statement remains pending independently; a retry also remains
due after handled-event compaction. The existing nightly fold trims handled
marks, bounded at 10,000 per run. No new table or untrimmed history is added.

The new event update uses job_change_mark_events_job(job_id), and the base update
uses job_change_marks_pkey(job_id). Natural plans choose the small due
partial indexes instead when the pending set is sparse; the contract checks
both sparse and dense pending sets. The existing indexed due probes are
unchanged: job_change_mark_events_due and job_change_marks_base_due. The switch
read still uses feature_flags_pkey(flag_name), inside the existing helper.
No new scan of jobs, business_events, invoices, pay or other context tables was
added. Business mark writers still only append, without the builder's advisory
lock, mark-row update, unique key or parent foreign-key lock.

## Proof and compatibility

The new case proves real message/card equality for missing, off and on switch
states; a real second session holding the first job's advisory lock; the second
marked job building first next run; the first completing after release; a
changed build retaining the old page and acknowledgement while yielding;
compaction preserving the pending retry; browser refusal; historical identity
rollback; and this migration's rollback. The planted break removes the yield
calls and must fail on the busy-head assertion.

No test was deleted. The original page and schedule contracts now restore this successor
after their historical reapply, so later cases test the installed definitions.
The historical identity rollback accepts the equivalent new message body as
well as its original hash, then restores its own original predecessor.

The final local gate ran the 18 cases naming either replaced function: 18
positive cases, 4 rollback cases and 18 planted breaks rejected as expected,
with zero unexpected failures. The stock run.sh phases were retained in a
scratch copy selecting those 18 cases while building the registered schema
prerequisites. Unrelated behavior contracts were excluded. Earlier isolated
runs also checked the new case and the historical page case. No full contract
suite, ops-api type check, browser, deployment or live-system call was run.
The parity seed bypasses attribution only during synthetic row insertion, and
asserts nonempty reader output before comparing fields and real cards.

Command (owned disposable server, under /tmp/se-heavy.lock):

```sh
PGOPTIONS='-c timezone=UTC' TMPDIR=/Volumes/SSD/agent-scratch/cx-page-speed \
PGHOST=127.0.0.1 PGPORT=56431 \
MIGRATION_CONTRACT_ADMIN_DATABASE_URL=postgresql://postgres@127.0.0.1:56431/postgres \
MIGRATION_CONTRACT_DISPOSABLE_ACK=I-confirm-this-is-disposable-local-postgres \
bash /Volumes/SSD/agent-scratch/cx-page-speed/run-named-cases.sh
```

Pass line: `PostgreSQL migration contracts passed`. The retained profile seed
and build scripts also ran successfully once on another fresh local copy
(verification only, excluded from the five-sample comparison above).

Director, on live after review and merge: measure deployed build times and
observe that pending changed/busy jobs no longer monopolize successive turns.
No trigger or timer installation is required.
