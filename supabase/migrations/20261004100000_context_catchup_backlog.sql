-- The backlog: a catch-up writer that reaches every job (4 Oct 2026).
--
-- The context system reads a job only when live evidence wakes it (captured
-- at or after live_since), or when it sits on the catch-up list
-- (20260924220000). That list has one writer, context_catchup_request, which
-- takes only live jobs (active statuses, or quoted in the last 60 days) with no
-- done read since live_since, and is one-time: a done job stays done. So no
-- switch reaches invoiced, complete, cancelled, archived, lost, older quoted or
-- draft jobs, a job whose rows were relinked onto it after its read
-- (20261002170100), or an open-invoice job whose only new rows are status-only
-- (status-only rows never wake a job). This migration adds a second writer for
-- the same list, by tier, so the existing reading worker works through every
-- job under its existing caps:
--
--   context_catchup_jobs      priority widened from 1..2 to 1..5 (the tier);
--                             mode 'full' (read every eligible row, the
--                             existing behaviour and the default) or 'unread'
--                             (read only rows never read for this job); scope
--                             'live_catchup' (the default, every existing row
--                             and every row context_catchup_request writes) or
--                             'backlog' (written by the new writer).
--   context_catchup_pending_rows  in mode 'unread' also leaves out rows that
--                             already carry a luna_v2 receipt for that job, so
--                             a job read since go-live re-reads only what it
--                             never read. Mode 'full' is unchanged.
--   context_catchup_request_backlog(p_tier, p_dry_run, p_limit)  the new
--                             writer, service role only, under the same
--                             advisory lock as context_catchup_request. Dry run
--                             by default: nothing written; counts by status,
--                             the job list (ids and numbers only) and the
--                             estimated runs.
--
-- Tiers. Every job is in exactly one tier, the first that fits, so tiers 1 to 5
-- together are every job in the system:
--   1  open money or relinked rows: a job with an open invoice (ACCREC,
--      AUTHORISED or SUBMITTED, amount_due > 0) that never had a done read, or
--      whose status is cancelled or archived; or a job holding a row stamped
--      metadata.placement_repaired (the payload-job repair moved it there).
--   2  work in hand: accepted, partially_accepted, scheduled, in_progress,
--      processing, approvals, order_materials, schedule_install,
--      awaiting_supplier, awaiting_deposit, final_payment, rectification,
--      invoiced, get_review.
--   3  sales: quoted, and draft with readable evidence in the last 90 days.
--   4  complete (or completed).
--   5  everything else: cancelled, archived, lost, drafts with no evidence in
--      90 days, and any other status.
-- Within the tier the writer picks extractable jobs (context_job_extractable's
-- rule, not held by metadata.do_not_schedule)
-- with readable rows (context_catchup_eligible_rows) and something to read:
--   never had a done extraction read  -> mode 'full', every eligible row;
--   read before                       -> mode 'unread', only admissible rows
--                                        with no luna_v2 receipt
--                                        (context_unread_rows, the one unread
--                                        definition).
-- A job already listed and not done keeps its row, mode and scope; its
-- priority is raised to the tier when the tier is more urgent and never
-- lowered. A done row is re-opened (done_at and done_run_id cleared,
-- requested_at now, mode 'unread', scope 'backlog', priority the tier) only
-- when it has unread rows. A job with nothing to read is never listed. p_limit
-- bounds the jobs one call writes; call again for the rest ('more').
--
-- Unchanged: context_catchup_request, context_jobs_cadence (a listed job is
-- due from its request time), the candidates order (live reads first, then
-- catch-up-only work by priority, so tier 1 before tier 5), the batch, flags,
-- done marker, status block, context_cadence_policy() and every cap number
-- (400 calls a day, 300 before noon, 60 attribution, 6 runs a job a day).
--
-- Stop the backlog at once (live reads and the original catch-up carry on):
--   delete from public.context_catchup_jobs where done_at is null and scope <> 'live_catchup';
-- Rollback: supabase/rollbacks/20261004100000_context_catchup_backlog_down.sql.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- 0. Pre-image guard. Reports every mismatch at once. The pending read must be
-- 20260924220000's (the repository body, or the earlier body that migration's
-- own guard also accepts) or this migration's; the writer must be absent or
-- this migration's; the list must be 20260924220000's table; the priority
-- check must be the 1..2 check or this migration's 1..5 check; mode and scope
-- must be absent or this migration's.
DO $guard$
DECLARE problems text[]:='{}'; live text; x record; checks text[];
BEGIN
 FOR x IN SELECT * FROM (VALUES
  ('public.context_catchup_pending_rows(uuid[])',ARRAY['153a4a0e10b566445a029f0785c096ff','a0e09f635eff10a48fa51b40aef5bafd','65f9a648e73e417df6ddb2f061160519'],false),
  ('public.context_catchup_request_backlog(integer,boolean,integer)',ARRAY['42a5f8384c70ef8b2bc1232ec128bfb2'],true)
 ) AS t(sig,accepted,may_be_absent) LOOP
  live:=NULL;
  SELECT md5(p.prosrc) INTO live FROM pg_proc p WHERE p.oid=to_regprocedure(x.sig);
  IF live IS NULL AND x.may_be_absent THEN CONTINUE; END IF;
  IF live IS NULL OR NOT live=ANY(x.accepted) THEN problems:=problems||format('%s md5 %s',x.sig,coalesce(live,'<missing>')); END IF;
 END LOOP;
 IF to_regclass('public.context_catchup_jobs') IS NULL OR NOT EXISTS(SELECT 1 FROM pg_description d
   WHERE d.objoid=to_regclass('public.context_catchup_jobs') AND d.classoid='pg_class'::regclass AND d.objsubid=0 AND d.description LIKE 'Catch-up:%')
 THEN problems:=problems||'public.context_catchup_jobs is missing or not 20260924220000''s'::text;
 ELSE
  SELECT array_agg(pg_get_constraintdef(c.oid) ORDER BY c.conname) INTO checks FROM pg_constraint c
   WHERE c.conrelid='public.context_catchup_jobs'::regclass AND c.contype='c'
    AND c.conkey=ARRAY[(SELECT a.attnum FROM pg_attribute a WHERE a.attrelid='public.context_catchup_jobs'::regclass AND a.attname='priority')];
  IF checks IS NULL OR cardinality(checks)<>1
   OR checks[1] NOT IN ('CHECK ((priority = ANY (ARRAY[1, 2])))','CHECK (((priority >= 1) AND (priority <= 5)))')
  THEN problems:=problems||format('context_catchup_jobs priority checks %s',coalesce(array_to_string(checks,' | '),'<none>')); END IF;
  IF EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid='public.context_catchup_jobs'::regclass AND a.attname IN ('mode','scope')
    AND a.attnum>0 AND NOT a.attisdropped
    AND NOT EXISTS(SELECT 1 FROM pg_description d WHERE d.objoid=a.attrelid AND d.classoid='pg_class'::regclass AND d.objsubid=a.attnum
     AND d.description LIKE 'Catch-up backlog (20261004100000):%'))
  THEN problems:=problems||'context_catchup_jobs has a mode or scope column that is not this migration''s'::text; END IF;
 END IF;
 IF cardinality(problems)>0 THEN
  RAISE EXCEPTION 'context_catchup_backlog_preimage_mismatch: %; read the live definitions before replacing them',array_to_string(problems,'; ');
 END IF;
END $guard$;

-- 1. The list: priority 1..5, mode and scope.
DO $$
DECLARE c record;
BEGIN
 FOR c IN SELECT conname FROM pg_constraint
  WHERE conrelid='public.context_catchup_jobs'::regclass AND contype='c'
   AND conkey=ARRAY[(SELECT a.attnum FROM pg_attribute a WHERE a.attrelid='public.context_catchup_jobs'::regclass AND a.attname='priority')]
 LOOP
  EXECUTE format('ALTER TABLE public.context_catchup_jobs DROP CONSTRAINT %I',c.conname);
 END LOOP;
END $$;
ALTER TABLE public.context_catchup_jobs ADD CONSTRAINT context_catchup_jobs_priority_check CHECK (priority BETWEEN 1 AND 5);
ALTER TABLE public.context_catchup_jobs
 ADD COLUMN IF NOT EXISTS mode text NOT NULL DEFAULT 'full' CONSTRAINT context_catchup_jobs_mode_check CHECK (mode IN ('full','unread')),
 ADD COLUMN IF NOT EXISTS scope text NOT NULL DEFAULT 'live_catchup' CONSTRAINT context_catchup_jobs_scope_check CHECK (scope IN ('live_catchup','backlog'));
COMMENT ON COLUMN public.context_catchup_jobs.mode IS
 'Catch-up backlog (20261004100000): full reads every eligible row on the job (earlier receipts or not); unread reads only rows with no luna_v2 receipt for the job.';
COMMENT ON COLUMN public.context_catchup_jobs.scope IS
 'Catch-up backlog (20261004100000): live_catchup for rows written by context_catchup_request (and every row before this migration); backlog for rows written or re-opened by context_catchup_request_backlog.';
COMMENT ON TABLE public.context_catchup_jobs IS
 'Catch-up: jobs to give a fresh read regardless of live_since (20260924220000). Written by context_catchup_request (scope live_catchup) and context_catchup_request_backlog (scope backlog, 20261004100000); priority 1..5, lower reads first; mode full or unread; done_at is set by the first done extraction run that leaves the job with no pending rows. Service role only.';

-- 2. The pending read: 20260924220000's body, plus mode 'unread' leaving out
-- rows already receipted for the job.
CREATE OR REPLACE FUNCTION public.context_catchup_pending_rows(p_job_ids uuid[]) RETURNS SETOF public.business_events
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT e.* FROM public.context_catchup_eligible_rows(p_job_ids) e
 JOIN public.context_catchup_jobs c ON c.job_id=e.job_id AND c.done_at IS NULL
 WHERE NOT EXISTS(SELECT 1 FROM public.context_catchup_reads r WHERE r.job_id=e.job_id AND r.event_id=e.id)
  AND (c.mode='full' OR NOT EXISTS(SELECT 1 FROM public.context_extraction_event_receipts x
   WHERE x.event_id=e.id AND x.job_id=e.job_id AND x.extractor_version='luna_v2'))
$$;
COMMENT ON FUNCTION public.context_catchup_pending_rows(uuid[]) IS
 'Catch-up: rows on listed, not-yet-done jobs that no catch-up read has covered; in mode full earlier receipts or not, in mode unread only rows with no luna_v2 receipt for the job (20261004100000). Service role only.';

-- 3. The backlog writer.
CREATE OR REPLACE FUNCTION public.context_catchup_request_backlog(p_tier integer,p_dry_run boolean DEFAULT true,p_limit integer DEFAULT 200)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE dry boolean:=coalesce(p_dry_run,true); lim integer:=coalesce(p_limit,200);
 judged jsonb; picked jsonb; summary jsonb; by_status jsonb;
 added integer:=0; reopened integer:=0; raised integer:=0;
BEGIN
 IF p_tier IS NULL OR p_tier NOT BETWEEN 1 AND 5 THEN RAISE EXCEPTION 'context_catchup_backlog_tier_invalid: tier must be 1 to 5'; END IF;
 IF lim NOT BETWEEN 1 AND 5000 THEN RAISE EXCEPTION 'context_catchup_backlog_limit_invalid: limit must be 1 to 5000'; END IF;
 PERFORM pg_advisory_xact_lock(20260924,22);

 -- Extractable is context_job_extractable's rule written inline, as
 -- context_jobs_cadence writes it: the function serialises the whole jobs row
 -- (scope_json included) and this read covers every job.
 -- Tier of every job (facts read once over the whole jobs table), then, per
 -- member of the requested tier, its readable rows, rows still to read in each
 -- mode, its list row and the action.
 WITH rd AS (
  SELECT r.job_id, max(r.finished_at) AS last_read FROM public.context_extraction_runs r
  WHERE r.job_id IS NOT NULL AND r.phase='extraction' AND r.status='done' GROUP BY r.job_id
 ), oi AS (
  SELECT DISTINCT x.job_id FROM public.xero_invoices x
  WHERE x.job_id IS NOT NULL AND x.invoice_type='ACCREC' AND x.status IN ('AUTHORISED','SUBMITTED') AND x.amount_due>0
 ), rp AS (
  SELECT DISTINCT e.job_id FROM public.business_events e WHERE e.job_id IS NOT NULL AND e.metadata ? 'placement_repaired'
 ), draft_recent AS (
  SELECT e.job_id FROM public.context_catchup_eligible_rows(ARRAY(SELECT j.id FROM public.jobs j WHERE j.status='draft')) e
  GROUP BY e.job_id HAVING max(coalesce(e.event_at,e.occurred_at))>now()-interval '90 days'
 ), member AS (
  SELECT f.* FROM (
   SELECT j.id, j.job_number, j.status, coalesce(j.metadata->>'do_not_schedule','') NOT IN ('true','1') AS extractable, rd.last_read,
    CASE
     WHEN rp.job_id IS NOT NULL OR (oi.job_id IS NOT NULL AND (rd.last_read IS NULL OR j.status IN ('cancelled','archived'))) THEN 1
     WHEN j.status IN ('accepted','partially_accepted','scheduled','in_progress','processing','approvals','order_materials',
       'schedule_install','awaiting_supplier','awaiting_deposit','final_payment','rectification','invoiced','get_review') THEN 2
     WHEN j.status='quoted' OR (j.status='draft' AND dr.job_id IS NOT NULL) THEN 3
     WHEN j.status IN ('complete','completed') THEN 4
     ELSE 5 END AS tier
   FROM public.jobs j LEFT JOIN rd ON rd.job_id=j.id LEFT JOIN oi ON oi.job_id=j.id
   LEFT JOIN rp ON rp.job_id=j.id LEFT JOIN draft_recent dr ON dr.job_id=j.id
  ) f WHERE f.tier=p_tier
 ), el AS (
  SELECT e.job_id, count(*) AS eligible_n, max(coalesce(e.event_at,e.occurred_at)) AS last_evidence_at,
   count(*) FILTER (WHERE NOT EXISTS(SELECT 1 FROM public.context_catchup_reads r WHERE r.job_id=e.job_id AND r.event_id=e.id)) AS full_n
  FROM public.context_catchup_eligible_rows(ARRAY(SELECT m.id FROM member m)) e GROUP BY e.job_id
 ), un AS (
  -- The one unread definition, less rows a catch-up read already covered.
  SELECT u.job_id, count(*) AS unread_n FROM public.context_unread_rows(ARRAY(SELECT m.id FROM member m)) u
  WHERE NOT EXISTS(SELECT 1 FROM public.context_catchup_reads r WHERE r.job_id=u.job_id AND r.event_id=u.id)
  GROUP BY u.job_id
 ), pe AS (
  SELECT p.job_id, count(*) AS pending_n FROM public.context_catchup_pending_rows(ARRAY(SELECT m.id FROM member m)) p GROUP BY p.job_id
 ), base AS (
  SELECT m.*, coalesce(el.eligible_n,0) AS eligible_n, el.last_evidence_at, coalesce(el.full_n,0) AS full_n,
   coalesce(un.unread_n,0) AS unread_n, coalesce(pe.pending_n,0) AS listed_pending_n,
   c.job_id IS NOT NULL AS listed, c.done_at IS NOT NULL AS was_done, c.priority AS old_priority, c.mode AS old_mode
  FROM member m LEFT JOIN el ON el.job_id=m.id LEFT JOIN un ON un.job_id=m.id LEFT JOIN pe ON pe.job_id=m.id
  LEFT JOIN public.context_catchup_jobs c ON c.job_id=m.id
 ), moded AS (
  -- Listed and not done: the row as it stands. Never read and not listed:
  -- full. Otherwise (read before, or a done row): unread.
  SELECT b.*,
   CASE WHEN b.listed AND NOT b.was_done THEN b.old_mode WHEN b.last_read IS NULL AND NOT b.listed THEN 'full' ELSE 'unread' END AS mode,
   CASE WHEN b.listed AND NOT b.was_done THEN b.listed_pending_n WHEN b.last_read IS NULL AND NOT b.listed THEN b.full_n ELSE b.unread_n END AS pending_n
  FROM base b
 )
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',d.id,'job_number',d.job_number,'status',d.status,'mode',d.mode,
   'pending_n',d.pending_n,'last_evidence_at',d.last_evidence_at,'action',CASE
   WHEN NOT d.extractable THEN 'holding_job'
   WHEN d.eligible_n=0 THEN 'no_evidence'
   WHEN d.listed AND NOT d.was_done AND p_tier<d.old_priority THEN 'raise'
   WHEN d.listed AND NOT d.was_done THEN 'already_listed'
   WHEN d.pending_n=0 THEN 'nothing_unread'
   WHEN d.listed THEN 'reopen'
   ELSE 'add' END)),'[]'::jsonb)
 INTO judged FROM moded d;

 SELECT coalesce(jsonb_agg(jsonb_build_object('job_id',x.id,'job_number',x.job_number,'status',x.status,'mode',x.mode,
   'action',x.action,'pending_rows',x.pending_n,'runs',ceil(x.pending_n/25.0)::integer) ORDER BY x.ord),'[]'::jsonb)
 INTO picked
 FROM (SELECT j.*, row_number() OVER (ORDER BY j.last_evidence_at DESC NULLS LAST, j.job_number, j.id) AS ord
  FROM jsonb_to_recordset(judged) AS j(id uuid,job_number text,status text,mode text,pending_n integer,last_evidence_at timestamptz,action text)
  WHERE j.action IN ('add','reopen','raise')) x
 WHERE x.ord<=lim;

 SELECT jsonb_build_object('tier_jobs',count(*),
   'candidates',count(*) FILTER (WHERE j.action IN ('add','reopen','raise')),
   'excluded',jsonb_build_object('holding_job',count(*) FILTER (WHERE j.action='holding_job'),
    'no_evidence',count(*) FILTER (WHERE j.action='no_evidence'),
    'nothing_unread',count(*) FILTER (WHERE j.action='nothing_unread')),
   'already_listed',jsonb_build_object('jobs',count(*) FILTER (WHERE j.action='already_listed'),
    'estimated_runs',coalesce(sum(ceil(j.pending_n/25.0)) FILTER (WHERE j.action='already_listed'),0)::integer))
 INTO summary FROM jsonb_to_recordset(judged) AS j(pending_n integer,action text);
 SELECT coalesce(jsonb_object_agg(s.status,jsonb_build_object('jobs',s.jobs,'picked',s.picked)),'{}'::jsonb) INTO by_status
 FROM (SELECT coalesce(j.status,'(none)') AS status, count(*) AS jobs, count(*) FILTER (WHERE j.action IN ('add','reopen','raise')) AS picked
  FROM jsonb_to_recordset(judged) AS j(status text,action text) GROUP BY 1) s;

 IF NOT dry THEN
  WITH src AS (SELECT (x->>'job_id')::uuid AS job_id, x->>'action' AS action, x->>'mode' AS mode FROM jsonb_array_elements(picked) x),
  ins AS (INSERT INTO public.context_catchup_jobs(job_id,job_number,priority,mode,scope)
   SELECT s.job_id, coalesce(j.job_number,''), p_tier, s.mode, 'backlog' FROM src s JOIN public.jobs j ON j.id=s.job_id WHERE s.action='add'
   ON CONFLICT (job_id) DO NOTHING RETURNING job_id),
  reo AS (UPDATE public.context_catchup_jobs c SET done_at=NULL,done_run_id=NULL,requested_at=now(),mode='unread',scope='backlog',priority=p_tier
   FROM src s WHERE c.job_id=s.job_id AND s.action='reopen' AND c.done_at IS NOT NULL RETURNING c.job_id),
  rai AS (UPDATE public.context_catchup_jobs c SET priority=p_tier
   FROM src s WHERE c.job_id=s.job_id AND s.action='raise' AND c.done_at IS NULL AND c.priority>p_tier RETURNING c.job_id)
  SELECT (SELECT count(*) FROM ins),(SELECT count(*) FROM reo),(SELECT count(*) FROM rai) INTO added, reopened, raised;
 END IF;

 RETURN jsonb_build_object('dry_run',dry,'as_of',now(),'tier',p_tier,'limit',lim)
  ||summary
  ||jsonb_build_object('by_status',by_status,
   'listed_this_call',jsonb_array_length(picked),
   'more',(summary->>'candidates')::integer-jsonb_array_length(picked),
   'by_action',jsonb_build_object(
    'add',(SELECT count(*) FROM jsonb_array_elements(picked) x WHERE x->>'action'='add'),
    'reopen',(SELECT count(*) FROM jsonb_array_elements(picked) x WHERE x->>'action'='reopen'),
    'raise',(SELECT count(*) FROM jsonb_array_elements(picked) x WHERE x->>'action'='raise')),
   'estimated_runs',(SELECT coalesce(sum((x->>'runs')::integer) FILTER (WHERE x->>'action'<>'raise'),0) FROM jsonb_array_elements(picked) x),
   'jobs',picked,
   'written',CASE WHEN dry THEN NULL ELSE jsonb_build_object('added',added,'reopened',reopened,'priority_raised',raised) END);
END $$;
COMMENT ON FUNCTION public.context_catchup_request_backlog(integer,boolean,integer) IS
 'Catch-up backlog (20261004100000): list one tier (1 open money or relinked rows, 2 work in hand, 3 quoted and recent drafts, 4 complete, 5 everything else) for a fresh read through the normal worker and caps. Never-read jobs read in full, read jobs only their unread rows; a done row is re-opened only with unread rows; a pending row is never lowered. Dry run (the default) returns counts by status, the job list (ids and numbers only) and estimated runs without writing. Service role only.';

-- 4. Grants: service role only.
REVOKE ALL ON FUNCTION public.context_catchup_request_backlog(integer,boolean,integer),public.context_catchup_pending_rows(uuid[]) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.context_catchup_request_backlog(integer,boolean,integer),public.context_catchup_pending_rows(uuid[]) TO service_role;
