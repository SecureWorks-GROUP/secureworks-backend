-- P2-03.4. Callable only. No business data or switch changes at install.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $guard$
DECLARE f record;
/* exact parent or this migration's own bodies */ BEGIN
  FOR f IN SELECT p.oid::regprocedure sig, md5(p.prosrc) hash FROM pg_proc p
    WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN
      ('reconcile_undo','reconcile_undo_lines','reconcile_match_clue_key')
  LOOP
    IF (f.sig::text,f.hash) NOT IN (
      ('reconcile_undo(bigint,uuid)','8d34d85b018204c72d7db66ea915dcda'),
      ('reconcile_undo_lines(uuid,text,text)','4dbbeb9de37f716bf9210ce55053a43e'),
      ('reconcile_match_clue_key(match_clues)','02f37748d5e85a1d5aad7d71c13ca5a7')
    ) THEN RAISE EXCEPTION 'reconcile_undo_body_changed'; END IF;
  END LOOP;
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.match_apply_stop(text)'::regprocedure)
    NOT IN ('e5382283d43345f54b314a6fdf6fc897','b7ae6f0f0fbcdc47137b28f9022796d8') THEN
    RAISE EXCEPTION 'match_stop_body_changed';
  END IF;
END $guard$;

-- Preserve coordinates unavailable from a bare run hash when no item existed.
-- Only the successful placement's before-image changes. Undo also needs the
-- pre-withdraw summary because withdraw adds a reason to that object.
DO $matcher$
DECLARE sig regprocedure := 'public.match_apply(text,text,uuid,text,jsonb,jsonb,jsonb,jsonb,text)'::regprocedure;
  h text; def text;
/* patch the checked parent in place, retaining its grants and settings */ BEGIN
  SELECT md5(prosrc), pg_get_functiondef(oid) INTO STRICT h,def FROM pg_proc WHERE oid=sig;
  IF h = '2d37c485e29e0a9a1a2b59985417741f' THEN
    def := replace(def, $old$'run_hash',run_hash,'lines'$old$, $new$'run_hash',run_hash,'item_kind',p_item_kind,'lines'$new$);
    def := replace(def, $old$'status',item.status,$old$, $new$'status',item.status,'summary',item.summary,$new$);
    EXECUTE def;
  END IF;
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=sig) <> 'b011ec334de5208fffc613e5f6fe7fc9' THEN
    RAISE EXCEPTION 'match_apply_body_changed';
  END IF;
END $matcher$;

-- Only semantic facts identify a clue. A replay creates new row and run ids.
CREATE OR REPLACE FUNCTION public.reconcile_match_clue_key(c public.match_clues)
RETURNS text LANGUAGE sql STABLE STRICT SECURITY INVOKER SET search_path='' AS $fn$
  SELECT md5(jsonb_build_array(c.clue_code,c.family,c.root,c.outcome,c.job_id,c.division,
    c.names_one,c.seen_where,c.seen_value,c.detail,c.rule_version,c.kept_from)::text)
$fn$;

CREATE OR REPLACE FUNCTION public.match_apply_stop(p_subject_id text)
RETURNS text LANGUAGE sql STABLE SECURITY INVOKER SET search_path='' AS $fn$
  SELECT 'held_by_person'::text WHERE EXISTS (
    SELECT FROM public.job_cost_lines l WHERE l.document_kind = split_part(p_subject_id,':',1)
    AND l.document_id = substr(p_subject_id,strpos(p_subject_id,':')+1) AND l.decided_by_kind = 'person')
  OR EXISTS (
    -- The receipt survives a refreshed suggestion or placement on other
    -- evidence. Only a later substantive decision by a person releases it.
    SELECT FROM public.reconcile_decisions u
    WHERE u.subject_kind='cost_document' AND u.subject_id=p_subject_id
      AND u.action='undo' AND u.before ? 'matcher_clues'
      AND NOT EXISTS (SELECT FROM public.reconcile_decisions next
        WHERE next.subject_kind=u.subject_kind AND next.subject_id=u.subject_id
          AND next.org_id=u.org_id AND next.id>u.id AND next."by" LIKE 'person:%'
          AND next.action NOT IN ('leave','undo'))
      AND (SELECT jsonb_agg(public.reconcile_match_clue_key(k)) FROM public.match_clues k
        WHERE k.subject_kind=u.subject_kind AND k.subject_id=u.subject_id AND k.org_id=u.org_id AND k.current)
        @> (u.before->'matcher_clues'))
$fn$;

CREATE OR REPLACE FUNCTION public.reconcile_undo_lines(p_org uuid,p_kind text,p_doc text)
RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER SET search_path='' AS $fn$
  SELECT jsonb_agg(jsonb_build_object(
    'id',l.id,'source_hash',l.source_hash,'amount_ex',l.amount_ex,'state',l.state,
    'needs_reason',l.needs_reason,'not_counted_reason',l.not_counted_reason,
    'decided_by_kind',l.decided_by_kind,'decision_id',l.decision_id,
    'covered_by_line_id',l.covered_by_line_id,'order_kind',l.order_kind,'order_id',l.order_id,
    'parts',(SELECT coalesce(jsonb_agg(jsonb_build_object('part_no',p.part_no,'target',p.target,
      'job_id',p.job_id,'division',p.division,'lane',p.lane,'amount_ex',p.amount_ex)
      ORDER BY p.part_no),'[]') FROM public.job_cost_line_parts p WHERE p.line_id=l.id)
  ) ORDER BY l.id) FROM public.job_cost_lines l
  WHERE l.org_id=p_org AND l.document_kind=p_kind AND l.document_id=p_doc
$fn$;

CREATE OR REPLACE FUNCTION public.reconcile_undo(p_decision_id bigint,p_user_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
DECLARE
  staff_org uuid;
  d public.reconcile_decisions;
  item public.reconcile_items;
  other_item uuid;
  restored uuid;
  item_kind text;
  doc_kind text;
  doc text;
  old_lines jsonb;
  current_lines jsonb;
  receipt jsonb;
  old_item jsonb;
  saved jsonb;
  matcher boolean;
  proof jsonb;
  jobs uuid[];
  latest bigint;
  undo_id bigint;
  ctx_id bigint;
  ctx record;
/* one transaction for the document, review item and decision */ BEGIN
  SELECT org_id INTO staff_org FROM public.users WHERE id=p_user_id AND role IN ('admin','owner','ops_manager');
  IF staff_org IS NULL THEN RAISE EXCEPTION 'reconcile_not_staff' USING ERRCODE='42501'; END IF;
  SELECT * INTO d FROM public.reconcile_decisions WHERE id=p_decision_id;
  IF NOT FOUND OR d.action='undo' THEN RAISE EXCEPTION 'reconcile_not_latest'; END IF;
  IF d.org_id <> staff_org THEN RAISE EXCEPTION 'reconcile_not_staff' USING ERRCODE='42501'; END IF;
  IF d.item_id IS NULL AND d."by" NOT LIKE 'matcher:%' AND d.context_decision_id IS NULL THEN
    RAISE EXCEPTION 'reconcile_snapshot_missing';
  END IF;
  matcher := d."by" LIKE 'matcher:%';
  old_item := d.before->'item';
  IF d.item_id IS NOT NULL AND d.context_decision_id IS NULL
    AND old_item->>'status' IS DISTINCT FROM 'open' THEN RAISE EXCEPTION 'reconcile_snapshot_missing'; END IF;
  IF d.item_id IS NOT NULL THEN
    SELECT i.kind INTO item_kind FROM public.reconcile_items i WHERE i.id=d.item_id
      AND i.org_id=d.org_id AND i.subject_table=d.subject_kind AND i.subject_id=d.subject_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'reconcile_item_changed'; END IF;
  ELSIF matcher THEN
    item_kind := d.before->>'item_kind';
    -- Earlier matcher decisions did not keep the kind. Only recover an
    -- unambiguous queue; a bank transaction can be a bank or card line.
    item_kind := coalesce(item_kind, CASE split_part(d.subject_id,':',1) WHEN 'xero_bill' THEN 'bill'
      WHEN 'expense_receipt' THEN 'receipt' WHEN 'xero_credit_note' THEN 'credit' END);
    IF item_kind IS NULL THEN RAISE EXCEPTION 'reconcile_item_kind_unknown'; END IF;
  END IF;

  -- Same lock order as match_apply: list coordinate, items, document, lines.
  IF item_kind IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('reconcile_item_raise'||chr(31)||item_kind||chr(31)||
      d.subject_kind||chr(31)||d.subject_id,0));
  END IF;
  PERFORM 1 FROM public.reconcile_items i WHERE i.subject_table=d.subject_kind
    AND i.subject_id=d.subject_id AND i.org_id=d.org_id AND (i.status='open' OR i.id=d.item_id)
    ORDER BY i.id FOR UPDATE;
  SELECT * INTO item FROM public.reconcile_items WHERE id=d.item_id;
  SELECT i.id INTO other_item FROM public.reconcile_items i WHERE i.status='open'
    AND i.subject_table=d.subject_kind AND i.subject_id=d.subject_id AND i.org_id=d.org_id
    AND i.id IS DISTINCT FROM d.item_id ORDER BY (i.kind=item_kind) DESC,i.id LIMIT 1;
  IF d.subject_kind='cost_document' THEN
    doc_kind := split_part(d.subject_id,':',1);
    doc := substr(d.subject_id,length(doc_kind)+2);
    PERFORM pg_advisory_xact_lock(hashtextextended(d.org_id::text||':'||d.subject_id,0));
    PERFORM 1 FROM public.job_cost_lines WHERE org_id=d.org_id AND document_kind=doc_kind
      AND document_id=doc ORDER BY id FOR UPDATE;
  ELSIF d.context_decision_id IS NOT NULL THEN
    PERFORM 1 FROM public.business_events WHERE id=d.subject_id::uuid FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'reconcile_document_changed'; END IF;
  END IF;
  SELECT id INTO latest FROM public.reconcile_decisions WHERE subject_kind=d.subject_kind
    AND subject_id=d.subject_id AND org_id=d.org_id ORDER BY decided_at DESC,id DESC LIMIT 1;
  IF latest IS DISTINCT FROM d.id THEN RAISE EXCEPTION 'reconcile_not_latest'; END IF;

  receipt := jsonb_build_object('item',CASE WHEN item.id IS NOT NULL THEN jsonb_build_object(
    'status',item.status,'suggestion',item.suggestion,'snooze_until',item.snooze_until,
    'reason',item.reason,'summary',item.summary,
    'closed_at',item.closed_at,'decision_id',item.decision_id,'evidence_hash',item.evidence_hash) END);
  IF doc_kind IS NOT NULL THEN
    old_lines := d.before->'lines';
    current_lines := public.reconcile_undo_lines(d.org_id,doc_kind,doc);
    IF jsonb_typeof(old_lines) IS DISTINCT FROM 'array' OR current_lines IS NULL OR
      jsonb_array_length(current_lines) <> jsonb_array_length(old_lines) OR EXISTS (
        SELECT 1 FROM jsonb_array_elements(current_lines) c FULL JOIN jsonb_array_elements(old_lines) s
          ON c->>'id'=s->>'id'
        WHERE c IS NULL OR s IS NULL OR c->'amount_ex' IS DISTINCT FROM s->'amount_ex'
          OR c->'source_hash' IS DISTINCT FROM s->'source_hash'
          OR NOT (s ?& ARRAY['state','needs_reason','not_counted_reason','decided_by_kind',
            'decision_id','covered_by_line_id']) OR jsonb_typeof(s->'parts') IS DISTINCT FROM 'array'
      ) THEN RAISE EXCEPTION 'reconcile_document_changed'; END IF;
    receipt := receipt || jsonb_build_object('lines',current_lines);
    IF d.action IN ('place','split','overhead','division_stock','duplicate') THEN
      FOR saved IN SELECT value FROM jsonb_array_elements(old_lines) LOOP
        -- A counted line was written by this decision. A newer manual change
        -- outside the shared log cannot be overwritten by this undo.
        IF saved->>'state' IS NOT NULL AND NOT EXISTS (SELECT FROM public.job_cost_lines
          WHERE id=(saved->>'id')::uuid AND decision_id=d.id) THEN
          RAISE EXCEPTION 'reconcile_document_changed';
        END IF;
        IF saved->>'state' IS NULL THEN CONTINUE; END IF;
        UPDATE public.job_cost_lines SET state=saved->>'state',needs_reason=saved->>'needs_reason',
          not_counted_reason=saved->>'not_counted_reason',decided_by_kind=saved->>'decided_by_kind',
          decision_id=(saved->>'decision_id')::bigint,covered_by_line_id=(saved->>'covered_by_line_id')::uuid,
          order_kind=CASE WHEN saved ? 'order_kind' THEN saved->>'order_kind' ELSE order_kind END,
          order_id=CASE WHEN saved ? 'order_id' THEN saved->>'order_id' ELSE order_id END,
          state_changed_at=now(),updated_at=now() WHERE id=(saved->>'id')::uuid;
        DELETE FROM public.job_cost_line_parts WHERE line_id=(saved->>'id')::uuid;
        INSERT INTO public.job_cost_line_parts(line_id,part_no,target,job_id,division,lane,amount_ex)
          SELECT (saved->>'id')::uuid,p.* FROM jsonb_to_recordset(saved->'parts') AS
          p(part_no int,target text,job_id uuid,division text,lane text,amount_ex numeric);
      END LOOP;
      PERFORM public.job_cost_lines_refollow(doc_kind,doc);
      SELECT array_agg(DISTINCT (p->>'job_id')::uuid) INTO jobs FROM jsonb_array_elements(old_lines||current_lines) l,
        jsonb_array_elements(l->'parts') p WHERE p->>'job_id' IS NOT NULL;
      IF cardinality(jobs)>0 THEN
        IF to_regprocedure('public.job_profit_mark(uuid,text)') IS NOT NULL THEN
          PERFORM public.job_profit_mark(j,'person') FROM unnest(jobs) j;
        END IF;
        IF to_regprocedure('public.job_mark_changed(uuid,text)') IS NOT NULL THEN
          PERFORM public.job_mark_changed(j,'person') FROM unnest(jobs) j;
        END IF;
      END IF;
    END IF;
  END IF;

  IF d.context_decision_id IS NOT NULL THEN
    SELECT c.id,c.evidence_hash,c.source_time_hash INTO ctx FROM public.context_reconciliation_decisions c
      WHERE c.subject_kind='event' AND c.subject_id=d.subject_id::uuid ORDER BY c.id DESC LIMIT 1;
    IF NOT FOUND OR ctx.id <> d.context_decision_id THEN RAISE EXCEPTION 'reconcile_not_latest'; END IF;
    ctx_id := public.context_recon_record_decision(d.subject_id::uuid,
      CASE WHEN ctx.source_time_hash IS NULL THEN ctx.evidence_hash
        ELSE md5(jsonb_build_array('matching-source-time-v1',ctx.evidence_hash,ctx.source_time_hash)::text) END,
      'unresolved','{}','ambiguity:undo',p_user_id,NULL);
  END IF;

  IF old_item->>'status'='open' OR (d.context_decision_id IS NOT NULL AND item.decision_id=d.id) THEN
    IF item.id IS NULL OR (coalesce(old_item->>'evidence_hash',d.shown_hash,item.evidence_hash)
       IS DISTINCT FROM item.evidence_hash) THEN RAISE EXCEPTION 'reconcile_item_changed'; END IF;
    IF other_item IS NULL THEN
      UPDATE public.reconcile_items SET status='open',closed_at=NULL,decision_id=NULL,
        suggestion=CASE WHEN old_item ? 'suggestion' THEN nullif(old_item->'suggestion','null') ELSE suggestion END,
        snooze_until=(old_item->>'snooze_until')::timestamptz,
        summary=CASE WHEN old_item ? 'summary' THEN old_item->'summary'
          WHEN matcher THEN summary-'withdrawn_reason' ELSE summary END WHERE id=item.id;
      restored := item.id;
    ELSE
      UPDATE public.reconcile_items SET status='withdrawn',closed_at=coalesce(closed_at,now()),decision_id=NULL
        WHERE id=item.id;
      restored := other_item;
    END IF;
  END IF;
  IF matcher THEN
    SELECT jsonb_agg(public.reconcile_match_clue_key(c) ORDER BY c.id) INTO proof FROM public.match_clues c
      WHERE c.id=ANY(d.clue_ids) AND c.org_id=d.org_id AND c.subject_kind=d.subject_kind AND c.subject_id=d.subject_id;
    IF jsonb_array_length(proof) IS DISTINCT FROM 2 THEN RAISE EXCEPTION 'reconcile_match_evidence_missing'; END IF;
    IF restored IS NULL THEN restored := other_item; END IF;
    IF restored IS NULL THEN
      restored := public.reconcile_item_raise(item_kind,d.subject_kind,d.subject_id,
        ARRAY[(d.parts->0->>'job_id')::uuid],NULL,
        jsonb_build_object('reason','undone_by_person','amount_ex',(SELECT CASE WHEN count(*)=count(l->>'amount_ex')
          THEN sum((l->>'amount_ex')::numeric) END FROM jsonb_array_elements(old_lines) l WHERE l->>'state' IS NOT NULL)),
        'person:'||p_user_id);
    END IF;
    IF restored IS NULL THEN RAISE EXCEPTION 'reconcile_item_changed'; END IF;
    -- Keep the item's original suggestion and evidence hash. The reason on the
    -- review list is distinct from the evidence that was shown to the person.
    UPDATE public.reconcile_items SET reason='undone_by_person' WHERE id=restored AND status='open';
    receipt := receipt || jsonb_build_object('matcher_clues',proof);
  END IF;
  INSERT INTO public.reconcile_decisions(org_id,item_id,subject_kind,subject_id,action,"by",supersedes,
    before,context_decision_id,decided_at) VALUES(d.org_id,coalesce(restored,item.id),d.subject_kind,
    d.subject_id,'undo','person:'||p_user_id,d.id,receipt,ctx_id,greatest(now(),d.decided_at))
    RETURNING id INTO undo_id;
  RETURN jsonb_build_object('decision_id',undo_id,'restored_item_id',restored);
EXCEPTION WHEN data_exception OR integrity_constraint_violation THEN
  RAISE EXCEPTION 'reconcile_restore_invalid';
END $fn$;

REVOKE ALL ON FUNCTION public.reconcile_undo(bigint,uuid),public.reconcile_undo_lines(uuid,text,text),
  public.reconcile_match_clue_key(public.match_clues) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_undo(bigint,uuid),public.reconcile_undo_lines(uuid,text,text),
  public.reconcile_match_clue_key(public.match_clues) TO service_role;
