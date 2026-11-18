-- Contract for 20261118153001_job_work_order_labour_confirm.sql. Every
-- fixture write is inside one transaction that rolls back. Made-up amounts,
-- ZZTEST job numbers, roles only.

\ir ../../../migrations/20261118153001_job_work_order_labour_confirm.sql

-- 1. Shape: switch seeded off, the write is service-role only, the record is
-- not readable by browser roles.
DO $$
BEGIN
  IF COALESCE((SELECT enabled FROM public.feature_flags
               WHERE flag_name = 'job_work_order_labour_confirm_v1'), true) THEN
    RAISE EXCEPTION 'ZZTEST labour confirm switch must be seeded off';
  END IF;
  IF has_function_privilege('authenticated',
       'public.confirm_job_work_order_labour(uuid,uuid,numeric,uuid,uuid)', 'EXECUTE')
     OR has_function_privilege('anon',
       'public.confirm_job_work_order_labour(uuid,uuid,numeric,uuid,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'ZZTEST confirm write must be service-role only';
  END IF;
  IF has_table_privilege('authenticated', 'public.job_work_order_labour_confirmations', 'SELECT')
     OR has_table_privilege('service_role', 'public.job_work_order_labour_confirmations', 'INSERT') THEN
    RAISE EXCEPTION 'ZZTEST confirmations are written only by the function';
  END IF;
END $$;

-- 2. Behaviour.
BEGIN;
SET LOCAL session_replication_role = replica;
INSERT INTO public.users (id, org_id, name, role) VALUES
  ('00000000-0000-0000-0000-0000000fc001', '00000000-0000-0000-0000-0000000fc0a0', 'ZZTEST office', 'ops_manager'),
  ('00000000-0000-0000-0000-0000000fc002', '00000000-0000-0000-0000-0000000fc0a0', 'ZZTEST trade', 'lead_installer');
INSERT INTO public.jobs (id, org_id, job_number, type, status) VALUES
  ('00000000-0000-0000-0000-0000000fc101', '00000000-0000-0000-0000-0000000fc0a0', 'ZZTEST-LC1', 'patio', 'scheduled'),
  ('00000000-0000-0000-0000-0000000fc102', '00000000-0000-0000-0000-0000000fc0a0', 'ZZTEST-LC2', 'patio', 'scheduled'),
  ('00000000-0000-0000-0000-0000000fc103', '00000000-0000-0000-0000-0000000fc0a0', 'ZZTEST-LC3', 'patio', 'scheduled');
INSERT INTO public.scope_revisions (id, job_id, revision_number, status, scope_canonical_text, pricing_canonical_text, scope_hash, pricing_hash) VALUES
  ('00000000-0000-0000-0000-0000000fc201', '00000000-0000-0000-0000-0000000fc101', 1, 'frozen', '{}', '{"p":1}',
   encode(sha256(convert_to('{}', 'UTF8')), 'hex'), encode(sha256(convert_to('{"p":1}', 'UTF8')), 'hex')),
  ('00000000-0000-0000-0000-0000000fc202', '00000000-0000-0000-0000-0000000fc102', 1, 'frozen', '{}', '{"p":2}',
   encode(sha256(convert_to('{}', 'UTF8')), 'hex'), encode(sha256(convert_to('{"p":2}', 'UTF8')), 'hex'));
INSERT INTO public.job_budgets (id, job_id, scope_revision_id, version, pricing_hash, trade, complete, gap_count, budget) VALUES
  ('00000000-0000-0000-0000-0000000fc301', '00000000-0000-0000-0000-0000000fc101', '00000000-0000-0000-0000-0000000fc201', 1,
   encode(sha256(convert_to('{"p":1}', 'UTF8')), 'hex'), 'patio', true, 0,
   '{"version":"budget.v1","labour":{"pay":"group_work_order","work_order_amount_ex_gst":1234.5}}'::jsonb),
  ('00000000-0000-0000-0000-0000000fc302', '00000000-0000-0000-0000-0000000fc102', '00000000-0000-0000-0000-0000000fc202', 1,
   encode(sha256(convert_to('{"p":2}', 'UTF8')), 'hex'), 'patio', true, 0,
   '{"version":"budget.v1","labour":{"pay":"group_work_order"}}'::jsonb);
SET LOCAL session_replication_role = origin;
INSERT INTO public.work_orders (id, org_id, job_id, wo_number, kind, status) VALUES
  ('00000000-0000-0000-0000-0000000fc401', '00000000-0000-0000-0000-0000000fc0a0', '00000000-0000-0000-0000-0000000fc101', 'ZZTEST-WO-LC1', 'job', 'draft'),
  ('00000000-0000-0000-0000-0000000fc402', '00000000-0000-0000-0000-0000000fc0a0', '00000000-0000-0000-0000-0000000fc102', 'ZZTEST-WO-LC2', 'job', 'draft');
INSERT INTO public.work_orders (id, org_id, job_id, wo_number, kind, status, agreed_labour_ex) VALUES
  ('00000000-0000-0000-0000-0000000fc403', '00000000-0000-0000-0000-0000000fc0a0', '00000000-0000-0000-0000-0000000fc103', 'ZZTEST-WO-LC3', 'job', 'draft', 10);

DO $$
DECLARE
  org    uuid := '00000000-0000-0000-0000-0000000fc0a0';
  office uuid := '00000000-0000-0000-0000-0000000fc001';
  trade  uuid := '00000000-0000-0000-0000-0000000fc002';
  wo1    uuid := '00000000-0000-0000-0000-0000000fc401';
  wo2    uuid := '00000000-0000-0000-0000-0000000fc402';
  wo3    uuid := '00000000-0000-0000-0000-0000000fc403';
  b1     uuid := '00000000-0000-0000-0000-0000000fc301';
  b2     uuid := '00000000-0000-0000-0000-0000000fc302';
  r jsonb;
  refused boolean;
BEGIN
  -- Switch off: nothing is written.
  r := public.confirm_job_work_order_labour(wo1, b1, 1234.5, office, org);
  IF r->>'code' IS DISTINCT FROM 'labour_confirm_off'
     OR (SELECT agreed_labour_ex FROM public.work_orders WHERE id = wo1) IS NOT NULL THEN
    RAISE EXCEPTION 'ZZTEST switch off must refuse and write nothing: %', r;
  END IF;
  UPDATE public.feature_flags SET enabled = true WHERE flag_name = 'job_work_order_labour_confirm_v1';

  -- A non-office person is refused.
  r := public.confirm_job_work_order_labour(wo1, b1, 1234.5, trade, org);
  IF r->>'code' IS DISTINCT FROM 'operator_access_required' THEN
    RAISE EXCEPTION 'ZZTEST non-office press must be refused: %', r;
  END IF;
  -- Another company is refused.
  r := public.confirm_job_work_order_labour(wo1, b1, 1234.5, office, gen_random_uuid());
  IF r->>'code' IS DISTINCT FROM 'operator_access_required' THEN
    RAISE EXCEPTION 'ZZTEST other company must be refused: %', r;
  END IF;
  -- A stale proposal writes nothing.
  r := public.confirm_job_work_order_labour(wo1, b1, 999, office, org);
  IF r->>'code' IS DISTINCT FROM 'proposal_changed'
     OR (SELECT agreed_labour_ex FROM public.work_orders WHERE id = wo1) IS NOT NULL THEN
    RAISE EXCEPTION 'ZZTEST stale amount must be refused: %', r;
  END IF;

  -- The sealed amount is confirmed once, with who and when.
  r := public.confirm_job_work_order_labour(wo1, b1, 1234.5, office, org);
  IF r->>'state' IS DISTINCT FROM 'confirmed' OR (r->>'agreed_labour_ex')::numeric <> 1234.5
     OR r->>'confirmed_by' IS DISTINCT FROM office::text OR r->>'confirmed_at' IS NULL THEN
    RAISE EXCEPTION 'ZZTEST sealed amount not confirmed: %', r;
  END IF;
  IF (SELECT agreed_labour_ex FROM public.work_orders WHERE id = wo1) <> 1234.5
     OR (SELECT status FROM public.work_orders WHERE id = wo1) <> 'draft'
     OR (SELECT hand_edited_at FROM public.work_orders WHERE id = wo1) IS NULL THEN
    RAISE EXCEPTION 'ZZTEST draft must carry the amount, stay a draft and never auto-issue';
  END IF;
  -- A second press answers the first and writes nothing more.
  r := public.confirm_job_work_order_labour(wo1, b1, 1234.5, office, org);
  IF r->>'state' IS DISTINCT FROM 'already_confirmed'
     OR (SELECT count(*) FROM public.job_work_order_labour_confirmations WHERE work_order_id = wo1) <> 1 THEN
    RAISE EXCEPTION 'ZZTEST double press must be idempotent: %', r;
  END IF;

  -- A sealed budget with no labour amount proposes nothing and writes nothing.
  r := public.confirm_job_work_order_labour(wo2, b2, 0, office, org);
  IF r->>'code' IS DISTINCT FROM 'no_amount_in_sealed_quote'
     OR (SELECT agreed_labour_ex FROM public.work_orders WHERE id = wo2) IS NOT NULL THEN
    RAISE EXCEPTION 'ZZTEST no sealed amount must write nothing: %', r;
  END IF;
  -- A draft that already has an amount is left alone.
  r := public.confirm_job_work_order_labour(wo3, b1, 1234.5, office, org);
  IF r->>'code' IS DISTINCT FROM 'work_order_has_amount'
     OR (SELECT agreed_labour_ex FROM public.work_orders WHERE id = wo3) <> 10 THEN
    RAISE EXCEPTION 'ZZTEST draft with an amount must be left alone: %', r;
  END IF;

  -- The record is append-only.
  refused := false;
  BEGIN
    UPDATE public.job_work_order_labour_confirmations SET agreed_labour_ex = 1 WHERE work_order_id = wo1;
  EXCEPTION WHEN OTHERS THEN refused := SQLERRM = 'job_work_order_labour_confirmations_append_only';
  END;
  IF NOT refused THEN RAISE EXCEPTION 'ZZTEST confirmation must be append-only'; END IF;
END $$;
ROLLBACK;
