-- Rollback of 20261104095000_context_known_contact_placement.sql: restores the five live bodies and comments
-- byte for byte (pg_get_functiondef, production, 3 Nov 2026) and drops
-- context_empty_row_job. Rows the new rules placed or named keep their state;
-- a row changes only when it is decided again.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';
DO $guard$
DECLARE problems text[]:='{}'; live text; x record;
BEGIN
 FOR x IN SELECT * FROM (VALUES
  ('public.context_reconsider_eligible(public.business_events,uuid)',ARRAY['375857877700389aa8f6f730095b8800','b36321bfcadcb02dc2aef454d12cece7']),
  ('public.context_redecide_one(uuid,text,jsonb)',ARRAY['3c79bd64e707a5f5a4bd92a5d67a0aca','8b96162586764b08d76e419871e17fb9']),
  ('public.context_redecide_resting(text,timestamptz,uuid)',ARRAY['6dccf6320f1fffa4a4c385e23ba9de88','5c11ac90d98fe62b0749e27c4f427f64']),
  ('public.context_reconsider_contact(text,timestamptz,text,uuid)',ARRAY['75aea904fb88a526ee6aed68b4d592b9','53f7d9d592e75d0232226fa466f76464']),
  ('public.resolve_context_attribution(public.business_events,boolean,boolean)',ARRAY['2ccef791fca954bfe1fcbb4e0de5f8a2','f9cd8d311bf00a92f7b708ff2d2dc8a7'])
 ) AS t(sig,accepted) LOOP
  SELECT md5(p.prosrc) INTO live FROM pg_proc p WHERE p.oid=to_regprocedure(x.sig);
  IF live IS NULL OR NOT live=ANY(x.accepted) THEN problems:=problems||format('%s md5 %s',x.sig,coalesce(live,'<missing>')); END IF;
 END LOOP;
 IF cardinality(problems)>0 THEN
  RAISE EXCEPTION 'context_known_contact_placement_down_mismatch: %',array_to_string(problems,'; ');
 END IF;
END $guard$;

CREATE OR REPLACE FUNCTION public.resolve_context_attribution(e business_events, p_preview boolean, p_rules_on boolean)
 RETURNS business_events
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
  'audience','recipient_role_source','placement_held_from',
  'placement_ranked_from','placement_ranked_below','party_key_conflict','placement_guarded_from'];
 writer_job uuid;
 held_job uuid; held_conf numeric; held_match_conf numeric; held_ok boolean:=false; all_ids uuid[]; own_live_ids uuid[];
 -- Unplaced stage 1 (20261014170000).
 link_ids uuid[]; link_only boolean:=false; builder_ids uuid[]; party_ids uuid[]; party_conflict boolean; open_all_ids uuid[]; ranked_from text; ranked_set uuid[];
 guard_rule text;
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
     -- L1e (20261005170000): a job the service role named without saying how
     -- (no match_method) is kept for a row the reader never reads.
     writer_job:=public.context_event_writer_job(e);
     -- L1f (20261006020000): a job a contact rule or Luna already chose
     -- (single_open, single_line or luna, match_method contact_id) is
     -- remembered for the held placement at step 5.
     IF prior_status IN ('single_open','single_line','luna') AND source_method='contact_id' THEN
      held_job:=e.job_id; held_conf:=e.attribution_confidence; held_match_conf:=e.match_confidence;
     END IF;
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
    -- L1f (20261006020000): a row the reader never reads (system or audit,
    -- no words, automated) keeps a custody job the service role confirmed
    -- after the insert (source_job_binding.via, written only by a reviewed
    -- service-role repair such as writer_key_relink: the insert trigger strips
    -- any binding a writer sends, and no other role may update the row), as
    -- with the rules off. Every worded row from this writer is still held.
    IF e.job_id IS NOT NULL AND e.metadata->'source_job_binding' ? 'via'
     AND (to_jsonb(e)->>'channel' IN ('system','audit') OR btrim(words)='' OR prior_status='automated'
      OR e.payload->>'automated'='true' OR e.payload->>'auto_submitted' IN ('auto-generated','auto-replied')) THEN
     e.attribution_status:=CASE WHEN to_jsonb(e)->>'channel' IN ('system','audit') THEN 'automated' WHEN btrim(words)='' THEN 'empty' ELSE 'automated' END;
     e.metadata:=e.metadata||jsonb_build_object('placement_rule','confirmed_custody');
     EXIT rules;
    END IF;
    IF e.job_id IS NOT NULL THEN
     e.metadata:=e.metadata||jsonb_build_object('attribution_hint',jsonb_build_object('job_id',e.job_id,'match_method',source_method,'match_confidence',e.match_confidence));
     e.job_id:=NULL;
    END IF;
    e.metadata:=e.metadata||jsonb_build_object('bucket_reason','unverified_writer','placement_rule','unverified_writer');
    EXIT rules;
   END IF;
   -- L1e (20261005170000): a row with no words, a system row and an automated
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
   -- Stage 1 (20261014170000): a make-safe reconcile record is a machine
   -- event, never a message: automated at capture, never unplaced.
   IF prior_status='automated' OR e.payload->>'automated'='true' OR e.payload->>'auto_submitted' IN ('auto-generated','auto-replied')
    OR e.event_type LIKE 'makesafe.reconcile.%'
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
   -- L1e (20261005170000): a payload job its writer declared a guess is not
   -- the source's own job; the row goes on to the later rules.
   IF cand IS NULL AND public.context_payload_job_is_guess(e) THEN
    e.metadata:=e.metadata||jsonb_build_object('payload_job_guess',true);
   ELSIF cand IS NULL AND e.payload#>>'{job_id}' IS NOT NULL THEN
    IF e.payload#>>'{job_id}' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
     SELECT j.id INTO cand FROM public.jobs j WHERE j.id=(e.payload#>>'{job_id}')::uuid
      AND lower(coalesce(j.metadata->>'do_not_schedule','')) <> 'true';
    END IF;
    IF cand IS NULL THEN
     e.metadata:=e.metadata||jsonb_build_object('bucket_reason','payload_job_unbindable','placement_rule','payload_job_unbindable');
     EXIT rules;
    END IF;
    e.attribution_status:='direct'; e.attribution_step:=1; rule:='payload_job';
   END IF;

   -- 3. References.
   IF cand IS NULL THEN
    -- Stage 1 (20261014170000): a quote or variation link token in the words
    -- (send-quote view?token=) names its job exactly, like a job number.
    link_ids:=public.context_link_ref_jobs(words);
    IF cardinality(link_ids)>0 THEN
     link_only:=coalesce(cardinality(ref_ids),0)=0;
     ref_ids:=ARRAY(SELECT DISTINCT x FROM unnest(coalesce(ref_ids,'{}'::uuid[])||link_ids) x ORDER BY x);
    END IF;
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
     cand:=ref_ids[1]; e.attribution_status:='direct'; e.attribution_step:=1; rule:=CASE WHEN link_only THEN 'link_ref' ELSE 'direct_ref' END;
    ELSIF cardinality(ref_ids) BETWEEN 2 AND 5 THEN
     -- A message naming several of our jobs concerns each of them: never
     -- ranked (stage 1 review, 14 Oct 2026), review as before.
     e.attribution_status:='unplaced'; e.attribution_step:=1; e.candidate_job_ids:=ref_ids;
     e.metadata:=e.metadata||jsonb_build_object('placement_rule','multi_ref');
     EXIT rules;
    ELSIF cardinality(ref_ids)>5 THEN
     e.metadata:=e.metadata||jsonb_build_object('placement_rule','multi_ref_many','bucket_reason','multi_ref_many','ref_job_ids',to_jsonb(ref_ids));
     EXIT rules;
    END IF;
    -- Stage 1 (20261014170000): with no reference of ours, a builder's claim
    -- or purchase order that names exactly one job places the row there
    -- (builder_ref). Several jobs fall through to the rules below, unchanged.
    IF cand IS NULL AND coalesce(cardinality(ref_ids),0)=0 THEN
     builder_ids:=public.context_builder_ref_jobs(words,e.payload->'builder_refs');
     IF cardinality(builder_ids)=1 THEN
      cand:=builder_ids[1]; e.attribution_status:='direct'; e.attribution_step:=1; rule:='builder_ref';
     END IF;
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
      AND t.created_at<=v_at AND t.terminal_at<=v_at AND t.terminal_at>=v_at-interval '60 days'),'{}'),
     coalesce(array_agg(t.job_id ORDER BY t.job_id) FILTER (WHERE t.basis<>'key_other_contact'),'{}'),
     coalesce(array_agg(t.job_id ORDER BY t.job_id) FILTER (WHERE t.basis<>'key_other_contact' AND t.candidate),'{}'),
     -- Stage 1 (20261014170000): the customer's live jobs now
     -- (context_job_live), for only_open_job.
     coalesce(array_agg(t.job_id ORDER BY t.job_id) FILTER (WHERE t.basis<>'key_other_contact' AND public.context_job_live(t.job_id)),'{}')
    INTO ids,line_ids,guard_ids,contactless_ids,other_ids,used_updated_at,unpaid_ids,window_ids,all_ids,own_live_ids,open_all_ids
    FROM public.context_contact_job_timeline(contact,v_at,pk,ek) t;
    -- L1f (20261006020000): the held job is still the answer while it is one
    -- of the customer's own or contactless jobs and none of those is live at
    -- the message time. Another contact's job that shares the phone or email
    -- is not the customer's job.
    -- L1g (20261006035000): it is also the answer while it is itself one of
    -- those jobs live at the message time, or one the review would offer
    -- (finished in the guard window, unpaid, or in the aftercare window),
    -- whatever other job of the customer is live then. The decision made when
    -- the row was placed stands: a newer job reopens a placed row only through
    -- P1b at its insert (context_reconsider_contact, the one reopen path), and
    -- a job that was a draft then and went live later reopens nothing.
    held_ok:=held_job IS NOT NULL AND held_job=ANY(all_ids)
     AND (cardinality(own_live_ids)=0 OR held_job=ANY(own_live_ids||guard_ids||unpaid_ids||window_ids));
   END IF;

   -- 4. Thread: a live binding; with a known contact, only one of its jobs.
   IF cand IS NULL AND NOT is_ghl AND nullif(e.thread_key,'') IS NOT NULL THEN
    SELECT * INTO b FROM public.event_threads WHERE thread_key=e.thread_key;
    IF FOUND AND b.retired_at IS NOT NULL THEN
     -- L1f (20261006020000): a held row goes on to step 5 and stays.
     IF NOT held_ok THEN
      e.attribution_status:='unplaced'; e.attribution_step:=2;
      e.candidate_job_ids:=ARRAY(SELECT DISTINCT x FROM unnest(ARRAY[b.job_id,b.retired_conflict_job_id]) x WHERE x IS NOT NULL ORDER BY x);
      e.metadata:=e.metadata||jsonb_build_object('placement_rule','thread_retired','placement_retired_binding',e.thread_key);
      EXIT rules;
     END IF;
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
    -- L1f (20261006020000): held placement. A row a contact rule or Luna
    -- already put on a job keeps it when the rules above would send it to
    -- review or the bucket and its job is still the answer (held_ok, set with
    -- the candidates): the rules-on reasons (an invoiced job counted finished,
    -- aftercare, a shared phone or email, a recently finished job and, since
    -- L1g, another live job of the customer) never take it off its job. A
    -- placement the rules above make is not outranked. placement_held_from
    -- names the rule it outranked.
    IF cand IS NULL AND held_ok THEN
     e.metadata:=e.metadata||jsonb_build_object('placement_held_from',coalesce(rule,CASE WHEN contact IS NULL THEN 'no_contact' ELSE 'no_candidate_at_time' END));
     cand:=held_job; e.attribution_status:=prior_status;
     e.attribution_step:=CASE prior_status WHEN 'single_open' THEN 3 WHEN 'single_line' THEN 4 ELSE 5 END;
     rule:='held_placement'; review_ids:=NULL;
    END IF;
    -- Stage 1 (20261014170000), candidate ranking (context_rank_contact_set),
    -- for a contact review only: the message names no job of ours, so its
    -- candidates come from who sent it. Jobs that are not a customer's job
    -- (no number: a hidden old-system record; a test job) leave the set,
    -- and a quote that was already dead at the message time (closed with
    -- no trace of progress, context_job_dead) leaves the recently finished
    -- set. When exactly one job is left and no finished work competes, the
    -- row places on it (ranked_open), as single_open would have. Work done,
    -- a job live at the message time that closed later, and aftercare stay
    -- competitors; status now and creation date are never evidence. A text
    -- naming several jobs, an address shared by several jobs and an
    -- identity conflict are never ranked.
    IF cand IS NULL AND review_ids IS NOT NULL AND rule IN ('review_several','review_recent_other_job') THEN
     SELECT r.job_id,r.dropped INTO cand,ranked_set FROM public.context_rank_contact_set(ids,guard_ids) r;
     IF cand IS NOT NULL THEN
      e.metadata:=e.metadata||jsonb_build_object('placement_ranked_from',rule,'placement_ranked_below',to_jsonb(ranked_set));
      ranked_from:=rule; rule:='ranked_open';
      e.attribution_status:='single_open'; e.attribution_step:=3; review_ids:=NULL;
     END IF;
    END IF;
    -- A known customer with no job at the message time (the bucket) whose
    -- only job, of any status, is live now and was created after the
    -- message and within 60 days of it: the row places on it
    -- (only_open_job), a lead the job's own window just missed. The review
    -- guards below send it to review when the message, or the customer's
    -- messages around it, name another site, address or claim.
    IF cand IS NULL AND rule IS NULL AND contact IS NOT NULL AND cardinality(ids)=0 AND cardinality(open_all_ids)=1
     AND (SELECT count(*) FROM unnest(all_ids) x WHERE public.context_job_real(x))=1 THEN
     SELECT j.id INTO cand FROM public.jobs j WHERE j.id=open_all_ids[1] AND j.created_at>v_at AND j.created_at<=v_at+interval '60 days';
     IF cand IS NOT NULL THEN e.attribution_status:='single_open'; e.attribution_step:=3; rule:='only_open_job'; END IF;
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

   -- Stage 1 (20261014170000): a sender or recipient that is a job party
   -- (job_contacts) with no CRM contact places the row on that party's job
   -- (job_party) when exactly one job matches at the message time
   -- (context_party_key_jobs) and, when both the email and the phone match,
   -- they name the same parties. Anything else stays where it was.
   IF cand IS NULL AND contact IS NULL AND NOT (e.metadata ? 'identity_conflict') AND (ek IS NOT NULL OR pk IS NOT NULL) THEN
    SELECT CASE WHEN count(DISTINCT p.job_id)=1
      AND (NOT (bool_or(p.by_email) AND bool_or(p.by_phone))
       OR array_agg(DISTINCT p.party_id ORDER BY p.party_id) FILTER (WHERE p.by_email)
        =array_agg(DISTINCT p.party_id ORDER BY p.party_id) FILTER (WHERE p.by_phone))
      THEN array_agg(DISTINCT p.job_id) END,
     count(DISTINCT p.job_id)>1 OR (bool_or(p.by_email) AND bool_or(p.by_phone)
      AND array_agg(DISTINCT p.party_id ORDER BY p.party_id) FILTER (WHERE p.by_email)
       IS DISTINCT FROM array_agg(DISTINCT p.party_id ORDER BY p.party_id) FILTER (WHERE p.by_phone))
    INTO party_ids,party_conflict FROM public.context_party_key_jobs(ek,pk,v_at) p;
    IF cardinality(party_ids)=1 THEN
     cand:=party_ids[1]; e.attribution_status:='single_open'; e.attribution_step:=3; rule:='job_party';
    ELSIF party_conflict THEN
     e.metadata:=e.metadata||jsonb_build_object('party_key_conflict',true);
    END IF;
   END IF;

   -- Stage 1 review guards (20261014170000, third review). A placement made
   -- by who sent or received the message, not by what it names, goes to
   -- review instead, with the job as the one candidate, when:
   --   review_other_site: only_open_job, and the message or the customer's
   --     messages within 7 days of it name another site, address or claim
   --     (context_contact_names_other_site);
   --   review_party_other_site: job_party, and the email's subject (else the
   --     words) names a street address that is not the job's site nor any of
   --     its parties' (context_party_names_other_site);
   --   review_outbound_no_number: our own outbound message would land on a
   --     record with no job number, a test job or a holding job;
   --   review_empty_call_before_job: a call with no words would land on a job
   --     created more than 30 days after the call.
   -- A held placement and a placement by a reference, claim, thread or site
   -- are not guarded here.
   IF cand IS NOT NULL AND (rule IN ('single_open','single_line','ranked_open','only_open_job','job_party') OR rule LIKE 'identity\_%') THEN
    guard_rule:=CASE
     WHEN rule='only_open_job' AND public.context_contact_names_other_site(contact,words,e.payload->'builder_refs',v_at,cand) THEN 'review_other_site'
     WHEN rule='job_party' AND public.context_party_names_other_site(coalesce(nullif(btrim(subj),''),words),cand) THEN 'review_party_other_site'
     WHEN e.direction='outbound' AND NOT public.context_job_real(cand) THEN 'review_outbound_no_number'
     WHEN e.event_type='client.call_logged' AND coalesce(e.payload->>'words','')<>'true'
      AND (SELECT j.created_at FROM public.jobs j WHERE j.id=cand)>v_at+interval '30 days' THEN 'review_empty_call_before_job'
    END;
    IF guard_rule IS NOT NULL THEN
     e.attribution_status:=CASE WHEN v_mode IN ('backfill','relink') THEN 'unplaced' ELSE 'pending_luna' END;
     e.attribution_step:=5; e.candidate_job_ids:=ARRAY[cand];
     e.metadata:=e.metadata||jsonb_build_object('placement_rule',guard_rule,'placement_guarded_from',rule);
     cand:=NULL;
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
       AND lower(coalesce(j.metadata->>'do_not_schedule','')) <> 'true'
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
   e.attribution_confidence:=CASE WHEN rule='held_placement' THEN coalesce(held_conf,1) ELSE 1 END; e.attributed_at:=clock_timestamp();
   e.match_status:='matched'; e.match_confidence:=CASE WHEN rule='held_placement' THEN coalesce(held_match_conf,1) ELSE 1 END;
   e.match_method:=CASE WHEN custody THEN source_method WHEN rule='payload_job' THEN 'direct_job_id' WHEN rule IN ('direct_ref','link_ref','builder_ref') THEN 'ladder_ref'
    WHEN e.attribution_status='content_ref' THEN 'content_ref' ELSE 'contact_id' END;
   -- Stage 1 (20261014170000): a stored row that rested (bucket, unplaced,
   -- review or never decided) and is placed now by a stage-1 rule or by the
   -- recipient of our own message is a re-decision. The one rule for a
   -- stored-row re-decision (context_redecided_metadata) applies, by the
   -- message's own time: older than 48 hours it is stamped capture_mode
   -- relink (prior mode in capture_mode_before), so the event listener never
   -- reads it as fresh news; within 48 hours it stays news. A row being
   -- inserted is never stamped here.
   IF (rule IN ('link_ref','builder_ref','ranked_open','only_open_job','job_party')
     OR (e.direction='outbound' AND e.metadata ? 'contact_recovered_by'))
    AND (prior_status IN ('admin_bucket','unplaced','pending_luna')
     OR (prior_status IS NULL AND EXISTS (SELECT 1 FROM public.business_events x WHERE x.id=e.id))) THEN
    e.metadata:=public.context_redecided_metadata(e.metadata,coalesce(e.event_at,e.occurred_at));
   END IF;
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
END $function$;
COMMENT ON FUNCTION public.resolve_context_attribution(public.business_events,boolean,boolean) IS
 'L1g plus unplaced stage 1 (20261014170000): the ladder (P4) as L1g left it (20261006035000), rules-on path only. Rules off: P1a''s ladder as L1e left it, unchanged. Rules on: writer check, except that a row the reader never reads (system or audit, no words, automated) keeps a custody job the service role confirmed after the insert (source_job_binding.via: confirmed_custody); a service-role outbound row marked recipient_role crew or staff handled by the L1d rule; a row with no words, an automated row or a make-safe reconcile record (stage 1) is never placed by the rules and keeps a custody job and the job a service-role writer named with no match_method (writer_job); custody with monitor-inbox re-scan; the source''s own payload job unless its writer declared it a guess; identity (payload.from read; an outbound row reads its recipient, stage 1); references, with quote and variation link tokens (link_ref, stage 1), a text naming 2 to 5 jobs going to review, and with no reference of ours a builder claim naming one job, narrowed by one purchase order of that claim (builder_ref, stage 1); live thread and supplier order bindings; contact rules with keys and aftercare, where a row a contact rule or Luna already put on a job keeps it instead of going to review or the bucket while that job is still the answer (held_placement, placement_held_from names the rule it outranked; a newer job reopens a placed row only through P1b at its insert); then (stage 1) ranking of a contact review (context_rank_contact_set: jobs that cannot be a customer''s and quotes dead before the message leave; one job left and no finished work places, ranked_open; never by status now or creation date), a known customer whose only job is live and was created within 60 days after the message (only_open_job); a job party''s key with no CRM contact, one job at the message time and no disagreement between email and phone (job_party, stage 1); review guards (stage 1, third review): a placement by who sent or received the message goes to review with its job as the one candidate when only_open_job meets another site, address or claim in the message or the customer''s messages within 7 days (review_other_site), a job_party email''s subject names another street address than the job''s or its parties'' (review_party_other_site), our outbound message would land on a record with no job number (review_outbound_no_number), or a call with no words would land on a job created over 30 days after it (review_empty_call_before_job); exact or loose site address (several exact matches go to review); bucket. A stored row a stage-1 rule places follows context_redecided_metadata (a message older than 48 hours is capture_mode relink). Always stamps metadata.bucket_reason on a bucket row. p_preview writes nothing. p_rules_on null reads the flag.';

CREATE OR REPLACE FUNCTION public.context_reconsider_contact(p_contact_id text, p_since timestamp with time zone, p_reason text, p_job_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
 c record; e public.business_events; resolved public.business_events;
 v_until timestamptz; v_at timestamptz; v_start timestamptz:=clock_timestamp(); v_set uuid[]; v_cands uuid[]; v_note jsonb; v_mode jsonb;
 n_seen int:=0; n_placed int:=0; n_review int:=0; n_reopened int:=0; n_widened int:=0; n_unchanged int:=0;
 n_busy int:=0;
 v_limit constant int:=500; v_budget constant interval:='2 seconds'; v_truncated text;
BEGIN
 -- Stage 1 (20261014170000): job_contact_linked, a job that gets its GHL
 -- contact after its insert (the patio path), reconsiders like a new job,
 -- up to the moment of the link rather than the job's creation.
 IF p_reason IS NULL OR p_reason NOT IN ('job_created','job_contact_linked') THEN RAISE EXCEPTION 'context_reconsider_contact: unknown reason'; END IF;
 IF p_job_id IS NULL THEN RAISE EXCEPTION 'context_reconsider_contact: % needs the job',p_reason; END IF;
 IF nullif(btrim(p_contact_id),'') IS NULL THEN RETURN jsonb_build_object('outcome','no_contact'); END IF;
 IF NOT public.automation_lane_enabled('attribution') THEN RETURN jsonb_build_object('outcome','lane_off'); END IF;
 -- The lead window ends at the job's creation (rules 6 and 7).
 SELECT coalesce(j.created_at,now()) INTO v_until FROM public.jobs j WHERE j.id=p_job_id;
 IF NOT FOUND THEN RETURN jsonb_build_object('outcome','no_job'); END IF;
 IF p_reason='job_contact_linked' THEN v_until:=clock_timestamp(); END IF;
 FOR c IN
  SELECT b.id, coalesce(b.event_at,b.occurred_at) AS at FROM public.business_events b
  WHERE b.contact_id=p_contact_id
   AND coalesce(b.event_at,b.occurred_at)>=coalesce(p_since,'-infinity'::timestamptz)
   AND coalesce(b.event_at,b.occurred_at)<=v_until
   AND public.context_reconsider_eligible(b,p_job_id)
  -- Newest first: the rows nearest the new job matter most if the cap is hit.
  ORDER BY coalesce(b.event_at,b.occurred_at) DESC,b.id DESC
  LIMIT v_limit+1
 LOOP
  IF n_seen>=v_limit THEN v_truncated:='row_cap'; EXIT; END IF;
  IF clock_timestamp()-v_start>v_budget THEN v_truncated:='time_budget'; EXIT; END IF;
  n_seen:=n_seen+1;
  -- Cheap test first, no lock: is the new job a candidate at this row's time?
  SELECT coalesce(array_agg(j.job_id ORDER BY j.created_at,j.job_id),'{}') INTO v_set FROM public.context_contact_jobs_at(p_contact_id,c.at) j;
  IF NOT (p_job_id=ANY(v_set)) THEN n_unchanged:=n_unchanged+1; CONTINUE; END IF;
  -- Never wait on a row another session holds (say, Luna placing it): skip it.
  SELECT * INTO e FROM public.business_events b WHERE b.id=c.id FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN
   IF EXISTS(SELECT 1 FROM public.business_events b WHERE b.id=c.id) THEN n_busy:=n_busy+1; ELSE n_unchanged:=n_unchanged+1; END IF;
   CONTINUE;
  END IF;
  -- Re-check under the lock: the row may have changed since the scan.
  IF e.contact_id IS DISTINCT FROM p_contact_id OR NOT public.context_reconsider_eligible(e,p_job_id) THEN n_unchanged:=n_unchanged+1; CONTINUE; END IF;
  v_at:=coalesce(e.event_at,e.occurred_at);
  IF v_at IS DISTINCT FROM c.at THEN
   IF v_at<coalesce(p_since,'-infinity'::timestamptz) OR v_at>v_until THEN n_unchanged:=n_unchanged+1; CONTINUE; END IF;
   SELECT coalesce(array_agg(j.job_id ORDER BY j.created_at,j.job_id),'{}') INTO v_set FROM public.context_contact_jobs_at(p_contact_id,v_at) j;
   IF NOT (p_job_id=ANY(v_set)) THEN n_unchanged:=n_unchanged+1; CONTINUE; END IF;
  END IF;
  v_note:=jsonb_build_object('reason',p_reason,'job_id',p_job_id,'at',clock_timestamp());

  IF e.job_id IS NULL AND (e.attribution_status IS NULL OR e.attribution_status='admin_bucket') THEN
   -- (a) Before any job: the ladder decides with the new job now a candidate.
   resolved:=public.resolve_context_attribution(e);
   -- Only a placement or a review case is a move; anything else is left for
   -- the bucket re-run exactly as it was.
   IF resolved.job_id IS NULL AND resolved.attribution_status IS DISTINCT FROM 'pending_luna' THEN
    n_unchanged:=n_unchanged+1; CONTINUE;
   END IF;
   UPDATE public.business_events SET
    job_id=resolved.job_id,contact_id=resolved.contact_id,
    attribution_status=resolved.attribution_status,attribution_step=resolved.attribution_step,
    attribution_confidence=resolved.attribution_confidence,attributed_at=resolved.attributed_at,
    attribution_checked_at=resolved.attribution_checked_at,event_at=resolved.event_at,
    match_status=resolved.match_status,match_method=resolved.match_method,match_confidence=resolved.match_confidence,
    candidate_job_ids=resolved.candidate_job_ids,payload=resolved.payload,
    -- Stage 1: a stored row placed or sent to review because its job got
    -- its contact late follows the one re-decision rule by the message's
    -- time (context_redecided_metadata): older than 48 hours, relink.
    metadata=CASE WHEN p_reason='job_contact_linked'
      THEN public.context_redecided_metadata(coalesce(resolved.metadata,'{}'::jsonb),v_at)
      ELSE coalesce(resolved.metadata,'{}'::jsonb) END||jsonb_build_object(
     'placement_reconsidered',v_note||jsonb_build_object('from_status',coalesce(e.attribution_status,'none')))
   WHERE id=e.id;
   IF resolved.job_id IS NOT NULL THEN n_placed:=n_placed+1; ELSE n_review:=n_review+1; END IF;

  ELSIF e.job_id IS NULL AND e.attribution_status='pending_luna' THEN
   -- (c) Already waiting for review: the new job joins its stored candidates.
   SELECT array_agg(x ORDER BY o) INTO v_cands FROM (
    SELECT x, min(o) AS o FROM unnest(coalesce(e.candidate_job_ids,'{}'::uuid[])||v_set) WITH ORDINALITY AS u(x,o) GROUP BY x) d;
   UPDATE public.business_events SET candidate_job_ids=v_cands,attribution_checked_at=clock_timestamp(),
    metadata=coalesce(metadata,'{}'::jsonb)||jsonb_build_object('placement_candidates_widened',v_note)
   WHERE id=e.id;
   n_widened:=n_widened+1;

  ELSE
   -- (b) resting unplaced, or (d) placed on a sibling by a contact rule:
   -- back to review, once, with the old job, the new job and every candidate
   -- at its time.
   v_mode:=coalesce(e.metadata->'capture_mode_before',to_jsonb(coalesce(e.metadata->>'capture_mode','live')));
   SELECT array_agg(x ORDER BY o) INTO v_cands FROM (
    SELECT x, min(o) AS o FROM unnest(coalesce(e.candidate_job_ids,'{}'::uuid[])||CASE WHEN e.job_id IS NOT NULL THEN ARRAY[e.job_id] ELSE '{}'::uuid[] END||v_set)
     WITH ORDINALITY AS u(x,o) GROUP BY x) d;
   IF e.job_id IS NOT NULL THEN
    v_note:=v_note||jsonb_build_object('from_status',e.attribution_status,'from_job_id',e.job_id,'from_step',e.attribution_step,
     'from_confidence',e.attribution_confidence,'from_attributed_at',e.attributed_at);
   ELSE
    v_note:=v_note||jsonb_build_object('from_status',e.attribution_status);
   END IF;
   UPDATE public.business_events SET job_id=NULL,attribution_status='pending_luna',attribution_step=5,
    attribution_confidence=NULL,attributed_at=NULL,attribution_checked_at=clock_timestamp(),
    match_status='unresolved',match_method='none',match_confidence=NULL,candidate_job_ids=v_cands,
    -- Stage 1: a resting unplaced row a late contact sends to review follows
    -- the one re-decision rule by the message's time; a row taken off a job
    -- it was already placed on is always relink, as P1b does.
    metadata=CASE WHEN p_reason='job_contact_linked' AND e.job_id IS NULL
      THEN public.context_redecided_metadata(coalesce(metadata,'{}'::jsonb),v_at)
      ELSE coalesce(metadata,'{}'::jsonb)||jsonb_build_object('capture_mode','relink','capture_mode_before',v_mode) END
     ||jsonb_build_object('placement_rule','reopen_new_job','placement_reconsidered',v_note)
   WHERE id=e.id;
   n_reopened:=n_reopened+1;
  END IF;
 END LOOP;
 RETURN jsonb_build_object('outcome','done','reason',p_reason,'job_id',p_job_id,'seen',n_seen,'placed',n_placed,
  'to_review',n_review,'reopened',n_reopened,'widened',n_widened,'unchanged',n_unchanged,'skipped_busy',n_busy,
  'truncated',v_truncated);
END $function$;
COMMENT ON FUNCTION public.context_reconsider_contact(text,timestamptz,text,uuid) IS
 'Reconsiders a GHL contact''s messages between p_since and the job''s creation (reason job_created) or, since unplaced stage 1 (20261014170000), the moment the job got this contact by update (reason job_contact_linked), when that job is a candidate at their time: bucket rows re-run the ladder; unplaced rows and rows placed on a sibling by single_open, single_line or luna go back to review once with the job added; review rows gain it as a candidate. Sibling reopens are capture_mode relink; a job_created first bind or unplaced reopen keeps P1b''s marks; a job_contact_linked placement, review case or unplaced reopen follows context_redecided_metadata (a message older than 48 hours is relink). Never direct, thread, content_ref or party placements; never waits on a locked row. Returns counts.';

CREATE OR REPLACE FUNCTION public.context_redecide_resting(p_status text DEFAULT 'unplaced'::text, p_before_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_before_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE c record; v_out text; v_rows int:=0;
 v_start timestamptz:=clock_timestamp(); n_placed int:=0; n_review int:=0; n_out int:=0; n_unchanged int:=0; n_busy int:=0;
 v_last_at timestamptz; v_last_id uuid; v_truncated boolean:=false;
 v_limit constant int:=200; v_budget constant interval:='20 seconds';
BEGIN
 IF p_status IS NULL OR p_status NOT IN ('unplaced','admin_bucket') THEN RAISE EXCEPTION 'context_redecide_resting: status must be unplaced or admin_bucket'; END IF;
 IF (p_before_at IS NULL) <> (p_before_id IS NULL) THEN RAISE EXCEPTION 'context_redecide_resting: pass both cursor parts or neither'; END IF;
 IF NOT public.automation_lane_enabled('attribution') THEN RETURN jsonb_build_object('outcome','lane_off'); END IF;
 FOR c IN
  SELECT b.id, coalesce(b.event_at,b.occurred_at,'-infinity'::timestamptz) AS at FROM public.business_events b
  WHERE b.job_id IS NULL AND b.attribution_status=p_status
   AND (p_before_at IS NULL OR (coalesce(b.event_at,b.occurred_at,'-infinity'::timestamptz),b.id)<(p_before_at,p_before_id))
  ORDER BY coalesce(b.event_at,b.occurred_at,'-infinity'::timestamptz) DESC,b.id DESC
  LIMIT v_limit
 LOOP
  IF clock_timestamp()-v_start>v_budget THEN v_truncated:=true; EXIT; END IF;
  v_rows:=v_rows+1;
  v_out:=public.context_redecide_one(c.id,'hand_run',jsonb_build_object('status',p_status));
  CASE v_out WHEN 'placed' THEN n_placed:=n_placed+1; WHEN 'review' THEN n_review:=n_review+1;
   WHEN 'taken_out' THEN n_out:=n_out+1; WHEN 'busy' THEN n_busy:=n_busy+1; ELSE n_unchanged:=n_unchanged+1; END CASE;
  v_last_at:=c.at; v_last_id:=c.id;
 END LOOP;
 RETURN jsonb_build_object('outcome','done','status',p_status,'seen',v_rows,'placed',n_placed,'to_review',n_review,
  'taken_out',n_out,'unchanged',n_unchanged,'skipped_busy',n_busy,
  'finished',(NOT v_truncated AND v_rows<v_limit),
  'next',CASE WHEN v_last_id IS NOT NULL AND (v_truncated OR v_rows>=v_limit)
   THEN jsonb_build_object('before_at',v_last_at,'before_id',v_last_id) END);
END $function$;
COMMENT ON FUNCTION public.context_redecide_resting(text,timestamptz,uuid) IS
 'Unplaced stage 1 (20261014170000): the hand run. Walks rows with no job resting in p_status (unplaced or admin_bucket) newest first by message time then id, strictly before the cursor (p_before_at, p_before_id: the previous answer''s next), through context_redecide_one (hand_run); at most 200 rows and 20 seconds a call; answers counts, finished, and next (the cursor for the following call, null when finished). Never run by the migration. Service role only.';

CREATE OR REPLACE FUNCTION public.context_redecide_one(p_id uuid, p_reason text, p_detail jsonb DEFAULT NULL::jsonb)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE e public.business_events; resolved public.business_events; v_note jsonb; v_outcome text;
BEGIN
 IF p_reason IS NULL OR p_reason NOT IN ('thread_bound','invoice_linked','hand_run') THEN
  RAISE EXCEPTION 'context_redecide_one: unknown reason';
 END IF;
 SELECT * INTO e FROM public.business_events b WHERE b.id=p_id FOR UPDATE SKIP LOCKED;
 IF NOT FOUND THEN
  RETURN CASE WHEN EXISTS(SELECT 1 FROM public.business_events b WHERE b.id=p_id) THEN 'busy' ELSE 'unchanged' END;
 END IF;
 IF e.job_id IS NOT NULL OR coalesce(e.attribution_status,'admin_bucket') NOT IN ('admin_bucket','unplaced') THEN RETURN 'unchanged'; END IF;
 resolved:=public.resolve_context_attribution(e);
 v_outcome:=CASE WHEN resolved.job_id IS NOT NULL THEN 'placed'
  WHEN resolved.attribution_status='pending_luna' AND e.attribution_status IS DISTINCT FROM 'unplaced'
   AND NOT (coalesce(e.metadata,'{}'::jsonb) ? 'luna_outcome') THEN 'review'
  WHEN resolved.attribution_status IN ('automated','empty') THEN 'taken_out' END;
 IF v_outcome IS NULL THEN RETURN 'unchanged'; END IF;
 v_note:=jsonb_build_object('reason',p_reason,'at',clock_timestamp(),'from_status',coalesce(e.attribution_status,'none'))
  ||coalesce(p_detail,'{}'::jsonb);
 resolved.metadata:=coalesce(resolved.metadata,'{}'::jsonb)||jsonb_build_object('placement_redecided',v_note);
 IF v_outcome IN ('placed','review') THEN
  resolved.metadata:=public.context_redecided_metadata(resolved.metadata,coalesce(resolved.event_at,resolved.occurred_at));
 END IF;
 UPDATE public.business_events SET
  job_id=resolved.job_id,contact_id=resolved.contact_id,
  attribution_status=resolved.attribution_status,attribution_step=resolved.attribution_step,
  attribution_confidence=resolved.attribution_confidence,attributed_at=resolved.attributed_at,
  attribution_checked_at=resolved.attribution_checked_at,event_at=resolved.event_at,
  match_status=resolved.match_status,match_method=resolved.match_method,match_confidence=resolved.match_confidence,
  candidate_job_ids=resolved.candidate_job_ids,payload=resolved.payload,metadata=resolved.metadata
 WHERE id=e.id;
 RETURN v_outcome;
END $function$;
COMMENT ON FUNCTION public.context_redecide_one(uuid,text,jsonb) IS
 'Unplaced stage 1 (20261014170000): re-runs the ladder on one row with no job resting in the bucket or unplaced (reasons thread_bound, invoice_linked, hand_run) and writes only a placement (placed), a review case for a bucket row the model has not answered (review) or a machine or empty row taken out with no job (taken_out), with metadata.placement_redecided; anything else is unchanged (an unplaced row is never sent to the model again). A placement or review case follows context_redecided_metadata (a message older than 48 hours is capture_mode relink). A locked row is busy. Service role only.';

CREATE OR REPLACE FUNCTION public.context_reconsider_eligible(e business_events, p_job_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
 SELECT coalesce(
  ((e.job_id IS NULL AND (e.attribution_status IS NULL OR e.attribution_status IN ('admin_bucket','unplaced','pending_luna')))
   OR (e.job_id IS NOT NULL AND e.job_id<>p_job_id AND e.attribution_status IN ('single_open','single_line','luna')))
  -- Once per event: never a row that already names this job as a candidate
  -- or was already reconsidered for it.
  AND NOT (p_job_id=ANY(coalesce(e.candidate_job_ids,'{}'::uuid[])))
  AND coalesce(e.metadata->'placement_reconsidered'->>'job_id','') IS DISTINCT FROM p_job_id::text
  AND coalesce(e.metadata->'placement_candidates_widened'->>'job_id','') IS DISTINCT FROM p_job_id::text,
 false)
$function$;
COMMENT ON FUNCTION public.context_reconsider_eligible(public.business_events,uuid) IS
 'Private to context_reconsider_contact: a row it may reconsider for a new job (bucket, unplaced, pending review, or placed on another job by single_open, single_line or luna), not already offered that job.';

DROP FUNCTION IF EXISTS public.context_empty_row_job(public.business_events);
