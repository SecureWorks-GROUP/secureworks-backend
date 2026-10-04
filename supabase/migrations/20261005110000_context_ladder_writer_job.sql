-- Ladder L1e: a job the writer named stays with its record, a payload job the
-- writer called a guess is not trusted, and turning the rules on keeps custody.
--
-- Why (scout report cio-ctx-linking, 4 Oct 2026): four writers name the job a
-- record belongs to but set no match_method: the xero payment trigger
-- (fn_payment_detected, invoice.paid), ops-api log_business_event (source
-- mcp_agent), the Jarvis event listener (graf_event_listener) and the patio
-- tool. The ladder trusts a writer's job only with direct_job_id,
-- direct_reference or manual, so it moved each of these jobs into
-- metadata.attribution_hint and, the rows having no words, stopped at empty
-- with no job: about 2,200 rows in 30 days sat on no job although their
-- writer knew it. The patio tool writes with the public key and keeps its job
-- only in payload.job_id; a public-key writer must never pin a row to a job,
-- so it is not covered here (closing the public grant on business_events
-- stops that writer; its past rows are in the separate relink).
-- Two risks found on the way are fixed in the same pass:
-- F6, with context_unlinked_rules_v1 on, a row with no words (or an
-- automated row) lost even a custody job; F5, step 1b (20261003100000)
-- placed a row on its payload.job_id as certain, but the Jarvis SMS cache
-- backfill writes there its guess (the contact's newest job, closed and
-- archived jobs included).
--
-- Changed, on both paths of the one ladder (rules off, the live path while
-- context_unlinked_rules_v1 is off, and rules on):
--   1. Writer job. A row whose writer is the service role (metadata.written_as,
--      stamped by the insert trigger from the request role) and which names a
--      job with no match_method (null or none) keeps that job when the row is
--      never read: a row with no words (status empty), a system or audit row
--      and an automated row (status automated). metadata.placement_rule
--      writer_job; the job must exist and not be holding. A worded row keeps
--      today's behaviour: the job stays a hint and the ladder decides from the
--      words and the contact, because a worded row is what the reader takes as
--      the customer's or our words, and some null-method writers name a job
--      the model or a contact lookup chose (Jarvis mcp tools such as
--      sw_send_sms pass an unchecked job to log_business_event). Any other
--      writer (the public key, a signed-in login) gets nothing new.
--   2. F6 (rules on). A row with no words and an automated row keep the job
--      custody proved, as the rules-off path always has. Nothing else in the
--      rules-on path changes, and the flag stays off.
--   3. F5 (step 1b). A payload.job_id the writer itself declared a guess is
--      not the source's own job: source or payload.source
--      ghl_sms_cache_backfill, or a payload.attribution_hint naming the same
--      job with a method other than direct_job_id, direct_reference or manual.
--      The row goes on to the reference, thread and contact rules and carries
--      metadata.payload_job_guess true. Such a row placed by a contact rule on
--      a job other than its payload job stays placed but is still not read
--      (the revision store refuses a row whose payload names another job,
--      20261002170000); the Jarvis writer moving its guess out of
--      payload.job_id is the follow-up that makes it readable.
--   4. The payload-job repair (20261002170100) classes such a row
--      payload_job_guess and never repoints it onto the guessed job.
-- Not changed: the entry, the insert trigger, the L1d rules (crew and staff
-- recipients, references to a non-customer), custody, references, threads,
-- contact rules, Luna, reconsideration, capture_business_event and the
-- readers. No existing row is written: rows change only when inserted or
-- re-decided. The relink of rows already stripped is a separate, reviewed
-- script run by hand after its dry run.
--
-- New private helpers, plain SQL, no SET clause: context_event_writer_job(e),
-- context_payload_job_is_guess(e).
--
-- Replaces (built on the bodies merged on main):
--   context_ladder_p1a(business_events,boolean)                    L1d (20261005090000) md5(prosrc) e11321e9d986be1e83f05e95f3efc36c
--   resolve_context_attribution(business_events,boolean,boolean)   L1d (20261005090000) md5(prosrc) 90c038b5f48677af4598e475e2583572
--   context_payload_job_mismatch_rows()                            20261002170100 md5(prosrc) 3c7759191b5f51dfeaabab87ae2c4cdb
-- Read, not replaced: resolve_context_attribution(business_events) 32365101 (P4),
--   attribute_business_event() d0036a1b (P4), context_payload_job_repair(boolean,integer)
--   db041256 (20261002170100), context_ref_recipient_is_customer(business_events,uuid)
--   18904e54 (L1c),
--   context_internal_text_role(business_events) e7327d10 (L1d),
--   context_internal_about_job(business_events) aa53618f (L1d).
-- The guard refuses unless each replaced body is the one above (or already
-- this migration's, for a re-apply). The two ladder bodies carry an "L1e:"
-- comment, so a re-apply of L1d over them refuses rather than silently
-- removing these rules.
-- Rollback: supabase/rollbacks/20261005110000_context_ladder_writer_job_down.sql
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- 0. Pre-image guard. Reports every problem at once.
DO $guard$
DECLARE problems text[]:='{}'; live text; x record;
BEGIN
 FOR x IN SELECT * FROM (VALUES
  -- Replaced: the predecessor's body, or this migration's.
  ('public.resolve_context_attribution(public.business_events,boolean,boolean)',ARRAY['90c038b5f48677af4598e475e2583572','a9b163a19a804750dc48fe20eb2f6801'],false),
  ('public.context_ladder_p1a(public.business_events,boolean)',ARRAY['e11321e9d986be1e83f05e95f3efc36c','cfcf68a7d83f9c76aa369398a1a4d76e'],false),
  ('public.context_payload_job_mismatch_rows()',ARRAY['3c7759191b5f51dfeaabab87ae2c4cdb','69d68f016116576e6b6c8c773de8752e'],false),
  -- New: absent, or already this migration's.
  ('public.context_event_writer_job(public.business_events)',ARRAY['cd36b092818e7607d114d1b3011b3bfd'],true),
  ('public.context_payload_job_is_guess(public.business_events)',ARRAY['1c87d88718cf014429170e3f1aaaa2aa'],true),
  -- Read, not replaced.
  ('public.resolve_context_attribution(public.business_events)',ARRAY['32365101d23dde1695707a0bddff640b'],false),
  ('public.attribute_business_event()',ARRAY['d0036a1bc36f4b2a779f4a8b192cd687'],false),
  ('public.context_payload_job_repair(boolean,integer)',ARRAY['db0412566058df9e27a070472abb5482'],false),
  ('public.context_ref_recipient_is_customer(public.business_events,uuid)',ARRAY['18904e5439afd9c23e59e97f200d256e'],false),
  ('public.context_internal_text_role(public.business_events)',ARRAY['e7327d108966e2bcb9d2eb48e3086a55'],false),
  ('public.context_internal_about_job(public.business_events)',ARRAY['aa53618f6c82998a821b8f7439c75e60'],false)
 ) AS t(sig,accepted,may_be_absent) LOOP
  live:=NULL;
  SELECT md5(p.prosrc) INTO live FROM pg_proc p WHERE p.oid=to_regprocedure(x.sig);
  IF live IS NULL AND x.may_be_absent THEN CONTINUE; END IF;
  IF live IS NULL OR NOT live=ANY(x.accepted) THEN problems:=problems||format('%s md5 %s',x.sig,coalesce(live,'<missing>')); END IF;
 END LOOP;
 FOR x IN SELECT * FROM (VALUES
  ('jobs','id','uuid'),('jobs','metadata','jsonb'),('business_events','job_id','uuid'),('business_events','match_method','text'),
  ('business_events','source','text'),('business_events','payload','jsonb'),('business_events','metadata','jsonb')
 ) AS c(tbl,col,typ) LOOP
  live:=NULL;
  SELECT format_type(a.atttypid,a.atttypmod) INTO live FROM pg_attribute a
  WHERE a.attrelid=to_regclass('public.'||x.tbl) AND a.attname=x.col AND a.attnum>0 AND NOT a.attisdropped;
  IF live IS DISTINCT FROM x.typ THEN problems:=problems||format('%s.%s is %s, expected %s',x.tbl,x.col,coalesce(live,'<missing>'),x.typ); END IF;
 END LOOP;
 IF cardinality(problems)>0 THEN
  RAISE EXCEPTION 'context_ladder_writer_job_preimage_mismatch: %; read the live definitions before replacing them',array_to_string(problems,'; ');
 END IF;
END $guard$;

-- 1. The job a service-role writer named with no match_method, when it is a
-- job that is not holding; null otherwise. Read by both ladder paths only for
-- a row the reader never reads (no words, system, automated).
CREATE OR REPLACE FUNCTION public.context_event_writer_job(e public.business_events) RETURNS uuid
LANGUAGE sql STABLE AS $$
 SELECT j.id FROM public.jobs j
 WHERE j.id=e.job_id
  AND coalesce(nullif(btrim(e.match_method),''),'none')='none'
  AND e.metadata->>'written_as'='service_role'
  AND coalesce(j.metadata->>'do_not_schedule','') NOT IN ('true','1')
$$;
COMMENT ON FUNCTION public.context_event_writer_job(public.business_events) IS
 'L1e: the job a service-role writer (metadata.written_as) named on the row with no match_method (null or none), if it exists and is not holding; null otherwise (20261005110000). Kept by the ladder only on a row with no words, a system or audit row and an automated row. Private; read by the ladder.';

-- 2. Did the writer itself call its payload.job_id a guess? True for the
-- Jarvis SMS cache backfill (source or payload.source ghl_sms_cache_backfill)
-- and for any payload whose attribution_hint names the same job with a method
-- other than direct_job_id, direct_reference or manual.
CREATE OR REPLACE FUNCTION public.context_payload_job_is_guess(e public.business_events) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
 SELECT coalesce(e.payload#>>'{job_id}' IS NOT NULL AND (
   e.source='ghl_sms_cache_backfill' OR e.payload->>'source'='ghl_sms_cache_backfill'
   OR (e.payload#>>'{attribution_hint,job_id}'=e.payload#>>'{job_id}'
    AND coalesce(nullif(e.payload#>>'{attribution_hint,match_method}',''),'none') NOT IN ('direct_job_id','direct_reference','manual'))),
  false)
$$;
COMMENT ON FUNCTION public.context_payload_job_is_guess(public.business_events) IS
 'L1e: true when the writer declared its payload.job_id a guess: source or payload.source ghl_sms_cache_backfill, or payload.attribution_hint naming the same job with a method other than direct_job_id, direct_reference or manual (20261005110000). Step 1b skips such a payload job; the payload-job repair never repoints onto it. Private; read by the ladder and the repair classifier.';

-- 3. Rules off: L1d's body plus the writer job and the guess check.
CREATE OR REPLACE FUNCTION public.context_ladder_p1a(e public.business_events,p_preview boolean) RETURNS public.business_events
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE words text; tokens text; ids uuid[]; candidate uuid; n int; line text; contact_ids text[]; prior_status text; source_method text;
 v_at timestamptz; is_ghl boolean; line_ids uuid[]; guard_ids uuid[]; contactless_ids uuid[]; used_updated_at boolean; rule text; irole text;
 writer_job uuid;
BEGIN
 prior_status:=e.attribution_status;
 source_method:=e.match_method;
 IF e.job_id IS NOT NULL AND source_method IN ('direct_job_id','direct_reference','manual') THEN
   e.metadata:=coalesce(e.metadata,'{}'::jsonb)||jsonb_build_object('source_job_binding',jsonb_build_object('job_id',e.job_id,'match_method',source_method));
 ELSIF e.job_id IS NULL AND e.metadata->'source_job_binding'->>'match_method' IN ('direct_job_id','direct_reference','manual') THEN
   SELECT id INTO e.job_id FROM public.jobs WHERE id::text=e.metadata->'source_job_binding'->>'job_id';
   source_method:=e.metadata->'source_job_binding'->>'match_method';
 END IF;
 IF e.job_id IS NOT NULL AND coalesce(source_method,'none') NOT IN ('direct_job_id','direct_reference','manual') THEN
   -- L1e (20261005110000): a job the service role named without saying how
   -- (no match_method) is kept for a row the reader never reads.
   writer_job:=public.context_event_writer_job(e);
   e.metadata:=coalesce(e.metadata,'{}'::jsonb)||jsonb_build_object('attribution_hint',jsonb_build_object('job_id',e.job_id,'match_method',source_method,'match_confidence',e.match_confidence));
   e.job_id:=NULL;
 END IF;
 e.attribution_checked_at:=clock_timestamp();
 words:=public.context_event_text(e);
 e.attribution_status:='admin_bucket'; e.attribution_step:=6;
 e.attribution_confidence:=NULL; e.attributed_at:=NULL;
 e.match_status:='unresolved'; e.match_method:='none'; e.match_confidence:=NULL;
 e.candidate_job_ids:=NULL;
 IF e.metadata ?| ARRAY['placement_rule','placement_contactless_job_ids','placement_guard_job_ids','payload_job_guess'] THEN
  e.metadata:=e.metadata-'placement_rule'-'placement_contactless_job_ids'-'placement_guard_job_ids'-'payload_job_guess';
 END IF;
 IF e.payload ? 'terminal_time_source' THEN e.payload:=e.payload-'terminal_time_source'; END IF;
 IF NOT public.automation_lane_enabled('attribution') THEN e.job_id:=NULL; RETURN e; END IF;
 IF to_jsonb(e)->>'channel' IN ('system','audit') THEN e.attribution_status:='automated';
  IF writer_job IS NOT NULL THEN e.job_id:=writer_job; e.metadata:=coalesce(e.metadata,'{}'::jsonb)||jsonb_build_object('placement_rule','writer_job'); END IF;
  RETURN e;
 END IF;
 IF btrim(words)='' THEN e.attribution_status:='empty';
  IF writer_job IS NOT NULL THEN e.job_id:=writer_job; e.metadata:=coalesce(e.metadata,'{}'::jsonb)||jsonb_build_object('placement_rule','writer_job'); END IF;
  RETURN e;
 END IF;
 -- L1d (20261005090000): a text our own tool sent to crew or staff (writer
 -- marker metadata.recipient_role crew or staff on an outbound row written by
 -- the service role) is internal job communication, never a customer
 -- message. It stays ON the job it is about (metadata.about_job_id, else the
 -- one job its words name): direct, step 1, placement_rule
 -- internal_recipient, audience internal, recipient_role_source writer,
 -- match_method about_job_id or ladder_ref. It binds no thread. With no such
 -- job it rests off every job as automated, still labelled.
 IF e.direction='outbound' AND e.metadata->>'recipient_role' IN ('crew','staff') AND e.metadata->>'written_as'='service_role' THEN
  e.metadata:=coalesce(e.metadata,'{}'::jsonb)||jsonb_build_object('placement_rule','internal_recipient','audience','internal','recipient_role_source','writer');
  SELECT a.job_id,a.match_method INTO e.job_id,e.match_method FROM public.context_internal_about_job(e) a;
  IF e.job_id IS NULL THEN e.attribution_status:='automated'; e.match_method:='none'; RETURN e; END IF;
  e.attribution_status:='direct'; e.attribution_step:=1; e.attribution_confidence:=1; e.attributed_at:=clock_timestamp();
  e.match_status:='matched'; e.match_confidence:=1;
  RETURN e;
 END IF;
 IF prior_status='automated' OR e.payload->>'automated'='true' OR e.payload->>'auto_submitted' IN ('auto-generated','auto-replied')
 THEN e.attribution_status:='automated';
  IF writer_job IS NOT NULL THEN e.job_id:=writer_job; e.metadata:=coalesce(e.metadata,'{}'::jsonb)||jsonb_build_object('placement_rule','writer_job'); END IF;
  RETURN e;
 END IF;
 is_ghl:=public.context_event_is_ghl(e);
 SELECT id INTO candidate FROM public.jobs WHERE id=e.job_id;
 -- 1b. The source's own job (20261003100000), as in the rules-on ladder: a
 -- payload.job_id that is the exact id text of a job that is not holding is
 -- the candidate (direct, step 1); one that names no such job rests the row
 -- in the bucket (payload_job_unbindable), never on another job.
 -- L1e (20261005110000): a payload job its writer declared a guess (the SMS
 -- cache backfill's newest job of the contact) is not the source's own job;
 -- the row goes on to the reference and contact rules.
 IF candidate IS NULL AND public.context_payload_job_is_guess(e) THEN
  e.metadata:=coalesce(e.metadata,'{}'::jsonb)||jsonb_build_object('payload_job_guess',true);
 ELSIF candidate IS NULL AND e.payload#>>'{job_id}' IS NOT NULL THEN
  IF e.payload#>>'{job_id}' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
   SELECT j.id INTO candidate FROM public.jobs j WHERE j.id=(e.payload#>>'{job_id}')::uuid
    AND coalesce(j.metadata->>'do_not_schedule','') NOT IN ('true','1');
  END IF;
  IF candidate IS NULL THEN
   e.job_id:=NULL;
   e.metadata:=coalesce(e.metadata,'{}'::jsonb)||jsonb_build_object('bucket_reason','payload_job_unbindable','placement_rule','payload_job_unbindable');
   RETURN e;
  END IF;
  e.metadata:=coalesce(e.metadata,'{}'::jsonb)||jsonb_build_object('placement_rule','payload_job');
 END IF;
 IF candidate IS NULL THEN
   tokens:=' '||upper(regexp_replace(words,'[^a-zA-Z0-9-]+',' ','g'))||' ';
   SELECT array_agg(DISTINCT refs.job_id) INTO ids FROM (
     SELECT j.id AS job_id FROM public.jobs j WHERE length(btrim(j.job_number))>=5
      AND strpos(tokens,' '||upper(j.job_number)||' ')>0
     UNION SELECT x.job_id FROM public.xero_invoices x WHERE x.job_id IS NOT NULL
      AND x.invoice_type='ACCREC' AND upper(x.invoice_number) LIKE 'INV-%' AND length(btrim(x.invoice_number))>=5
      AND strpos(tokens,' '||upper(x.invoice_number)||' ')>0
     UNION SELECT po.job_id FROM public.purchase_orders po WHERE po.job_id IS NOT NULL AND length(btrim(po.po_number))>=5
      AND strpos(tokens,' '||upper(po.po_number)||' ')>0
   ) refs JOIN public.jobs ref_job ON ref_job.id=refs.job_id
   WHERE coalesce(to_jsonb(ref_job)->'metadata'->>'do_not_schedule','') NOT IN ('true','1');
   IF cardinality(ids)=1 THEN candidate:=ids[1];
   ELSIF cardinality(ids)>1 THEN e.job_id:=NULL; RETURN e; END IF;
   -- L1d (20261005090000): a reference alone never makes an outbound row to
   -- a known contact who is not that job's customer (nor a party on it) a
   -- message to the customer. It stays ON the job as internal communication
   -- (direct, step 1, match_method ladder_ref, placement_rule internal_ref),
   -- labelled with who it went to: recipient_role crew or staff when its
   -- words are one of our crew or staff templates (recipient_role_source
   -- wording, audience internal), else other (recipient_role_source contact,
   -- audience other_party). It binds no thread.
   IF candidate IS NOT NULL AND NOT public.context_ref_recipient_is_customer(e,candidate) THEN
    irole:=public.context_internal_text_role(e);
    e.job_id:=candidate; e.attribution_status:='direct'; e.attribution_step:=1;
    e.attribution_confidence:=1; e.attributed_at:=clock_timestamp();
    e.match_status:='matched'; e.match_method:='ladder_ref'; e.match_confidence:=1;
    e.metadata:=coalesce(e.metadata,'{}'::jsonb)||jsonb_build_object('placement_rule','internal_ref','recipient_role',irole,
     'recipient_role_source',CASE WHEN irole='other' THEN 'contact' ELSE 'wording' END,'audience',CASE WHEN irole='other' THEN 'other_party' ELSE 'internal' END);
    RETURN e;
   END IF;
 END IF;
 IF candidate IS NOT NULL THEN e.attribution_status:='direct'; e.attribution_step:=1;
 ELSE
  IF NOT is_ghl THEN
   SELECT job_id INTO candidate FROM public.event_threads WHERE thread_key=e.thread_key AND retired_at IS NULL;
  END IF;
  IF candidate IS NOT NULL THEN e.attribution_status:='thread'; e.attribution_step:=2;
  ELSE
   IF e.contact_id IS NULL THEN
    SELECT array_agg(DISTINCT j.ghl_contact_id) INTO contact_ids FROM public.jobs j
    WHERE j.ghl_contact_id IS NOT NULL AND (
      (nullif(e.payload->>'email','') IS NOT NULL AND lower(to_jsonb(j)->>'client_email')=lower(e.payload->>'email')) OR
      (length(regexp_replace(coalesce(e.payload->>'phone',''),'[^0-9]','','g'))>=8 AND
       right(regexp_replace(coalesce(to_jsonb(j)->>'client_phone',to_jsonb(j)->>'phone',''),'[^0-9]','','g'),9)=right(regexp_replace(e.payload->>'phone','[^0-9]','','g'),9)));
    IF cardinality(contact_ids)=1 THEN e.contact_id:=contact_ids[1]; END IF;
   END IF;
   v_at:=coalesce(e.event_at,e.occurred_at,clock_timestamp());
   line:=lower(coalesce(e.payload->>'line',e.payload->>'business_line',''));
   SELECT coalesce(array_agg(t.job_id ORDER BY t.created_at,t.job_id) FILTER (WHERE t.candidate),'{}'),
    coalesce(array_agg(t.job_id ORDER BY t.created_at,t.job_id) FILTER (WHERE t.candidate AND t.type=line AND line IN ('fencing','patio')),'{}'),
    coalesce(array_agg(t.job_id ORDER BY t.terminal_at DESC,t.job_id) FILTER (WHERE NOT t.candidate AND t.terminal
     AND t.created_at<=v_at AND t.terminal_at<=v_at AND t.terminal_at>=v_at-interval '90 days'),'{}'),
    coalesce(array_agg(t.job_id ORDER BY t.job_id) FILTER (WHERE t.basis='contactless' AND (t.candidate OR (NOT t.candidate AND t.terminal
     AND t.created_at<=v_at AND t.terminal_at<=v_at AND t.terminal_at>=v_at-interval '90 days'))),'{}'),
    coalesce(bool_or(t.terminal_time_source='updated_at' AND (t.candidate OR (NOT t.candidate AND t.terminal
     AND t.created_at<=v_at AND t.terminal_at<=v_at AND t.terminal_at>=v_at-interval '90 days'))),false)
   INTO ids,line_ids,guard_ids,contactless_ids,used_updated_at
   FROM public.context_contact_job_timeline(e.contact_id,v_at) t;
   n:=cardinality(ids);
   IF n=1 AND cardinality(guard_ids)=0 THEN
    candidate:=ids[1]; e.attribution_status:='single_open'; e.attribution_step:=3; rule:='single_open';
   ELSIF n=1 THEN
    e.attribution_status:='pending_luna'; e.attribution_step:=5; rule:='review_recent_other_job';
    e.candidate_job_ids:=ids||guard_ids;
   ELSIF n>1 AND cardinality(line_ids)=1 THEN
    candidate:=line_ids[1]; e.attribution_status:='single_line'; e.attribution_step:=4; rule:='single_line';
   ELSIF n>1 THEN
    e.attribution_status:='pending_luna'; e.attribution_step:=5; rule:='review_several';
    e.candidate_job_ids:=ids;
   ELSE
    rule:=CASE WHEN e.contact_id IS NULL THEN 'no_contact' ELSE 'no_candidate_at_time' END;
   END IF;
   e.metadata:=coalesce(e.metadata,'{}'::jsonb)||jsonb_build_object('placement_rule',rule);
   IF cardinality(contactless_ids)>0 THEN
    e.metadata:=e.metadata||jsonb_build_object('placement_contactless_job_ids',to_jsonb(contactless_ids));
   END IF;
   IF rule='review_recent_other_job' THEN
    e.metadata:=e.metadata||jsonb_build_object('placement_guard_job_ids',to_jsonb(guard_ids));
   END IF;
   IF used_updated_at THEN e.payload:=coalesce(e.payload,'{}'::jsonb)||jsonb_build_object('terminal_time_source','updated_at'); END IF;
  END IF;
 END IF;
 e.job_id:=candidate;
 IF candidate IS NOT NULL THEN
  IF nullif(e.thread_key,'') IS NOT NULL AND NOT is_ghl THEN
   IF NOT p_preview THEN
    INSERT INTO public.event_threads(thread_key,job_id,bound_by,source_event_id) VALUES(e.thread_key,candidate,'ladder',e.id) ON CONFLICT DO NOTHING;
   END IF;
   IF EXISTS (SELECT 1 FROM public.event_threads WHERE thread_key=e.thread_key AND job_id<>candidate) THEN
    e.job_id:=NULL; e.attribution_status:='admin_bucket'; e.attribution_step:=6;
    e.payload:=coalesce(e.payload,'{}')||jsonb_build_object('attribution_error','thread_conflict'); RETURN e;
   END IF;
  END IF;
  e.attribution_confidence:=1; e.attributed_at:=clock_timestamp();
  e.match_status:='matched'; e.match_method:=CASE WHEN e.attribution_status='direct' THEN 'direct_job_id' ELSE 'contact_id' END; e.match_confidence:=1;
 ELSE e.match_status:='unresolved'; e.match_method:='none'; e.match_confidence:=NULL;
 END IF;
 RETURN e;
EXCEPTION WHEN OTHERS THEN
 e.job_id:=NULL; e.attribution_status:='admin_bucket'; e.attribution_step:=6;
 e.attribution_confidence:=NULL; e.attributed_at:=NULL; e.candidate_job_ids:=NULL;
 e.match_status:='unresolved'; e.match_method:='none'; e.match_confidence:=NULL;
 e.payload:=coalesce(e.payload,'{}')||jsonb_build_object('attribution_error',SQLERRM);
 RETURN e;
END $$;
COMMENT ON FUNCTION public.context_ladder_p1a(public.business_events,boolean) IS
 'L1e: P1a''s ladder (P4''s copy, run while context_unlinked_rules_v1 is off) as L1d left it (20261005090000: step 1b and the crew and staff rules) plus L1e (20261005110000): a service-role row naming a job with no match_method keeps it when it has no words, is a system row or is automated (placement_rule writer_job); a payload job its writer declared a guess (context_payload_job_is_guess) is skipped by step 1b (payload_job_guess). In preview it writes no thread binding. Private; call resolve_context_attribution.';

-- 4. Rules on: L1d's body plus F6, the writer job and the guess check.
CREATE OR REPLACE FUNCTION public.resolve_context_attribution(e public.business_events,p_preview boolean,p_rules_on boolean)
RETURNS public.business_events
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
 rules_on boolean; words text; subj text; prior_status text; source_method text; writer text;
 v_at timestamptz; is_ghl boolean; v_mode text; ek text; pk text; contact text; n_contacts int; by_key text;
 toks text[]; ref_ids uuid[]; found_toks text[]; unfound text[]; cand uuid; rule text; custody boolean:=false;
 b public.event_threads; sk text; order_toks text[]; tok text; live_ids uuid[]; retired_ids uuid[];
 ids uuid[]; line text; line_ids uuid[]; guard_ids uuid[]; contactless_ids uuid[]; other_ids uuid[]; used_updated_at boolean;
 unpaid_ids uuid[]; window_ids uuid[]; review_ids uuid[]; n int; irole text;
 site_text text; exact_keys text[]; loose_keys text[]; exact_ids uuid[]; loose_ids uuid[]; bindings jsonb:='[]'; conflicts jsonb:='[]';
 owned_keys constant text[]:=ARRAY['payload_job_guess','placement_rule','placement_contactless_job_ids','placement_guard_job_ids','placement_other_contact_job_ids',
  'bucket_reason','ref_not_found','ref_job_ids','identity_conflict','contact_recovered_by','writer_unknown','custody_rescan',
  'placement_site_keys','placement_retired_binding','placement_preview_bindings','supplier_ref_conflicts','aftercare_unpaid_job_ids',
  'audience','recipient_role_source'];
 writer_job uuid;
BEGIN
 rules_on:=coalesce(p_rules_on,public.context_unlinked_rules_enabled());
 p_preview:=coalesce(p_preview,false);
 -- L1d (20261005090000): a recipient role the ladder derived (from the words
 -- or the contact) is derived again on every decision; a writer's is kept.
 IF e.metadata->>'recipient_role_source' IN ('wording','contact') THEN e.metadata:=e.metadata-'recipient_role'; END IF;
 IF e.metadata ?| owned_keys THEN e.metadata:=e.metadata-owned_keys; END IF;
 IF NOT rules_on THEN
  e:=public.context_ladder_p1a(e,p_preview);
 ELSE
  <<rules>>
  BEGIN
   prior_status:=e.attribution_status;
   source_method:=e.match_method;
   IF e.job_id IS NOT NULL THEN
    IF e.metadata->'source_job_binding'->>'job_id'=e.job_id::text
     AND e.metadata->'source_job_binding'->>'match_method' IN ('direct_job_id','direct_reference','manual') THEN
     source_method:=e.metadata->'source_job_binding'->>'match_method';
    ELSE
     -- L1e (20261005110000): a job the service role named without saying how
     -- (no match_method) is kept for a row the reader never reads.
     writer_job:=public.context_event_writer_job(e);
     e.metadata:=coalesce(e.metadata,'{}'::jsonb)-'source_job_binding';
     e.metadata:=coalesce(e.metadata,'{}'::jsonb)||jsonb_build_object('attribution_hint',jsonb_build_object('job_id',e.job_id,'match_method',source_method,'match_confidence',e.match_confidence));
     e.job_id:=NULL;
     source_method:=NULL;
    END IF;
   ELSIF e.metadata->'source_job_binding'->>'match_method' IN ('direct_job_id','direct_reference','manual') THEN
    SELECT id INTO e.job_id FROM public.jobs WHERE id::text=e.metadata->'source_job_binding'->>'job_id';
    IF FOUND THEN source_method:=e.metadata->'source_job_binding'->>'match_method';
    ELSE e.metadata:=e.metadata-'source_job_binding'; source_method:=NULL;
    END IF;
   ELSE
    e.metadata:=coalesce(e.metadata,'{}'::jsonb)-'source_job_binding';
   END IF;
   e.attribution_checked_at:=clock_timestamp();
   words:=public.context_bucket_text(e);
   subj:=coalesce(nullif(btrim(e.payload->>'subject'),''),substring(public.context_event_text(e) from '^Subject: ([^\r\n]*)'));
   e.attribution_status:='admin_bucket'; e.attribution_step:=6;
   e.attribution_confidence:=NULL; e.attributed_at:=NULL;
   e.match_status:='unresolved'; e.match_method:='none'; e.match_confidence:=NULL;
   e.candidate_job_ids:=NULL;
   IF e.payload ? 'terminal_time_source' THEN e.payload:=e.payload-'terminal_time_source'; END IF;
   IF NOT public.automation_lane_enabled('attribution') THEN e.job_id:=NULL; EXIT rules; END IF;
   -- 0. Writer check (X16, X36).
   writer:=e.metadata->>'written_as';
   IF writer IS NULL THEN
    e.metadata:=coalesce(e.metadata,'{}'::jsonb)||jsonb_build_object('writer_unknown',true);
   ELSIF writer<>'service_role' THEN
    IF e.job_id IS NOT NULL THEN
     e.metadata:=e.metadata||jsonb_build_object('attribution_hint',jsonb_build_object('job_id',e.job_id,'match_method',source_method,'match_confidence',e.match_confidence));
     e.job_id:=NULL;
    END IF;
    e.metadata:=e.metadata||jsonb_build_object('bucket_reason','unverified_writer','placement_rule','unverified_writer');
    EXIT rules;
   END IF;
   -- L1e (20261005110000): a row with no words, a system row and an automated
   -- row keep the job custody proved (as with the rules off) and the job the
   -- service role named; none of them is ever read.
   IF to_jsonb(e)->>'channel' IN ('system','audit') THEN e.attribution_status:='automated';
    IF writer_job IS NOT NULL AND e.job_id IS NULL THEN e.job_id:=writer_job; e.metadata:=e.metadata||jsonb_build_object('placement_rule','writer_job'); END IF;
    EXIT rules;
   END IF;
   IF btrim(words)='' THEN e.attribution_status:='empty';
    IF writer_job IS NOT NULL AND e.job_id IS NULL THEN e.job_id:=writer_job; e.metadata:=e.metadata||jsonb_build_object('placement_rule','writer_job'); END IF;
    EXIT rules;
   END IF;
   -- L1d (20261005090000): a text our own tool sent to crew or staff is
   -- internal job communication on the job it is about (internal_recipient),
   -- as on the rules-off path.
   IF e.direction='outbound' AND e.metadata->>'recipient_role' IN ('crew','staff') AND e.metadata->>'written_as'='service_role' THEN
    e.metadata:=e.metadata||jsonb_build_object('placement_rule','internal_recipient','audience','internal','recipient_role_source','writer');
    SELECT a.job_id,a.match_method INTO e.job_id,e.match_method FROM public.context_internal_about_job(e) a;
    IF e.job_id IS NULL THEN e.attribution_status:='automated'; e.match_method:='none'; EXIT rules; END IF;
    e.attribution_status:='direct'; e.attribution_step:=1; e.attribution_confidence:=1; e.attributed_at:=clock_timestamp();
    e.match_status:='matched'; e.match_confidence:=1;
    EXIT rules;
   END IF;
   IF prior_status='automated' OR e.payload->>'automated'='true' OR e.payload->>'auto_submitted' IN ('auto-generated','auto-replied')
   THEN e.attribution_status:='automated';
    IF writer_job IS NOT NULL AND e.job_id IS NULL THEN e.job_id:=writer_job; e.metadata:=e.metadata||jsonb_build_object('placement_rule','writer_job'); END IF;
    EXIT rules;
   END IF;
   is_ghl:=public.context_event_is_ghl(e);
   v_at:=coalesce(e.event_at,e.occurred_at,clock_timestamp());
   v_mode:=coalesce(e.metadata->>'capture_mode','live');

   -- 2. Identity: computes the customer's keys and recovers exactly one contact.
   SELECT i.email_key,i.phone_key INTO ek,pk FROM public.context_event_identity(e) i;
   contact:=nullif(btrim(e.contact_id),'');
   IF contact IS NULL AND (ek IS NOT NULL OR pk IS NOT NULL) THEN
    SELECT c.contact_id,c.contacts INTO contact,n_contacts FROM public.context_contact_for_key(ek,pk) c;
    IF n_contacts=1 THEN
     by_key:=CASE WHEN ek IS NOT NULL AND (SELECT c.contacts FROM public.context_contact_for_key(ek,NULL) c)=1 THEN 'email' ELSE 'phone' END;
     e.contact_id:=contact;
     e.metadata:=e.metadata||jsonb_build_object('contact_recovered_by',by_key);
    ELSE
     contact:=NULL;
     IF n_contacts>1 THEN e.metadata:=e.metadata||jsonb_build_object('identity_conflict',n_contacts); END IF;
    END IF;
   END IF;

   -- References, used by custody's re-scan and by step 3.
   toks:=public.context_job_ref_tokens(words);
   IF cardinality(toks)>0 THEN
    SELECT array_agg(DISTINCT r.job_id ORDER BY r.job_id),array_agg(DISTINCT replace(r.token,'-','')) INTO ref_ids,found_toks FROM public.context_ref_jobs(toks) r;
    SELECT array_agg(t ORDER BY t) INTO unfound FROM unnest(toks) t
    WHERE t ~ '^SW[A-Z]{0,4}-?[0-9]{4,}' AND NOT (replace(t,'-','')=ANY(coalesce(found_toks,'{}')))
     AND NOT EXISTS (SELECT 1 FROM unnest(toks) t2 WHERE t2<>t AND replace(t2,'-','')=replace(t,'-','') AND replace(t2,'-','')=ANY(coalesce(found_toks,'{}')));
    IF cardinality(unfound)>0 THEN e.metadata:=e.metadata||jsonb_build_object('ref_not_found',to_jsonb(unfound)); END IF;
   END IF;

   -- 1. Custody. monitor-inbox's first-match binding is re-scanned (Review B1).
   IF e.job_id IS NOT NULL THEN
    custody:=true;
    IF source_method='direct_reference' AND e.source IN ('monitor-inbox','monitor-inbox-group','monitor_inbox') AND cardinality(ref_ids)>=1 THEN
     IF cardinality(ref_ids) BETWEEN 2 AND 5 THEN
      e.metadata:=e.metadata||jsonb_build_object('custody_rescan',jsonb_build_object('writer_job_id',e.job_id,'jobs',cardinality(ref_ids)),'placement_rule','multi_ref');
      e.job_id:=NULL; e.attribution_status:='unplaced'; e.attribution_step:=1; e.candidate_job_ids:=ref_ids;
      EXIT rules;
     ELSIF cardinality(ref_ids)>5 THEN
      e.metadata:=e.metadata||jsonb_build_object('custody_rescan',jsonb_build_object('writer_job_id',e.job_id,'jobs',cardinality(ref_ids)),
       'placement_rule','multi_ref_many','bucket_reason','multi_ref_many','ref_job_ids',to_jsonb(ref_ids));
      e.job_id:=NULL;
      EXIT rules;
     ELSIF ref_ids[1]<>e.job_id THEN
      e.metadata:=e.metadata||jsonb_build_object('custody_rescan',jsonb_build_object('writer_job_id',e.job_id,'jobs',1));
      e.job_id:=ref_ids[1]; custody:=false; rule:='direct_ref';
     END IF;
    END IF;
    cand:=e.job_id; e.attribution_status:='direct'; e.attribution_step:=1; rule:=coalesce(rule,'custody');
   END IF;

   -- 1b. The source's own job (20261003100000). A payload.job_id that is the
   -- exact id text of a job that is not holding places the row there (rule
   -- payload_job, a step-1 direct placement), whatever a contact rule would
   -- pick. One that names no such job (missing, holding, another spelling)
   -- rests the row in the bucket with bucket_reason payload_job_unbindable,
   -- never on another job: the revision store refuses a row whose payload
   -- names a job other than the one it sits on.
   -- L1e (20261005110000): a payload job its writer declared a guess is not
   -- the source's own job; the row goes on to the later rules.
   IF cand IS NULL AND public.context_payload_job_is_guess(e) THEN
    e.metadata:=e.metadata||jsonb_build_object('payload_job_guess',true);
   ELSIF cand IS NULL AND e.payload#>>'{job_id}' IS NOT NULL THEN
    IF e.payload#>>'{job_id}' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
     SELECT j.id INTO cand FROM public.jobs j WHERE j.id=(e.payload#>>'{job_id}')::uuid
      AND coalesce(j.metadata->>'do_not_schedule','') NOT IN ('true','1');
    END IF;
    IF cand IS NULL THEN
     e.metadata:=e.metadata||jsonb_build_object('bucket_reason','payload_job_unbindable','placement_rule','payload_job_unbindable');
     EXIT rules;
    END IF;
    e.attribution_status:='direct'; e.attribution_step:=1; rule:='payload_job';
   END IF;

   -- 3. References.
   IF cand IS NULL THEN
    -- L1d (20261005090000): a reference alone never makes an outbound row to
    -- a known contact who is not that job's customer or party a message to
    -- the customer; it stays ON the job as internal communication
    -- (internal_ref), labelled with who it went to, as on the rules-off path.
    IF cardinality(ref_ids)=1 AND NOT public.context_ref_recipient_is_customer(e,ref_ids[1]) THEN
     irole:=public.context_internal_text_role(e);
     e.job_id:=ref_ids[1]; e.attribution_status:='direct'; e.attribution_step:=1;
     e.attribution_confidence:=1; e.attributed_at:=clock_timestamp();
     e.match_status:='matched'; e.match_method:='ladder_ref'; e.match_confidence:=1;
     e.metadata:=e.metadata||jsonb_build_object('placement_rule','internal_ref','recipient_role',irole,
      'recipient_role_source',CASE WHEN irole='other' THEN 'contact' ELSE 'wording' END,'audience',CASE WHEN irole='other' THEN 'other_party' ELSE 'internal' END);
     EXIT rules;
    ELSIF cardinality(ref_ids)=1 THEN
     cand:=ref_ids[1]; e.attribution_status:='direct'; e.attribution_step:=1; rule:='direct_ref';
    ELSIF cardinality(ref_ids) BETWEEN 2 AND 5 THEN
     e.attribution_status:='unplaced'; e.attribution_step:=1; e.candidate_job_ids:=ref_ids;
     e.metadata:=e.metadata||jsonb_build_object('placement_rule','multi_ref');
     EXIT rules;
    ELSIF cardinality(ref_ids)>5 THEN
     e.metadata:=e.metadata||jsonb_build_object('placement_rule','multi_ref_many','bucket_reason','multi_ref_many','ref_job_ids',to_jsonb(ref_ids));
     EXIT rules;
    END IF;
   END IF;

   -- Candidates of a known contact (with the message's keys), for the thread
   -- check and step 5.
   IF cand IS NULL THEN
    line:=lower(coalesce(e.payload->>'line',e.payload->>'business_line',''));
    SELECT coalesce(array_agg(t.job_id ORDER BY t.created_at,t.job_id) FILTER (WHERE t.candidate),'{}'),
     coalesce(array_agg(t.job_id ORDER BY t.created_at,t.job_id) FILTER (WHERE t.candidate AND t.type=line AND line IN ('fencing','patio')),'{}'),
     coalesce(array_agg(t.job_id ORDER BY t.terminal_at DESC,t.job_id) FILTER (WHERE NOT t.candidate AND t.terminal
      AND t.created_at<=v_at AND t.terminal_at<=v_at AND t.terminal_at>=v_at-interval '90 days'),'{}'),
     coalesce(array_agg(t.job_id ORDER BY t.job_id) FILTER (WHERE t.basis='contactless' AND (t.candidate OR (NOT t.candidate AND t.terminal
      AND t.created_at<=v_at AND t.terminal_at<=v_at AND t.terminal_at>=v_at-interval '90 days'))),'{}'),
     coalesce(array_agg(t.job_id ORDER BY t.job_id) FILTER (WHERE t.basis='key_other_contact' AND t.candidate),'{}'),
     coalesce(bool_or(t.terminal_time_source='updated_at' AND (t.candidate OR (NOT t.candidate AND t.terminal
      AND t.created_at<=v_at AND t.terminal_at<=v_at AND t.terminal_at>=v_at-interval '90 days'))),false),
     -- Aftercare reads only the customer's own and contactless jobs, never
     -- another contact's job found by a shared phone or email.
     coalesce(array_agg(t.job_id ORDER BY t.terminal_at DESC,t.job_id) FILTER (WHERE t.basis<>'key_other_contact' AND t.terminal AND t.unpaid_at
      AND t.created_at<=v_at),'{}'),
     coalesce(array_agg(t.job_id ORDER BY t.terminal_at DESC,t.job_id) FILTER (WHERE t.basis<>'key_other_contact' AND t.terminal AND NOT t.unpaid_at
      AND t.created_at<=v_at AND t.terminal_at<=v_at AND t.terminal_at>=v_at-interval '60 days'),'{}')
    INTO ids,line_ids,guard_ids,contactless_ids,other_ids,used_updated_at,unpaid_ids,window_ids
    FROM public.context_contact_job_timeline(contact,v_at,pk,ek) t;
   END IF;

   -- 4. Thread: a live binding; with a known contact, only one of its jobs.
   IF cand IS NULL AND NOT is_ghl AND nullif(e.thread_key,'') IS NOT NULL THEN
    SELECT * INTO b FROM public.event_threads WHERE thread_key=e.thread_key;
    IF FOUND AND b.retired_at IS NOT NULL THEN
     e.attribution_status:='unplaced'; e.attribution_step:=2;
     e.candidate_job_ids:=ARRAY(SELECT DISTINCT x FROM unnest(ARRAY[b.job_id,b.retired_conflict_job_id]) x WHERE x IS NOT NULL ORDER BY x);
     e.metadata:=e.metadata||jsonb_build_object('placement_rule','thread_retired','placement_retired_binding',e.thread_key);
     EXIT rules;
    ELSIF FOUND AND (contact IS NULL OR b.job_id=ANY(ids||unpaid_ids||window_ids)) THEN
     cand:=b.job_id; e.attribution_status:='thread'; e.attribution_step:=2; rule:='thread';
    END IF;
   END IF;

   -- Supplier order numbers, only with no customer identity.
   IF cand IS NULL AND contact IS NULL AND ek IS NULL AND pk IS NULL THEN
    sk:=public.context_sender_key(e);
    order_toks:=public.context_supplier_order_tokens(subj);
    IF sk IS NOT NULL AND cardinality(order_toks)>0 THEN
     SELECT coalesce(array_agg(DISTINCT t.job_id) FILTER (WHERE t.retired_at IS NULL),'{}'),
      coalesce(array_agg(DISTINCT x) FILTER (WHERE t.retired_at IS NOT NULL AND x IS NOT NULL),'{}')
     INTO live_ids,retired_ids
     FROM public.event_threads t LEFT JOIN LATERAL unnest(ARRAY[t.job_id,t.retired_conflict_job_id]) x ON true
     WHERE t.thread_key IN (SELECT 'supplier_ref:'||sk||':'||o FROM unnest(order_toks) o);
     IF cardinality(retired_ids)>0 THEN
      e.attribution_status:='unplaced'; e.attribution_step:=2;
      e.candidate_job_ids:=ARRAY(SELECT DISTINCT x FROM unnest(retired_ids||live_ids) x ORDER BY x);
      e.metadata:=e.metadata||jsonb_build_object('placement_rule','supplier_order_retired');
      EXIT rules;
     ELSIF cardinality(live_ids)=1 THEN
      cand:=live_ids[1]; e.attribution_status:='thread'; e.attribution_step:=2; rule:='supplier_order_ref';
     ELSIF cardinality(live_ids)>1 THEN
      e.attribution_status:='unplaced'; e.attribution_step:=2;
      e.candidate_job_ids:=ARRAY(SELECT x FROM unnest(live_ids) x ORDER BY x);
      e.metadata:=e.metadata||jsonb_build_object('placement_rule','supplier_order_several');
      EXIT rules;
     END IF;
    END IF;
   END IF;

   -- 5. Contact rules, with the message's keys and the aftercare clause.
   IF cand IS NULL THEN
    n:=cardinality(ids);
    review_ids:=NULL;
    IF n>0 AND (e.metadata ? 'identity_conflict' OR cardinality(other_ids)>0) THEN
     rule:='review_identity_conflict'; review_ids:=ids||guard_ids;
    ELSIF n=1 AND cardinality(guard_ids)=0 THEN
     cand:=ids[1]; e.attribution_status:='single_open'; e.attribution_step:=3;
     rule:=CASE WHEN e.metadata ? 'contact_recovered_by' THEN 'identity_'||(e.metadata->>'contact_recovered_by')
      WHEN contact IS NULL AND ek IS NOT NULL THEN 'identity_email' WHEN contact IS NULL THEN 'identity_phone' ELSE 'single_open' END;
    ELSIF n=1 THEN
     rule:='review_recent_other_job'; review_ids:=ids||guard_ids;
     e.metadata:=e.metadata||jsonb_build_object('placement_guard_job_ids',to_jsonb(guard_ids));
    ELSIF n>1 AND cardinality(line_ids)=1 THEN
     cand:=line_ids[1]; e.attribution_status:='single_line'; e.attribution_step:=4; rule:='single_line';
    ELSIF n>1 THEN
     rule:='review_several'; review_ids:=ids;
    ELSIF cardinality(unpaid_ids)+cardinality(window_ids)>0 THEN
     -- Aftercare never places directly (decision on N7 and N17, 24 Sep): an
     -- unpaid invoice cannot tell a final-payment question from a new
     -- enquiry, only the words can, so the finished jobs go to review with the
     -- unpaid ones named.
     rule:='review_aftercare'; review_ids:=unpaid_ids||window_ids;
     IF cardinality(unpaid_ids)>0 THEN
      e.metadata:=e.metadata||jsonb_build_object('aftercare_unpaid_job_ids',to_jsonb(unpaid_ids));
     END IF;
    END IF;
    IF review_ids IS NOT NULL THEN
     -- Rows loaded as history or re-links never go to the model (X27).
     e.attribution_status:=CASE WHEN v_mode IN ('backfill','relink') THEN 'unplaced' ELSE 'pending_luna' END;
     e.attribution_step:=5; e.candidate_job_ids:=review_ids;
    END IF;
    IF rule IS NOT NULL THEN
     IF cardinality(contactless_ids)>0 THEN e.metadata:=e.metadata||jsonb_build_object('placement_contactless_job_ids',to_jsonb(contactless_ids)); END IF;
     IF cardinality(other_ids)>0 THEN e.metadata:=e.metadata||jsonb_build_object('placement_other_contact_job_ids',to_jsonb(other_ids)); END IF;
     IF used_updated_at THEN e.payload:=coalesce(e.payload,'{}'::jsonb)||jsonb_build_object('terminal_time_source','updated_at'); END IF;
    END IF;
    IF review_ids IS NOT NULL THEN
     e.metadata:=e.metadata||jsonb_build_object('placement_rule',rule);
     EXIT rules;
    END IF;
   END IF;

   -- 6. Site address, only with no contact (council, certifier, our own mail,
   -- a sender we cannot identify) and no identity conflict.
   IF cand IS NULL AND contact IS NULL AND NOT (e.metadata ? 'identity_conflict') THEN
    site_text:=coalesce(subj||E'\n','')||left(public.context_event_text(e),1500);
    SELECT array_agg(DISTINCT m.address_key) FILTER (WHERE m.address_key IS NOT NULL AND NOT m.slash_form),
     array_agg(DISTINCT lk) INTO exact_keys,loose_keys
    FROM public.context_address_mentions(site_text) m LEFT JOIN LATERAL unnest(m.loose_keys) lk ON true;
    IF cardinality(loose_keys)>0 THEN
     WITH near AS (
      SELECT j.id, public.context_address_key(j.site_address) AS k, public.context_address_loose_keys(j.site_address) AS lk
      FROM public.jobs j
      WHERE j.site_address IS NOT NULL
       AND coalesce(j.metadata->>'do_not_schedule','') NOT IN ('true','1')
       AND coalesce(j.created_at,'-infinity'::timestamptz)<=v_at
       AND (NOT (j.status::text IN ('cancelled','archived','lost','closed','complete','completed') OR coalesce(j.archived,false)
         OR (j.status::text='invoiced' AND j.completed_at IS NOT NULL))
        OR coalesce((
         SELECT min(coalesce(be.event_at,be.occurred_at)) FROM public.business_events be
         WHERE be.entity_type='job' AND be.entity_id=j.id::text AND be.event_type='job.status_changed'
          AND lower(be.payload->'changes'->'status'->>'to') IN ('cancelled','archived','lost','closed','complete','completed')
          AND coalesce(be.event_at,be.occurred_at)>coalesce((
           SELECT max(coalesce(nt.event_at,nt.occurred_at)) FROM public.business_events nt
           WHERE nt.entity_type='job' AND nt.entity_id=j.id::text AND nt.event_type='job.status_changed'
            AND lower(nt.payload->'changes'->'status'->>'to') NOT IN ('cancelled','archived','lost','closed','complete','completed')
          ),'-infinity'::timestamptz)
        ),j.completed_at,'-infinity'::timestamptz)>=v_at-interval '60 days'))
     SELECT array_agg(DISTINCT n.id ORDER BY n.id) FILTER (WHERE n.k=ANY(coalesce(exact_keys,'{}'))),
      array_agg(DISTINCT n.id ORDER BY n.id) FILTER (WHERE n.lk && loose_keys)
     INTO exact_ids,loose_ids FROM near n;
     e.metadata:=e.metadata||jsonb_build_object('placement_site_keys',jsonb_build_object('exact',cardinality(exact_keys),'loose',cardinality(loose_keys)));
     IF cardinality(exact_ids)=1 THEN
      cand:=exact_ids[1]; e.attribution_status:='content_ref'; e.attribution_step:=6; rule:='site_address';
     ELSIF cardinality(exact_ids) BETWEEN 2 AND 3 THEN
      e.attribution_status:='unplaced'; e.attribution_step:=6; e.candidate_job_ids:=exact_ids;
      e.metadata:=e.metadata||jsonb_build_object('placement_rule','site_address_several');
      EXIT rules;
     ELSIF cardinality(exact_ids)>3 THEN
      e.metadata:=e.metadata||jsonb_build_object('placement_rule','site_address_many','bucket_reason','no_identity_site');
      EXIT rules;
     ELSIF cardinality(loose_ids) BETWEEN 1 AND 3 THEN
      e.attribution_status:='unplaced'; e.attribution_step:=6; e.candidate_job_ids:=loose_ids;
      e.metadata:=e.metadata||jsonb_build_object('placement_rule','site_address_loose');
      EXIT rules;
     ELSIF cardinality(loose_ids)>3 THEN
      e.metadata:=e.metadata||jsonb_build_object('placement_rule','site_address_many','bucket_reason','no_identity_site');
      EXIT rules;
     END IF;
    END IF;
   END IF;

   -- 7. Nothing proved a job.
   IF cand IS NULL THEN
    e.metadata:=e.metadata||jsonb_build_object('placement_rule',CASE WHEN contact IS NULL THEN 'no_contact' ELSE 'no_candidate_at_time' END);
    EXIT rules;
   END IF;

   -- Placed. Bindings from proven placements only (X25).
   e.job_id:=cand;
   IF e.attribution_status IN ('direct','content_ref') AND nullif(e.thread_key,'') IS NOT NULL AND NOT is_ghl THEN
    SELECT * INTO b FROM public.event_threads WHERE thread_key=e.thread_key;
    IF NOT FOUND THEN
     IF p_preview THEN bindings:=bindings||jsonb_build_array(jsonb_build_object('key',e.thread_key,'job_id',cand));
     ELSE INSERT INTO public.event_threads(thread_key,job_id,bound_by,source_event_id) VALUES(e.thread_key,cand,'ladder',e.id) ON CONFLICT DO NOTHING;
     END IF;
    ELSIF e.attribution_status='content_ref' AND b.retired_at IS NULL AND b.job_id<>cand THEN
     -- A content reference disagreeing with a live binding: neither is proof.
     IF NOT p_preview THEN
      UPDATE public.event_threads SET retired_at=clock_timestamp(),retired_reason='conflict',retired_conflict_job_id=cand
      WHERE thread_key=e.thread_key AND retired_at IS NULL;
     END IF;
     e.job_id:=NULL; e.attribution_status:='unplaced'; e.attribution_step:=6;
     e.candidate_job_ids:=ARRAY(SELECT DISTINCT x FROM unnest(ARRAY[b.job_id,cand]) x ORDER BY x);
     e.metadata:=e.metadata||jsonb_build_object('placement_rule','thread_retired','placement_retired_binding',e.thread_key);
     cand:=NULL;
     EXIT rules;
    END IF;
   END IF;
   IF e.attribution_status='direct' AND contact IS NULL AND ek IS NULL AND pk IS NULL THEN
    sk:=public.context_sender_key(e);
    order_toks:=public.context_supplier_order_tokens(subj);
    IF sk IS NOT NULL AND cardinality(order_toks) BETWEEN 1 AND 2 THEN
     FOREACH tok IN ARRAY order_toks LOOP
      SELECT * INTO b FROM public.event_threads WHERE thread_key='supplier_ref:'||sk||':'||tok;
      IF NOT FOUND THEN
       IF p_preview THEN
        bindings:=bindings||jsonb_build_array(jsonb_build_object('key','supplier_ref:'||sk||':'||tok,'job_id',cand));
       ELSE
        INSERT INTO public.event_threads(thread_key,job_id,bound_by,source_event_id) VALUES('supplier_ref:'||sk||':'||tok,cand,'ladder',e.id) ON CONFLICT DO NOTHING;
        SELECT * INTO b FROM public.event_threads WHERE thread_key='supplier_ref:'||sk||':'||tok;
       END IF;
      END IF;
      IF NOT p_preview AND FOUND AND b.retired_at IS NULL AND b.job_id<>cand THEN
       -- The same order number named for two jobs: retire it (Review M3).
       UPDATE public.event_threads SET retired_at=clock_timestamp(),retired_reason='conflict',retired_conflict_job_id=cand
       WHERE thread_key='supplier_ref:'||sk||':'||tok AND retired_at IS NULL;
       conflicts:=conflicts||to_jsonb('supplier_ref:'||sk||':'||tok);
      END IF;
     END LOOP;
    END IF;
   END IF;
   IF jsonb_array_length(conflicts)>0 THEN e.metadata:=e.metadata||jsonb_build_object('supplier_ref_conflicts',conflicts); END IF;
   IF p_preview AND jsonb_array_length(bindings)>0 THEN e.metadata:=e.metadata||jsonb_build_object('placement_preview_bindings',bindings); END IF;
   e.metadata:=e.metadata||jsonb_build_object('placement_rule',rule);
   e.attribution_confidence:=1; e.attributed_at:=clock_timestamp();
   e.match_status:='matched'; e.match_confidence:=1;
   e.match_method:=CASE WHEN custody THEN source_method WHEN rule='payload_job' THEN 'direct_job_id' WHEN rule='direct_ref' THEN 'ladder_ref'
    WHEN e.attribution_status='content_ref' THEN 'content_ref' ELSE 'contact_id' END;
  EXCEPTION WHEN OTHERS THEN
   e.job_id:=NULL; e.attribution_status:='admin_bucket'; e.attribution_step:=6;
   e.attribution_confidence:=NULL; e.attributed_at:=NULL; e.candidate_job_ids:=NULL;
   e.match_status:='unresolved'; e.match_method:='none'; e.match_confidence:=NULL;
   e.payload:=coalesce(e.payload,'{}')||jsonb_build_object('attribution_error',SQLERRM);
  END;
  IF e.job_id IS NULL AND e.attribution_status NOT IN ('direct','thread','single_open','single_line','luna','content_ref','party') THEN
   e.match_status:='unresolved'; e.match_method:='none'; e.match_confidence:=NULL;
   e.attribution_confidence:=NULL; e.attributed_at:=NULL;
  END IF;
 END IF;
 -- Always: why a bucket row is unlinked (metadata only, never a placement).
 IF e.attribution_status='admin_bucket' AND NOT (coalesce(e.metadata,'{}'::jsonb) ? 'bucket_reason') THEN
  e.metadata:=coalesce(e.metadata,'{}'::jsonb)||jsonb_build_object('bucket_reason',public.context_bucket_reason(e));
 END IF;
 RETURN e;
END $$;
COMMENT ON FUNCTION public.resolve_context_attribution(public.business_events,boolean,boolean) IS
 'L1e: the ladder (P4) as L1d left it (20261005090000: step 1b and the crew and staff rules) plus L1e (20261005110000). Rules off: P1a''s ladder with those and L1e. Rules on: writer check, a service-role outbound row marked recipient_role crew or staff handled by the L1d rule, a row with no words or an automated row keeps a custody job and the job a service-role writer named with no match_method (writer_job), custody with monitor-inbox re-scan, the source''s own payload job unless its writer declared it a guess (bindable: placed, rule payload_job; unbindable: bucket, payload_job_unbindable; guess: payload_job_guess, on to the later rules), identity (payload.from read), references (multi_ref unplaced; one job on an outbound row to a known contact who is not that job''s customer or party: the L1d rule), live thread and supplier order bindings, contact rules with keys and aftercare, exact or loose site address, bucket. Always stamps metadata.bucket_reason on a bucket row. p_preview writes nothing. p_rules_on null reads the flag.';

-- 5. The payload-job repair's classifier: a declared guess is its own class.
CREATE OR REPLACE FUNCTION public.context_payload_job_mismatch_rows()
RETURNS TABLE(id uuid,from_job_id uuid,to_job_id uuid,status text,class text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT b.id,b.job_id,j.id,b.attribution_status,
  CASE
   WHEN b.attribution_status IS NULL OR b.attribution_status NOT IN ('single_open','single_line','luna') THEN 'not_contact_rule'
   WHEN public.context_payload_job_is_guess(b) THEN 'payload_job_guess'
   WHEN j.id IS NULL THEN 'payload_job_not_found'
   WHEN coalesce(j.metadata->>'do_not_schedule','') IN ('true','1') THEN 'payload_job_holding'
   WHEN nullif(b.thread_key,'') IS NOT NULL AND NOT public.context_event_is_ghl(b)
    AND EXISTS(SELECT 1 FROM public.event_threads t WHERE t.thread_key=b.thread_key AND t.job_id<>j.id) THEN 'thread_bound_elsewhere'
   ELSE 'repoint' END
 FROM public.business_events b
 LEFT JOIN public.jobs j ON j.id::text=b.payload#>>'{job_id}'
 WHERE b.job_id IS NOT NULL AND b.payload#>>'{job_id}' IS NOT NULL AND b.payload#>>'{job_id}'<>b.job_id::text
$$;
COMMENT ON FUNCTION public.context_payload_job_mismatch_rows() IS
 'Rows the revision store refuses as payload_job_mismatch (job_id set, payload.job_id set and different), each classed repoint, payload_job_guess, payload_job_not_found, payload_job_holding, not_contact_rule or thread_bound_elsewhere (20261002170100; payload_job_guess 20261005110000: the writer declared its payload job a guess, never repointed). Read-only. Service role only.';

-- Grants: the ladder bodies and both helpers private; the classifier for the
-- service role, as before.
REVOKE ALL ON FUNCTION
 public.context_event_writer_job(public.business_events),
 public.context_payload_job_is_guess(public.business_events),
 public.context_ladder_p1a(public.business_events,boolean),
 public.resolve_context_attribution(public.business_events,boolean,boolean)
FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.context_payload_job_mismatch_rows() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.context_payload_job_mismatch_rows() TO service_role;
