-- P4-02.2: explicit dry run overrides the existing off-seeded switch.
CREATE OR REPLACE FUNCTION public.context_ledger_close_on_records(p_job_id uuid, p_dry_run boolean DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE v_write boolean; i public.context_ledger_items; g uuid; c record; v_candidates jsonb;
 v_chosen jsonb; v_evidence jsonb; v_would integer := 0; v_closed integer := 0;
 v_ambiguous integer := 0; v_items jsonb := '[]';
/* close block */ BEGIN
 v_write := NOT coalesce(p_dry_run, NOT coalesce((SELECT enabled FROM public.feature_flags WHERE flag_name = 'context_record_close_v1'), false));
 -- The generation lock matches person_edit and serializes promotion and close.
 -- context_ledger_generations_one_live; items use context_ledger_items_generation.
 SELECT id INTO g FROM public.context_ledger_generations WHERE job_id=p_job_id AND status='live' FOR UPDATE;
 FOR i IN SELECT li.* FROM public.context_ledger_items li WHERE li.generation_id=g AND li.job_id=p_job_id
  AND li.status='open' AND NOT li.person_locked AND NOT coalesce(li.job_not_certain,false)
  AND li.written_by NOT LIKE 'person:%' AND li.closes_on IN ('quote_sent','invoice_issued','payment','booking_made','visit','work_done')
  ORDER BY li.id FOR UPDATE
 LOOP
  SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.closes_at,x.table_name COLLATE "C",x.record_id COLLATE "C"),'[]')
   INTO v_candidates FROM public.context_ledger_record_candidates(p_job_id,i.closes_on,i.about_key,i.opened_at,i.from_role) x;
  v_chosen := NULL;
  IF i.about_key ~ '^(invoice:inv-|quote:q-|booking:)' THEN
   SELECT value INTO v_chosen FROM jsonb_array_elements(v_candidates) WHERE value->>'key'=i.about_key LIMIT 1;
  ELSIF jsonb_array_length(v_candidates)=1 THEN v_chosen := v_candidates->0;
  END IF;
  IF v_chosen IS NULL THEN
   IF jsonb_array_length(v_candidates)>1 THEN
    v_ambiguous := v_ambiguous+1;
    v_items := v_items || jsonb_build_array(jsonb_build_object('item_id',i.id,'item_key',i.item_key,
     'candidates',(SELECT jsonb_agg(jsonb_build_object('table_name',value->>'table_name','record_id',value->>'record_id','label',value->>'label'))
      FROM jsonb_array_elements(v_candidates))));
   END IF;
   CONTINUE;
  END IF;
  v_would := v_would+1;
  IF v_write THEN
   v_evidence := jsonb_build_array(jsonb_build_object('table',v_chosen->>'table_name','id',v_chosen->>'record_id'));
   UPDATE public.context_ledger_items SET status='closed',closed_at=(v_chosen->>'closes_at')::timestamptz,
    closed_by=v_evidence,updated_at=now() WHERE id=i.id;
   INSERT INTO public.context_ledger_transitions(item_id,generation_id,job_id,from_status,to_status,by,evidence,reason)
   VALUES(i.id,i.generation_id,p_job_id,'open','closed','rule:record_close_v1',v_evidence,v_chosen->>'label');
   v_closed := v_closed+1;
  END IF;
 END LOOP;
 RETURN jsonb_build_object('job_id',p_job_id,'wrote',v_write,'would_close',v_would,'closed',v_closed,
  'ambiguous',v_ambiguous,'ambiguous_items',v_items);
END $fn$;

CREATE OR REPLACE FUNCTION public.context_ledger_record_close_undo(p_since timestamptz)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE i public.context_ledger_items; v_count integer := 0; v_by text; v_at timestamptz; v_evidence jsonb;
/* undo block */ BEGIN
 -- context_ledger_items_job_status does not lead on status. This manual undo
 -- starts from the indexed transition time, then uses item/generation primary keys.
 FOR i IN SELECT li.* FROM public.context_ledger_items li
  WHERE li.id IN (SELECT tr.item_id FROM public.context_ledger_transitions tr
   WHERE tr.by='rule:record_close_v1' AND tr.at>=p_since)
  AND li.status='closed' AND NOT li.person_locked ORDER BY li.generation_id,li.id
 LOOP
  PERFORM 1 FROM public.context_ledger_generations WHERE id=i.generation_id FOR UPDATE;
  SELECT * INTO i FROM public.context_ledger_items WHERE id=i.id FOR UPDATE;
  -- context_ledger_transitions_item, with identity as a tie-break for now().
  SELECT tr.by,tr.at,tr.evidence INTO v_by,v_at,v_evidence FROM public.context_ledger_transitions tr WHERE tr.item_id=i.id ORDER BY tr.at DESC,tr.id DESC LIMIT 1;
  IF i.status<>'closed' OR i.person_locked OR v_by IS DISTINCT FROM 'rule:record_close_v1' OR v_at<p_since THEN CONTINUE; END IF;
  UPDATE public.context_ledger_items SET status='open',closed_at=NULL,closed_by=NULL,updated_at=now() WHERE id=i.id;
  INSERT INTO public.context_ledger_transitions(item_id,generation_id,job_id,from_status,to_status,by,evidence,reason)
  VALUES(i.id,i.generation_id,i.job_id,'closed','open','rule:record_close_undo',v_evidence,'Record close undone.');
  v_count := v_count+1;
 END LOOP;
 RETURN v_count;
END $fn$;
-- The undo is manual, not a timer. Its starting range must not scan history.
CREATE INDEX IF NOT EXISTS context_ledger_record_close_at ON public.context_ledger_transitions(at,item_id)
 WHERE by='rule:record_close_v1';
REVOKE ALL ON FUNCTION public.context_ledger_close_on_records(uuid,boolean), public.context_ledger_record_close_undo(timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.context_ledger_close_on_records(uuid,boolean), public.context_ledger_record_close_undo(timestamptz) TO service_role;
