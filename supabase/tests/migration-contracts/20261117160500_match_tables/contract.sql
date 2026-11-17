BEGIN;

DO $$
DECLARE
  table_name text;
  role_name text;
  privilege_name text;
BEGIN
  IF (SELECT count(*) FROM public.match_clue_types) <> 17 THEN
    RAISE EXCEPTION 'match tables contract: expected 17 seeded types';
  END IF;
  IF (SELECT count(*) FROM public.match_clue_types WHERE mode = 'counts') <> 4
     OR EXISTS (SELECT 1 FROM public.match_clue_types WHERE mode = 'counts' AND class <> 'key')
     OR (SELECT array_agg(code ORDER BY code COLLATE "C") FROM public.match_clue_types WHERE mode = 'counts')
        IS DISTINCT FROM ARRAY['job_number', 'order_number', 'sealed_scope_order', 'trade_app_link'] THEN
    RAISE EXCEPTION 'match tables contract: only the four seeded keys may initially count';
  END IF;
  IF (SELECT count(*) FROM public.match_clue_types WHERE class = 'clue' AND mode = 'suggest_only') <> 8
     OR (SELECT count(*) FROM public.match_clue_types WHERE class = 'narrower' AND mode = 'off') <> 4
     OR NOT EXISTS (SELECT 1 FROM public.match_clue_types WHERE code = 'ai_read' AND class = 'ai' AND mode = 'suggest_only') THEN
    RAISE EXCEPTION 'match tables contract: suggestion and narrower defaults differ';
  END IF;
  IF EXISTS (
    SELECT code, class, family, mode FROM public.match_clue_types
    FULL JOIN (VALUES
      ('job_number', 'key', 'doc_text', 'counts'),
      ('order_number', 'key', 'order', 'counts'),
      ('sealed_scope_order', 'key', 'order', 'counts'),
      ('trade_app_link', 'key', 'trade_app', 'counts'),
      ('order_amount', 'clue', 'order', 'suggest_only'),
      ('delivery_address', 'clue', 'address', 'suggest_only'),
      ('supplier_mail', 'clue', 'mail', 'suggest_only'),
      ('booked_trade_day', 'clue', 'roster', 'suggest_only'),
      ('scope_items', 'clue', 'scope', 'suggest_only'),
      ('learned_rule', 'clue', 'rule', 'suggest_only'),
      ('overhead_account', 'clue', 'account', 'suggest_only'),
      ('group_tag', 'clue', 'tag', 'suggest_only'),
      ('ai_read', 'ai', 'ai', 'suggest_only'),
      ('division_tag', 'narrower', 'tag', 'off'),
      ('xero_link_legacy', 'narrower', 'legacy', 'off'),
      ('supplier_history', 'narrower', 'history', 'off'),
      ('who_ordered', 'narrower', 'history', 'off')
    ) AS expected(code, class, family, mode) USING (code, class, family, mode)
    WHERE match_clue_types.code IS NULL OR expected.code IS NULL
  ) THEN
    RAISE EXCEPTION 'match tables contract: seeded code, class, family or mode differs';
  END IF;
  IF EXISTS (
    SELECT 1 FROM (VALUES
      ('match_clue_types', 'code', 'text'),
      ('match_clue_types', 'class', 'text'),
      ('match_clue_types', 'family', 'text'),
      ('match_clue_types', 'mode', 'text'),
      ('match_clue_types', 'words', 'text'),
      ('match_clue_types', 'right_count', 'int4'),
      ('match_clue_types', 'wrong_count', 'int4'),
      ('match_clue_types', 'mode_changed_at', 'timestamptz'),
      ('match_clue_types', 'mode_changed_by', 'text'),
      ('match_clues', 'id', 'int8'),
      ('match_clues', 'org_id', 'uuid'),
      ('match_clues', 'subject_kind', 'text'),
      ('match_clues', 'subject_id', 'text'),
      ('match_clues', 'run_id', 'uuid'),
      ('match_clues', 'clue_code', 'text'),
      ('match_clues', 'class', 'text'),
      ('match_clues', 'family', 'text'),
      ('match_clues', 'root', 'text'),
      ('match_clues', 'outcome', 'text'),
      ('match_clues', 'job_id', 'uuid'),
      ('match_clues', 'division', 'text'),
      ('match_clues', 'names_one', 'bool'),
      ('match_clues', 'seen_where', 'text'),
      ('match_clues', 'seen_value', 'text'),
      ('match_clues', 'detail', 'jsonb'),
      ('match_clues', 'rule_version', 'text'),
      ('match_clues', 'kept_from', 'text'),
      ('match_clues', 'current', 'bool'),
      ('match_clues', 'created_at', 'timestamptz'),
      ('match_queue', 'subject_kind', 'text'),
      ('match_queue', 'subject_id', 'text'),
      ('match_queue', 'reason', 'text'),
      ('match_queue', 'queued_at', 'timestamptz'),
      ('match_shadow_runs', 'id', 'int8'),
      ('match_shadow_runs', 'subject_kind', 'text'),
      ('match_shadow_runs', 'subject_id', 'text'),
      ('match_shadow_runs', 'run_id', 'uuid'),
      ('match_shadow_runs', 'result', 'jsonb'),
      ('match_shadow_runs', 'stops', 'jsonb'),
      ('match_shadow_runs', 'rule_version', 'text'),
      ('match_shadow_runs', 'created_at', 'timestamptz'),
      ('match_rules', 'id', 'int8'),
      ('match_rules', 'kind', 'text'),
      ('match_rules', 'party_id', 'text'),
      ('match_rules', 'division', 'text'),
      ('match_rules', 'status', 'text'),
      ('match_rules', 'proposed_at', 'timestamptz'),
      ('match_rules', 'confirmed_by', 'text'),
      ('match_rules', 'confirmed_at', 'timestamptz'),
      ('match_rules', 'right_count', 'int4'),
      ('match_rules', 'wrong_count', 'int4')
    ) AS expected(table_name, column_name, udt_name)
    FULL JOIN (SELECT c.table_name, c.column_name, c.udt_name FROM information_schema.columns c
      WHERE c.table_schema = 'public' AND c.table_name IN
        ('match_clue_types', 'match_clues', 'match_queue', 'match_shadow_runs', 'match_rules')) actual
    USING (table_name, column_name, udt_name)
    WHERE expected.column_name IS NULL OR actual.column_name IS NULL
  ) THEN
    RAISE EXCEPTION 'match tables contract: column name or type differs';
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
      IF has_table_privilege('service_role', 'public.' || table_name, privilege_name)
         IS DISTINCT FROM (privilege_name IN ('SELECT', 'INSERT', 'UPDATE', 'DELETE')) THEN
        RAISE EXCEPTION 'match tables contract: service role rights differ for % on %', privilege_name, table_name;
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
