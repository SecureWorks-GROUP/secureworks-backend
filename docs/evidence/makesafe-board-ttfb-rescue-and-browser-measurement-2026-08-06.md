# Make-safe board TTFB: commit rescue outcome and the browser measurement

Date: 2026-08-06. Read-only measurement against production. No card data,
client names, phone numbers, emails or street addresses appear here.

## 1. The "stranded" commit was never unshipped

`238cd9d1ac04d2b03009e7598f7a48ef2e06782d` ("Cut make-safe board TTFB by
parallelising PostgREST waves", 2026-08-04) was reported as existing in exactly
one place, because it is not an ancestor of `origin/main` and not an ancestor of
`origin/fm/makesafe-board-load-ttfb-v1`.

Both of those facts are true and neither means the work is unshipped. GitHub
squash-merge rewrites the SHA, so a squash-merged branch head never becomes an
ancestor of `main`. The content shipped four minutes after it was written:

| fact | value |
|---|---|
| stranded commit patch-id | `07d28ce6a2836a33c2291a7951ac74a9825d621d` |
| `54be0a0` (PR #564) patch-id | `07d28ce6a2836a33c2291a7951ac74a9825d621d` |
| `git cherry origin/main 238cd9d1` | `-` (equivalent patch already upstream) |
| tree diff over the 4 touched paths | empty |

`git diff 238cd9d1 54be0a0 -- AGENTS.md supabase/functions/ops-api/index.ts
supabase/functions/ops-api/makesafe_board_population_test.ts
supabase/functions/ops-api/makesafe_compact_reads.ts` returns nothing.

All four behaviours from the commit message are live on `main` today:

1. concurrent URL-budget chunks — `makesafe_compact_reads.ts`, chunks run
   concurrently under `CHUNK_FETCH_CONCURRENCY`
2. one concurrent dependent-read wave — `Promise.all` in `makesafePipeline`
3. terminal-synthetic ledger reuse — `terminal_synthetic_job_ids` published by
   the pipeline and consumed by `loadCanonicalMakesafeBoard`
4. active-scope skip of stage-dependent joins —
   `skipArchivedStatusDependents: columnScope === 'active'`

PR #567 then *hardened* this with the captain's bounded fan-out cap
(`CHUNK_FETCH_CONCURRENCY = 8`, `withBoundedFetchSlot`, and the job-source lanes
acquiring from the same pool).

**Nothing was reconciled onto main, deliberately.** Re-applying `238cd9d1` would
have reverted #567's bound — reintroducing the unbounded fan-out that the
captain's cap exists to prevent — for zero gain, since the patch is already
applied. A second copy of the commit is preserved on
`origin/fm/rescue-board-ttfb-238cd9d1` regardless.

## 2. The board API is not the board's slowness

`GET /functions/v1/ops-api?action=makesafe_board`, 10 consecutive runs:

| stat | TTFB |
|---|---|
| min | 2.495 s |
| median | 2.697 s |
| mean | 2.916 s |
| max | 4.106 s |

Payload is not the driver, which re-confirms the standing AGENTS.md claim —
three variants, three runs each, all in the same TTFB band across a 10x byte range:

| variant | bytes | TTFB |
|---|---|---|
| active / card (default) | 591 KB | 2.500 – 2.605 s |
| `include_archive=1` | 1.72 MB | 2.641 – 2.717 s |
| `fields=full` | 5.72 MB | 2.668 – 3.258 s |
| default, gzip (what a browser gets) | **83 KB** | 2.595 – 3.169 s |

The browser agrees with curl: the in-page `makesafe_board` fetch measured
2.879 / 2.913 / 3.303 / 3.480 ms across four samples.

## 3. Where the Captain's ~20 seconds actually goes

Ops dashboard (`ops.html`), cold load then Jobs → Make Safes, instrumented via
the Resource Timing API. The shell is fast: first contentful paint **212 ms**,
`loadEventEnd` **216 ms**.

The API call timeline from one fully-booted run:

| call | starts | duration |
|---|---|---|
| `list_users` / `ops_summary` / `pipeline` | 0.9 s | 0.9 – 1.6 s |
| `daily-digest` | 2.6 s | **17.6 s** |
| `auto_approve_clean_intake_drafts` | 18.4 s | **28.6 s** |
| `makesafe_board` | **47.0 s** | 3.5 s |

`makesafe_board` starts at 46,992 ms — one millisecond after
`auto_approve_clean_intake_drafts` ends at 46,991 ms. The board request is
**serialised behind** that call; it is not slow, it is queued.

Click-to-painted for the make-safe board was **32,138 ms**, of which:

- ~28.5 s waiting before the board request is issued at all
- 3.5 s board fetch
- **46 ms** render (170 cards, 11,770 DOM nodes)

`daily-digest` was 17.6 s and 18.6 s on two separate loads. It is fired by
`loadAiAlerts()` and is independent of the board.

### The honest reading

The API optimisation worked and is already in production. It is also not what
the Captain is experiencing. The board API is ~2.5–3.5 s of a ~32 s journey, and
client render is 46 ms. **Making the board API faster cannot move his number.**
The two long poles are both client-initiated calls to other endpoints, and the
board simply waits its turn behind one of them.

Sample sizes, stated plainly: `makesafe_board` n=23 (19 curl + 4 browser),
`daily-digest` n=2, `auto_approve_clean_intake_drafts` n=1. The single sample on
the 28.6 s call is a real limitation, and it was left at one deliberately — see
below.

## 4. Disclosure: measuring the board triggers a production write

`ops.html` calls `autoApproveCleanMakesafeIntakeDraftsIfNeeded()` on board
autoload, which POSTs `auto_approve_clean_intake_drafts`
(`limit: 60`, `triggered_by: 'ops_board_autoload'`), throttled to once per 30 s.

This is the dashboard's designed standing behaviour and fires for any user who
opens the make-safe board. It is not a change made here. But it means the
browser measurement required by this task caused that approval action to run
(approximately three board loads). Further repeat runs on the board view were
stopped for that reason, which is why the 28.6 s figure has n=1 rather than a
spread.

## 5. Placement and archive honesty

Unchanged, and not merely by assertion: no `ops-api` source file was modified in
this work. `git diff origin/main` over `supabase/functions/` is empty. The
placement and archive-honesty claim from the original commit continues to hold
because the code carrying it is the code already on `main`, verified above and
covered by `makesafe_board_population_test.ts` and
`makesafe_compact_reads_test.ts`.

## 6. Open, not addressed here

The client-side serialisation is the live defect and stays open: the make-safe
board request should not be queued behind `auto_approve_clean_intake_drafts`,
and `daily-digest` should not occupy 18 s of a dashboard load. Both live in the
`dashboard` submodule (`SecureWorks-GROUP/secureworks-ux`), not in this repo.
