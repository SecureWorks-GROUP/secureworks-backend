BEGIN;
DO $$
DECLARE d jsonb; r jsonb; a uuid; b uuid; credit uuid; parts jsonb;
  org uuid := '00000000-0000-0000-0000-000000000001';
BEGIN
  d := jsonb_build_object('org_id',org,'document_kind','xero_bill','document_id','ZZTEST-writer',
    'document_status','AUTHORISED','live',true,'lines',jsonb_build_array(
      jsonb_build_object('line_key','1','line_no',1,'kind','supplier_bill','lane','materials','amount_ex',100),
      jsonb_build_object('line_key','2','line_no',2,'kind','supplier_bill','lane','materials','amount_ex',100)));
  r := public.job_cost_lines_upsert_documents(jsonb_build_array(d));
  IF (r->>'lines_written')::int <> 2 OR (SELECT count(*) FROM public.job_cost_lines
    WHERE document_id = 'ZZTEST-writer' AND state = 'needs_person') <> 2 THEN
    RAISE EXCEPTION 'writer: new lines need a person'; END IF;
  r := public.job_cost_lines_upsert_documents(jsonb_build_array(d));
  IF r->>'lines_written' <> '0' OR r->'changed' <> '[]'::jsonb THEN
    RAISE EXCEPTION 'writer: identical document wrote lines'; END IF;
  SELECT id INTO a FROM public.job_cost_lines WHERE document_id = 'ZZTEST-writer' AND line_key = '1';
  SELECT id INTO b FROM public.job_cost_lines WHERE document_id = 'ZZTEST-writer' AND line_key = '2';
  -- Use an existing synthetic job supplied in this rolled-back fixture.
  INSERT INTO public.jobs(id,org_id,job_number,type,status) VALUES
    ('20000000-0000-4000-8000-000000000001',org,'ZZTEST-990001','fencing','draft');
  parts := '[{"target":"job","job_id":"20000000-0000-4000-8000-000000000001","amount_ex":100}]';
  PERFORM public.job_cost_lines_set_state(a,'on_job',parts,'matcher',NULL,NULL);
  d := jsonb_set(d,'{lines,0,amount_ex}','120');
  PERFORM public.job_cost_lines_upsert_documents(jsonb_build_array(d));
  IF (SELECT amount_ex FROM public.job_cost_line_parts WHERE line_id = a) IS DISTINCT FROM 120 THEN
    RAISE EXCEPTION 'writer: automatic part did not follow amount'; END IF;
  parts := jsonb_set(parts,'{0,amount_ex}','120');
  PERFORM public.job_cost_lines_set_state(a,'on_job',parts,'person',7,NULL);
  BEGIN
    PERFORM public.job_cost_lines_set_state(a,'needs_person','[]','matcher',NULL,NULL);
    RAISE EXCEPTION 'writer: person decision overwritten';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'cost_line_person_decided' THEN RAISE; END IF;
  END;
  d := jsonb_set(d,'{lines,0,amount_ex}','150');
  PERFORM public.job_cost_lines_upsert_documents(jsonb_build_array(d));
  IF NOT EXISTS (SELECT 1 FROM public.job_cost_lines WHERE id=a AND state='needs_person'
    AND needs_reason='document_changed_after_decision' AND decision_id=7)
    OR EXISTS (SELECT 1 FROM public.job_cost_line_parts WHERE line_id=a) THEN
    RAISE EXCEPTION 'writer: changed person amount did not reopen'; END IF;
  -- Whole-document follow: one bill split three ways, plus a negative credit.
  d := jsonb_set(d,'{lines}','[{"line_key":"1","kind":"supplier_bill","lane":"materials","amount_ex":1000}]');
  PERFORM public.job_cost_lines_upsert_documents(jsonb_build_array(d));
  PERFORM public.job_cost_lines_set_state(a,'split',
    '[{"target":"overhead","amount_ex":600},{"target":"overhead","amount_ex":300},{"target":"overhead","amount_ex":100}]',
    'person',8,NULL);
  PERFORM public.job_cost_lines_upsert_documents(jsonb_build_array(jsonb_build_object('org_id',org,
    'document_kind','xero_credit_note','document_id','ZZTEST-credit','document_status','AUTHORISED','live',true,
    'lines','[{"line_key":"1","kind":"supplier_credit","lane":"materials","amount_ex":-100,"follows_document_kind":"xero_bill","follows_document_id":"ZZTEST-writer"}]'::jsonb)));
  SELECT id INTO credit FROM public.job_cost_lines WHERE document_id='ZZTEST-credit';
  -- A removed line is history, not a current undecided bill line.
  PERFORM public.job_cost_lines_refollow('xero_bill','ZZTEST-writer');
  IF (SELECT array_agg(amount_ex ORDER BY part_no) FROM public.job_cost_line_parts WHERE line_id=credit)
    IS DISTINCT FROM ARRAY[-60,-30,-10]::numeric[] THEN
    RAISE EXCEPTION 'writer: removed history poisoned current bill follow'; END IF;
  -- Use an independent single-line bill for the proportional examples.
  d := jsonb_set(d,'{document_id}','"ZZTEST-split"');
  PERFORM public.job_cost_lines_upsert_documents(jsonb_build_array(d));
  SELECT id INTO a FROM public.job_cost_lines WHERE document_id='ZZTEST-split';
  PERFORM public.job_cost_lines_set_state(a,'split',
    '[{"target":"overhead","amount_ex":600},{"target":"overhead","amount_ex":300},{"target":"overhead","amount_ex":100}]','matcher',NULL,NULL);
  UPDATE public.job_cost_lines SET follows_document_id='ZZTEST-split' WHERE id=credit;
  PERFORM public.job_cost_lines_refollow('xero_bill','ZZTEST-split');
  IF (SELECT array_agg(amount_ex ORDER BY part_no) FROM public.job_cost_line_parts WHERE line_id=credit)
    IS DISTINCT FROM ARRAY[-60.00,-30.00,-10.00]::numeric[] THEN RAISE EXCEPTION 'writer: negative proportional parts'; END IF;
  d := jsonb_set(d,'{lines,0,amount_ex}','3');
  PERFORM public.job_cost_lines_upsert_documents(jsonb_build_array(d));
  PERFORM public.job_cost_lines_set_state(a,'split',
    '[{"target":"overhead","amount_ex":1},{"target":"overhead","amount_ex":1},{"target":"overhead","amount_ex":1}]','matcher',NULL,NULL);
  UPDATE public.job_cost_lines SET amount_ex=100 WHERE id=credit;
  PERFORM public.job_cost_lines_refollow('xero_bill','ZZTEST-split');
  IF (SELECT array_agg(amount_ex ORDER BY part_no) FROM public.job_cost_line_parts WHERE line_id=credit)
    IS DISTINCT FROM ARRAY[33.33,33.33,33.34]::numeric[] THEN RAISE EXCEPTION 'writer: cents remainder'; END IF;
  d := jsonb_set(d,'{live}','false');
  PERFORM public.job_cost_lines_upsert_documents(jsonb_build_array(d));
  IF NOT EXISTS (SELECT 1 FROM public.job_cost_lines WHERE id=a AND state IS NULL AND not_counted_reason='document_not_live')
    OR EXISTS(SELECT 1 FROM public.job_cost_line_parts WHERE line_id=a) THEN RAISE EXCEPTION 'writer: non-live parts survived'; END IF;
  -- Excluded duplicates retain coverage and state on source updates and removal.
  UPDATE public.job_cost_lines SET not_counted_reason='duplicate_document',covered_by_line_id=b WHERE id=a;
  d := jsonb_set(d,'{lines,0,amount_ex}','9');
  PERFORM public.job_cost_lines_upsert_documents(jsonb_build_array(d));
  d := jsonb_set(d,'{lines}','[]');
  PERFORM public.job_cost_lines_upsert_documents(jsonb_build_array(d));
  IF NOT EXISTS (SELECT 1 FROM public.job_cost_lines WHERE id=a AND not_counted_reason='duplicate_document'
    AND covered_by_line_id=b AND amount_ex=9) THEN RAISE EXCEPTION 'writer: duplicate protection lost'; END IF;
  IF has_function_privilege('authenticated','public.job_cost_lines_upsert_documents(jsonb)','EXECUTE')
    OR has_function_privilege('anon','public.job_cost_lines_set_state(uuid,text,jsonb,text,bigint,text)','EXECUTE')
    OR has_function_privilege('authenticated','public.job_cost_lines_refollow(text,text)','EXECUTE') THEN
    RAISE EXCEPTION 'writer: browser execution allowed'; END IF;
END;
$$;
SET CONSTRAINTS ALL IMMEDIATE;
ROLLBACK;
