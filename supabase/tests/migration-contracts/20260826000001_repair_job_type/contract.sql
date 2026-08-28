-- Executed by ../run.sh against disposable PostgreSQL after the migration.
--
-- Proves the repair job type is real end to end, and — just as important — that
-- every pre-existing job type still behaves exactly as it did before.
BEGIN;

-- ── The type vocabulary widened, and only widened. ───────────────────────────
DO $$
DECLARE
  definition text;
  legacy_type text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO definition
  FROM pg_constraint
  WHERE conrelid = 'public.jobs'::regclass AND conname = 'jobs_type_check';

  IF definition IS NULL THEN
    RAISE EXCEPTION 'jobs_type_check is missing';
  END IF;
  IF position('''repair''' in definition) = 0 THEN
    RAISE EXCEPTION 'jobs_type_check does not admit repair';
  END IF;
  FOREACH legacy_type IN ARRAY ARRAY[
    'fencing', 'patio', 'combo', 'decking', 'renovation', 'insurance',
    'roofing', 'miscellaneous', 'general', 'makesafe'
  ] LOOP
    IF position('''' || legacy_type || '''' in definition) = 0 THEN
      RAISE EXCEPTION 'jobs_type_check dropped the pre-existing type %', legacy_type;
    END IF;
  END LOOP;
END;
$$;

-- ── next_job_number: repair mints SWR-, every prior prefix is untouched, and
-- the deployed four-digit sequence width survived the in-place patch. ─────────
DO $$
DECLARE
  year_token text := ((EXTRACT(YEAR FROM now())::int % 100))::text;
  minted text;
  expectation record;
BEGIN
  FOR expectation IN
    SELECT * FROM (VALUES
      ('patio', 'SWP-'),
      ('fencing', 'SWF-'),
      ('decking', 'SWD-'),
      ('renovation', 'SWR-'),
      ('insurance', 'SWI-'),
      ('roofing', 'SWR-'),
      ('miscellaneous', 'SWM-'),
      ('general', 'SWG-'),
      ('makesafe', 'SWMS-'),
      ('repair', 'SWR-'),
      ('not_a_job_type', 'SW-')
    ) AS t(job_type, prefix)
  LOOP
    minted := public.next_job_number(expectation.job_type);
    IF minted NOT LIKE expectation.prefix || '%' THEN
      RAISE EXCEPTION 'next_job_number(%) minted % but must start with %',
        expectation.job_type, minted, expectation.prefix;
    END IF;
    IF minted NOT LIKE expectation.prefix || year_token || '%' THEN
      RAISE EXCEPTION 'next_job_number(%) lost its two-digit year segment: %',
        expectation.job_type, minted;
    END IF;
  END LOOP;

  -- Width contract: a four-digit sequence must NOT be truncated to three. This
  -- is the drift the migration exists to preserve; a naive re-declaration of the
  -- newest repo migration body would mint SWR-26131 for sequence 1313.
  UPDATE public.job_number_counters
  SET last_seq = 1312
  WHERE year = (EXTRACT(YEAR FROM now())::int % 100)::smallint;

  minted := public.next_job_number('repair');
  IF minted <> 'SWR-' || year_token || '1313' THEN
    RAISE EXCEPTION 'repair job number truncated a four-digit sequence: %', minted;
  END IF;
END;
$$;

-- ── A repair job is insertable, auto-numbers SWR-, and carries the make-safe
-- overlay details row plus both intake-case links. A patio job still cannot. ──
DO $$
DECLARE
  org constant uuid := '00000000-0000-0000-0000-0000000000aa';
  repair_job constant uuid := 'aaaaaaaa-0000-4000-8000-000000000001';
  makesafe_job constant uuid := 'aaaaaaaa-0000-4000-8000-000000000002';
  patio_job constant uuid := 'aaaaaaaa-0000-4000-8000-000000000003';
  renovation_job constant uuid := 'aaaaaaaa-0000-4000-8000-000000000004';
  minted text;
  refused boolean;
BEGIN
  INSERT INTO public.jobs (id, org_id, status, type, metadata)
  VALUES (repair_job, org, 'accepted', 'repair',
          '{"repair_stage":"wo_in","makesafe_job_family":"repair"}'::jsonb);

  SELECT job_number INTO minted FROM public.jobs WHERE id = repair_job;
  IF minted NOT LIKE 'SWR-%' THEN
    RAISE EXCEPTION 'a repair job auto-numbered % instead of SWR-', minted;
  END IF;

  -- Control: the pre-existing make-safe path is byte-for-byte unchanged.
  INSERT INTO public.jobs (id, org_id, status, type)
  VALUES (makesafe_job, org, 'accepted', 'makesafe');
  SELECT job_number INTO minted FROM public.jobs WHERE id = makesafe_job;
  IF minted NOT LIKE 'SWMS-%' THEN
    RAISE EXCEPTION 'a make-safe job auto-numbered % instead of SWMS-', minted;
  END IF;

  -- Control: renovation still owns SWR- too. The prefix is deliberately shared.
  INSERT INTO public.jobs (id, org_id, status, type)
  VALUES (renovation_job, org, 'accepted', 'renovation');
  SELECT job_number INTO minted FROM public.jobs WHERE id = renovation_job;
  IF minted NOT LIKE 'SWR-%' THEN
    RAISE EXCEPTION 'a renovation job auto-numbered % instead of SWR-', minted;
  END IF;

  INSERT INTO public.jobs (id, org_id, status, type)
  VALUES (patio_job, org, 'accepted', 'patio');

  -- Details row: allowed on repair AND make-safe, still refused on patio.
  INSERT INTO public.makesafe_job_details (job_id, report_type)
  VALUES (repair_job, 'repair');
  INSERT INTO public.makesafe_job_details (job_id) VALUES (makesafe_job);

  refused := false;
  BEGIN
    INSERT INTO public.makesafe_job_details (job_id) VALUES (patio_job);
  EXCEPTION WHEN others THEN
    refused := true;
  END;
  IF NOT refused THEN
    RAISE EXCEPTION 'makesafe_job_details accepted a patio job after the widening';
  END IF;

  -- ── The money seal. This is the defect the risk assessment found. ──────────
  -- The details-row inserts above fire trg_makesafe_details_seal_job ->
  -- seal_makesafe_job_v1, which carried no type predicate at all. Live proof of
  -- the consequence: 536 of 536 jobs holding a details row are sealed. The
  -- repair route ALWAYS inserts a details row, so every repair job would have
  -- been sealed at mint — permanently, the seal being write-once.
  IF EXISTS (
    SELECT 1 FROM public.jobs
    WHERE id = repair_job AND ses_money_sealed_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION
      'a repair job was auto-money-sealed by its details row; Captain Decision 4 is violated';
  END IF;

  -- CONTROL: a make-safe is still sealed by exactly the same write, with its
  -- source and version intact. The exemption is repair-shaped, not a hole.
  IF NOT EXISTS (
    SELECT 1 FROM public.jobs
    WHERE id = makesafe_job
      AND ses_money_sealed_at IS NOT NULL
      AND ses_money_seal_source = 'makesafe_job_details'
      AND ses_money_seal_version = 1
  ) THEN
    RAISE EXCEPTION
      'the repair seal exemption stopped make-safe jobs being sealed by their details row';
  END IF;

  -- The seal function still refuses a job id that does not exist at all, so a
  -- genuine fault stays loud rather than being silently exempted.
  refused := false;
  BEGIN
    PERFORM public.seal_makesafe_job_v1(
      'aaaaaaaa-0000-4000-8000-0000000000ee'::uuid, 'contract-probe');
  EXCEPTION WHEN others THEN
    refused := true;
  END;
  IF NOT refused THEN
    RAISE EXCEPTION 'seal_makesafe_job_v1 stopped refusing a missing job';
  END IF;

  -- And a direct call on a repair job is a silent no-op, not an error: the job
  -- exists, so the not-found guard must not fire.
  PERFORM public.seal_makesafe_job_v1(repair_job, 'contract-probe');
  IF EXISTS (
    SELECT 1 FROM public.jobs
    WHERE id = repair_job AND ses_money_sealed_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'a direct seal call sealed a repair job';
  END IF;

  -- Intake case job_id link: allowed on repair, still refused on patio.
  INSERT INTO public.makesafe_intake_cases (org_id, state, job_id)
  VALUES (org, 'confirmed_live_job', repair_job);

  refused := false;
  BEGIN
    INSERT INTO public.makesafe_intake_cases (org_id, state, job_id)
    VALUES (org, 'confirmed_live_job', patio_job);
  EXCEPTION WHEN others THEN
    refused := true;
  END;
  IF NOT refused THEN
    RAISE EXCEPTION 'an intake case linked a patio job after the widening';
  END IF;

  -- Intake case target_job_id: allowed on repair, still refused on patio.
  INSERT INTO public.makesafe_intake_cases (org_id, state, target_job_id)
  VALUES (org, 'exception', repair_job);

  refused := false;
  BEGIN
    INSERT INTO public.makesafe_intake_cases (org_id, state, target_job_id)
    VALUES (org, 'exception', patio_job);
  EXCEPTION WHEN others THEN
    refused := true;
  END;
  IF NOT refused THEN
    RAISE EXCEPTION 'an intake case targeted a patio job after the widening';
  END IF;

  -- The in-place patch of enforce_makesafe_intake_case_write() must not have
  -- disturbed the guards it never transcribed.
  refused := false;
  BEGIN
    INSERT INTO public.makesafe_intake_cases (org_id, state) VALUES (org, '');
  EXCEPTION WHEN others THEN
    refused := true;
  END;
  IF NOT refused THEN
    RAISE EXCEPTION 'the unrelated intake-case guard was lost by the in-place patch';
  END IF;

  -- An unknown type is still refused outright.
  refused := false;
  BEGIN
    INSERT INTO public.jobs (id, org_id, status, type)
    VALUES ('aaaaaaaa-0000-4000-8000-00000000000f', org, 'accepted', 'not_a_job_type');
  EXCEPTION WHEN others THEN
    refused := true;
  END;
  IF NOT refused THEN
    RAISE EXCEPTION 'jobs_type_check stopped refusing unknown job types';
  END IF;
END;
$$;

-- ── Repair revenue stays inside the P&L view, and nothing else moves. ────────
-- Today's repair cards are type='makesafe' and are therefore already inside
-- job_financials; the type flip alone would have dropped the first SWR- job's
-- revenue out of the one P&L surface the ops panel reads.
DO $$
DECLARE
  org constant uuid := '00000000-0000-0000-0000-000000000001';
BEGIN
  INSERT INTO public.jobs (id, org_id, status, type, client_name)
  VALUES
    ('bbbbbbbb-0000-4000-8000-000000000001', org, 'processing', 'repair',     'Repair Revenue'),
    ('bbbbbbbb-0000-4000-8000-000000000002', org, 'processing', 'makesafe',   'Make-safe Revenue'),
    ('bbbbbbbb-0000-4000-8000-000000000003', org, 'processing', 'patio',      'Patio Revenue'),
    ('bbbbbbbb-0000-4000-8000-000000000004', org, 'processing', 'renovation', 'Renovation Revenue'),
    ('bbbbbbbb-0000-4000-8000-000000000005', org, 'processing', 'roofing',    'Roofing Revenue'),
    ('bbbbbbbb-0000-4000-8000-000000000006', org, 'cancelled',  'repair',     'Cancelled Repair');

  IF NOT EXISTS (
    SELECT 1 FROM public.job_financials
    WHERE job_id = 'bbbbbbbb-0000-4000-8000-000000000001'
  ) THEN
    RAISE EXCEPTION 'a repair job is missing from job_financials';
  END IF;

  -- CONTROL: make-safe is still in, and the three types that were out stay out.
  IF NOT EXISTS (
    SELECT 1 FROM public.job_financials
    WHERE job_id = 'bbbbbbbb-0000-4000-8000-000000000002'
  ) THEN
    RAISE EXCEPTION 'widening job_financials dropped make-safe jobs';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.job_financials
    WHERE job_id IN (
      'bbbbbbbb-0000-4000-8000-000000000003',
      'bbbbbbbb-0000-4000-8000-000000000004',
      'bbbbbbbb-0000-4000-8000-000000000005'
    )
  ) THEN
    RAISE EXCEPTION 'widening job_financials admitted a type it should not have';
  END IF;

  -- CONTROL: the view's OTHER predicates survived the in-place patch. A
  -- cancelled job stays excluded whatever its type.
  IF EXISTS (
    SELECT 1 FROM public.job_financials
    WHERE job_id = 'bbbbbbbb-0000-4000-8000-000000000006'
  ) THEN
    RAISE EXCEPTION 'the in-place patch lost the cancelled-job exclusion';
  END IF;
END;
$$;

ROLLBACK;
