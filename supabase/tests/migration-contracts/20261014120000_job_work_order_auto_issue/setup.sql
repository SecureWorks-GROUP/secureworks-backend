-- Pre-migration surface for the automatic issue of job work orders. Earlier
-- registered cases already create public.jobs, public.users,
-- public.work_orders (with the job work order layer of 20261012130000),
-- public.job_events and public.feature_flags.
--
-- Two drafts the quote fill wrote before this migration, as production holds
-- them on 14 Oct 2026: one nobody touched after its fill event (the migration
-- stamps it as the fill's own) and one saved after its fill event (it stays
-- unstamped and waits for the approver).

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN; END IF;
END $$;

DO $$
DECLARE
  v_untouched uuid := 'a0a0a0a0-0000-4000-8000-000000000001';
  v_saved uuid := 'a0a0a0a0-0000-4000-8000-000000000002';
  v_wo uuid;
BEGIN
  IF EXISTS (SELECT 1 FROM public.jobs WHERE id IN (v_untouched, v_saved)) THEN
    RETURN;
  END IF;
  INSERT INTO public.jobs (id, org_id, type, status, job_number) VALUES
    (v_untouched, '00000000-0000-0000-0000-000000000001', 'fencing', 'accepted', 'WOA-PRIOR-1'),
    (v_saved, '00000000-0000-0000-0000-000000000001', 'fencing', 'accepted', 'WOA-PRIOR-2');

  SELECT id INTO v_wo FROM public.work_orders WHERE job_id = v_untouched AND kind = 'job';
  UPDATE public.work_orders
    SET scope_items = '[{"description":"Install 20 m Colorbond","qty":20,"unit":"m","source":"quote"}]',
        agreed_labour_ex = 700
    WHERE id = v_wo;
  INSERT INTO public.job_events (id, job_id, event_type, detail_json, created_at)
  SELECT gen_random_uuid(), v_untouched, 'job_work_order_draft_filled_from_quote', jsonb_build_object('work_order_id', v_wo),
         wo.updated_at + interval '1 second'
  FROM public.work_orders wo WHERE wo.id = v_wo;

  SELECT id INTO v_wo FROM public.work_orders WHERE job_id = v_saved AND kind = 'job';
  UPDATE public.work_orders
    SET scope_items = '[{"description":"Install 10 m Colorbond","qty":10,"unit":"m","source":"quote"}]',
        agreed_labour_ex = 350
    WHERE id = v_wo;
  -- The fill event, then a save after it.
  INSERT INTO public.job_events (id, job_id, event_type, detail_json, created_at)
  SELECT gen_random_uuid(), v_saved, 'job_work_order_draft_filled_from_quote', jsonb_build_object('work_order_id', v_wo),
         wo.updated_at - interval '1 second'
  FROM public.work_orders wo WHERE wo.id = v_wo;
END $$;
