# Follow-up 33: keep real changes ahead of profit fills

The director's 18 Nov queue observation was 2,034 bulk profit marks, one page build a minute and 16.7 seconds per build, with 241 later status/invoice changes behind the fill. The nightly load report measured 297 refresh calls, 5.7 seconds median, 12.6 seconds p95 and 1,703 seconds total database time. These are historical baselines, not measurements of this change on production.

`job_pages_next_due` now orders real changes before explicit bulk sources (`profit` and the reserved future source `bulk`), then by oldest mark and job id. A job with a pending real change qualifies even if it also has older bulk marks. A legacy base row is bulk only when its nonempty source array contains only those bulk sources. Empty or unknown sources remain real work.

Main's two time-leading partial due indexes cannot serve that priority directly. The new partial expression indexes `job_change_mark_events_priority_due` and `job_change_marks_base_priority_due` each supply one ordered candidate. The event candidate validates its job with `jobs_pkey`. Existing time-leading due indexes serve the trailing sample. The contract checks native executed plans for index scans and row bounds, without pinning an index name or disabling sequential scans.

`job_pages_refresh_due(5)` attempts up to five distinct jobs while fewer than 40 seconds have elapsed. Its safety ceiling is 100 attempts. The original transaction-level runner lock and the existing per-job renderer, failure, acknowledgement and retry logic remain. No new build starts at or after 40 seconds. An already-started build still runs under the caller's statement timeout. Fast builds therefore consume the supplied limit; a slow build may leave the rest for the next run.

The trailing `left` count samples at most 1,001 marks from each pending lane and returns at most 1,000 distinct jobs. `left_capped: true` means this is a lower bound, including when duplicate marks fill a sample. A trailing timeout returns `left: null` and preserves builds already completed. No new retained data is added; existing acknowledgement and bounded nightly folding remain.

For a deliberately quiet profit refill, the director sets the transaction-local no-mark option before the batch:

```sql
SET LOCAL statement_timeout = '120s';
SET LOCAL secureworks.job_profit_no_page_mark = 'on';
SELECT public.job_profit_refresh_all(NULL::uuid, 500);
```

Commit each batch and repeat both settings with the returned cursor in a new transaction. This option suppresses only the refill's derived `profit` marks. Stored figures, dirty-row clearing and changed/refreshed counts remain the same. Invoice, payment, status and other business marks remain active. Missing, off or unrecognised settings retain main's existing profit-mark behaviour. Use this option only when the fill does not change the card's displayed figures, including the current first fill while the card reads live profit. It is not a flag to suppress genuine changes after stored readers go live.

The profit source helper now queues store dirtiness only. It no longer directly marks a page with a source-specific reason. The changed-figure comparison in `job_profit_refresh_many` is the sole profit-driven page marker, using bulk source `profit` once per changed job in the batch. The helper's existing append-only queue and 200-event trim remain. Its switch-off return and all source-routing lookups remain unchanged. Follow-up 32's eleven trigger wrappers are untouched.

The migration replaces definitions on an already-installed job-pages path. It installs no trigger or timer and creates no feature switch. Existing scheduled calls still pass their existing argument; the current installer uses `job_pages_refresh_due(1)`. To gain multiple builds each minute, the director must explicitly change the existing timer to pass 5 after a bounded live proof. This PR makes no live call or schedule change.

Proof is `supabase/tests/migration-contracts/20261118023443_job_pages_real_changes_first/contract.sql`: older bulk marks versus a newer invoice, mixed legacy sources, unknown real sources, five fast builds, nonpositive limits, failed builds, one runner, bounded native plans, suppressed first fill, unchanged/default marks, manual marks, the 40-second start budget, unchanged renderer and rollback restoration. All fixtures and renderer stand-ins roll back. The full-stack contract uses the real profit engine; isolated local prerequisites are reported separately.

Director, on live: compare the four guarded function hashes, prove an invoice is chosen ahead of the existing profit backlog, time one bounded run, select the intended timer argument, and verify queue age and reader fallback. Before every bulk fill, inspect what it marks or queues as well as what it writes. Rollback restores the exact previous function bodies and removes only the two new indexes.
