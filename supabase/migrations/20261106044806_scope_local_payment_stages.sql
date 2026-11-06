-- Local payment-stage children of the retained payer drafts. No accounting,
-- sending, authorisation, payment links, flags or backfill.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE IF NOT EXISTS public.scope_payment_plans (
  job_id uuid PRIMARY KEY REFERENCES public.scope_job_draft_sets(job_id),
  org_id uuid NOT NULL,
  scope_revision_id uuid NOT NULL REFERENCES public.scope_revisions(id),
  schedule jsonb NOT NULL,
  captured_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.scope_payment_stage_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES public.scope_payment_plans(job_id),
  scope_revision_id uuid NOT NULL REFERENCES public.scope_revisions(id),
  stage_id text NOT NULL,
  trigger jsonb NOT NULL,
  happened_at timestamptz NOT NULL,
  UNIQUE(job_id, stage_id)
);
-- Keep an exact named event that arrives before full acceptance. It can be
-- consumed only by this same source revision once accepted, never re-priced.
CREATE TABLE IF NOT EXISTS public.scope_payment_signals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES public.scope_job_draft_sets(job_id),
  scope_revision_id uuid NOT NULL REFERENCES public.scope_revisions(id),
  kind text NOT NULL,
  coordinate jsonb NOT NULL,
  happened_at timestamptz NOT NULL,
  UNIQUE(job_id,scope_revision_id,kind,coordinate)
);
CREATE TABLE IF NOT EXISTS public.scope_payment_stage_drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES public.scope_payment_plans(job_id),
  org_id uuid NOT NULL,
  scope_revision_id uuid NOT NULL REFERENCES public.scope_revisions(id),
  payer_invoice_id uuid NOT NULL REFERENCES public.scope_job_draft_invoices(id),
  payer_id text NOT NULL,
  stage_id text NOT NULL,
  event_id uuid NOT NULL REFERENCES public.scope_payment_stage_events(id),
  amount_cents bigint NOT NULL CHECK(amount_cents >= 0),
  due_rule jsonb NOT NULL,
  due_at timestamptz NOT NULL,
  held_reason text,
  UNIQUE(job_id, payer_id, stage_id)
);
CREATE TABLE IF NOT EXISTS public.scope_payment_stage_confirmations (
  job_id uuid NOT NULL REFERENCES public.scope_payment_plans(job_id),
  stage_id text NOT NULL,
  actor_id uuid NOT NULL REFERENCES public.users(id),
  evidence_kind text NOT NULL CHECK(evidence_kind IN ('work_done','materials_supplied')),
  note text NOT NULL CHECK(length(btrim(note)) BETWEEN 1 AND 4000),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(job_id,stage_id)
);
ALTER TABLE public.scope_payment_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.scope_payment_stage_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.scope_payment_stage_drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.scope_payment_stage_confirmations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.scope_payment_signals ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.scope_payment_plans, public.scope_payment_stage_events,
  public.scope_payment_stage_drafts, public.scope_payment_stage_confirmations, public.scope_payment_signals FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.scope_payment_plans, public.scope_payment_stage_events,
  public.scope_payment_stage_drafts, public.scope_payment_stage_confirmations, public.scope_payment_signals TO service_role;

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

-- Internal producer. The wrappers below supply authoritative event identity
-- and time. No API action accepts these arguments or a monetary figure.
CREATE OR REPLACE FUNCTION public.apply_scope_payment_event(p_job uuid,p_kind text,p_coordinate jsonb,p_at timestamptz,p_stage_id text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE schedule jsonb; stage jsonb; payer jsonb; plan public.scope_payment_plans%ROWTYPE;
  event uuid; held text; confirmation public.scope_payment_stage_confirmations%ROWTYPE;
BEGIN
  schedule:=public.scope_payment_plan(p_job);
  IF schedule IS NULL THEN RETURN; END IF;
  SELECT * INTO plan FROM public.scope_payment_plans WHERE job_id=p_job;
  FOR stage IN SELECT value FROM jsonb_array_elements(schedule->'stages') LOOP
    IF p_stage_id IS NOT NULL AND stage->>'id'<>p_stage_id THEN CONTINUE; END IF;
    IF stage#>>'{trigger,kind}'<>p_kind THEN CONTINUE; END IF;
    IF p_kind='council_step_completed' AND (stage#>'{trigger}'<>p_coordinate) THEN CONTINUE; END IF;
    held:=NULL;
    IF stage->>'basis'='unconfirmed' THEN held:='basis_unconfirmed';
    ELSIF p_kind='install_scheduled' OR stage->>'basis'='materials_supplied' AND p_kind<>'stage_confirmed'
      THEN held:='work_or_material_evidence_required'; END IF;
    SELECT * INTO confirmation FROM public.scope_payment_stage_confirmations WHERE job_id=p_job AND stage_id=stage->>'id';
    IF FOUND AND stage->>'basis'=confirmation.evidence_kind THEN held:=NULL; END IF;
    INSERT INTO public.scope_payment_stage_events(job_id,scope_revision_id,stage_id,trigger,happened_at)
      VALUES(p_job,plan.scope_revision_id,stage->>'id',p_coordinate,p_at)
      ON CONFLICT(job_id,stage_id) DO NOTHING RETURNING id INTO event;
    IF event IS NULL THEN CONTINUE; END IF;
    FOR payer IN SELECT value FROM jsonb_array_elements(stage->'payers') LOOP
      INSERT INTO public.scope_payment_stage_drafts(job_id,org_id,scope_revision_id,payer_invoice_id,payer_id,stage_id,event_id,amount_cents,due_rule,due_at,held_reason)
        SELECT p_job,plan.org_id,plan.scope_revision_id,i.id,i.payer_id,stage->>'id',event,
          public.scope_draft_cents(payer->'amount_inc_gst'),stage->'due_rule',
          p_at+make_interval(days=>(stage#>>'{due_rule,days}')::int),held
        FROM public.scope_job_draft_invoices i WHERE i.job_id=p_job AND i.scope_revision_id=plan.scope_revision_id AND i.payer_id=payer->>'payer_id';
    END LOOP;
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION public.record_scope_payment_signal(p_job uuid,p_kind text,p_coordinate jsonb,p_at timestamptz)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE source uuid; recorded_at timestamptz;
BEGIN
  SELECT scope_revision_id INTO source FROM public.scope_job_draft_sets WHERE job_id=p_job;
  IF NOT FOUND THEN RETURN; END IF;
  INSERT INTO public.scope_payment_signals(job_id,scope_revision_id,kind,coordinate,happened_at)
    VALUES(p_job,source,p_kind,p_coordinate,p_at) ON CONFLICT(job_id,scope_revision_id,kind,coordinate) DO NOTHING;
  SELECT happened_at INTO recorded_at FROM public.scope_payment_signals
    WHERE job_id=p_job AND scope_revision_id=source AND kind=p_kind AND coordinate=p_coordinate;
  BEGIN
    PERFORM public.apply_scope_payment_event(p_job,p_kind,p_coordinate,recorded_at);
  EXCEPTION
    WHEN query_canceled THEN RAISE WARNING 'local payment event retained for retry after timeout';
    WHEN OTHERS THEN RAISE WARNING 'local payment event retained but held: %',SQLSTATE;
  END;
END $$;

CREATE OR REPLACE FUNCTION public.scope_payment_acceptance_event()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE signal record;
BEGIN
  IF OLD.released_at IS NULL AND NEW.released_at IS NOT NULL THEN
    BEGIN
      PERFORM public.record_scope_payment_signal(NEW.job_id,'quote_accepted',
        jsonb_build_object('kind','quote_accepted','scope_revision_id',NEW.scope_revision_id),NEW.released_at);
      FOR signal IN SELECT * FROM public.scope_payment_signals WHERE job_id=NEW.job_id AND scope_revision_id=NEW.scope_revision_id
        AND kind IN ('install_scheduled','council_step_completed') ORDER BY happened_at,id LOOP
        PERFORM public.apply_scope_payment_event(NEW.job_id,signal.kind,signal.coordinate,signal.happened_at);
      END LOOP;
    EXCEPTION
      WHEN query_canceled THEN RAISE WARNING 'local payment stages held after timeout; acceptance retained';
      WHEN OTHERS THEN RAISE WARNING 'local payment stages held; acceptance retained: %',SQLSTATE;
    END;
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS scope_payment_on_acceptance ON public.scope_job_draft_sets;
CREATE TRIGGER scope_payment_on_acceptance AFTER UPDATE OF released_at ON public.scope_job_draft_sets
  FOR EACH ROW EXECUTE FUNCTION public.scope_payment_acceptance_event();

CREATE OR REPLACE FUNCTION public.scope_payment_install_event()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF NEW.scheduled_date IS NOT NULL AND NOT coalesce(NEW.is_ghost,false) AND NEW.status IS DISTINCT FROM 'cancelled'
    AND NEW.role IS DISTINCT FROM 'observer' AND NEW.assignment_type='install' THEN
    BEGIN
      PERFORM public.record_scope_payment_signal(NEW.job_id,'install_scheduled',
        jsonb_build_object('kind','install_scheduled','assignment_id',NEW.id,'scheduled_date',NEW.scheduled_date),clock_timestamp());
    EXCEPTION
      WHEN query_canceled THEN RAISE WARNING 'local payment stages held after timeout; booking retained';
      WHEN OTHERS THEN RAISE WARNING 'local payment stages held; booking retained: %',SQLSTATE;
    END;
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS scope_payment_on_install ON public.job_assignments;
CREATE TRIGGER scope_payment_on_install AFTER INSERT OR UPDATE OF scheduled_date,status,assignment_type ON public.job_assignments
  FOR EACH ROW EXECUTE FUNCTION public.scope_payment_install_event();

CREATE OR REPLACE FUNCTION public.consume_scope_council_payment_event(p_submission uuid,p_step text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE sub public.council_submissions%ROWTYPE; step jsonb;
BEGIN
  SELECT * INTO sub FROM public.council_submissions WHERE id=p_submission;
  IF NOT FOUND THEN RETURN; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.scope_job_draft_sets d WHERE d.job_id=sub.job_id AND d.org_id=sub.org_id)
    OR (SELECT count(*) FROM jsonb_array_elements(sub.steps) WHERE value->>'step_id'=p_step)<>1 THEN RETURN; END IF;
  SELECT value INTO step FROM jsonb_array_elements(sub.steps) WHERE value->>'step_id'=p_step;
  IF step->>'status' IS DISTINCT FROM 'complete' OR step->>'completed_at' IS NULL THEN RETURN; END IF;
  PERFORM public.record_scope_payment_signal(sub.job_id,'council_step_completed',jsonb_build_object(
    'kind','council_step_completed','submission_id',sub.id,'step_id',p_step,'step_name',step->>'name'),
    (step->>'completed_at')::timestamptz);
END $$;

CREATE OR REPLACE FUNCTION public.read_scope_payment_stages(p_job_id uuid,p_scope_revision_id uuid,p_org_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE rows jsonb; prepared boolean;
BEGIN
  PERFORM 1 FROM public.jobs WHERE id=p_job_id AND org_id=p_org_id FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'scope_payment_job_forbidden' USING ERRCODE='42501'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.scope_job_draft_sets WHERE job_id=p_job_id AND scope_revision_id=p_scope_revision_id) THEN
    RAISE EXCEPTION 'scope_payment_revision_mismatch' USING ERRCODE='23514'; END IF;
  SELECT EXISTS(SELECT 1 FROM public.scope_payment_plans WHERE job_id=p_job_id AND scope_revision_id=p_scope_revision_id) INTO prepared;
  SELECT jsonb_agg(jsonb_build_object('id',d.id,'payer_id',d.payer_id,'payer_invoice_id',d.payer_invoice_id,
      'stage_id',d.stage_id,'scope_revision_id',d.scope_revision_id,'status','draft','amount_inc_gst',d.amount_cents/100.0,
      'trigger',e.trigger,'due_rule',d.due_rule,'due_at',d.due_at,'held_reason',d.held_reason)
      ORDER BY d.stage_id COLLATE "C",d.payer_id COLLATE "C") INTO rows
    FROM public.scope_payment_stage_drafts d JOIN public.scope_payment_stage_events e ON e.id=d.event_id
    WHERE d.job_id=p_job_id AND d.scope_revision_id=p_scope_revision_id;
  RETURN jsonb_build_object('job_id',p_job_id,'scope_revision_id',p_scope_revision_id,'prepared',prepared,
    'stages',coalesce(rows,'[]'::jsonb),'xero_writes',false,'sent',false,'payment_links',false);
END $$;

CREATE OR REPLACE FUNCTION public.confirm_scope_payment_stage(p_job_id uuid,p_scope_revision_id uuid,p_org_id uuid,p_actor uuid,
  p_stage_id text,p_evidence_kind text,p_note text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE schedule jsonb; stage jsonb; source public.scope_job_draft_sets%ROWTYPE;
BEGIN
  PERFORM 1 FROM public.jobs WHERE id=p_job_id AND org_id=p_org_id FOR UPDATE;
  IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM public.users WHERE id=p_actor AND org_id=p_org_id
    AND role IN ('admin','owner','ops_manager')) THEN RAISE EXCEPTION 'scope_payment_actor_forbidden' USING ERRCODE='42501'; END IF;
  SELECT * INTO source FROM public.scope_job_draft_sets WHERE job_id=p_job_id;
  IF source.scope_revision_id IS DISTINCT FROM p_scope_revision_id OR source.released_at IS NULL THEN
    RAISE EXCEPTION 'scope_payment_accepted_revision_required' USING ERRCODE='23514'; END IF;
  schedule:=public.scope_payment_plan(p_job_id);
  SELECT value INTO stage FROM jsonb_array_elements(schedule->'stages') WHERE value->>'id'=p_stage_id;
  IF stage IS NULL OR p_evidence_kind NOT IN ('work_done','materials_supplied') OR coalesce(btrim(p_note),'')='' THEN
    RAISE EXCEPTION 'scope_payment_confirmation_invalid' USING ERRCODE='23514'; END IF;
  IF stage->>'basis' NOT IN (p_evidence_kind,'unconfirmed') THEN
    RAISE EXCEPTION 'scope_payment_evidence_basis_mismatch' USING ERRCODE='23514'; END IF;
  INSERT INTO public.scope_payment_stage_confirmations(job_id,stage_id,actor_id,evidence_kind,note)
    VALUES(p_job_id,p_stage_id,p_actor,p_evidence_kind,p_note) ON CONFLICT(job_id,stage_id) DO NOTHING;
  IF stage#>>'{trigger,kind}'='stage_confirmed' THEN
    PERFORM public.apply_scope_payment_event(p_job_id,'stage_confirmed',
      jsonb_build_object('kind','stage_confirmed','stage_id',p_stage_id),clock_timestamp(),p_stage_id);
  END IF;
  -- Confirmation never changes frozen money, event identity or due date. An
  -- unconfirmed contractual basis stays held even after work is evidenced.
  IF stage->>'basis'=p_evidence_kind THEN
    UPDATE public.scope_payment_stage_drafts SET held_reason=NULL
      WHERE job_id=p_job_id AND stage_id=p_stage_id AND held_reason='work_or_material_evidence_required';
  END IF;
  RETURN public.read_scope_payment_stages(p_job_id,p_scope_revision_id,p_org_id);
END $$;

REVOKE ALL ON FUNCTION public.scope_payment_plan(uuid),public.apply_scope_payment_event(uuid,text,jsonb,timestamptz,text),
  public.record_scope_payment_signal(uuid,text,jsonb,timestamptz),
  public.scope_payment_acceptance_event(),public.scope_payment_install_event(),public.consume_scope_council_payment_event(uuid,text),
  public.read_scope_payment_stages(uuid,uuid,uuid),public.confirm_scope_payment_stage(uuid,uuid,uuid,uuid,text,text,text)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.consume_scope_council_payment_event(uuid,text),public.read_scope_payment_stages(uuid,uuid,uuid),
  public.confirm_scope_payment_stage(uuid,uuid,uuid,uuid,text,text,text) TO service_role;
