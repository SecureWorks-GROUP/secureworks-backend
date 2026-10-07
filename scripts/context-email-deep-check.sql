-- Read-only check of the deep email history load (history depth PR B,
-- 20261007080000).
--
-- Run each numbered query on its own (the Supabase SQL connector returns one
-- result set per call). Every query is wrapped in BEGIN READ ONLY ... ROLLBACK
-- and is a plain SELECT: codes, times and counts only, never mail text or
-- addresses.
--
-- What healthy looks like once email_reader_deep_v1 is on:
--   query 1: 20261007080000 is in the ledger; the four email flags are on.
--   query 2: every source loading, then succeeded; covered_from walking back
--            31 days a slice towards target_floor; attention empty.
--   query 3: email_depth_pct rising to 95 or more; mailboxes_finished reaching
--            mailboxes_selected.
--   query 4: the monitored jobs by status and reason; loading ones name why.
--   query 5: deep rows only ever placed by rule or left for review: the
--            attribution worker has asked about none of them.
--   query 6: each source's newest deep runs move (progressed > 0) and keep
--            mail by job number, builder reference or client email; slice_id
--            is the posting each run belongs to (the tick judges a slice only
--            by a run of its own posting).

-- 1. The migration and the flags.
BEGIN READ ONLY;
SELECT
 (SELECT string_agg(version||' '||coalesce(name,''),', ' ORDER BY version COLLATE "C")
    FROM supabase_migrations.schema_migrations WHERE version='20261007080000') AS ledger,
 (SELECT jsonb_object_agg(flag_name,enabled ORDER BY flag_name COLLATE "C") FROM public.feature_flags
   WHERE flag_name IN ('email_reader_v1','email_reader_schedule_v1','email_capture_v2','email_reader_history_v1','email_reader_deep_v1')) AS flags,
 (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('public.trigger_context_email_deep_history()')) AS tick_md5,
 public.automation_lane_enabled('capture') AS capture_lane,
 now() AS read_at;
ROLLBACK;

-- 2. The plan, one row per source, and what needs a person.
BEGIN READ ONLY;
SELECT x->>'source_key' AS source_key, x->>'kind' AS kind, x->>'state' AS state, x->>'live_floor' AS live_floor,
 x->>'covered_from' AS covered_from, x->>'target_floor' AS target_floor, x->>'slice_from' AS slice_from, x->>'slice_to' AS slice_to,
 x->>'slice_kind' AS slice_kind, (x->>'slices_done')::int AS slices_done, (x->>'needing_jobs')::int AS needing_jobs,
 (x->>'posts')::int AS posts, (x->>'posts_since_progress')::int AS posts_since_progress, x->>'last_run_status' AS last_run_status,
 x->>'last_progress_at' AS last_progress_at, x->>'stall_reason' AS stall_reason, (x->>'stalls')::int AS stalls,
 s->>'lead_rule' AS lead_rule, (s->>'members')::int AS members, (s->>'finished')::boolean AS finished, s->'attention' AS attention
FROM (SELECT public.context_email_deep_status() AS s) st CROSS JOIN LATERAL jsonb_array_elements(st.s->'plan') x
ORDER BY x->>'source_key' COLLATE "C";
ROLLBACK;

-- 3. Row 14's email lane: the jobs by status and each mailbox's reach.
BEGIN READ ONLY;
SELECT r->'jobs' AS jobs, r->>'email_depth_pct' AS email_depth_pct, r->>'target_floor' AS target_floor,
 r->>'mailboxes_finished' AS mailboxes_finished, r->>'mailboxes_selected' AS mailboxes_selected, r->>'lead_rule' AS lead_rule,
 (SELECT jsonb_agg(jsonb_build_object('source_key',b->>'source_key','state',b->>'state','reaches',b->>'reaches',
   'needing_jobs',b->'needing_jobs','finished',b->'finished') ORDER BY b->>'source_key' COLLATE "C")
  FROM jsonb_array_elements(r->'mailboxes') b) AS mailboxes
FROM (SELECT public.context_email_history_reach(now()) AS r) x;
ROLLBACK;

-- 4. The live jobs by status and reason.
BEGIN READ ONLY;
SELECT status, coalesce(reason,'-') AS reason, count(*) AS jobs,
 min(lead_in_from) AS oldest_history_start, max(reaches) AS latest_reach
FROM public.context_email_history_reach_jobs(NULL, now())
GROUP BY status, reason
ORDER BY status COLLATE "C", reason COLLATE "C";
ROLLBACK;

-- 5. Deep rows: how they were placed, and that AI placement never asked.
BEGIN READ ONLY;
SELECT coalesce(e.attribution_status,'-') AS attribution_status, count(*) AS rows,
 count(*) FILTER (WHERE e.job_id IS NOT NULL) AS on_a_job,
 count(*) FILTER (WHERE a.event_id IS NOT NULL) AS ai_asked,
 min(e.event_at) AS oldest, max(e.event_at) AS newest
FROM public.business_events e
LEFT JOIN public.context_attribution_attempts a ON a.event_id=e.id
WHERE e.source='outlook-mail-capture' AND e.metadata->>'history_tier'='deep'
GROUP BY 1 ORDER BY coalesce(e.attribution_status,'-') COLLATE "C";
ROLLBACK;

-- 6. Each source's newest deep runs.
BEGIN READ ONLY;
SELECT c.source, c.started_at, c.status, c.error_code, c.cursor->>'history_from' AS slice_from, c.cursor->>'history_to' AS slice_to,
 c.cursor->>'deep_slice' AS slice_id,
 c.counts->'progressed' AS progressed, c.counts->'seen' AS seen, c.counts->'inserted' AS inserted, c.counts->'duplicates' AS duplicates,
 c.counts->'kept_by_job_number' AS by_job_number, c.counts->'kept_by_builder_ref' AS by_builder_ref,
 c.counts->'kept_by_client_email' AS by_client_email, c.counts->'skipped_before_job' AS before_job,
 c.counts->'skipped_out_of_scope' AS out_of_scope, c.counts->'skipped_private' AS private,
 c.counts->'builder_ref_prefixes_floor_only' AS prefixes_floor_only
FROM (SELECT r.*, row_number() OVER (PARTITION BY r.source ORDER BY r.started_at DESC) AS n
      FROM public.context_capture_runs r WHERE r.source LIKE 'outlook\_deep\_history\_%') c
WHERE c.n<=3
ORDER BY c.source COLLATE "C", c.started_at DESC;
ROLLBACK;
