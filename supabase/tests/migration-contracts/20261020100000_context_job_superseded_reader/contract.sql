-- Contract for 20261020100000_context_job_superseded_reader.sql (CTX-T16b
-- slice 1). Every fixture write is a synthetic job_events row inside a
-- transaction that rolls back; no SQ-23 object is created or read.
--
-- Named limit, asserted on the function comment below:
-- status_without_event_not_detected_needs_gap_grant. A status change with no
-- event (status_without_event, "chronology unknown", held O?) is NOT detected:
-- that needs the quote_acceptance_gaps grant held for the owner, and reading
-- jobs.status is forbidden. false from this reader is never "no gap".

-- 1. Shape: STABLE, SECURITY INVOKER, LANGUAGE sql, no SET clause, the slice
--    comment carrying both named limits, and no forbidden source in the body.
DO $$
DECLARE f record;
BEGIN
  SELECT p.provolatile, p.prosecdef, p.proconfig, l.lanname, p.prosrc,
         obj_description(p.oid, 'pg_proc') AS cmt
    INTO f
    FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang
   WHERE p.oid = to_regprocedure('public.context_job_superseded_during(uuid,timestamp with time zone)');
  IF NOT FOUND THEN RAISE EXCEPTION 'contract: reader missing'; END IF;
  IF f.provolatile <> 's' OR f.prosecdef OR f.proconfig IS NOT NULL OR f.lanname <> 'sql' THEN
    RAISE EXCEPTION 'contract: reader must be STABLE SECURITY INVOKER sql with no SET clause';
  END IF;
  IF f.prosrc ~* '(public\.jobs\M|superseded_at|superseded_by_job_id|quote_acceptance_gaps|feature_flags|\.status\M)' THEN
    RAISE EXCEPTION 'contract: reader body reads a forbidden source';
  END IF;
  IF f.cmt NOT LIKE 'Job superseded reader (20261020100000)%'
     OR position('status_without_event_not_detected_needs_gap_grant' IN f.cmt) = 0
     OR position('same_instant_order_not_causal' IN f.cmt) = 0 THEN
    RAISE EXCEPTION 'contract: reader comment must name the slice and both named limits';
  END IF;
  RAISE NOTICE 'pass: shape';
END $$;

-- 2. Grants: anon and authenticated cannot execute; service_role can.
DO $$
BEGIN
  IF has_function_privilege('anon', 'public.context_job_superseded_during(uuid,timestamp with time zone)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.context_job_superseded_during(uuid,timestamp with time zone)', 'EXECUTE') THEN
    RAISE EXCEPTION 'contract: the reader is executable by anon or authenticated';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.context_job_superseded_during(uuid,timestamp with time zone)', 'EXECUTE') THEN
    RAISE EXCEPTION 'contract: service_role cannot execute the reader';
  END IF;
  RAISE NOTICE 'pass: grants';
END $$;

-- 3. The flag exists, once, and is off.
DO $$
BEGIN
  IF (SELECT count(*) FROM public.feature_flags WHERE flag_name = 'context_job_superseded_reader_v1') <> 1
     OR EXISTS (SELECT 1 FROM public.feature_flags
                 WHERE flag_name = 'context_job_superseded_reader_v1' AND enabled IS NOT FALSE) THEN
    RAISE EXCEPTION 'contract: flag context_job_superseded_reader_v1 must exist once and be false';
  END IF;
  RAISE NOTICE 'pass: flag exists and is false';
END $$;

-- 4. Behaviour, as service_role, on synthetic rows.
--    Job ids (synthetic):
--      ...01 no events             ...02 superseded           ...03 superseded then cleared
--      ...04 re-superseded         ...05 unpaired unsuperseded ...06 double superseded
--      ...07 tie, superseded id later   ...08 tie, unsuperseded id later
--      ...09 other event types and a null created_at only
--      b...01 has none, b...02 holds the events (another job's events ignored)
BEGIN;
GRANT SELECT ON public.job_events TO service_role;

INSERT INTO public.job_events (id, job_id, event_type, created_at) VALUES
 ('00000000-0000-4000-8000-000000000201', 'a0000000-0000-4000-8000-000000000002', 'quote_option_superseded',    '2026-10-01 10:00+00'),
 ('00000000-0000-4000-8000-000000000301', 'a0000000-0000-4000-8000-000000000003', 'quote_option_superseded',    '2026-10-01 10:00+00'),
 ('00000000-0000-4000-8000-000000000302', 'a0000000-0000-4000-8000-000000000003', 'quote_option_unsuperseded',  '2026-10-02 10:00+00'),
 ('00000000-0000-4000-8000-000000000401', 'a0000000-0000-4000-8000-000000000004', 'quote_option_superseded',    '2026-10-01 10:00+00'),
 ('00000000-0000-4000-8000-000000000402', 'a0000000-0000-4000-8000-000000000004', 'quote_option_unsuperseded',  '2026-10-02 10:00+00'),
 ('00000000-0000-4000-8000-000000000403', 'a0000000-0000-4000-8000-000000000004', 'quote_option_superseded',    '2026-10-03 10:00+00'),
 ('00000000-0000-4000-8000-000000000501', 'a0000000-0000-4000-8000-000000000005', 'quote_option_unsuperseded',  '2026-10-01 10:00+00'),
 ('00000000-0000-4000-8000-000000000601', 'a0000000-0000-4000-8000-000000000006', 'quote_option_superseded',    '2026-10-01 10:00+00'),
 ('00000000-0000-4000-8000-000000000602', 'a0000000-0000-4000-8000-000000000006', 'quote_option_superseded',    '2026-10-02 10:00+00'),
 ('00000000-0000-4000-8000-000000000603', 'a0000000-0000-4000-8000-000000000006', 'quote_option_unsuperseded',  '2026-10-03 10:00+00'),
 ('00000000-0000-4000-8000-000000000701', 'a0000000-0000-4000-8000-000000000007', 'quote_option_unsuperseded',  '2026-10-01 10:00+00'),
 ('00000000-0000-4000-8000-000000000702', 'a0000000-0000-4000-8000-000000000007', 'quote_option_superseded',    '2026-10-01 10:00+00'),
 ('00000000-0000-4000-8000-000000000801', 'a0000000-0000-4000-8000-000000000008', 'quote_option_superseded',    '2026-10-01 10:00+00'),
 ('00000000-0000-4000-8000-000000000802', 'a0000000-0000-4000-8000-000000000008', 'quote_option_unsuperseded',  '2026-10-01 10:00+00'),
 ('00000000-0000-4000-8000-000000000901', 'a0000000-0000-4000-8000-000000000009', 'quote_option_review_needed', '2026-10-01 10:00+00'),
 ('00000000-0000-4000-8000-000000000902', 'a0000000-0000-4000-8000-000000000009', 'status_changed',             '2026-10-01 11:00+00'),
 ('00000000-0000-4000-8000-000000000903', 'a0000000-0000-4000-8000-000000000009', 'QUOTE_OPTION_SUPERSEDED',    '2026-10-01 12:00+00'),
 ('00000000-0000-4000-8000-000000000904', 'a0000000-0000-4000-8000-000000000009', 'quote_option_superseded',    NULL),
 ('00000000-0000-4000-8000-000000001201', 'b0000000-0000-4000-8000-000000000002', 'quote_option_superseded',    '2026-10-01 10:00+00');

CREATE TEMP TABLE t16b_cases (ord integer, label text, job uuid, at timestamptz, expected boolean) ON COMMIT DROP;
GRANT SELECT ON t16b_cases TO service_role;
INSERT INTO t16b_cases VALUES
 (1,  'no events: false',                                       'a0000000-0000-4000-8000-000000000001', '2026-10-05 00:00+00', false),
 (2,  'superseded before p_at: true',                           'a0000000-0000-4000-8000-000000000002', '2026-10-05 00:00+00', true),
 (3,  'before the superseded event: false',                     'a0000000-0000-4000-8000-000000000002', '2026-10-01 09:59:59+00', false),
 (4,  'superseded event exactly at p_at: true',                 'a0000000-0000-4000-8000-000000000002', '2026-10-01 10:00+00', true),
 (5,  'superseded then unsuperseded before p_at: false',        'a0000000-0000-4000-8000-000000000003', '2026-10-05 00:00+00', false),
 (6,  'p_at inside the interval: true',                         'a0000000-0000-4000-8000-000000000003', '2026-10-01 18:00+00', true),
 (7,  'unsuperseded event exactly at p_at: false',              'a0000000-0000-4000-8000-000000000003', '2026-10-02 10:00+00', false),
 (8,  're-supersede after a clear, inside the gap: false',      'a0000000-0000-4000-8000-000000000004', '2026-10-02 18:00+00', false),
 (9,  're-supersede after a clear, after it: true',             'a0000000-0000-4000-8000-000000000004', '2026-10-05 00:00+00', true),
 (10, 'unpaired unsuperseded: false',                           'a0000000-0000-4000-8000-000000000005', '2026-10-05 00:00+00', false),
 (11, 'double superseded, between the two: true',               'a0000000-0000-4000-8000-000000000006', '2026-10-01 18:00+00', true),
 (12, 'double superseded, after the second: true',              'a0000000-0000-4000-8000-000000000006', '2026-10-02 18:00+00', true),
 (13, 'double superseded, one clear closes it: false',          'a0000000-0000-4000-8000-000000000006', '2026-10-05 00:00+00', false),
 (14, 'same-instant tie, superseded has the later id: true',    'a0000000-0000-4000-8000-000000000007', '2026-10-01 10:00+00', true),
 (15, 'same-instant tie, unsuperseded has the later id: false', 'a0000000-0000-4000-8000-000000000008', '2026-10-01 10:00+00', false),
 (16, 'other event types and null created_at ignored: false',   'a0000000-0000-4000-8000-000000000009', '2026-10-05 00:00+00', false),
 (17, 'another job''s events ignored: false',                   'b0000000-0000-4000-8000-000000000001', '2026-10-05 00:00+00', false),
 (18, 'the other job itself reads true',                        'b0000000-0000-4000-8000-000000000002', '2026-10-05 00:00+00', true);

SET LOCAL ROLE service_role;

DO $$
DECLARE c record; got boolean; n integer := 0;
BEGIN
  FOR c IN SELECT * FROM t16b_cases ORDER BY ord LOOP
    got := public.context_job_superseded_during(c.job, c.at);
    IF got IS DISTINCT FROM c.expected THEN
      RAISE EXCEPTION 'contract: % (got %, expected %)', c.label, got, c.expected;
    END IF;
    RAISE NOTICE 'pass: %', c.label;
    n := n + 1;
  END LOOP;
  IF n <> 18 THEN RAISE EXCEPTION 'contract: expected 18 behaviour cases, ran %', n; END IF;
  IF public.context_job_superseded_during(NULL, '2026-10-05 00:00+00') IS NOT NULL
     OR public.context_job_superseded_during('a0000000-0000-4000-8000-000000000002', NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'contract: a null job or instant must read null (unknown), never false';
  END IF;
  RAISE NOTICE 'pass: null job or instant reads null';
END $$;
ROLLBACK;

-- 5. anon and authenticated are refused at call time too.
BEGIN;
SET LOCAL ROLE anon;
DO $$
BEGIN
  PERFORM public.context_job_superseded_during('a0000000-0000-4000-8000-000000000001', now());
  RAISE EXCEPTION 'contract: anon executed the reader';
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'pass: anon refused at call time';
END $$;
ROLLBACK;

BEGIN;
SET LOCAL ROLE authenticated;
DO $$
BEGIN
  PERFORM public.context_job_superseded_during('a0000000-0000-4000-8000-000000000001', now());
  RAISE EXCEPTION 'contract: authenticated executed the reader';
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'pass: authenticated refused at call time';
END $$;
ROLLBACK;

-- 6. Re-apply is idempotent: the migration runs a second time and leaves one
--    reader, one flag row still off, and the same grants.
BEGIN;
\ir ../../../migrations/20261020100000_context_job_superseded_reader.sql
DO $$
BEGIN
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'context_job_superseded_during') <> 1
     OR (SELECT count(*) FROM public.feature_flags WHERE flag_name = 'context_job_superseded_reader_v1') <> 1
     OR EXISTS (SELECT 1 FROM public.feature_flags
                 WHERE flag_name = 'context_job_superseded_reader_v1' AND enabled IS NOT FALSE)
     OR has_function_privilege('anon', 'public.context_job_superseded_during(uuid,timestamp with time zone)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.context_job_superseded_during(uuid,timestamp with time zone)', 'EXECUTE') THEN
    RAISE EXCEPTION 'contract: re-apply is not idempotent';
  END IF;
  RAISE NOTICE 'pass: re-apply idempotent';
END $$;
ROLLBACK;
