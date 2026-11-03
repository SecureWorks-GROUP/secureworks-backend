-- Undo 20261104102000_context_c2_not_job_senders: context_bucket_reason_detail is the 20260924183000 definition again, word
-- for word (md5(prosrc) 78cad84dc555a47155e6bc614bbba3b8), so a message with no job, no customer and no live site ends as
-- no_identity whoever sent it; the trigger context_a0_entity_contact and its function context_entity_contact_fill, and
-- context_not_job_sender, are dropped. context_sender_register is dropped when empty; a register with rows is kept (it is
-- inert without context_not_job_sender; its rows are the reviewed list, kept for a re-apply). Rows already re-decided keep
-- the reason they were given and their contact_id: re-decide them again to take the old answer.
-- Refuses while a later body has replaced context_bucket_reason_detail (roll that back first).
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $down$
DECLARE v_live text; v_rows bigint := 0;
BEGIN
  SELECT md5(prosrc) INTO v_live FROM pg_proc WHERE oid = to_regprocedure('public.context_bucket_reason_detail(public.business_events,jsonb)');
  IF v_live IS NULL OR v_live NOT IN ('78cad84dc555a47155e6bc614bbba3b8', '1c3b05a8d875d55ebca37671857010a9') THEN
    RAISE EXCEPTION 'context_bucket_reason_detail is not the 20261104090000 definition (md5 %); roll the later one back first', coalesce(v_live, '<missing>');
  END IF;
  IF v_live = '1c3b05a8d875d55ebca37671857010a9' THEN
    -- The exact definition before 20261104090000, as pg_get_functiondef printed it.
    EXECUTE $old_def$CREATE OR REPLACE FUNCTION public.context_bucket_reason_detail(e business_events, p_site_index jsonb DEFAULT NULL::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE d jsonb:='{}'; txt text; toks text[]; ref_ids uuid[]; unfound text[]; kind text; ek text; pk text;
 contact text; n_contacts int; at timestamptz; tl record; site_text text; exact_keys text[]; loose text[];
 exact_ids text[]; loose_ids text[]; site jsonb;
BEGIN
 IF e.payload ? 'attribution_error' THEN
  RETURN jsonb_build_object('reason',CASE WHEN e.payload->>'attribution_error'='thread_conflict' THEN 'thread_conflict' ELSE 'error' END);
 END IF;
 IF e.metadata ? 'written_as' AND e.metadata->>'written_as'<>'service_role' THEN
  RETURN jsonb_build_object('reason','unverified_writer');
 END IF;
 -- A hint is a job the ladder took off the row. On a row recorded before the
 -- ladder existed (20260911171000, read as 11 Sep 17:10 Perth) only a later
 -- re-run can have taken it: re-stamped legacy. After that, the ladder took it
 -- at insert because the writer gave no allowed method: hint stripped.
 -- (attribution_checked_at cannot tell them apart: every re-run re-checks
 -- every bucket row.)
 IF e.metadata ? 'attribution_hint' THEN
  d:=jsonb_build_object('hint_job_id',e.metadata->'attribution_hint'->>'job_id',
   'hint_method',coalesce(e.metadata->'attribution_hint'->>'match_method','none'));
  IF coalesce(e.recorded_at,e.context_captured_at,e.occurred_at)<'2026-09-11 09:10:00+00' THEN
   RETURN d||jsonb_build_object('reason','restamped_legacy');
  END IF;
  RETURN d||jsonb_build_object('reason','hint_stripped');
 END IF;
 kind:=public.context_event_sender_kind(e);
 d:=jsonb_build_object('sender_kind',kind);
 IF kind='platform' THEN RETURN d||jsonb_build_object('reason','platform_sender'); END IF;
 txt:=public.context_bucket_text(e);
 toks:=public.context_job_ref_tokens(txt);
 IF cardinality(toks)>0 THEN
  SELECT array_agg(DISTINCT r.job_id ORDER BY r.job_id) INTO ref_ids FROM public.context_ref_jobs(toks) r;
 END IF;
 IF cardinality(ref_ids)>5 THEN RETURN d||jsonb_build_object('reason','multi_ref_many','ref_job_ids',to_jsonb(ref_ids)); END IF;
 IF cardinality(ref_ids)>1 THEN RETURN d||jsonb_build_object('reason','multi_ref','ref_job_ids',to_jsonb(ref_ids)); END IF;
 IF cardinality(ref_ids)=1 THEN RETURN d||jsonb_build_object('reason','single_ref','ref_job_ids',to_jsonb(ref_ids)); END IF;
 SELECT array_agg(t ORDER BY t) INTO unfound FROM unnest(toks) t WHERE t ~ '^SW[A-Z]{0,4}-?[0-9]{4,}';
 IF cardinality(unfound)>0 THEN RETURN d||jsonb_build_object('reason','ref_not_found','ref_not_found',to_jsonb(unfound)); END IF;
 contact:=nullif(btrim(e.contact_id),'');
 IF contact IS NULL THEN
  SELECT i.email_key,i.phone_key INTO ek,pk FROM public.context_event_identity(e) i;
  IF ek IS NOT NULL OR pk IS NOT NULL THEN
   SELECT c.contact_id,c.contacts INTO contact,n_contacts FROM public.context_contact_for_key(ek,pk) c;
   d:=d||jsonb_build_object('identity',jsonb_build_object('email',ek IS NOT NULL,'phone',pk IS NOT NULL,'contacts',n_contacts));
   IF n_contacts>1 THEN RETURN d||jsonb_build_object('reason','identity_conflict'); END IF;
   IF n_contacts=1 THEN RETURN d||jsonb_build_object('reason','identity_unread'); END IF;
  END IF;
 ELSE
  at:=coalesce(e.event_at,e.occurred_at);
  SELECT count(*) FILTER (WHERE t.candidate) AS cand, count(*) AS total,
   count(*) FILTER (WHERE t.terminal AND t.terminal_at<=at) AS finished,
   count(*) FILTER (WHERE t.terminal AND t.terminal_at<=at AND t.terminal_at>=at-interval '60 days') AS recent
  INTO tl FROM public.context_contact_job_timeline(contact,at) t;
  d:=d||jsonb_build_object('contact_jobs',tl.total,'contact_candidates',tl.cand);
  IF tl.cand>0 THEN RETURN d||jsonb_build_object('reason','contact_has_candidates'); END IF;
  IF tl.total=0 THEN RETURN d||jsonb_build_object('reason','contact_no_jobs'); END IF;
  IF tl.finished>0 THEN RETURN d||jsonb_build_object('reason','contact_only_finished','aftercare_window',tl.recent>0); END IF;
  RETURN d||jsonb_build_object('reason','before_any_job');
 END IF;
 -- No customer identity: a site address (subject plus the first 1,500 characters).
 site_text:=coalesce(nullif(btrim(e.payload->>'subject'),'')||E'\n','')||left(public.context_event_text(e),1500);
 SELECT array_agg(DISTINCT m.address_key) FILTER (WHERE m.address_key IS NOT NULL),
  array_agg(DISTINCT lk) INTO exact_keys, loose
 FROM public.context_address_mentions(site_text) m LEFT JOIN LATERAL unnest(m.loose_keys) lk ON true;
 IF cardinality(loose)>0 THEN
  site:=coalesce(p_site_index,public.context_live_site_index(loose));
  SELECT array_agg(DISTINCT x ORDER BY x) INTO exact_ids
  FROM unnest(coalesce(exact_keys,'{}')) k, jsonb_array_elements_text(coalesce(site->'exact'->k,'[]')) x;
  SELECT array_agg(DISTINCT x ORDER BY x) INTO loose_ids
  FROM unnest(loose) k, jsonb_array_elements_text(coalesce(site->'loose'->k,'[]')) x;
  IF cardinality(loose_ids)>0 THEN
   RETURN d||jsonb_build_object('reason','no_identity_site','site_exact_job_ids',coalesce(to_jsonb(exact_ids),'[]'::jsonb),
    'site_loose_job_ids',to_jsonb(loose_ids));
  END IF;
 END IF;
 IF kind='supplier' THEN RETURN d||jsonb_build_object('reason','supplier_no_ref'); END IF;
 IF kind='ours' THEN RETURN d||jsonb_build_object('reason','own_party'); END IF;
 RETURN d||jsonb_build_object('reason','no_identity');
END $function$$old_def$;
  END IF;
  SELECT md5(prosrc) INTO v_live FROM pg_proc WHERE oid = 'public.context_bucket_reason_detail(public.business_events,jsonb)'::regprocedure;
  IF v_live <> '78cad84dc555a47155e6bc614bbba3b8' THEN
    RAISE EXCEPTION 'context_bucket_reason_detail after the undo is not the old definition (md5 %)', v_live;
  END IF;
  DROP TRIGGER IF EXISTS context_a0_entity_contact ON public.business_events;
  DROP FUNCTION IF EXISTS public.context_entity_contact_fill();
  DROP FUNCTION IF EXISTS public.context_not_job_sender(public.business_events);
  IF to_regclass('public.context_sender_register') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM public.context_sender_register' INTO v_rows;
    IF v_rows = 0 THEN
      DROP TABLE public.context_sender_register;
    ELSE
      RAISE NOTICE 'context_sender_register kept: % reviewed rows (inert without context_not_job_sender)', v_rows;
    END IF;
  END IF;
END
$down$;
