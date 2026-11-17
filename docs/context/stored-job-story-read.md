# Stored job story read: P0-02.3 and P0-02.4

The backend's current job story reads use `job_page_get` only while
`feature_flags.job_page_stored_read_v1` is true. Migration
`20261117195601` seeds this spec read switch off and preserves an existing
setting. Nothing installs a trigger or timer or changes a worker on merge.

With the switch off, missing or unreadable, `readJobStory` calls the existing
`context_job_story` with the same arguments and returns the same answer.
Explicit `as_of`, `since` and `generation_id` requests always retain that reader.
The current stored card carries `meta.stored_page` with its build time and stale
flag. A stored miss (error, absent page, not ready, wrong job or bad shape) falls
back to the existing `context_job_story` call with the same arguments, including
when the stored RPC throws. A ready page is still served without a live call.
The existing `job_page_get` can build a missing page on demand; an existing stale
page is returned with its stale flag. Both the story door and Job Overview use
this shared reader. Saved prose, notes, files and client stories keep their
existing readers.

The only new direct query is one flag by `feature_flags_pkey`. Existing
`job_page_get` reads one page by `job_pages_pkey`, and its mark view uses
`jobs_pkey`, `job_change_marks_pkey` (on the renamed base table), `job_page_marks_seen_pkey`,
`job_notes_marks_seen_pkey` and `job_change_mark_events_job`. No growing table,
new schedule, Xero call or money write is added.

## Prove it

- P0-02.3 backend: `deno test --no-check --allow-env --allow-read
  supabase/functions/ops-api/job_story_stored_page_test.ts
  supabase/functions/ops-api/job_story_door_test.ts
  supabase/functions/ops-api/job_overview_read_test.ts`: 32 pass, zero fail.
  The focused switch guard failed before the implementation.
- Migration: the single `20261117195601_job_story_stored_page_read` contract
  prints `PASS: P0-02.3 stored story read seeded off; two reapplies preserve setting`.
- P0-02.4, director on a disposable copy: run `psql "$COPY_DATABASE_URL" -X
  -v ON_ERROR_STOP=1 -v job_change_chain_copy=I-confirm-this-is-a-disposable-copy
  -f supabase/checks/job_change_chain_check.sql`. Expected: no error,
  `refresh_ms` below 2000, the `PASS: P0-02.4` notice and final `ROLLBACK`.
  With the story writer off, the notice says so and proves only mark/page work.
  The copy must have the page triggers installed, an existing organisation and
  a drained page queue. No fixture is written outside the rolled-back transaction.
  The unchanged job may retain its acknowledged birth mark; its version must
  not move, no pending event may remain, and no request may appear. The check
  uses the current append-only marks and acknowledgements, never deletes history.
- Director on live: confirm the planted ZZTEST change's mark and page-build
  timestamps are within five minutes. This was not run by the builder.

P0-02.3's original worker steps belong to secureworks-jarvis:
`src/automation/luna-story-phase.ts` must stop its every-tick changed-story
sweep and throttle first-story enqueue, with its own worker test and build.
This backend slice does not claim those steps are complete or permit that
worker release before the stored-page schedule is proven live.
