# Follow-up 26 item 0: the written story stale check

The director measured one quiet production read per step on 18 Nov: page build 16.5 s, story text check 15.8 s, its money book 14.7 s for 1.5 KB, bill outcomes 1.1 s. The card took 1.4 to 2.6 s and one-job Job Profit took 0.3 s. These are the before numbers from the director's night database-load report, not timings made by this worker.

## Which reads cost work

`context_job_story_text_get` builds the book even with no written story, because it also returns current money. With a story it folds the book's digest and the bill-outcome digest into the existing full hash. Removing the book without replacing that current-money read changes the answer.

The book reads Job Profit, open suggested bills, revenue by payer, owing customer invoices, crew costs by party, priced purchase-order count, its work order, the newest sign-off, and the existing money signature. Its two `v_job_cost_events` reads ask only for actual `trade_line` rows and `po_committed` rows. The legacy view has shared, multiply referenced CTEs for trade, bill classification, credit and supplier work. Native local plans show the source and job predicates applied at CTE scans after unrelated rows were built. Even the PO-only count visits the shared trade/bill graph. An index on the final view predicate cannot cross that materialization boundary.

A local PostgreSQL 17 probe with 5,000 unrelated jobs and trade lines showed both reads scanning 5,011 trade lines and 5,026 jobs. That proves a company-size dependency in this source path. It does not attribute the live 14.7 seconds among those reads: no production profiler was run. Other existing reads and their costs remain, including Job Profit, the money signature, card and bill outcomes.

## Why the mark shortcut was not used

Current marks are broader than the rendered book and are not a complete book digest. An unrelated event can move a mark without moving the words; an order can become overdue with no write; current mark triggers do not cover every book input. Equating a mark change with stale would change freshness. A cache would need complete invalidation and a clock-bound policy first. This change keeps the current digest comparison.

## Narrow replacement

The bounded helper selects candidate trade lines by the resolver's three existing coordinates: direct job id, trimmed line job number, and its existing extracted description reference. `UNION` removes overlap. It then calls the real `v_trade_charge_resolved` for each candidate line behind its primary key, preserving tenant checks, direct-reference precedence, test exclusion, lane rules and invoice state. It reads no unrelated trade/bill CTEs. The PO count uses the exact legacy PO predicate against this job and its matching actual facts.

Two expression indexes serve the fallback coordinates, and one partial index serves matching actual PO facts. Existing direct-job, PO-job, primary-key and job-number indexes serve the other probes. No new ledger, cache, queue or growing table exists.

The fast book is derived from the guarded current main function definition, changing only those two reads and adding failure fallback. Its words, arithmetic, policy, money signature and digest are unchanged. The original book and `context_job_story_text_get` remain byte-identical on merge. No page-refresh function changes.

An explicit `install_context_story_book_speed()` swaps in the derived fast body after checking both original function bodies. `remove_context_story_book_speed()` restores the exact original body. Both are service-role only and neither runs on merge. The helper checks the cost-view and resolver pre-images on every call. A later source change, an active cost-line cutover or a failed bounded read falls back to the captured current-main book. A failing main read still fails; no saved money substitutes for current truth. Office changes are read on the next request, and a refused read can be retried.

## Proof and release limits

The focused contract compares complete books for the existing 27 MB, TP13 and H7 fixture jobs. It compares the real staff read for none, fresh, unchecked, wrong-card, writer-card and stale states, tests resolver overlap and exclusions, failed reads and source drift, install/remove and service-role privileges. Its two native plans use 10,000 unrelated rows, assert no sequential scan on the big tables and bound rows examined, without disabling sequential scans. Fixture writes and installation roll back.

A separate local one-run probe on the 5,000-job population measured main at 390 ms and fast at 139 ms. Planning/cache conditions differ from production; this is not a live speed claim. The remaining card and bill-outcome timings also mean the overall three-second target cannot be asserted locally.

Director, on live: check the source guards with `context_story_book_costs` on the same job; compare main and fast whole books and current text status; install explicitly only after agreement; re-time that job's page build. No migration, installer, switch, deploy or live-system call was run by this worker. The Job Profit stored-read switch is unchanged. The requested job-id compare overload belongs to the separate P0-09 worker.
