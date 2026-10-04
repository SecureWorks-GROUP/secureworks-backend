-- Ladder L1c: a text to someone who is not the job's customer is never filed as
-- a message to that customer.
--
-- Why (independent grade of the live job briefs, 4 Oct 2026): ops-api texts an
-- installer "New job assigned: <job number> - <client> | Site | Date" and the
-- managers "Job ready for crew: ..." through ghl-proxy send_sms, which passes
-- no job. The ladder's reference step then found the job number in the words
-- and placed the row on the customer's job (direct, step 1, match_method
-- direct_job_id, matched, confidence 1) without asking who received it. The
-- row stays client.sms_out, so every reader of the job took the crew text for
-- our message to the customer; one brief told the owner a customer had been
-- sent an assignment text that went to a crew member's phone. Seven brief
-- lines on four jobs rested on such rows.
--
-- Changed, on both paths of the one ladder (rules off, the live path while
-- context_unlinked_rules_v1 is off, and rules on):
--   1. Staff recipient (writer marker). An outbound row whose writer, the
--      service role, marked metadata.recipient_role crew or staff (ghl-proxy
--      send_sms stamps it when ops-api says the text goes to crew or staff)
--      rests off every job: attribution_status automated, job_id null,
--      metadata.placement_rule staff_recipient. The writer keeps the job the
--      text was about in metadata.about_job_id; the ladder never reads it as a
--      placement. Checked before every placement step, custody included.
--   2. Reference to a non-customer (no marker). When the reference step finds
--      exactly one job on an OUTBOUND row whose contact is known and is
--      neither that job's customer (jobs.ghl_contact_id) nor a party on it
--      (job_contacts.ghl_contact_id), the row stays for review instead of
--      being placed: attribution_status unplaced, step 1, candidate_job_ids
--      the one job, metadata.placement_rule ref_not_customer, match unresolved.
--      Unplaced rows never go to Luna, never wake a read and are moved again
--      only by a re-decision through this ladder.
--   Why unplaced and not "placed with a marker": every reader of a job's
--   events (the facts read, the brief, the agent's job read, reporting-api
--   job_context, the ops job detail) selects by job_id and reads
--   client.sms_out as our words to the customer; none reads a marker today.
--   Off the job is the one change that makes all of them right at once. The
--   job stays named on the row (candidate_job_ids, about_job_id).
-- Not changed: inbound rows (a customer writing from a second number or
-- address with their job number still places), rows with no contact, custody
-- placements (a writer that verified the job's contact), step 1b's payload
-- job, two or more references, the entry, the insert trigger, the readers,
-- Luna, reconsideration and capture_business_event. No existing row is
-- written; rows change only when inserted or re-decided. No flag or switch
-- changes. Rows already misfiled are listed and corrected separately, by
-- hand, dry run first.
--
-- New private helper: context_ref_recipient_is_customer(e, job), plain SQL,
-- no SET clause, schema-qualified.
--
-- Built on the L1b bodies merged on main (20261003100000):
--   resolve_context_attribution(business_events,boolean,boolean)  md5(prosrc) a0205f1a17ae9866ca4c8e57ff2746e4
--   context_ladder_p1a(business_events,boolean)                   md5(prosrc) 6a45c9ea9a68c8c5899fba45b44e18b5
--   read, not replaced: resolve_context_attribution(business_events) 32365101 (P4),
--   attribute_business_event() d0036a1b (P4).
-- Whether L1b is applied in production was not observed.
-- The guard refuses unless each replaced body is L1b's (or already this
-- migration's, for a re-apply). Both replaced functions carry an "L1c:"
-- comment, so a re-apply of L1b over them refuses rather than silently
-- removing these rules.
-- Rollback: supabase/rollbacks/20261004200000_context_ladder_non_customer_text_down.sql
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- 0. Pre-image guard. Reports every problem at once.
DO $guard$
DECLARE problems text[]:='{}'; live text; x record;
BEGIN
 FOR x IN SELECT * FROM (VALUES
  -- Replaced: L1b's body, or this migration's.
  ('public.resolve_context_attribution(public.business_events,boolean,boolean)',ARRAY['a0205f1a17ae9866ca4c8e57ff2746e4','9a94bf772e45b23f7f4ffe725a804fc6']),
  ('public.context_ladder_p1a(public.business_events,boolean)',ARRAY['6a45c9ea9a68c8c5899fba45b44e18b5','b7d991654bd7d4f2a00136be29ad8fc9']),
  -- Read, not replaced: the entry and the insert trigger still route every row through the ladder.
  ('public.resolve_context_attribution(public.business_events)',ARRAY['32365101d23dde1695707a0bddff640b']),
  ('public.attribute_business_event()',ARRAY['d0036a1bc36f4b2a779f4a8b192cd687'])
 ) AS t(sig,accepted) LOOP
  live:=NULL;
  SELECT md5(p.prosrc) INTO live FROM pg_proc p WHERE p.oid=to_regprocedure(x.sig);
  IF live IS NULL OR NOT live=ANY(x.accepted) THEN problems:=problems||format('%s md5 %s',x.sig,coalesce(live,'<missing>')); END IF;
 END LOOP;
 -- New: absent, or already this migration's.
 SELECT md5(p.prosrc) INTO live FROM pg_proc p WHERE p.oid=to_regprocedure('public.context_ref_recipient_is_customer(public.business_events,uuid)');
 IF live IS NOT NULL AND live<>'18904e5439afd9c23e59e97f200d256e' THEN
  problems:=problems||format('public.context_ref_recipient_is_customer(public.business_events,uuid) md5 %s',live);
 END IF;
 FOR x IN SELECT * FROM (VALUES
  ('jobs','id','uuid'),('jobs','ghl_contact_id','text'),('job_contacts','job_id','uuid'),('job_contacts','ghl_contact_id','text'),
  ('business_events','direction','text'),('business_events','contact_id','text'),('business_events','metadata','jsonb')
 ) AS c(tbl,col,typ) LOOP
  live:=NULL;
  SELECT format_type(a.atttypid,a.atttypmod) INTO live FROM pg_attribute a
  WHERE a.attrelid=to_regclass('public.'||x.tbl) AND a.attname=x.col AND a.attnum>0 AND NOT a.attisdropped;
  IF live IS DISTINCT FROM x.typ THEN problems:=problems||format('%s.%s is %s, expected %s',x.tbl,x.col,coalesce(live,'<missing>'),x.typ); END IF;
 END LOOP;
 IF cardinality(problems)>0 THEN
  RAISE EXCEPTION 'context_ladder_non_customer_text_preimage_mismatch: %; read the live definitions before replacing them',array_to_string(problems,'; ');
 END IF;
END $guard$;

-- 1. Is the row's contact the customer of the job a reference names? True for
-- a row that is not outbound, a row with no contact, the job's own contact
-- and any party on the job (a neighbour on a shared fence is a customer).
CREATE OR REPLACE FUNCTION public.context_ref_recipient_is_customer(e public.business_events,p_job uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
 SELECT e.direction IS DISTINCT FROM 'outbound'
  OR nullif(btrim(e.contact_id),'') IS NULL
  OR EXISTS (SELECT 1 FROM public.jobs j WHERE j.id=p_job AND j.ghl_contact_id=btrim(e.contact_id))
  OR EXISTS (SELECT 1 FROM public.job_contacts c WHERE c.job_id=p_job AND c.ghl_contact_id=btrim(e.contact_id))
$$;
COMMENT ON FUNCTION public.context_ref_recipient_is_customer(public.business_events,uuid) IS
 'L1c: may a reference place this row on p_job? False only for an outbound row whose known contact is neither the job''s GHL contact nor a party''s on it (20261004200000). Private; read by the ladder.';

-- 2. Rules off: L1b's body plus both rules.
CREATE OR REPLACE FUNCTION public.context_ladder_p1a(e public.business_events,p_preview boolean) RETURNS public.business_events
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE words text; tokens text; ids uuid[]; candidate uuid; n int; line text; contact_ids text[]; prior_status text; source_method text;
 v_at timestamptz; is_ghl boolean; line_ids uuid[]; guard_ids uuid[]; contactless_ids uuid[]; used_updated_at boolean; rule text;
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
   e.metadata:=coalesce(e.metadata,'{}'::jsonb)||jsonb_build_object('attribution_hint',jsonb_build_object('job_id',e.job_id,'match_method',source_method,'match_confidence',e.match_confidence));
   e.job_id:=NULL;
 END IF;
 e.attribution_checked_at:=clock_timestamp();
 words:=public.context_event_text(e);
 e.attribution_status:='admin_bucket'; e.attribution_step:=6;
 e.attribution_confidence:=NULL; e.attributed_at:=NULL;
 e.match_status:='unresolved'; e.match_method:='none'; e.match_confidence:=NULL;
 e.candidate_job_ids:=NULL;
 IF e.metadata ?| ARRAY['placement_rule','placement_contactless_job_ids','placement_guard_job_ids'] THEN
  e.metadata:=e.metadata-'placement_rule'-'placement_contactless_job_ids'-'placement_guard_job_ids';
 END IF;
 IF e.payload ? 'terminal_time_source' THEN e.payload:=e.payload-'terminal_time_source'; END IF;
 IF NOT public.automation_lane_enabled('attribution') THEN e.job_id:=NULL; RETURN e; END IF;
 IF to_jsonb(e)->>'channel' IN ('system','audit') THEN e.attribution_status:='automated'; RETURN e; END IF;
 IF btrim(words)='' THEN e.attribution_status:='empty'; RETURN e; END IF;
 -- L1c (20261004200000): a text our own tool sent to crew or staff (writer
 -- marker metadata.recipient_role crew or staff on an outbound row written by
 -- the service role) is never a customer message: it rests off every job as
 -- automated, placement_rule staff_recipient.
 IF e.direction='outbound' AND e.metadata->>'recipient_role' IN ('crew','staff') AND e.metadata->>'written_as'='service_role' THEN
  e.job_id:=NULL; e.attribution_status:='automated';
  e.metadata:=coalesce(e.metadata,'{}'::jsonb)||jsonb_build_object('placement_rule','staff_recipient');
  RETURN e;
 END IF;
 IF prior_status='automated' OR e.payload->>'automated'='true' OR e.payload->>'auto_submitted' IN ('auto-generated','auto-replied')
 THEN e.attribution_status:='automated'; RETURN e; END IF;
 is_ghl:=public.context_event_is_ghl(e);
 SELECT id INTO candidate FROM public.jobs WHERE id=e.job_id;
 -- 1b. The source's own job (20261003100000), as in the rules-on ladder: a
 -- payload.job_id that is the exact id text of a job that is not holding is
 -- the candidate (direct, step 1); one that names no such job rests the row
 -- in the bucket (payload_job_unbindable), never on another job.
 IF candidate IS NULL AND e.payload#>>'{job_id}' IS NOT NULL THEN
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
   -- L1c (20261004200000): a reference alone never makes an outbound row to
   -- a known contact who is not that job's customer (nor a party on it) a
   -- message to the customer. It stays for review (unplaced, the job as the
   -- one candidate, placement_rule ref_not_customer).
   IF candidate IS NOT NULL AND NOT public.context_ref_recipient_is_customer(e,candidate) THEN
    e.job_id:=NULL; e.attribution_status:='unplaced'; e.attribution_step:=1; e.candidate_job_ids:=ARRAY[candidate];
    e.metadata:=coalesce(e.metadata,'{}'::jsonb)||jsonb_build_object('placement_rule','ref_not_customer');
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
 'L1c: P1a''s ladder (P4''s copy, run while context_unlinked_rules_v1 is off) plus step 1b (20261003100000) and the two non-customer rules (20261004200000): a service-role outbound row marked recipient_role crew or staff rests off every job (automated, staff_recipient); a reference to one job on an outbound row to a known contact who is not that job''s customer or party stays for review (unplaced, ref_not_customer). In preview it writes no thread binding. Private; call resolve_context_attribution.';

-- 3. Rules on: L1b's body plus both rules.
CREATE OR REPLACE FUNCTION public.resolve_context_attribution(e public.business_events,p_preview boolean,p_rules_on boolean)
RETURNS public.business_events
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
 rules_on boolean; words text; subj text; prior_status text; source_method text; writer text;
 v_at timestamptz; is_ghl boolean; v_mode text; ek text; pk text; contact text; n_contacts int; by_key text;
 toks text[]; ref_ids uuid[]; found_toks text[]; unfound text[]; cand uuid; rule text; custody boolean:=false;
 b public.event_threads; sk text; order_toks text[]; tok text; live_ids uuid[]; retired_ids uuid[];
 ids uuid[]; line text; line_ids uuid[]; guard_ids uuid[]; contactless_ids uuid[]; other_ids uuid[]; used_updated_at boolean;
 unpaid_ids uuid[]; window_ids uuid[]; review_ids uuid[]; n int;
 site_text text; exact_keys text[]; loose_keys text[]; exact_ids uuid[]; loose_ids uuid[]; bindings jsonb:='[]'; conflicts jsonb:='[]';
 owned_keys constant text[]:=ARRAY['placement_rule','placement_contactless_job_ids','placement_guard_job_ids','placement_other_contact_job_ids',
  'bucket_reason','ref_not_found','ref_job_ids','identity_conflict','contact_recovered_by','writer_unknown','custody_rescan',
  'placement_site_keys','placement_retired_binding','placement_preview_bindings','supplier_ref_conflicts','aftercare_unpaid_job_ids'];
BEGIN
 rules_on:=coalesce(p_rules_on,public.context_unlinked_rules_enabled());
 p_preview:=coalesce(p_preview,false);
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
   IF to_jsonb(e)->>'channel' IN ('system','audit') THEN e.attribution_status:='automated'; EXIT rules; END IF;
   IF btrim(words)='' THEN e.attribution_status:='empty'; e.job_id:=NULL; EXIT rules; END IF;
   -- L1c (20261004200000): a text our own tool sent to crew or staff is never
   -- a customer message (automated, staff_recipient), as on the rules-off path.
   IF e.direction='outbound' AND e.metadata->>'recipient_role' IN ('crew','staff') AND e.metadata->>'written_as'='service_role' THEN
    e.attribution_status:='automated'; e.job_id:=NULL;
    e.metadata:=e.metadata||jsonb_build_object('placement_rule','staff_recipient');
    EXIT rules;
   END IF;
   IF prior_status='automated' OR e.payload->>'automated'='true' OR e.payload->>'auto_submitted' IN ('auto-generated','auto-replied')
   THEN e.attribution_status:='automated'; e.job_id:=NULL; EXIT rules; END IF;
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
   IF cand IS NULL AND e.payload#>>'{job_id}' IS NOT NULL THEN
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
    -- L1c (20261004200000): a reference alone never makes an outbound row to
    -- a known contact who is not that job's customer or party a message to
    -- the customer; it stays for review (unplaced, ref_not_customer).
    IF cardinality(ref_ids)=1 AND NOT public.context_ref_recipient_is_customer(e,ref_ids[1]) THEN
     e.attribution_status:='unplaced'; e.attribution_step:=1; e.candidate_job_ids:=ref_ids;
     e.metadata:=e.metadata||jsonb_build_object('placement_rule','ref_not_customer');
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
 'L1c: the ladder (P4) plus step 1b (20261003100000) and the two non-customer rules (20261004200000). Rules off (flag context_unlinked_rules_v1 off): P1a''s ladder with step 1b and both rules. Rules on: writer check, a service-role outbound row marked recipient_role crew or staff rests off every job (automated, staff_recipient), custody with monitor-inbox re-scan, the source''s own payload job (bindable: placed, rule payload_job; unbindable: bucket, payload_job_unbindable), identity (payload.from read), references (multi_ref unplaced; one job on an outbound row to a known contact who is not that job''s customer or party: unplaced, ref_not_customer), live thread and supplier order bindings, contact rules with keys and aftercare, exact or loose site address, bucket. Always stamps metadata.bucket_reason on a bucket row. p_preview writes nothing. p_rules_on null reads the flag.';

-- Grants: the two ladder bodies unchanged (CREATE OR REPLACE keeps them),
-- restated so all three stay private.
REVOKE ALL ON FUNCTION
 public.context_ref_recipient_is_customer(public.business_events,uuid),
 public.context_ladder_p1a(public.business_events,boolean),
 public.resolve_context_attribution(public.business_events,boolean,boolean)
FROM PUBLIC,anon,authenticated,service_role;
