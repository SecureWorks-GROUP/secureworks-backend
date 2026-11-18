# Stored Job Profit freshness: the ZZTEST check (written, not run)

Follow-up 32, before the story's stored-profit switch (`job_story_stored_profit_v1`)
and before any reader of `job_profit_stored_read_v1`. Nothing here writes. Run it
on one ZZTEST job, in `psql` as the service role, after the director's ZZTEST
proof of `job_profit_refresh_v1` (on since 18 Nov 2026 12:55).

## What the stored snapshot must pass

`job_story_stored_profit_as_at(job, as_of)` returns the snapshot's `computed_at`
only when every one of these holds; otherwise it returns NULL and
`context_job_story_book` serves the live book, exactly as main does:

- the store is armed, the refresh is on, its 11 source triggers are the armed set;
- no `job_profit_change_events` row and no `job_profit_dirty` row for the job;
- **no change mark for the job newer than the start of the refresh that stored
  the snapshot** (`job_change_mark_events`, and the folded `job_change_marks_base`
  row). The store's own `profit` and `bulk` marks are left out (the refresh writes
  them just after its stamp). A folded mark has no source and always counts.
  The start of the refresh is `job_story_stored_profit_counts.refresh_started_at`,
  which is never later than `computed_at`, so this is at least as strict as
  "`computed_at` at or after the newest change mark";
- the snapshot is from a refresh begun after the arm stamp, on the as-of Perth
  day, and its event sets are the ones its refresh fingerprinted.

When the store answers, the money block carries `computed_at` (the as-at time):
`context_job_story_book(...)->'computed_at'` and, on the staff read
`context_job_story_text_get`, `money.computed_at`. `ops-api?action=job_overview`
passes it through unchanged as `story_text.money.computed_at`
(`job_overview_read_test.ts`, "Follow-up 32"). The Job page does not show it yet:
`storyBook` in secureworks-ux `modules/ops-job-overview-v2.js` drops the field.
That screen change must ship before the switch goes on.

## The check

Set the job once (a ZZTEST job number):

```sql
\set job_number 'ZZTEST-...'
\timing on
-- Read only, but no open transaction: inside one, now() stays at its start
-- and a refresh landing later would read as newer than the as-of time.
SET default_transaction_read_only = on;
SELECT id AS job FROM public.jobs WHERE job_number = :'job_number' \gset
```

1. A ZZTEST invoice or bill change reaches the queue. Make the change the
   normal way first (a Xero edit on the ZZTEST invoice or bill, synced), then:

   ```sql
   -- Waiting change (folded within the minute by the refresh timer):
   SELECT id, reason FROM public.job_profit_change_events
    WHERE job_id = :'job' ORDER BY id DESC LIMIT 5;
   SELECT reason, marked_at FROM public.job_profit_dirty WHERE job_id = :'job';
   -- The job's own change marks since the change:
   SELECT source, marked_at FROM public.job_change_mark_events
    WHERE job_id = :'job' ORDER BY marked_at DESC LIMIT 5;
   -- While either row above exists, or a newer real mark does: NULL.
   SELECT public.job_story_stored_profit_as_at(:'job', now()) AS as_at;
   ```

   The timer folds the change into a dirty row and refreshes it in one
   transaction, so a dirty row may never be seen from outside. The proof is a
   change-event row (or a dirty row) first, then, after the next refresh, a
   `computed_at` later than the change:

   ```sql
   SELECT computed_at FROM public.job_profit_stored WHERE job_id = :'job';
   SELECT refresh_started_at FROM public.job_story_stored_profit_counts WHERE job_id = :'job';
   ```

   Pass: an event or dirty row appeared; `as_at` was NULL while it waited;
   after the refresh `computed_at` is after the change and `as_at` equals it.

2. Stored and live give the same answer:

   ```sql
   SELECT public.context_job_story_book_stored(:'job', now()) ->> 'digest' AS stored_digest,
          public.context_job_story_book_fast(:'job', now())   ->> 'digest' AS live_digest;
   SELECT (public.context_job_story_book_stored(:'job', now()) - 'computed_at')
        = public.context_job_story_book_fast(:'job', now()) AS same_book;
   SELECT public.job_profit_stored_compare(ARRAY[:'job'::uuid]) AS compare;
   ```

   Pass: the two digests are equal, `same_book` is true, and `compare` lists no
   differences and nothing missing.

3. Time both (the `\timing` lines above each statement):

   ```sql
   SELECT public.context_job_story_book_stored(:'job', now()) IS NOT NULL;
   SELECT public.context_job_story_book_fast(:'job', now()) IS NOT NULL;
   SELECT public.job_story_stored_profit_as_at(:'job', now());
   ```

   Record the three times. The stored read plus `as_at` should be faster than the
   live book; if not, the switch gains nothing and stays off.

Record the job number, the times and the three pass lines on the switch's
go-live note. Nothing in this check changes a row.
