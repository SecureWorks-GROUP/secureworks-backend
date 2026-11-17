\set ON_ERROR_STOP on
BEGIN;
SET LOCAL statement_timeout = '30s';
\ir ../../../migrations/20261118024515_trade_week_send_evidence.sql
-- Make the function re-apply safe inside this contract without touching a sibling case.
-- Each test database contains the same real v4 migration; this transaction restores v3.
DO $$ DECLARE t text; c record; BEGIN
  FOREACH t IN ARRAY ARRAY['trade_invoices', 'trade_invoice_lines'] LOOP
    FOR c IN SELECT tgname FROM pg_trigger WHERE tgrelid = format('public.%I', t)::regclass AND NOT tgisinternal LOOP
      EXECUTE format('ALTER TABLE public.%I DISABLE TRIGGER %I', t, c.tgname);
    END LOOP;
    FOR c IN SELECT conname FROM pg_constraint WHERE conrelid = format('public.%I', t)::regclass AND contype IN ('f','c','u','x') LOOP
      EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT %I', t, c.conname);
    END LOOP;
    FOR c IN SELECT attname FROM pg_attribute WHERE attrelid = format('public.%I', t)::regclass AND attnum > 0 AND NOT attisdropped AND attnotnull AND attname <> 'id' LOOP
      EXECUTE format('ALTER TABLE public.%I ALTER COLUMN %I DROP NOT NULL', t, c.attname);
    END LOOP;
  END LOOP;
END $$;
-- Deliberate v3 stand-in: isolate the new wrapper, not the existing invoice engine.
CREATE OR REPLACE FUNCTION public.persist_weekly_trade_invoice_v3(p_invoice jsonb,p_lines jsonb,p_requested_prior_draft_id uuid DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE made uuid;
BEGIN
  INSERT INTO public.trade_invoices(id) VALUES(gen_random_uuid()) RETURNING id INTO made;
  INSERT INTO public.trade_invoice_lines(id,trade_invoice_id,line_position,line_total_ex,office_review_note)
  SELECT gen_random_uuid(),made,COALESCE((x.line->>'line_position')::integer,x.n::integer-1),
    (x.line->>'line_total_ex')::numeric,'Existing office note'
  FROM jsonb_array_elements(p_lines) WITH ORDINALITY x(line,n);
  RETURN made;
END $$;
DO $$ DECLARE made uuid; stored record; before_count integer; BEGIN
  made := public.persist_weekly_trade_invoice_v4(
    '{"accepted_untouched":false,"confirm_seconds":17}',
    '[{"line_position":3,"line_total_ex":300,"suggested":{"source":"clock","hours":7.5},"changed_from_suggestion":true,"sent_values":{"typed_rate":41},"office_review_note":"Rate is set by the office"},{"line_total_ex":80,"suggested":{"source":"added_by_trade"},"changed_from_suggestion":null}]',NULL);
  IF NOT EXISTS(SELECT 1 FROM public.trade_invoices WHERE id=made AND accepted_untouched=false AND confirm_seconds=17) THEN
    RAISE EXCEPTION 'invoice evidence was not saved';
  END IF;
  SELECT * INTO STRICT stored FROM public.trade_invoice_lines WHERE trade_invoice_id=made AND line_position=3;
  IF stored.suggested <> '{"source":"clock","hours":7.5}'::jsonb OR stored.changed_from_suggestion IS DISTINCT FROM true
    OR stored.line_total_ex <> 300 OR stored.sent_values <> '{"typed_rate":41}'::jsonb
    OR stored.office_review_note <> 'Existing office note | Rate is set by the office' THEN
    RAISE EXCEPTION 'line evidence changed money, lost the office note, or did not persist';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.trade_invoice_lines WHERE trade_invoice_id=made AND line_position=1
    AND suggested='{"source":"added_by_trade"}'::jsonb AND changed_from_suggestion IS NULL) THEN
    RAISE EXCEPTION 'added line uncertainty was not kept';
  END IF;
  SELECT count(*) INTO before_count FROM public.trade_invoices;
  BEGIN
    PERFORM public.persist_weekly_trade_invoice_v4('{"accepted_untouched":false,"confirm_seconds":"bad"}', '[]',NULL);
    RAISE EXCEPTION 'invalid evidence was accepted';
  EXCEPTION WHEN invalid_text_representation THEN NULL;
  END;
  IF (SELECT count(*) FROM public.trade_invoices) <> before_count THEN RAISE EXCEPTION 'failed evidence left a partial invoice'; END IF;
  IF has_function_privilege('authenticated','public.persist_weekly_trade_invoice_v4(jsonb,jsonb,uuid)','execute')
    OR has_function_privilege('anon','public.persist_weekly_trade_invoice_v4(jsonb,jsonb,uuid)','execute') THEN
    RAISE EXCEPTION 'browser role can write server suggestion facts';
  END IF;
END $$;
ROLLBACK;
\echo PASS P1-16.3 atomic invoice and line evidence, failure rollback, service-role boundary
