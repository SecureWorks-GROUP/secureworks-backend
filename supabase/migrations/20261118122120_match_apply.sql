-- P2-02.6. Install callable functions only. Each call is one transaction.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $guard$
DECLARE f record;
/* permit only an exact reapplication */ BEGIN
  FOR f IN SELECT p.oid::regprocedure::text sig, md5(p.prosrc) body FROM pg_proc p
    WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('match_lock_cost_document','match_requeue','match_clue_add','match_apply_stop','match_apply')
  LOOP
    IF (f.sig,f.body) NOT IN (
      ('match_lock_cost_document(text)','c59bc534138571fda5d1b4c9c83d5731'),
      ('match_requeue(text,text,text)','fed2e3fb935261e3752bafc839a39276'),
      ('match_clue_add(text,text,uuid,text,text,jsonb,text)','b693ff4260774c5fa114bd498d7516fc'),
      ('match_apply_stop(text)','e5382283d43345f54b314a6fdf6fc897'),
      ('match_apply(text,text,uuid,text,jsonb,jsonb,jsonb,jsonb,text)','2d37c485e29e0a9a1a2b59985417741f')) THEN RAISE EXCEPTION 'match_function_body_changed'; END IF;
  END LOOP;
END $guard$;

CREATE OR REPLACE FUNCTION public.match_lock_cost_document(p_subject_id text)
RETURNS uuid LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $fn$
DECLARE
  v_doc_kind text := split_part(p_subject_id, ':', 1);
  doc text := substr(p_subject_id, length(v_doc_kind) + 2);
  org uuid;
/* lock the same document coordinate as the cost-line writer */ BEGIN
  SELECT l.org_id INTO org FROM public.job_cost_lines l
   WHERE l.document_kind = v_doc_kind AND l.document_id = doc LIMIT 1;
  IF NOT FOUND THEN RAISE EXCEPTION 'match_subject_unknown'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(org::text || ':' || p_subject_id, 0));
  -- Re-read after the lock and refuse ambiguous organisation ownership.
  RETURN public.reconcile_item_org('cost_document', p_subject_id, '{}');
END $fn$;

CREATE OR REPLACE FUNCTION public.match_requeue(p_subject_kind text, p_subject_id text, p_reason text)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $fn$
/* one pending row per subject */ BEGIN
  IF p_subject_kind IS NULL OR p_subject_kind NOT IN ('cost_document','message')
     OR nullif(btrim(p_subject_id),'') IS NULL OR nullif(btrim(p_reason),'') IS NULL THEN
    RAISE EXCEPTION 'match_queue_input_invalid';
  END IF;
  INSERT INTO public.match_queue(subject_kind,subject_id,reason) VALUES (p_subject_kind,p_subject_id,p_reason)
  ON CONFLICT (subject_kind,subject_id) DO UPDATE SET reason = excluded.reason;
END $fn$;

CREATE OR REPLACE FUNCTION public.match_clue_add(p_subject_id text, p_clue_code text, p_job_id uuid,
  p_seen_where text, p_seen_value text, p_detail jsonb, p_source text)
RETURNS bigint LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $fn$
DECLARE
  org uuid;
  root_key text;
  clue_id bigint;
/* external evidence and its requeue commit together */ BEGIN
  IF p_clue_code IS NULL OR p_clue_code NOT IN ('job_number','order_number','delivery_address') THEN
    RAISE EXCEPTION 'match_clue_code_not_allowed';
  END IF;
  org := public.match_lock_cost_document(p_subject_id);
  IF p_job_id IS NULL OR NOT EXISTS (SELECT FROM public.jobs WHERE id = p_job_id AND org_id = org)
    THEN RAISE EXCEPTION 'match_clue_job_unknown'; END IF;
  IF nullif(btrim(p_source),'') IS NULL THEN RAISE EXCEPTION 'match_clue_source_required'; END IF;
  SELECT c.id INTO clue_id FROM public.match_clues c WHERE c.current AND c.subject_kind = 'cost_document'
    AND c.subject_id = p_subject_id AND c.clue_code = p_clue_code AND c.job_id = p_job_id
    AND c.kept_from = p_source AND c.org_id = org;
  IF NOT FOUND THEN
    IF p_clue_code = 'order_number' THEN
      IF nullif(btrim(p_detail->>'order_id'),'') IS NULL THEN RAISE EXCEPTION 'match_clue_order_required'; END IF;
      root_key := 'order:' || (p_detail->>'order_id');
    ELSE
      root_key := 'doc:' || substr(p_subject_id, strpos(p_subject_id, ':') + 1);
    END IF;
    INSERT INTO public.match_clues(org_id,subject_kind,subject_id,run_id,clue_code,class,family,root,
      outcome,job_id,names_one,seen_where,seen_value,detail,rule_version,kept_from)
    SELECT org,'cost_document',p_subject_id,gen_random_uuid(),t.code,t.class,t.family,root_key,
      'job',p_job_id,true,p_seen_where,p_seen_value,coalesce(p_detail,'{}'),'v1',p_source
    FROM public.match_clue_types t WHERE t.code = p_clue_code RETURNING id INTO STRICT clue_id;
  END IF;
  PERFORM public.match_requeue('cost_document',p_subject_id,p_source);
  RETURN clue_id;
END $fn$;

-- P2-03.4 can extend this stop under the document lock before any live decision.
CREATE OR REPLACE FUNCTION public.match_apply_stop(p_subject_id text)
RETURNS text LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' AS $fn$
  SELECT 'held_by_person'::text WHERE EXISTS (
    SELECT FROM public.job_cost_lines l WHERE l.document_kind = split_part(p_subject_id,':',1)
    AND l.document_id = substr(p_subject_id,strpos(p_subject_id,':')+1) AND l.decided_by_kind = 'person')
$fn$;

CREATE OR REPLACE FUNCTION public.match_apply(p_subject_kind text, p_subject_id text, p_run_id uuid,
  p_item_kind text, p_clues jsonb, p_result jsonb, p_stops jsonb, p_summary jsonb, p_rule_version text)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $fn$
DECLARE
  v_doc_kind text := split_part(p_subject_id,':',1);
  doc text := substr(p_subject_id,length(v_doc_kind)+2);
  org uuid;
  enabled_now boolean;
  item public.reconcile_items;
  item_id uuid;
  stop_reason text;
  result_kind text := p_result->>'result';
  reason text := p_result->>'reason';
  job uuid := (p_result->>'job_id')::uuid;
  jobs_named uuid[];
  c jsonb;
  clue_id bigint;
  ids bigint[] := '{}';
  pair bigint[];
  picked bigint[];
  decision bigint;
  last_decision public.reconcile_decisions;
  run_hash text;
  line record;
  lines_before jsonb;
  amount numeric;
  doc_date date;
  order_ref jsonb;
  order_count integer;
  suggestion jsonb;
  outcome text := p_result->>'outcome';
/* one atomic writer for a subject */ BEGIN
  IF p_subject_kind IS DISTINCT FROM 'cost_document' THEN RAISE EXCEPTION 'match_subject_unknown'; END IF;
  IF p_run_id IS NULL OR p_rule_version IS DISTINCT FROM 'v1' OR jsonb_typeof(p_clues) IS DISTINCT FROM 'array'
     OR jsonb_typeof(p_stops) IS DISTINCT FROM 'array' OR jsonb_typeof(p_summary) IS DISTINCT FROM 'object'
     OR result_kind IS NULL OR result_kind NOT IN ('auto','suggest','none') THEN
    RAISE EXCEPTION 'match_input_invalid';
  END IF;
  SELECT f.enabled INTO enabled_now FROM public.feature_flags f WHERE f.flag_name = 'reconcile_matcher_v1' FOR SHARE;
  IF enabled_now IS NULL THEN RAISE EXCEPTION 'match_switch_unreadable'; END IF;
  IF NOT EXISTS (SELECT FROM public.reconcile_item_kinds k WHERE k.kind = p_item_kind)
    THEN RAISE EXCEPTION 'reconcile_kind_unknown'; END IF;
  IF enabled_now THEN
    -- Same list lock as raise/withdraw. Like reconcile_decide, lock the item before its lines.
    PERFORM pg_advisory_xact_lock(hashtextextended('reconcile_item_raise' || chr(31) || p_item_kind ||
      chr(31) || p_subject_kind || chr(31) || p_subject_id,0));
    SELECT * INTO item FROM public.reconcile_items i WHERE i.kind = p_item_kind AND i.status = 'open'
      AND i.subject_table = p_subject_kind AND i.subject_id = p_subject_id FOR UPDATE;
  END IF;
  org := public.match_lock_cost_document(p_subject_id);
  PERFORM 1 FROM public.job_cost_lines l WHERE l.document_kind = v_doc_kind AND l.document_id = doc
    ORDER BY l.id FOR UPDATE;

  -- Check all cited jobs once, including a job proposed only by the result.
  SELECT array_agg(DISTINCT j ORDER BY j) INTO jobs_named FROM (
    SELECT (v->>'job_id')::uuid j FROM jsonb_array_elements(p_clues) v
    UNION ALL SELECT job
    UNION ALL SELECT k.job_id FROM public.match_clues k WHERE k.current AND k.kept_from IS NOT NULL
      AND k.subject_kind = p_subject_kind AND k.subject_id = p_subject_id
  ) all_jobs WHERE j IS NOT NULL;
  PERFORM public.reconcile_item_org(p_subject_kind,p_subject_id,jobs_named);

  IF enabled_now AND result_kind = 'auto' THEN
    -- A lost response can replay the same successful run. Preserve the original
    -- before-image for undo. A new run always passes through the normal recheck.
    run_hash := md5(jsonb_build_array(p_item_kind,p_clues,p_result,p_stops,p_summary,p_rule_version)::text);
    SELECT d.* INTO last_decision FROM public.reconcile_decisions d WHERE d.subject_kind = p_subject_kind
      AND d.subject_id = p_subject_id ORDER BY d.decided_at DESC,d.id DESC LIMIT 1;
    IF last_decision.before->>'run_id' = p_run_id::text AND last_decision."by" = 'matcher:v1' THEN
      stop_reason := public.match_apply_stop(p_subject_id);
      IF stop_reason IS NOT NULL THEN RETURN jsonb_build_object('applied',stop_reason); END IF;
      IF last_decision.before->>'run_hash' IS DISTINCT FROM run_hash OR EXISTS (
        SELECT FROM public.job_cost_lines l WHERE l.document_kind = v_doc_kind AND l.document_id = doc
        AND l.state IS NOT NULL AND (l.decision_id IS DISTINCT FROM last_decision.id OR l.state <> 'on_job')
      ) THEN RAISE EXCEPTION 'match_run_changed'; END IF;
      RETURN jsonb_build_object('applied','auto','decision_id',last_decision.id);
    END IF;
  END IF;

  UPDATE public.match_clues k SET current = false WHERE k.current AND k.kept_from IS NULL
    AND k.subject_kind = p_subject_kind AND k.subject_id = p_subject_id;
  FOR c IN SELECT value FROM jsonb_array_elements(p_clues) LOOP
    IF nullif(btrim(c->>'root'),'') IS NULL THEN RAISE EXCEPTION 'match_clue_root_required'; END IF;
    INSERT INTO public.match_clues(org_id,subject_kind,subject_id,run_id,clue_code,class,family,root,
      outcome,job_id,division,names_one,seen_where,seen_value,detail,rule_version)
    SELECT org,p_subject_kind,p_subject_id,p_run_id,t.code,t.class,t.family,c->>'root',
      c->>'outcome',(c->>'job_id')::uuid,c->>'division',(c->>'names_one')::boolean,
      c->>'seen_where',c->>'seen_value',coalesce(c->'detail','{}'),p_rule_version
    FROM public.match_clue_types t WHERE t.code = c->>'clue_code' RETURNING id INTO clue_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'match_clue_type_unknown'; END IF;
    ids := array_append(ids,clue_id);
  END LOOP;
  IF NOT enabled_now THEN
    INSERT INTO public.match_shadow_runs(subject_kind,subject_id,run_id,result,stops,rule_version)
    VALUES (p_subject_kind,p_subject_id,p_run_id,p_result,p_stops,p_rule_version);
    RETURN '{"applied":"shadow"}';
  END IF;
  stop_reason := public.match_apply_stop(p_subject_id);
  IF stop_reason IS NOT NULL THEN RETURN jsonb_build_object('applied',stop_reason); END IF;

  -- decideMatch indexes fresh clues first and retained clues follow (in id order).
  SELECT ids || coalesce(array_agg(k.id ORDER BY k.id),'{}') INTO ids FROM public.match_clues k
    WHERE k.current AND k.kept_from IS NOT NULL AND k.subject_kind = p_subject_kind AND k.subject_id = p_subject_id;
  SELECT CASE WHEN count(*) = count(l.amount_ex) THEN sum(l.amount_ex) END, min(l.document_date)
    INTO amount, doc_date FROM public.job_cost_lines l
    WHERE l.document_kind = v_doc_kind AND l.document_id = doc AND l.state IS NOT NULL;
  IF result_kind = 'auto' THEN
    outcome := 'job';
    -- Bind the exact claimed pair to current rows and to the live type catalogue.
    IF jsonb_typeof(p_result->'clue_indexes') = 'array' AND jsonb_array_length(p_result->'clue_indexes') = 2 THEN
      pair := ARRAY[ids[1+(p_result#>>'{clue_indexes,0}')::int],ids[1+(p_result#>>'{clue_indexes,1}')::int]];
    END IF;
    PERFORM 1 FROM public.jobs j WHERE j.id = job AND j.org_id = org
      AND lower(j.status) NOT IN ('','cancelled','canceled','lost','draft','quoted')
      AND lower(coalesce(j.metadata->>'do_not_schedule','false')) <> 'true' FOR SHARE;
    IF FOUND AND amount IS NOT NULL AND p_stops = '[]' AND NOT EXISTS (
      SELECT FROM public.match_clues k WHERE k.id = ANY(ids) AND k.names_one AND k.class IN ('key','clue')
        AND (k.outcome <> 'job' OR k.job_id IS DISTINCT FROM job)
    ) THEN
      SELECT array_agg(k.id ORDER BY k.id) INTO picked FROM public.match_clues k
        JOIN public.match_clue_types t ON t.code = k.clue_code
        WHERE k.id = ANY(pair) AND k.job_id = job AND k.outcome = 'job' AND k.names_one
          AND t.class IN ('key','clue') AND t.mode = 'counts'
        HAVING count(*) = 2 AND count(DISTINCT t.family) = 2 AND count(DISTINCT k.root) = 2;
    END IF;
    SELECT count(*),jsonb_agg(o)->0 INTO order_count,order_ref FROM (
      SELECT DISTINCT jsonb_build_object('kind',k.detail->>'order_kind','id',k.detail->>'order_id') o
      FROM public.match_clues k WHERE k.id = ANY(ids) AND k.job_id = job AND k.outcome = 'job'
        AND k.clue_code IN ('order_number','sealed_scope_order','order_amount')
        AND k.detail->>'order_kind' IN ('purchase_order','dispatch_order')
        AND nullif(k.detail->>'order_id','') IS NOT NULL
    ) orders;
    IF picked IS NULL OR order_count > 1 THEN reason := 'recheck_failed';
    ELSE
      -- Same reversible snapshot as an office decision, including the source hash and old parts.
      SELECT jsonb_agg(jsonb_build_object('id',l.id,'state',l.state,'needs_reason',l.needs_reason,
        'not_counted_reason',l.not_counted_reason,'decided_by_kind',l.decided_by_kind,'decision_id',l.decision_id,
        'covered_by_line_id',l.covered_by_line_id,'source_hash',l.source_hash,'amount_ex',l.amount_ex,
        'order_kind',l.order_kind,'order_id',l.order_id,'parts',(SELECT coalesce(jsonb_agg(
          jsonb_build_object('part_no',p.part_no,'target',p.target,'job_id',p.job_id,'division',p.division,
            'lane',p.lane,'amount_ex',p.amount_ex) ORDER BY p.part_no),'[]') FROM public.job_cost_line_parts p
          WHERE p.line_id = l.id)) ORDER BY l.line_no,l.line_key COLLATE "C")
        INTO lines_before FROM public.job_cost_lines l WHERE l.document_kind = v_doc_kind AND l.document_id = doc;
      INSERT INTO public.reconcile_decisions(org_id,item_id,subject_kind,subject_id,action,clue_ids,before,"by",parts)
      VALUES (org,item.id,p_subject_kind,p_subject_id,'place',picked,jsonb_build_object('run_id',p_run_id,'run_hash',run_hash,'lines',lines_before,
        'item',CASE WHEN item.id IS NOT NULL THEN jsonb_build_object('status',item.status,
          'suggestion',item.suggestion,'snooze_until',item.snooze_until,'evidence_hash',item.evidence_hash) END),
        'matcher:v1',jsonb_build_array(jsonb_build_object('target','job','job_id',job))) RETURNING id INTO decision;
      FOR line IN SELECT l.id,l.amount_ex FROM public.job_cost_lines l WHERE l.document_kind = v_doc_kind
        AND l.document_id = doc AND l.state IS NOT NULL ORDER BY l.id LOOP
        -- The shared writer also refollows this document after changing a line.
        PERFORM public.job_cost_lines_set_state(line.id,'on_job',
          jsonb_build_array(jsonb_build_object('target','job','job_id',job,'amount_ex',line.amount_ex)),
          'matcher',decision,NULL);
      END LOOP;
      IF order_ref IS NOT NULL THEN
        UPDATE public.job_cost_lines l SET order_kind = order_ref->>'kind',order_id = order_ref->>'id'
          WHERE l.document_kind = v_doc_kind AND l.document_id = doc AND l.state IS NOT NULL;
      END IF;
      PERFORM public.reconcile_item_withdraw(p_item_kind,p_subject_kind,p_subject_id,'matched');
      RETURN jsonb_build_object('applied','auto','decision_id',decision);
    END IF;
  END IF;

  IF reason IS NULL OR btrim(reason) = '' THEN RAISE EXCEPTION 'match_reason_required'; END IF;
  IF outcome IS NOT NULL THEN
    suggestion := jsonb_build_object('outcome',outcome,'job_id',job,'division',p_result->>'division',
      'clue_ids',CASE WHEN result_kind = 'auto' THEN array_remove(pair,NULL)
        WHEN p_result ? 'from_clue_index' THEN array_remove(ARRAY[ids[1+(p_result->>'from_clue_index')::int]],NULL)
        ELSE ids END);
  END IF;
  UPDATE public.job_cost_lines l SET needs_reason = reason WHERE l.document_kind = v_doc_kind AND l.document_id = doc
    AND l.state = 'needs_person' AND l.needs_reason IS DISTINCT FROM reason;
  item_id := public.reconcile_item_raise(p_item_kind,p_subject_kind,p_subject_id,coalesce(jobs_named,'{}'),suggestion,
    jsonb_build_object('reason',reason,'amount_ex',amount,'document_date',doc_date,'summary',p_summary,'stops',p_stops),
    'matcher:' || p_rule_version);
  RETURN jsonb_build_object('applied','item','item_id',item_id);
EXCEPTION WHEN data_exception OR integrity_constraint_violation THEN
  RAISE EXCEPTION 'match_input_or_constraint_invalid';
END $fn$;

REVOKE ALL ON FUNCTION public.match_lock_cost_document(text),
  public.match_requeue(text,text,text),
  public.match_clue_add(text,text,uuid,text,text,jsonb,text),
  public.match_apply_stop(text),
  public.match_apply(text,text,uuid,text,jsonb,jsonb,jsonb,jsonb,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.match_lock_cost_document(text),
  public.match_requeue(text,text,text),
  public.match_clue_add(text,text,uuid,text,text,jsonb,text),
  public.match_apply_stop(text),
  public.match_apply(text,text,uuid,text,jsonb,jsonb,jsonb,jsonb,text) TO service_role;
