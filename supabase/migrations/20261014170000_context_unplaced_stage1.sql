-- Unplaced stage 1: customer messages that sit on no job (14 Oct 2026).
--
-- Why: of 1,534 rows unplaced on 14 Oct 2026 (diagnosis, firstmate home
-- data/cio-ctx-unlinked-diagnosis/report.md), 154 are make-safe reconcile
-- machine records and 289 are builder, council, supplier, staff mail and CRM
-- notes; about 111 more carry an identifier we already hold that the ladder
-- never reads; our own outbound email never identified its customer; a job
-- that got its GHL contact after its insert (the patio path) never reopened
-- earlier messages; nothing re-decided an unplaced row when new evidence
-- arrived; and a customer with one open job and a closed, numberless or test
-- job beside it went to review. This is stage 1 of the permanent fix
-- (diagnosis section 5 items 1, 2 and 3, plus candidate ranking). Property
-- (several-jobs) placement, opening notes from held rows and the staff tool
-- wait on owner calls and are not here. Note: ranked_recent on aftercare
-- places a finished job's later message on that job, which the 24 Sep 2026
-- aftercare decision (N7, N17) kept for review.
--
-- Changed (rules on only; the rules-off ladder, the entry, the insert
-- trigger, the preview, the timeline, Luna and the flag are unchanged):
--   1. Machine: makesafe.reconcile.* rows are automated when the ladder
--      decides them (insert, or any re-decision), never unplaced. Non-customer
--      rows are counted in their own lane by the monitor (6). Nothing deleted.
--   2. Identifiers: quote and variation link tokens are references
--      (link_ref); with no reference of ours, a builder purchase order or
--      claim naming exactly one job places the row (builder_ref); our own
--      outbound email or text reads its recipient (payload.to) as identity;
--      a sender or recipient that is a job party (job_contacts) with no CRM
--      contact places on that party's one job, or one open job (job_party).
--   3. Re-decision on new evidence: a new live thread binding, an ACCREC
--      invoice newly linked to a job whose number a resting row carries, and
--      a job that gets its GHL contact by update (reconsidering from the
--      job's lead window to the moment of the link) re-decide resting rows.
--   4. Ranking (agreed 14 Oct 2026, step 1 of the context plan): closed,
--      numberless and test (SW*-CANARY-*) jobs leave the candidate set
--      of a contact review (several jobs, a recently finished job beside a
--      live one, aftercare), of a text naming 2 to 5 of our jobs and of an
--      exact address matching 2 to 3 jobs. One live job left places on it
--      (ranked_open); none live places on the most recently created
--      numbered one (ranked_recent); two or more live stay for review. Identity conflicts
--      and loose address matches are never ranked. A known customer with no
--      candidate at the message time whose only live job is X places on X
--      (only_open_job). A ranked placement is single_open: it never makes a
--      thread binding, which only proof may make (X25).
--   5. Monitor: the bucket block of context_pipeline_status counts unplaced
--      and bucket rows by lane and alarms when the customer lane rises over
--      context_unplaced_policy().
--   6. Relink: a stored row (captured over an hour ago) that a stage-1 rule
--      or re-decision binds or sends to review is stamped capture_mode
--      relink, prior mode in capture_mode_before, as the 7 Oct repair did and
--      as the daily re-check does in 20261014034549 (PR 1040). This
--      migration does not touch rerun_context_attribution or
--      context_core_status, so the two apply in either order.
--
-- No data moves: rows change only when inserted or re-decided. The resting
-- rows of 14 Oct are re-decided only by a hand run of
-- context_redecide_events (docs/context/unplaced-stage1.md), not run here.
--
-- Replaces (built on the live definitions, read with pg_get_functiondef):
--   resolve_context_attribution(business_events,boolean,boolean) L1g (20261006035000) md5(prosrc) 0faf9b6362c35225b8eca7beba887d99
--   context_event_identity(business_events) B0 (20260924183000) cc484b96d670d401a3457347884f5371
--   context_reconsider_contact(text,timestamptz,text,uuid) P1b (20260924160000) 5f9dbe883f0add7a6987f3ed265a08af
--   context_bucket_status() F1b stub (20260924152100) 155104bfb08b8b3c2f98bdec089d4ee4
-- Rollback: supabase/rollbacks/20261014170000_context_unplaced_stage1_down.sql
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- 0. Pre-image guard. Reports every problem at once.
DO $guard$
DECLARE problems text[]:='{}'; live text; x record;
BEGIN
 FOR x IN SELECT * FROM (VALUES
  ('public.resolve_context_attribution(public.business_events,boolean,boolean)',ARRAY['0faf9b6362c35225b8eca7beba887d99','347d82db89617a0b6e9de65b9d19fd4d']),
  ('public.context_event_identity(public.business_events)',ARRAY['cc484b96d670d401a3457347884f5371','ec1f67645b889441791d433d5fe08339']),
  ('public.context_reconsider_contact(text,timestamptz,text,uuid)',ARRAY['5f9dbe883f0add7a6987f3ed265a08af','f42d3c1e27207295f39288c24030e5ba']),
  ('public.context_bucket_status()',ARRAY['155104bfb08b8b3c2f98bdec089d4ee4','1ac0e031034928239810432d213ed77e']),
  -- Read, not replaced.
  ('public.context_ladder_p1a(public.business_events,boolean)',ARRAY['ce620833c851196a00eca328d9b7426a']),
  ('public.resolve_context_attribution(public.business_events)',ARRAY['32365101d23dde1695707a0bddff640b']),
  ('public.attribute_business_event()',ARRAY['d0036a1bc36f4b2a779f4a8b192cd687']),
  ('public.context_job_created_reconsider()',ARRAY['2e199e27d38730e95bd5f2b0b8a9b165']),
  ('public.context_reconsider_eligible(public.business_events,uuid)',ARRAY['375857877700389aa8f6f730095b8800']),
  ('public.context_contact_job_timeline(text,timestamptz,text,text)',ARRAY['f98da204718a4d5ac6395761a963ced4']),
  ('public.context_contact_job_timeline(text,timestamptz)',ARRAY['2bc8e76f14fda242eb6e4d414e93fefa']),
  ('public.context_ref_jobs(text[])',ARRAY['f21ce8cf72292e016daf18d1ee5e9a8c']),
  ('public.context_job_ref_tokens(text)',ARRAY['c8c7dac3f00d9aa620fb230dfd3a2791']),
  ('public.context_bucket_text(public.business_events)',ARRAY['398e21232ca6eb425f882a39840c7b4a']),
  ('public.context_email_key(text)',ARRAY['bccbc990823518e71004ed4bd1d4b54b']),
  ('public.context_phone_key(text)',ARRAY['ad18564daffd9bb955949dbd4a5282c1']),
  ('public.context_event_sender_kind(public.business_events)',ARRAY['8d0c96101aa111dd540371953f4f12ad']),
  ('public.context_pipeline_status()',ARRAY['9183a756c0d4b3881507656751c0d422'])
 ) AS t(sig,accepted) LOOP
  live:=NULL;
  SELECT md5(p.prosrc) INTO live FROM pg_proc p WHERE p.oid=to_regprocedure(x.sig);
  IF live IS NULL OR NOT live=ANY(x.accepted) THEN problems:=problems||format('%s md5 %s',x.sig,coalesce(live,'<missing>')); END IF;
 END LOOP;
 IF cardinality(problems)>0 THEN
  RAISE EXCEPTION 'context_unplaced_stage1_preimage_mismatch: %; read the live definitions before replacing them',array_to_string(problems,'; ');
 END IF;
END $guard$;

-- 1. Helpers (new). Each computes; none places or writes.

-- Candidate ranking (agreed 14 Oct 2026, step 1 of the context plan): a
-- live job is one not closed (cancelled, complete, archived, lost,
-- invoiced, closed, or the archived flag), has a job number and is not a
-- test job. Every job with no number is an old-system record from before
-- April 2026 that the dashboard hides (1,245 on 14 Oct 2026), so it never
-- counts as live, not only a numberless draft.
CREATE OR REPLACE FUNCTION public.context_job_live(p_job_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT coalesce((
  SELECT NOT (j.status::text IN ('cancelled','archived','lost','closed','complete','completed','invoiced') OR coalesce(j.archived,false))
   AND nullif(btrim(coalesce(j.job_number,'')),'') IS NOT NULL
   AND coalesce(j.job_number,'') !~* 'CANARY'
  FROM public.jobs j WHERE j.id=p_job_id),false)
$$;
COMMENT ON FUNCTION public.context_job_live(uuid) IS
 'Unplaced stage 1 (20261014170000): a live job for candidate ranking: not closed (cancelled, complete, completed, archived, lost, invoiced, closed, or archived flag), has a job number (a numberless job is a hidden old-system record), and not a test job (SW*-CANARY-*).';

-- One job from a candidate set: the one live job (ranked_open); with none
-- live, the most recently created numbered job that is not a test job
-- (ranked_recent); two or more live, none.
CREATE OR REPLACE FUNCTION public.context_pick_ranked(p_ids uuid[])
RETURNS TABLE(job_id uuid, how text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 WITH c AS (
  SELECT j.id, j.created_at, public.context_job_live(j.id) AS live,
   nullif(btrim(coalesce(j.job_number,'')),'') IS NOT NULL AND j.job_number !~* 'CANARY' AS numbered
  FROM public.jobs j WHERE j.id=ANY(coalesce(p_ids,'{}'::uuid[]))
   AND coalesce(j.metadata->>'do_not_schedule','') NOT IN ('true','1')
 ), n AS (SELECT count(*) FILTER (WHERE live) AS live_n FROM c)
 SELECT c.id, 'ranked_open'::text FROM c, n WHERE n.live_n=1 AND c.live
 UNION ALL
 SELECT x.id, 'ranked_recent'::text FROM n, LATERAL (
  SELECT c.id FROM c WHERE c.numbered ORDER BY c.created_at DESC NULLS LAST, c.id DESC LIMIT 1) x
 WHERE n.live_n=0
$$;
COMMENT ON FUNCTION public.context_pick_ranked(uuid[]) IS
 'Unplaced stage 1 (20261014170000): candidate ranking agreed 14 Oct 2026. Closed, numberless and test jobs leave the set (context_job_live); exactly one live job left: that job, how ranked_open; none live: the most recently created numbered, non-test candidate, how ranked_recent (none such: no row); two or more live: no row (stays for review). Never a holding job.';

-- Quote and variation link tokens (send-quote view?token=<uuid>) to their job.
CREATE OR REPLACE FUNCTION public.context_link_ref_jobs(p_text text)
RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 WITH t AS (
  SELECT DISTINCT lower(m[1]) AS tok
  FROM regexp_matches(coalesce(p_text,''),'token=([0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12})','g') m
 ), j AS (
  SELECT d.job_id FROM public.job_documents d JOIN t ON d.share_token=t.tok WHERE d.job_id IS NOT NULL
  UNION
  SELECT v.job_id FROM public.job_variations v JOIN t ON v.share_token=t.tok WHERE v.job_id IS NOT NULL
 )
 SELECT coalesce(array_agg(j.job_id ORDER BY j.job_id),'{}'::uuid[])
 FROM j JOIN public.jobs x ON x.id=j.job_id
 WHERE coalesce(x.metadata->>'do_not_schedule','') NOT IN ('true','1')
$$;
COMMENT ON FUNCTION public.context_link_ref_jobs(text) IS
 'Unplaced stage 1 (20261014170000): the jobs whose quote (job_documents.share_token) or variation (job_variations.share_token) a link token in the text names, never a holding job. The ladder reads them as references.';

-- A builder's claim and purchase order references to our jobs. The purchase
-- order is the instruction key (captain 2 Aug 2026); a claim groups several.
-- Matching is on whole digit runs, never a substring.
CREATE OR REPLACE FUNCTION public.context_builder_ref_jobs(p_text text,p_refs jsonb)
RETURNS uuid[]
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE src text; po_ids uuid[]; claim_ids uuid[]; n_claims int;
 claim_re constant text:='(MLB|AJBR|AJS|AJ|BWCWA|BW|WB|ACG)(?:-?(?:RR|MW))?[- ]?([0-9]{4,})(?![0-9])';
 po_re constant text:='(?<![A-Z])P\.?O\.?[- #:]*([0-9]{5,6})(?![0-9])';
BEGIN
 src:=upper(coalesce(p_text,'')||' '||coalesce((SELECT string_agg(x,' ') FROM jsonb_array_elements_text(
  CASE WHEN jsonb_typeof(p_refs)='array' THEN p_refs ELSE '[]'::jsonb END) x),''));
 -- Cheap exit: most messages name neither.
 IF src !~ ('(?<![A-Z0-9])'||claim_re) AND src !~ po_re THEN RETURN '{}'::uuid[]; END IF;
 WITH c AS (
  SELECT DISTINCT CASE WHEN m[1] IN ('AJ','AJS','AJBR') THEN 'AJ' WHEN m[1] IN ('BW','BWCWA') THEN 'BW' ELSE m[1] END AS scope,
   ltrim(m[2],'0') AS num
  FROM regexp_matches(src,'(?<![A-Z0-9])'||claim_re,'g') m
 ), jc AS (
  SELECT d.job_id, CASE WHEN m[1] IN ('AJ','AJS','AJBR') THEN 'AJ' WHEN m[1] IN ('BW','BWCWA') THEN 'BW' ELSE m[1] END AS scope,
   ltrim(m[2],'0') AS num
  FROM public.makesafe_job_details d
  CROSS JOIN LATERAL regexp_matches(upper(coalesce(d.external_ref,'')),'^\s*'||claim_re) m
 )
 SELECT (SELECT count(*) FROM c), coalesce(array_agg(DISTINCT jc.job_id),'{}'::uuid[])
 INTO n_claims,claim_ids FROM jc JOIN c USING (scope,num);
 WITH p AS (
  SELECT DISTINCT ltrim(m[1],'0') AS num FROM regexp_matches(src,po_re,'g') m
 ), jp AS (
  SELECT d.job_id, ltrim(m[1],'0') AS num FROM public.makesafe_job_details d
  CROSS JOIN LATERAL regexp_matches(upper(coalesce(d.external_ref,'')),po_re,'g') m
  UNION
  SELECT j.id, ltrim(m[1],'0') FROM public.jobs j
  CROSS JOIN LATERAL regexp_matches(upper(coalesce(j.metadata->>'builder_po_number','')),po_re,'g') m
  WHERE j.metadata ? 'builder_po_number'
 )
 SELECT coalesce(array_agg(DISTINCT jp.job_id),'{}'::uuid[]) INTO po_ids FROM jp JOIN p USING (num);
 -- Holding jobs are never a builder's job.
 po_ids:=ARRAY(SELECT x FROM unnest(po_ids) x JOIN public.jobs j ON j.id=x
  WHERE coalesce(j.metadata->>'do_not_schedule','') NOT IN ('true','1') ORDER BY x);
 claim_ids:=ARRAY(SELECT x FROM unnest(claim_ids) x JOIN public.jobs j ON j.id=x
  WHERE coalesce(j.metadata->>'do_not_schedule','') NOT IN ('true','1') ORDER BY x);
 -- One purchase order names one job; when the text also names a claim, the
 -- purchase order's job must be on that claim.
 IF cardinality(po_ids)=1 AND (n_claims=0 OR po_ids[1]=ANY(claim_ids)) THEN RETURN po_ids; END IF;
 RETURN claim_ids;
END $$;
COMMENT ON FUNCTION public.context_builder_ref_jobs(text,jsonb) IS
 'Unplaced stage 1 (20261014170000): our jobs named by a builder''s purchase order (makesafe_job_details.external_ref or jobs.metadata.builder_po_number) or, failing one purchase order, by a builder claim (MLB, MLB-RR/MW, AJ/AJS/AJBR, BW/BWCWA, WB, ACG plus digits) in the text or payload.builder_refs. Whole digit runs only. A purchase order wins when it names exactly one job on any claim the text names. Never a holding job. The ladder places only when exactly one job is returned.';

-- Job parties (job_contacts) by the message's own email or phone key.
CREATE OR REPLACE FUNCTION public.context_party_key_jobs(p_email_key text,p_phone_key text)
RETURNS TABLE(job_id uuid, live boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT DISTINCT j.id, public.context_job_live(j.id)
 FROM public.job_contacts jc JOIN public.jobs j ON j.id=jc.job_id
 WHERE jc.removed_at IS NULL AND coalesce(jc.status,'')<>'removed'
  AND coalesce(j.metadata->>'do_not_schedule','') NOT IN ('true','1')
  AND ((p_email_key IS NOT NULL AND public.context_email_key(jc.client_email)=p_email_key)
   OR (p_phone_key IS NOT NULL AND public.context_phone_key(jc.client_phone)=p_phone_key))
$$;
COMMENT ON FUNCTION public.context_party_key_jobs(text,text) IS
 'Unplaced stage 1 (20261014170000): the jobs on which a live job party (job_contacts, not removed) has this email or phone key, and whether each is live (context_job_live). Never a holding job.';

-- Which lane an unplaced row counts in: machine, not a customer, customer.
CREATE OR REPLACE FUNCTION public.context_unplaced_lane(e public.business_events)
RETURNS text
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT CASE
  WHEN e.event_type LIKE 'makesafe.reconcile.%' THEN 'machine'
  WHEN e.event_type IN ('ghl.internal_comment','staff.email_internal','supplier.email_in')
   OR e.event_type LIKE 'supplier.%'
   OR coalesce(e.metadata->'party_roles'->>'audience','') IN ('internal','other_party') THEN 'not_customer'
  ELSE 'customer' END
$$;
COMMENT ON FUNCTION public.context_unplaced_lane(public.business_events) IS
 'Unplaced stage 1 (20261014170000): the lane a row on no job counts in: machine (make-safe reconcile records), not_customer (CRM staff notes, our own internal mail, supplier mail, and rows whose party_roles audience is internal or other_party: builders, councils, suppliers, our own people), customer (everything else). Counts only; deletes and moves nothing.';

-- 2. The ladder, rules on: the live L1g body with the stage-1 rules.
CREATE OR REPLACE FUNCTION public.resolve_context_attribution(e public.business_events, p_preview boolean, p_rules_on boolean)
 RETURNS public.business_events
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
  'placement_ranked_from','placement_ranked_below'];
 writer_job uuid;
 held_job uuid; held_conf numeric; held_match_conf numeric; held_ok boolean:=false; all_ids uuid[]; own_live_ids uuid[];
 -- Unplaced stage 1 (20261014170000).
 link_ids uuid[]; link_only boolean:=false; builder_ids uuid[]; party_ids uuid[]; open_all_ids uuid[]; ranked_from text; ranked_set uuid[];
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
     -- Stage 1 (20261014170000): ranked like the contact review.
     SELECT r.job_id,r.how INTO cand,rule FROM public.context_pick_ranked(ref_ids) r;
     IF cand IS NULL THEN
      rule:=NULL;
      e.attribution_status:='unplaced'; e.attribution_step:=1; e.candidate_job_ids:=ref_ids;
      e.metadata:=e.metadata||jsonb_build_object('placement_rule','multi_ref');
      EXIT rules;
     END IF;
     ranked_from:='multi_ref'; e.attribution_status:='single_open'; e.attribution_step:=1;
     e.metadata:=e.metadata||jsonb_build_object('placement_ranked_from',ranked_from,
      'placement_ranked_below',to_jsonb(ARRAY(SELECT x FROM unnest(ref_ids) x WHERE x<>cand ORDER BY x)));
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
    -- Stage 1 (20261014170000), candidate ranking (context_pick_ranked):
    -- closed, numberless and test jobs leave the candidate set; one live
    -- job left places on it (ranked_open), none live places on the most
    -- recent numbered one (ranked_recent), two or more live stay for review.
    -- Identity conflicts are never ranked.
    IF cand IS NULL AND review_ids IS NOT NULL AND rule IN ('review_several','review_recent_other_job','review_aftercare') THEN
     ranked_set:=ARRAY(SELECT DISTINCT x FROM unnest(review_ids) x ORDER BY x);
     SELECT r.job_id,r.how INTO cand,ranked_from FROM public.context_pick_ranked(ranked_set) r;
     IF cand IS NOT NULL THEN
      e.metadata:=e.metadata||jsonb_build_object('placement_ranked_from',rule,
       'placement_ranked_below',to_jsonb(ARRAY(SELECT x FROM unnest(ranked_set) x WHERE x<>cand ORDER BY x)));
      rule:=ranked_from; ranked_from:=e.metadata->>'placement_ranked_from';
      e.attribution_status:='single_open'; e.attribution_step:=3; review_ids:=NULL;
     END IF;
    END IF;
    -- A known customer with no job at the message time (the bucket) whose
    -- only open job is X: the row places on X (only_open_job).
    IF cand IS NULL AND rule IS NULL AND contact IS NOT NULL AND cardinality(ids)=0 AND cardinality(open_all_ids)=1 THEN
     cand:=open_all_ids[1]; e.attribution_status:='single_open'; e.attribution_step:=3; rule:='only_open_job';
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
   -- (job_contacts) with no CRM contact: exactly one of their jobs, or
   -- exactly one open one, places the row (job_party).
   IF cand IS NULL AND contact IS NULL AND NOT (e.metadata ? 'identity_conflict') AND (ek IS NOT NULL OR pk IS NOT NULL) THEN
    SELECT CASE WHEN count(*)=1 THEN array_agg(p.job_id)
      WHEN count(*) FILTER (WHERE p.live)=1 THEN array_agg(p.job_id) FILTER (WHERE p.live) END
    INTO party_ids FROM public.context_party_key_jobs(ek,pk) p;
    IF cardinality(party_ids)=1 THEN
     cand:=party_ids[1]; e.attribution_status:='single_open'; e.attribution_step:=3; rule:='job_party';
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
      -- Stage 1 (20261014170000): ranked like the contact review. A loose
      -- address match still never places.
      SELECT r.job_id,r.how INTO cand,rule FROM public.context_pick_ranked(exact_ids) r;
      IF cand IS NULL THEN
       rule:=NULL;
       e.attribution_status:='unplaced'; e.attribution_step:=6; e.candidate_job_ids:=exact_ids;
       e.metadata:=e.metadata||jsonb_build_object('placement_rule','site_address_several');
       EXIT rules;
      END IF;
      ranked_from:='site_address_several'; e.attribution_status:='single_open'; e.attribution_step:=6;
      e.metadata:=e.metadata||jsonb_build_object('placement_ranked_from',ranked_from,
       'placement_ranked_below',to_jsonb(ARRAY(SELECT x FROM unnest(exact_ids) x WHERE x<>cand ORDER BY x)));
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
    WHEN e.attribution_status='content_ref' THEN 'content_ref'
    WHEN ranked_from='multi_ref' THEN 'ladder_ref' WHEN ranked_from='site_address_several' THEN 'content_ref' ELSE 'contact_id' END;
   -- Stage 1 (20261014170000): a stored row that rested (bucket, unplaced,
   -- review or never decided) and is placed now by a stage-1 rule or by the
   -- recipient of our own message is a re-decision, not news: capture_mode
   -- relink (prior mode in capture_mode_before), as the 7 Oct repair and
   -- the re-check do, so the event listener never reads it as fresh.
   IF (prior_status IS NULL OR prior_status IN ('admin_bucket','unplaced','pending_luna'))
    AND coalesce(e.context_captured_at,e.recorded_at,'-infinity'::timestamptz)<clock_timestamp()-interval '1 hour'
    AND (rule IN ('link_ref','builder_ref','ranked_open','ranked_recent','only_open_job','job_party')
     OR (e.direction='outbound' AND e.metadata ? 'contact_recovered_by'))
    AND coalesce(e.metadata->>'capture_mode','') NOT IN ('backfill','relink') THEN
    e.metadata:=e.metadata||jsonb_build_object('capture_mode_before',e.metadata->'capture_mode','capture_mode','relink');
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
 'L1g plus unplaced stage 1 (20261014170000): the ladder (P4) as L1g left it (20261006035000), rules-on path only. Rules off: P1a''s ladder as L1e left it, unchanged. Rules on: writer check, except that a row the reader never reads (system or audit, no words, automated) keeps a custody job the service role confirmed after the insert (source_job_binding.via: confirmed_custody); a service-role outbound row marked recipient_role crew or staff handled by the L1d rule; a row with no words, an automated row or a make-safe reconcile record (stage 1) is never placed by the rules and keeps a custody job and the job a service-role writer named with no match_method (writer_job); custody with monitor-inbox re-scan; the source''s own payload job unless its writer declared it a guess; identity (payload.from read; an outbound row reads its recipient, stage 1); references, with quote and variation link tokens (link_ref, stage 1), and with no reference of ours a builder purchase order or claim naming one job (builder_ref, stage 1); live thread and supplier order bindings; contact rules with keys and aftercare, where a row a contact rule or Luna already put on a job keeps it instead of going to review or the bucket while that job is still the answer (held_placement, placement_held_from names the rule it outranked; a newer job reopens a placed row only through P1b at its insert); then (stage 1) candidate ranking (context_pick_ranked) of a contact review, a text naming 2 to 5 jobs and an exact address with 2 to 3 jobs: one live job places (ranked_open), none live places on the most recent (ranked_recent), two or more live stay for review and a known customer with no candidate at the message time and one open job places on it (only_open_job); a job party''s key with no CRM contact (job_party, stage 1); exact or loose site address; bucket. A stored row a stage-1 rule places is stamped capture_mode relink. Always stamps metadata.bucket_reason on a bucket row. p_preview writes nothing. p_rules_on null reads the flag.';

-- 3. Identity: our own outbound message names its customer by its recipient.
-- Inbound rows read exactly as before. An outbound row reads the recipients
-- in payload.to: exactly one customer email key (context_email_key drops our
-- own domains; council and platform domains never count), or, with no email
-- recipient at all, exactly one phone key (our own numbers never count).
CREATE OR REPLACE FUNCTION public.context_event_identity(e public.business_events, OUT email_key text, OUT phone_key text)
RETURNS record
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 WITH k AS (
  SELECT coalesce(e.direction,'')<>'outbound' AND public.context_event_sender_kind(e)='other' AS ok,
   coalesce(e.direction,'')='outbound' AND coalesce(e.event_type,'') NOT LIKE 'supplier.%'
    AND public.context_event_sender_kind(e) IN ('ours','other') AS out_ok
 ), rcpt AS (
  SELECT btrim(x) AS raw,
   CASE WHEN lower(coalesce(substring(x from '@([A-Za-z0-9.-]+)'),'')) ~ '((^|\.)gov\.au|(^|\.)(myob\.com|xero\.com|docusign\.net|docusign\.com|stripe\.com|paypal\.com|intuit\.com))$'
    THEN NULL ELSE public.context_email_key(x) END AS ek,
   CASE WHEN position('@' in x)=0 THEN public.context_phone_key(x) END AS pk
  FROM k, jsonb_array_elements_text(CASE jsonb_typeof(e.payload->'to') WHEN 'array' THEN e.payload->'to'
   WHEN 'string' THEN jsonb_build_array(e.payload->'to') ELSE '[]'::jsonb END) x
  WHERE k.out_ok AND nullif(btrim(x),'') IS NOT NULL
 )
 SELECT
  CASE WHEN k.ok THEN coalesce(public.context_email_key(e.payload->>'email'),public.context_email_key(e.payload->>'customer_email'),
   CASE WHEN position('@' in coalesce(e.payload->>'from',''))>0 THEN public.context_email_key(e.payload->>'from') END,
   public.context_email_key(e.payload->>'from_email'))
   WHEN k.out_ok THEN (SELECT CASE WHEN count(DISTINCT r.ek)=1 THEN min(r.ek) END FROM rcpt r) END,
  CASE WHEN k.ok THEN coalesce(public.context_phone_key(e.payload->>'customer_phone'),
   CASE WHEN e.direction='inbound' THEN public.context_phone_key(e.payload->>'phone') END)
   WHEN k.out_ok THEN (SELECT CASE WHEN count(*) FILTER (WHERE position('@' in r.raw)>0)=0 AND count(DISTINCT r.pk)=1 THEN min(r.pk) END FROM rcpt r) END
 FROM k
$$;
COMMENT ON FUNCTION public.context_event_identity(public.business_events) IS
 'B0, widened by unplaced stage 1 (20261014170000): the customer email and phone keys of a row from a closed list (payload email, customer_email, from with an @, from_email; customer_phone, then phone on inbound rows). None for supplier, council, platform or our own inbound rows. An outbound row we sent reads its recipients (payload.to): exactly one customer email key, or with no email recipient exactly one phone key; our own domains and numbers, councils and platforms never count. Computes; never places.';

-- 4. P1b's reconsideration also serves a job that gets its contact late.
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
    metadata=coalesce(resolved.metadata,'{}'::jsonb)||jsonb_build_object(
     'placement_reconsidered',v_note||jsonb_build_object('from_status',coalesce(e.attribution_status,'none')))
     -- Stage 1: a stored row bound because its job got its contact late is
     -- a re-decision, not news (relink), unless it arrived within the hour.
     ||CASE WHEN p_reason='job_contact_linked'
       AND coalesce(e.context_captured_at,e.recorded_at,'-infinity'::timestamptz)<clock_timestamp()-interval '1 hour'
       AND coalesce(resolved.metadata->>'capture_mode','') NOT IN ('backfill','relink')
      THEN jsonb_build_object('capture_mode_before',resolved.metadata->'capture_mode','capture_mode','relink') ELSE '{}'::jsonb END
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
    metadata=coalesce(metadata,'{}'::jsonb)||jsonb_build_object('capture_mode','relink','capture_mode_before',v_mode,
     'placement_rule','reopen_new_job','placement_reconsidered',v_note)
   WHERE id=e.id;
   n_reopened:=n_reopened+1;
  END IF;
 END LOOP;
 RETURN jsonb_build_object('outcome','done','reason',p_reason,'job_id',p_job_id,'seen',n_seen,'placed',n_placed,
  'to_review',n_review,'reopened',n_reopened,'widened',n_widened,'unchanged',n_unchanged,'skipped_busy',n_busy,
  'truncated',v_truncated);
END $function$;
COMMENT ON FUNCTION public.context_reconsider_contact(text,timestamptz,text,uuid) IS
 'Reconsiders a GHL contact''s messages between p_since and the job''s creation (reason job_created) or, since unplaced stage 1 (20261014170000), the moment the job got this contact by update (reason job_contact_linked), when that job is a candidate at their time: bucket rows re-run the ladder; unplaced rows and rows placed on a sibling by single_open, single_line or luna go back to review once with the job added; review rows gain it as a candidate. Unplaced and sibling reopens are capture_mode relink; a first bind keeps its capture_mode, except that a job_contact_linked first bind of a row stored over an hour ago is relink. Never direct, thread, content_ref or party placements; never waits on a locked row. Returns counts.';

-- 5. Re-decide resting rows when new evidence arrives.
-- One writer for the three evidence triggers below and for a hand run: it
-- re-runs the ladder on rows with no job that rest in the bucket or
-- unplaced, and writes only a placement or a review case. Anything else is
-- left exactly as it was. A stored row it binds or sends to review is a
-- re-decision, not news: capture_mode relink, prior mode in
-- capture_mode_before (as 20261014034549 does for the daily re-check), unless
-- the row arrived within the hour. Never waits on a locked row; at most 200
-- rows and 2 seconds a call.
CREATE OR REPLACE FUNCTION public.context_redecide_events(p_ids uuid[],p_reason text,p_detail jsonb DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE x uuid; e public.business_events; resolved public.business_events; v_note jsonb;
 v_start timestamptz:=clock_timestamp(); n_seen int:=0; n_placed int:=0; n_review int:=0; n_unchanged int:=0; n_busy int:=0;
 v_truncated text; v_limit constant int:=200; v_budget constant interval:='2 seconds';
BEGIN
 IF p_reason IS NULL OR p_reason NOT IN ('thread_bound','invoice_linked','hand_run') THEN
  RAISE EXCEPTION 'context_redecide_events: unknown reason';
 END IF;
 IF NOT public.automation_lane_enabled('attribution') THEN RETURN jsonb_build_object('outcome','lane_off'); END IF;
 FOR x IN SELECT DISTINCT u FROM unnest(coalesce(p_ids,'{}'::uuid[])) u WHERE u IS NOT NULL ORDER BY u LOOP
  IF n_seen>=v_limit THEN v_truncated:='row_cap'; EXIT; END IF;
  IF clock_timestamp()-v_start>v_budget THEN v_truncated:='time_budget'; EXIT; END IF;
  n_seen:=n_seen+1;
  SELECT * INTO e FROM public.business_events b WHERE b.id=x FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN
   IF EXISTS(SELECT 1 FROM public.business_events b WHERE b.id=x) THEN n_busy:=n_busy+1; ELSE n_unchanged:=n_unchanged+1; END IF;
   CONTINUE;
  END IF;
  IF e.job_id IS NOT NULL OR coalesce(e.attribution_status,'admin_bucket') NOT IN ('admin_bucket','unplaced') THEN
   n_unchanged:=n_unchanged+1; CONTINUE;
  END IF;
  resolved:=public.resolve_context_attribution(e);
  IF resolved.job_id IS NULL AND resolved.attribution_status IS DISTINCT FROM 'pending_luna' THEN
   n_unchanged:=n_unchanged+1; CONTINUE;
  END IF;
  v_note:=jsonb_build_object('reason',p_reason,'at',clock_timestamp(),'from_status',coalesce(e.attribution_status,'none'))
   ||coalesce(p_detail,'{}'::jsonb);
  resolved.metadata:=coalesce(resolved.metadata,'{}'::jsonb)||jsonb_build_object('placement_redecided',v_note);
  IF coalesce(e.context_captured_at,e.recorded_at,'-infinity'::timestamptz)<clock_timestamp()-interval '1 hour'
   AND coalesce(resolved.metadata->>'capture_mode','') NOT IN ('backfill','relink') THEN
   resolved.metadata:=resolved.metadata||jsonb_build_object('capture_mode_before',resolved.metadata->'capture_mode','capture_mode','relink');
  END IF;
  UPDATE public.business_events SET
   job_id=resolved.job_id,contact_id=resolved.contact_id,
   attribution_status=resolved.attribution_status,attribution_step=resolved.attribution_step,
   attribution_confidence=resolved.attribution_confidence,attributed_at=resolved.attributed_at,
   attribution_checked_at=resolved.attribution_checked_at,event_at=resolved.event_at,
   match_status=resolved.match_status,match_method=resolved.match_method,match_confidence=resolved.match_confidence,
   candidate_job_ids=resolved.candidate_job_ids,payload=resolved.payload,metadata=resolved.metadata
  WHERE id=e.id;
  IF resolved.job_id IS NOT NULL THEN n_placed:=n_placed+1; ELSE n_review:=n_review+1; END IF;
 END LOOP;
 RETURN jsonb_build_object('outcome','done','reason',p_reason,'seen',n_seen,'placed',n_placed,'to_review',n_review,
  'unchanged',n_unchanged,'skipped_busy',n_busy,'truncated',v_truncated);
END $$;
COMMENT ON FUNCTION public.context_redecide_events(uuid[],text,jsonb) IS
 'Unplaced stage 1 (20261014170000): re-runs the ladder on the named rows that have no job and rest in the bucket or unplaced (reasons thread_bound, invoice_linked, hand_run) and writes only a placement or a review case, with metadata.placement_redecided; anything else is left as it was. A row stored over an hour ago is stamped capture_mode relink (prior mode in capture_mode_before) so the event listener never reads it as fresh. Skips locked rows; at most 200 rows and 2 seconds a call; returns counts. Service role only.';

-- 5a. A new live thread binding re-decides the thread's resting rows.
CREATE OR REPLACE FUNCTION public.context_thread_bound_redecide()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_ids uuid[]; v_result jsonb;
BEGIN
 IF NEW.retired_at IS NOT NULL OR NEW.job_id IS NULL OR nullif(NEW.thread_key,'') IS NULL THEN RETURN NULL; END IF;
 v_ids:=ARRAY(SELECT b.id FROM public.business_events b
  WHERE b.thread_key=NEW.thread_key AND b.job_id IS NULL AND b.attribution_status IN ('admin_bucket','unplaced')
   AND b.id IS DISTINCT FROM NEW.source_event_id
  ORDER BY b.occurred_at DESC,b.id LIMIT 50);
 IF cardinality(v_ids)=0 THEN RETURN NULL; END IF;
 v_result:=public.context_redecide_events(v_ids,'thread_bound',jsonb_build_object('thread_key',NEW.thread_key,'job_id',NEW.job_id));
 IF coalesce((v_result->>'skipped_busy')::int,0)>0 OR v_result->>'truncated' IS NOT NULL THEN
  RAISE WARNING 'context thread re-decision incomplete: skipped_busy % truncated %',v_result->>'skipped_busy',v_result->>'truncated';
 END IF;
 RETURN NULL;
EXCEPTION WHEN OTHERS THEN
 -- Never fail the binding; log the code only.
 RAISE WARNING 'context thread re-decision failed: SQLSTATE %',SQLSTATE;
 RETURN NULL;
END $$;
COMMENT ON FUNCTION public.context_thread_bound_redecide() IS
 'Unplaced stage 1 (20261014170000): AFTER INSERT on event_threads: a new live binding re-decides up to 50 rows of that thread with no job that rest in the bucket or unplaced (context_redecide_events, thread_bound). Never fails the binding.';
DROP TRIGGER IF EXISTS context_thread_bound_redecide ON public.event_threads;
CREATE TRIGGER context_thread_bound_redecide AFTER INSERT ON public.event_threads
 FOR EACH ROW EXECUTE FUNCTION public.context_thread_bound_redecide();

-- 5b. A customer invoice linked to a job re-decides the resting rows of
-- that job's customer (or that name it as a candidate) whose words carry the
-- invoice number.
CREATE OR REPLACE FUNCTION public.context_invoice_linked_redecide()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_contact text; v_toks text[]; v_ids uuid[]; v_result jsonb;
BEGIN
 IF NEW.job_id IS NULL OR nullif(btrim(NEW.invoice_number),'') IS NULL OR coalesce(NEW.invoice_type,'')<>'ACCREC' THEN RETURN NULL; END IF;
 IF TG_OP='UPDATE' AND OLD.job_id IS NOT DISTINCT FROM NEW.job_id AND OLD.invoice_number IS NOT DISTINCT FROM NEW.invoice_number THEN RETURN NULL; END IF;
 SELECT nullif(btrim(j.ghl_contact_id),'') INTO v_contact FROM public.jobs j WHERE j.id=NEW.job_id;
 v_toks:=ARRAY[upper(btrim(NEW.invoice_number)),replace(upper(btrim(NEW.invoice_number)),'-','')];
 v_ids:=ARRAY(SELECT b.id FROM public.business_events b
  WHERE b.job_id IS NULL AND b.attribution_status IN ('admin_bucket','unplaced')
   AND ((v_contact IS NOT NULL AND b.contact_id=v_contact) OR b.candidate_job_ids @> ARRAY[NEW.job_id])
   AND public.context_job_ref_tokens(public.context_bucket_text(b)) && v_toks
  ORDER BY b.occurred_at DESC,b.id LIMIT 50);
 IF cardinality(v_ids)=0 THEN RETURN NULL; END IF;
 v_result:=public.context_redecide_events(v_ids,'invoice_linked',jsonb_build_object('invoice_number',NEW.invoice_number,'job_id',NEW.job_id));
 IF coalesce((v_result->>'skipped_busy')::int,0)>0 OR v_result->>'truncated' IS NOT NULL THEN
  RAISE WARNING 'context invoice re-decision incomplete: skipped_busy % truncated %',v_result->>'skipped_busy',v_result->>'truncated';
 END IF;
 RETURN NULL;
EXCEPTION WHEN OTHERS THEN
 -- Never fail the invoice write; log the code only.
 RAISE WARNING 'context invoice re-decision failed: SQLSTATE %',SQLSTATE;
 RETURN NULL;
END $$;
COMMENT ON FUNCTION public.context_invoice_linked_redecide() IS
 'Unplaced stage 1 (20261014170000): AFTER INSERT or UPDATE OF job_id, invoice_number on xero_invoices: an ACCREC invoice that newly has a job and a number re-decides up to 50 rows with no job, resting in the bucket or unplaced, of that job''s customer or naming the job as a candidate, whose words carry the invoice number (context_redecide_events, invoice_linked). Never fails the invoice write.';
DROP TRIGGER IF EXISTS context_invoice_linked_redecide ON public.xero_invoices;
CREATE TRIGGER context_invoice_linked_redecide AFTER INSERT OR UPDATE OF job_id,invoice_number ON public.xero_invoices
 FOR EACH ROW EXECUTE FUNCTION public.context_invoice_linked_redecide();

-- 5c. A job that gets its GHL contact after its insert (the patio path)
-- reconsiders that contact's earlier messages, as a new job does.
CREATE OR REPLACE FUNCTION public.context_job_contact_linked_reconsider()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_since timestamptz; v_result jsonb;
BEGIN
 IF nullif(btrim(NEW.ghl_contact_id),'') IS NULL
  OR nullif(btrim(OLD.ghl_contact_id),'') IS NOT DISTINCT FROM nullif(btrim(NEW.ghl_contact_id),'') THEN RETURN NULL; END IF;
 -- The job's lead window; a holding job has none and is never a candidate.
 SELECT t.window_start INTO v_since FROM public.context_contact_job_timeline(NEW.ghl_contact_id,now()) t WHERE t.job_id=NEW.id;
 IF NOT FOUND THEN RETURN NULL; END IF;
 v_result:=public.context_reconsider_contact(NEW.ghl_contact_id,v_since,'job_contact_linked',NEW.id);
 IF coalesce((v_result->>'skipped_busy')::int,0)>0 OR v_result->>'truncated' IS NOT NULL THEN
  RAISE WARNING 'context job contact reconsideration incomplete for job %: skipped_busy % truncated %',NEW.id,v_result->>'skipped_busy',v_result->>'truncated';
 END IF;
 RETURN NULL;
EXCEPTION WHEN OTHERS THEN
 -- Never fail the job update; log the code and the job id only.
 RAISE WARNING 'context job contact reconsideration failed for job %: SQLSTATE %',NEW.id,SQLSTATE;
 RETURN NULL;
END $$;
COMMENT ON FUNCTION public.context_job_contact_linked_reconsider() IS
 'Unplaced stage 1 (20261014170000): AFTER UPDATE OF ghl_contact_id on jobs: a job that gets a (different) GHL contact after its insert reconsiders that contact''s messages from its lead window to now (context_reconsider_contact, job_contact_linked), as P1b does at a job insert. Never fails the job update.';
DROP TRIGGER IF EXISTS context_job_contact_linked_reconsider ON public.jobs;
CREATE TRIGGER context_job_contact_linked_reconsider AFTER UPDATE OF ghl_contact_id ON public.jobs
 FOR EACH ROW EXECUTE FUNCTION public.context_job_contact_linked_reconsider();

-- 6. Monitor: the bucket block of context_pipeline_status (F1b stub until
-- now). Rows on no job by lane, with two alarms on the customer lane.
CREATE OR REPLACE FUNCTION public.context_unplaced_policy()
RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object(
  -- 1,091 customer rows were unplaced on 14 Oct 2026 (diagnosis, 08:45 UTC).
  -- Above this the pile is growing again; lower it once the hand re-check
  -- has run.
  'customer_unplaced_max',1100,
  -- The live inflow of customer rows was 10 to 20 a day on 14 Oct 2026.
  'customer_new_24h_max',30)
$$;
COMMENT ON FUNCTION public.context_unplaced_policy() IS
 'Unplaced stage 1 (20261014170000): the bucket block''s thresholds. customer_unplaced_max: customer-lane unplaced rows above which unplaced_customer_over_threshold fires. customer_new_24h_max: customer-lane rows that became unplaced in the last 24 hours above which unplaced_customer_inflow fires. Changed only by migration.';

CREATE OR REPLACE FUNCTION public.context_bucket_status()
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE pol jsonb:=public.context_unplaced_policy(); u jsonb; bk jsonb; alarms jsonb:='[]'::jsonb;
 n_customer bigint; n_new bigint;
BEGIN
 SELECT jsonb_build_object(
   'total',count(*),
   'machine',count(*) FILTER (WHERE l='machine'),
   'not_customer',count(*) FILTER (WHERE l='not_customer'),
   'customer',count(*) FILTER (WHERE l='customer'),
   'customer_history',count(*) FILTER (WHERE l='customer' AND cm IN ('backfill','relink')),
   'customer_live',count(*) FILTER (WHERE l='customer' AND cm NOT IN ('backfill','relink')),
   'customer_new_24h',count(*) FILTER (WHERE l='customer' AND checked>=now()-interval '24 hours'),
   'oldest_customer_checked_at',min(checked) FILTER (WHERE l='customer'))
 INTO u
 FROM (SELECT public.context_unplaced_lane(b) AS l, coalesce(b.metadata->>'capture_mode','live') AS cm, b.attribution_checked_at AS checked
  FROM public.business_events b WHERE b.attribution_status='unplaced' AND b.job_id IS NULL) s;
 SELECT jsonb_build_object(
   'total',count(*),
   'machine',count(*) FILTER (WHERE l='machine'),
   'not_customer',count(*) FILTER (WHERE l='not_customer'),
   'customer',count(*) FILTER (WHERE l='customer'))
 INTO bk
 FROM (SELECT public.context_unplaced_lane(b) AS l FROM public.business_events b
  WHERE b.attribution_status='admin_bucket' AND b.job_id IS NULL) s;
 n_customer:=(u->>'customer')::bigint; n_new:=(u->>'customer_new_24h')::bigint;
 IF n_customer>(pol->>'customer_unplaced_max')::bigint THEN
  alarms:=alarms||jsonb_build_array(jsonb_build_object('key','unplaced_customer_over_threshold','severity','warning','since',now(),
   'count',n_customer,'threshold',(pol->>'customer_unplaced_max')::bigint,
   'what_to_do','More customer messages sit on no job than the stated limit. Read the newest unplaced customer rows (context_unlinked_rows) and find what stopped them placing.'));
 END IF;
 IF n_new>(pol->>'customer_new_24h_max')::bigint THEN
  alarms:=alarms||jsonb_build_array(jsonb_build_object('key','unplaced_customer_inflow','severity','warning','since',now(),
   'count',n_new,'threshold',(pol->>'customer_new_24h_max')::bigint,
   'what_to_do','More customer messages went to no job in the last 24 hours than usual. Check the newest unplaced customer rows for a new sender, a new job type or a broken capture.'));
 END IF;
 RETURN jsonb_build_object('unplaced',u,'admin_bucket',bk,'policy',pol,'alarms',alarms);
END $$;
COMMENT ON FUNCTION public.context_bucket_status() IS
 'Status block bucket (unplaced stage 1, 20261014170000; was the F1b stub): rows with no job that rest unplaced, by lane (context_unplaced_lane: machine, not_customer, customer; the customer lane split into history and live and counted for the last 24 hours), and bucket rows by the same lanes, plus alarms unplaced_customer_over_threshold and unplaced_customer_inflow at the thresholds in context_unplaced_policy(). Read only.';

-- 7. Grants. Replaced functions keep theirs (CREATE OR REPLACE). New ones
-- are private: the service role may run the re-decision and read the block.
REVOKE ALL ON FUNCTION public.context_job_live(uuid) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.context_pick_ranked(uuid[]) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.context_link_ref_jobs(text) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.context_builder_ref_jobs(text,jsonb) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.context_party_key_jobs(text,text) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.context_unplaced_lane(public.business_events) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.context_unplaced_policy() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.context_redecide_events(uuid[],text,jsonb) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.context_thread_bound_redecide() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.context_invoice_linked_redecide() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.context_job_contact_linked_reconsider() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.context_redecide_events(uuid[],text,jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.context_unplaced_lane(public.business_events) TO service_role;
GRANT EXECUTE ON FUNCTION public.context_unplaced_policy() TO service_role;
GRANT EXECUTE ON FUNCTION public.context_link_ref_jobs(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.context_builder_ref_jobs(text,jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.context_party_key_jobs(text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.context_job_live(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.context_pick_ranked(uuid[]) TO service_role;
