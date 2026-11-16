-- Rollback for 20261113150000_quote_option_acceptances.sql.
-- Drops the write-once trigger, the two new functions and restores scope_payment_plan
-- to its 20261106044806 body. KEPT: the record table (the only record of which options
-- a customer took; send-quote from before this change never reads it) and the three
-- scope_job_draft_sets columns (nothing before this change reads them). A job whose
-- drafts already took options then fails closed at its payment plan
-- (scope_payment_total_mismatch) rather than billing the base stages: settle it by hand.
DROP TRIGGER IF EXISTS quote_option_acceptances_write_once ON public.quote_option_acceptances;
DROP FUNCTION IF EXISTS public.quote_option_acceptances_write_once();
DROP FUNCTION IF EXISTS public.accept_quote_document_with_options(uuid, timestamptz, jsonb);
DROP FUNCTION IF EXISTS public.apply_quote_options_to_scope_drafts(uuid, uuid);

CREATE OR REPLACE FUNCTION public.scope_payment_plan(p_job uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE d public.scope_job_draft_sets%ROWTYPE; plan public.scope_payment_plans%ROWTYPE;
  schedule jsonb; stage jsonb; payer jsonb; ids text[]:=ARRAY[]::text[]; payer_ids text[];
  amount bigint; total bigint:=0; payer_total bigint; parent record; stage_total bigint; ordinal int:=0;
BEGIN
  -- Same job-first lock order as the parent producer and release.
  PERFORM 1 FROM public.jobs WHERE id=p_job FOR UPDATE NOWAIT;
  SELECT * INTO d FROM public.scope_job_draft_sets WHERE job_id=p_job;
  IF NOT FOUND OR d.released_at IS NULL THEN RETURN NULL; END IF;
  SELECT * INTO plan FROM public.scope_payment_plans WHERE job_id=p_job;
  IF FOUND THEN
    IF plan.scope_revision_id<>d.scope_revision_id THEN RAISE EXCEPTION 'scope_payment_revision_mismatch'; END IF;
    RETURN plan.schedule;
  END IF;
  SELECT r.pricing_canonical_text::jsonb->'local_invoice_stages' INTO schedule
    FROM public.scope_revisions r WHERE r.id=d.scope_revision_id AND r.job_id=p_job
      AND r.status IN ('frozen','superseded')
      AND encode(sha256(convert_to(r.pricing_canonical_text,'UTF8')),'hex')=r.pricing_hash;
  IF schedule IS NULL OR schedule='null'::jsonb THEN RETURN NULL; END IF;
  IF NOT d.amounts_confirmed OR schedule->'version' IS DISTINCT FROM '1'::jsonb OR schedule->>'currency' IS DISTINCT FROM 'AUD'
    OR schedule->>'terms_version' IS DISTINCT FROM '2026-11-06' OR jsonb_typeof(schedule->'stages') IS DISTINCT FROM 'array'
    OR jsonb_array_length(schedule->'stages')=0
    OR public.scope_draft_cents(schedule->'total_inc_gst') IS DISTINCT FROM (d.totals->>'inc_cents')::bigint THEN
    RAISE EXCEPTION 'scope_payment_schedule_invalid' USING ERRCODE='23514';
  END IF;
  FOR stage IN SELECT value FROM jsonb_array_elements(schedule->'stages') LOOP
    ordinal:=ordinal+1;
    amount:=public.scope_draft_cents(stage->'amount_inc_gst');
    IF amount IS NULL OR jsonb_typeof(stage->'id') IS DISTINCT FROM 'string'
      OR coalesce(stage->>'id','')='' OR length(stage->>'id')>200 OR stage->>'id'=ANY(ids)
      OR jsonb_typeof(stage->'label') IS DISTINCT FROM 'string' OR jsonb_typeof(stage->'printed_terms') IS DISTINCT FROM 'string'
      OR coalesce(btrim(stage->>'label'),'')='' OR coalesce(btrim(stage->>'printed_terms'),'')=''
      OR coalesce(stage->>'basis','') NOT IN ('deposit','work_done','materials_supplied','unconfirmed')
      OR coalesce(stage#>>'{trigger,kind}','') NOT IN ('quote_accepted','install_scheduled','council_step_completed','stage_confirmed')
      OR stage#>>'{due_rule,kind}' IS DISTINCT FROM 'days_after_trigger'
      OR jsonb_typeof(stage#>'{due_rule,days}') IS DISTINCT FROM 'number'
      OR (stage#>>'{due_rule,days}')::numeric<0
      OR trunc((stage#>>'{due_rule,days}')::numeric)<>(stage#>>'{due_rule,days}')::numeric
      OR jsonb_typeof(stage->'payers') IS DISTINCT FROM 'array'
      OR jsonb_array_length(stage->'payers')=0 THEN
      RAISE EXCEPTION 'scope_payment_schedule_invalid' USING ERRCODE='23514';
    END IF;
    -- Validate the storage/date range for every stage before consuming any.
    PERFORM d.released_at+make_interval(days=>(stage#>>'{due_rule,days}')::int);
    IF ordinal=1 AND (stage->>'basis'<>'deposit' OR stage#>>'{trigger,kind}'<>'quote_accepted')
      OR ordinal>1 AND (stage->>'basis'='deposit' OR stage#>>'{trigger,kind}'='quote_accepted') THEN
      RAISE EXCEPTION 'scope_payment_first_stage_invalid' USING ERRCODE='23514';
    END IF;
    IF stage#>>'{trigger,kind}'='council_step_completed' AND (
      coalesce(stage#>>'{trigger,submission_id}','')='' OR coalesce(stage#>>'{trigger,step_id}','')=''
      OR coalesce(stage#>>'{trigger,step_name}','')='') THEN
      RAISE EXCEPTION 'scope_payment_council_identity_missing' USING ERRCODE='23514';
    END IF;
    ids:=array_append(ids,stage->>'id'); total:=total+amount; stage_total:=0; payer_ids:=ARRAY[]::text[];
    FOR payer IN SELECT value FROM jsonb_array_elements(stage->'payers') LOOP
      amount:=public.scope_draft_cents(payer->'amount_inc_gst');
      IF amount IS NULL OR payer->>'payer_id'=ANY(payer_ids) OR NOT EXISTS (
        SELECT 1 FROM public.scope_job_draft_invoices i WHERE i.job_id=p_job AND i.scope_revision_id=d.scope_revision_id
          AND i.payer_id=payer->>'payer_id') THEN
        RAISE EXCEPTION 'scope_payment_payer_invalid' USING ERRCODE='23514';
      END IF;
      payer_ids:=array_append(payer_ids,payer->>'payer_id'); stage_total:=stage_total+amount;
    END LOOP;
    IF stage_total<>public.scope_draft_cents(stage->'amount_inc_gst') THEN
      RAISE EXCEPTION 'scope_payment_stage_sum_mismatch' USING ERRCODE='23514';
    END IF;
  END LOOP;
  IF total<>(d.totals->>'inc_cents')::bigint THEN RAISE EXCEPTION 'scope_payment_total_mismatch' USING ERRCODE='23514'; END IF;
  FOR parent IN SELECT * FROM public.scope_job_draft_invoices WHERE job_id=p_job AND scope_revision_id=d.scope_revision_id LOOP
    SELECT sum(public.scope_draft_cents(p.value->'amount_inc_gst')) INTO payer_total
      FROM jsonb_array_elements(schedule->'stages') s CROSS JOIN LATERAL jsonb_array_elements(s.value->'payers') p
      WHERE p.value->>'payer_id'=parent.payer_id;
    IF payer_total IS DISTINCT FROM parent.inc_cents THEN RAISE EXCEPTION 'scope_payment_payer_sum_mismatch' USING ERRCODE='23514'; END IF;
  END LOOP;
  INSERT INTO public.scope_payment_plans(job_id,org_id,scope_revision_id,schedule) VALUES(p_job,d.org_id,d.scope_revision_id,schedule);
  RETURN schedule;
END $$;
REVOKE ALL ON FUNCTION public.scope_payment_plan(uuid) FROM PUBLIC, anon, authenticated, service_role;
