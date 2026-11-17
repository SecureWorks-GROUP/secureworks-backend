BEGIN;

DO $$
DECLARE
  table_name text;
  role_name text;
  privilege_name text;
BEGIN
  IF (SELECT count(*) FROM public.match_clue_types) <> 16 THEN
    RAISE EXCEPTION 'match tables contract: expected 16 seeded types';
  END IF;
  IF (SELECT count(*) FROM public.match_clue_types WHERE mode = 'counts') <> 4
     OR EXISTS (SELECT 1 FROM public.match_clue_types WHERE mode = 'counts' AND class <> 'key')
     OR (SELECT array_agg(code ORDER BY code COLLATE "C") FROM public.match_clue_types WHERE mode = 'counts')
        IS DISTINCT FROM ARRAY['job_number', 'order_number', 'sealed_scope_order', 'trade_app_link'] THEN
    RAISE EXCEPTION 'match tables contract: only the four seeded keys may initially count';
  END IF;
  IF (SELECT count(*) FROM public.match_clue_types WHERE class = 'clue' AND mode = 'suggest_only') <> 8
     OR (SELECT count(*) FROM public.match_clue_types WHERE class = 'narrower' AND mode = 'off') <> 3
     OR NOT EXISTS (SELECT 1 FROM public.match_clue_types WHERE code = 'ai_read' AND class = 'ai' AND mode = 'suggest_only') THEN
    RAISE EXCEPTION 'match tables contract: suggestion and narrower defaults differ';
  END IF;
  BEGIN
    UPDATE public.match_clue_types SET mode = 'counts' WHERE code = 'ai_read';
    RAISE EXCEPTION 'match tables contract: ai_read was allowed to count';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE public.match_clue_types SET mode = 'counts' WHERE code = 'division_tag';
    RAISE EXCEPTION 'match tables contract: narrower type was allowed to count';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO public.match_clues (org_id, subject_kind, subject_id, run_id, clue_code, class, family, root, outcome, names_one, rule_version)
    VALUES ('00000000-0000-0000-0000-000000000001', 'cost_document', 'contract-document',
      '00000000-0000-0000-0000-000000000002', 'unknown_clue', 'key', 'doc_text', 'contract-root', 'job', true, 'contract-v1');
    RAISE EXCEPTION 'match tables contract: unknown clue_code was allowed';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
  IF NOT EXISTS (SELECT 1 FROM public.feature_flags WHERE flag_name = 'reconcile_matcher_v1' AND enabled = false) THEN
    RAISE EXCEPTION 'match tables contract: matcher switch must be seeded off';
  END IF;

  FOREACH table_name IN ARRAY ARRAY['match_clue_types', 'match_clues', 'match_queue', 'match_shadow_runs', 'match_rules'] LOOP
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = ('public.' || table_name)::regclass) THEN
      RAISE EXCEPTION 'match tables contract: RLS is missing on %', table_name;
    END IF;
    IF (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = table_name) <> 1
       OR NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = table_name
         AND roles = ARRAY['service_role']::name[] AND cmd = 'ALL' AND qual = 'true' AND with_check = 'true') THEN
      RAISE EXCEPTION 'match tables contract: service-only policy differs on %', table_name;
    END IF;
    FOREACH privilege_name IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] LOOP
      IF NOT has_table_privilege('service_role', 'public.' || table_name, privilege_name) THEN
        RAISE EXCEPTION 'match tables contract: service role lacks % on %', privilege_name, table_name;
      END IF;
      FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated'] LOOP
        IF has_table_privilege(role_name, 'public.' || table_name, privilege_name) THEN
          RAISE EXCEPTION 'match tables contract: % has % on %', role_name, privilege_name, table_name;
        END IF;
      END LOOP;
    END LOOP;
  END LOOP;
END $$;

-- Exercise identity defaults and storage through the only admitted role.
SET LOCAL ROLE service_role;
INSERT INTO public.match_clues (org_id, subject_kind, subject_id, run_id, clue_code, class, family, root, outcome, names_one, rule_version)
VALUES ('00000000-0000-0000-0000-000000000001', 'cost_document', 'contract-document',
  '00000000-0000-0000-0000-000000000002', 'job_number', 'key', 'doc_text', 'contract-root', 'job', true, 'contract-v1');
INSERT INTO public.match_clues (org_id, subject_kind, subject_id, run_id, clue_code, class, family, root, outcome, names_one, rule_version, kept_from)
VALUES ('00000000-0000-0000-0000-000000000001', 'message', 'contract-message',
  '00000000-0000-0000-0000-000000000002', 'trade_app_link', 'key', 'trade_app', 'contract-root', 'division_stock', false, 'contract-v1', 'phase3:bill_pdf');
INSERT INTO public.match_queue (subject_kind, subject_id, reason) VALUES ('cost_document', 'contract-document', 'contract-reason');
INSERT INTO public.match_shadow_runs (result) VALUES ('{}');
INSERT INTO public.match_rules (kind, party_id) VALUES ('supplier_usually_overhead', 'contract-party');

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.match_clues WHERE subject_id = 'contract-document'
    AND id IS NOT NULL AND current AND kept_from IS NULL AND detail = '{}'::jsonb AND created_at IS NOT NULL)
    OR NOT EXISTS (SELECT 1 FROM public.match_clues WHERE subject_id = 'contract-message'
    AND current AND kept_from = 'phase3:bill_pdf') THEN
    RAISE EXCEPTION 'match tables contract: clue storage defaults differ';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.match_rules WHERE party_id = 'contract-party'
    AND status = 'proposed' AND right_count = 0 AND wrong_count = 0 AND proposed_at IS NOT NULL) THEN
    RAISE EXCEPTION 'match tables contract: rule defaults differ';
  END IF;
  BEGIN
    INSERT INTO public.match_queue (subject_kind, subject_id, reason) VALUES ('cost_document', 'contract-document', 'duplicate');
    RAISE EXCEPTION 'match tables contract: duplicate queue subject was allowed';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO public.match_rules (kind, party_id) VALUES ('supplier_usually_overhead', 'contract-party');
    RAISE EXCEPTION 'match tables contract: duplicate rule was allowed';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
END $$;

ROLLBACK;
