# FU26.2: why the hourly context scorecard costs 68 seconds

**Result:** the recorder rebuilds the whole scorecard in one call. Its main
suspect is row 6's full canonical evidence read, followed by row 11's record
timeline read. There is no job or evidence-row work cap. A safe speed fix needs
parity proof on a test database; this PR changes documentation only.

**Owner:** Follow-up 26, item 2 (FU26.2 here), in the existing **CTX-T5 / X4
reliable-running** lane. The original scorecard implementation is W11 and its
hourly recorder. This closes the source investigation, not CTX-T5 or the speed
fix. No new Linear ticket was created or inferred. The director's frozen phase
ticket files contain no dedicated `context_scorecard_record_run` fix; the
records writer should retain FU26.2 against CTX-T5 when filing the next change.

**Method:** source inspection on backend main
`285b6883d34a56a75afe9b59e223fd3ef4dfde78`, 18 Nov 2026. No database was queried,
no migration was applied, no key was read, and no benchmark was run in this
investigation. Production's deployed definitions and plans were not observed.

## Before number and its limits

The director's `reports/db-load-17nov-night.md`, read at 23:59 Perth on 17 Nov,
reports **10 calls, 67.8 seconds average, 76.4 seconds longest, 678 seconds
total** for `context_scorecard_record_run`. These are top-level
`pg_stat_statements` totals since its 14:19 Perth reset, about 9 hours 40 minutes.
They do not split time inside the function, identify failed runs, or establish
a full working-day baseline. This investigation has no after number.

An earlier, separately dated production measurement is retained in
[the 15 Nov timeout migration](../../supabase/migrations/20261115090000_context_scorecard_hourly_timeout.sql#L1):
633 monitored jobs; row 6's evidence read 44.8 seconds; the timeline read
9.4 seconds; other individual reads under 2 seconds each. Run counts for those
two component measurements are not supplied there. They support where to look,
but are not a fresh breakdown of the 17 Nov 67.8 seconds. Do not subtract or
combine the two snapshots into a claimed current saving.

## The work done on every run

| Step | Source evidence | Implication |
| --- | --- | --- |
| Record a run | [Recorder, lines 270 onward](../../supabase/migrations/20261007040000_context_scorecard_hourly.sql#L270) | Tries a transaction advisory lock, calls `context_scorecard` once, validates and reduces its JSON, inserts one run, then prunes old runs. A competing recorder skips immediately rather than queuing on that advisory lock. |
| Choose the population | [Scorecard, lines 301 onward](../../supabase/migrations/20261007120000_context_scorecard_v2.sql#L301) | Calls `context_lead_monitored_jobs(NULL, as_of)` and collects every monitored job. No page limit. Several later history/status helpers also do their own reads. |
| Row 6: measure unread evidence | [Scorecard, lines 594 onward](../../supabase/migrations/20261007120000_context_scorecard_v2.sql#L594) | Calls `context_ledger_evidence_rows` for the entire monitored array, excludes copies, joins live and shadow generations, then counts unread items and jobs. It reads the evidence before filtering out already-read items. |
| Rows 11 to 13: story coverage | [Scorecard, lines 837 onward](../../supabase/migrations/20261007120000_context_scorecard_v2.sql#L837) | Finds live ledger generations and phase notes, then builds timeline rows for those jobs just to group by job and test a minimum count. It does not call `context_job_story` or Job Profit here. |
| Other work | [Scorecard body](../../supabase/migrations/20261007120000_context_scorecard_v2.sql#L309) | Capture/status readers, the 30-day event aggregates, party-role and placement measurements, history readers, grades and depth checks run serially in the same function. Their combined cost remains unmeasured here. |

The evidence reader is substantially more than an indexed count. Its
[person-placement version](../../supabase/migrations/20261030154917_context_ledger_person_placement.sql#L125)
reads business events and legacy inbox mail, checks canonical placement and
saved copies, computes message text, and uses a window partition containing
`md5(lower(context_ledger_text_norm(body)))` to identify duplicates within
120 seconds. Row 6 needs `copy_of`, so projecting only ids and landing times
outside the function cannot avoid the text-based duplicate calculation.
The SQL function also has a `SET search_path` clause: do not assume an outer
projection or filter will be pushed into its body.

Read the subsequent
[3 Nov key-lookup change](../../supabase/migrations/20261103150000_context_record_mail_copy_key_fast.sql#L1)
as well as the original body. It already replaces the old inbox-copy GIN
containment probe with the partial btree key lookup. Recommending that same fix
again, or diagnosing today's bottleneck from the older containment text alone,
would be wrong. No current sequential scan or missing index was measured here.

The [timeline implementation](../../supabase/migrations/20261011130000_context_record_scope.sql#L85)
constructs record milestones from messages, events, documents, invoices,
assignments and other job records. An outer `count` is still asking for the
result of that canonical reader. Replacing it with raw source-row counts would
change what qualifies as a timeline and could turn an unproved job green.

## What is bounded now, and what is not

| Boundary | Existing value | Actual limit |
| --- | --- | --- |
| Concurrent recorder calls | One transaction advisory-lock winner | Bounds recorder concurrency, not other callers of the scorecard or evidence reader. |
| Scheduled start | Minute 40 each UTC hour | A schedule, not proof that the job is active or that each hour succeeded. Live cron was not read. |
| Cron statement cancellation | 110 seconds; lock wait 10 seconds per lock attempt | Configured in the [15 Nov policy](../../supabase/migrations/20261115090000_context_scorecard_hourly_timeout.sql#L59). The recorder itself has no independent timeout setting. Manual callers rely on their connection's limits. |
| Staff scorecard RPC | Function setting 50 seconds | Declared on [the scorecard](../../supabase/migrations/20261007120000_context_scorecard_v2.sql#L278). It must not be treated as a fresh 50-second timer for each nested function call. |
| Working population | Every monitored job | No maximum job count, evidence-row count, body-text budget or checkpoint on the recorder path. The 30-day event window does not cap row 6's canonical evidence history. |
| Per-job drilldown | Default 150 jobs, maximum 300 | `context_scorecard_jobs` has this separate page bound. The recorder never calls it, so it does not bound hourly work. |
| Stored run payload | At most 262,144 bytes across its checked JSON fields | [Run table checks](../../supabase/migrations/20261007040000_context_scorecard_hourly.sql#L218). This limits stored output, not intermediate evidence or executor memory. |
| Retention | 180 days, receipts cascade with runs | Existing `as_of` and receipt `run_id` indexes support retention. The recorder deletes all expired rows in one statement; there is no deletion batch cap and failed pruning is caught for a later run. |

**110 seconds is a cancellation threshold, not a guaranteed whole-call wall
bound.** The recorder explicitly catches `query_canceled` around the scorecard,
then writes a failed-run row and attempts retention. It also catches an insert
cancellation and retries a bare failed row. Its own comment says execution after
a caught statement timeout continues. A run can therefore return after the
threshold. In addition, its `duration_ms` is captured **before** insertion and
pruning; it is not the full top-level duration in `pg_stat_statements`.

PostgreSQL documents that [statement timeout is measured on the client
statement and lock timeout applies to each lock attempt](https://www.postgresql.org/docs/current/runtime-config-client.html#GUC-STATEMENT-TIMEOUT).
Neither setting is a work-volume cap. Increasing or reducing these numbers
alone does not make the underlying reads cheaper.

## Bounded next change, still owned by FU26.2 / CTX-T5

No small safe runtime fix is established by these source reads. Keep this PR
report-only. Do not change the canonical evidence rules, silently sample jobs,
lower the scorecard's population, or label an interrupted measurement green.

The next implementation should first profile the exact row 6 query and row 11
query on a sanitized test database with the current canonical helpers. Use one
fixed `as_of` and a frozen population. Lift the nested SQL when collecting plans;
a top-level `Function Scan` alone does not identify which internal reads use
indexes. Retain plan row counts, buffers, sorting/spill and cold/warm timings.

The proposed operating bound for a split implementation is **one worker, at
most 25 monitored jobs per transaction, a 5-second statement-cancellation budget
set by the caller before each batch, and no immediate retry of a refused batch**.
These are proposed starting limits, not measured throughput or installed caps.
Job paging alone cannot bound one large job's evidence, so a batch timeout must
leave the overall run incomplete/failed, with an explicit continuation or error,
not publish partial denominators as a complete scorecard. A finite coordinator
deadline and separately bounded failure recording are also required; the current
recorder's caught timeout is insufficient as that deadline.

Prefer a canonical count projection only if it can share the existing evidence
admission, landing-time and duplicate truth. Otherwise page the canonical
measurement with a saved generation and completeness marker. Keep the prior
complete result with its as-at time while a run is incomplete. Reads of mutable
placement or office edits between batches must invalidate/restart that
generation rather than combine different populations into an apparently exact
answer. Any new storage needs bounded trimming in the same change.

Proof before enabling that change:

- All row 6 counts, row 11 coverage, lane statuses and denominators equal the
  unsplit reader at the same snapshot and `as_of`, including no-evidence jobs,
  live versus shadow readings, duplicate transport, legacy mail, unknown CRM
  times, placement corrections and office edits.
- Missing data, a failed read, an over-budget single job, and a retry leave an
  incomplete/failed run or the prior dated result. None becomes a false green;
  retries neither duplicate run completion nor skip an unmeasured job.
- Actual plans prove indexed access on each large table and bound the rows
  examined. Name existing applicable indexes after inspecting those plans;
  add none solely from a source-level guess.
- A feature switch seeded off preserves every existing answer and write. The
  director measures the same top-level statement after activation and reports
  its call count, mean and maximum beside the **67.8-second / 10-call** baseline.

The future split, its parity contracts and activation belong in a separate
runtime PR under the same owning ticket. They are not delivered here. Job
Profit storage (P0-09) is separate work and is not claimed to remove this
scorecard's evidence or timeline cost.

## Delivery and verification

Documentation only: no new query, index, table, trigger, timer, switch, migration
or entry point. No Xero path changes. The Job Profit budget switch remains
untouched; its off state is supplied by the brief, not re-observed here.
No test was deleted or changed. Relative source links and line anchors were
checked locally, and `git diff --check` passed. Runtime tests and database plans
were not run because this PR changes no runtime artifact. GitHub checks are
reported in the PR separately.

Run record: 18 Nov 2026, Codex (GPT-6), FU26.2 source investigation; explained
the all-job evidence and timeline work, documented existing and missing bounds
and CTX-T5 ownership; verified source links and diff by self; no new database
timing, runtime fix, deployment or live verification.

Resume: profile the exact row 6 and row 11 SQL on a sanitized test database,
preserving the fixed population and snapshot; implement and prove the proposed
split only after those plans identify its cost. The next PR must retain the
existing canonical admission, copy and landing-time rules.
