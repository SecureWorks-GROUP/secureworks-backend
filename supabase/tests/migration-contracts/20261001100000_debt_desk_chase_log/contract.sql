-- Contract for 20261001100000_debt_desk_chase_log.sql. Every fixture write is
-- inside one transaction that rolls back.

-- 1. The method CHECK holds exactly the nine earlier values plus visit,
--    statement and letter.
DO $$
DECLARE
  v_def text := pg_get_constraintdef(
    (SELECT oid FROM pg_constraint WHERE conname = 'payment_chase_logs_method_check'));
  v_method text;
BEGIN
  FOREACH v_method IN ARRAY ARRAY[
    'call', 'sms', 'auto_sms', 'email', 'note', 'status_change',
    'personality_note', 'classification', 'proposal',
    'visit', 'statement', 'letter'
  ] LOOP
    IF position(quote_literal(v_method) IN v_def) = 0 THEN
      RAISE EXCEPTION 'contract: method % missing from %', v_method, v_def;
    END IF;
  END LOOP;
  IF (SELECT count(*) FROM regexp_matches(v_def, '''[a-z_]+''', 'g')) <> 12 THEN
    RAISE EXCEPTION 'contract: method CHECK is not exactly twelve values: %', v_def;
  END IF;
END $$;

-- 2. The desk columns exist with their types; no channel column was added.
DO $$
DECLARE
  v_missing text;
BEGIN
  SELECT string_agg(want.col || ' ' || want.typ, ', ') INTO v_missing
    FROM (VALUES
      ('direction', 'text'),
      ('outcome_code', 'text'),
      ('promised_amount', 'numeric'),
      ('promised_date', 'date'),
      ('amount_due_at_promise', 'numeric'),
      ('schedule_step', 'text'),
      ('approved_by_user_id', 'uuid'),
      ('automated', 'boolean'),
      ('provider_message_id', 'text'),
      ('covers_invoice_ids', 'ARRAY'),
      ('draft_id', 'text'),
      ('draft_amount', 'numeric')
    ) AS want(col, typ)
    LEFT JOIN information_schema.columns c
      ON c.table_schema = 'public' AND c.table_name = 'payment_chase_logs'
     AND c.column_name = want.col AND c.data_type = want.typ
   WHERE c.column_name IS NULL;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'contract: missing desk columns: %', v_missing;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'payment_chase_logs'
                AND column_name = 'channel') THEN
    RAISE EXCEPTION 'contract: a channel column was added; method is the one channel field';
  END IF;
END $$;

BEGIN;

-- 3. Rows written the old way still insert, and read back with the defaults.
INSERT INTO public.payment_chase_logs (xero_invoice_id, method, outcome, notes, chased_by)
VALUES ('legacy-invoice', 'sms', 'SMS sent', 'old send_chase_sms row', 'ops@example.test');
DO $$
BEGIN
  IF (SELECT automated FROM public.payment_chase_logs WHERE xero_invoice_id = 'legacy-invoice') IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'contract: automated must default to false';
  END IF;
  IF (SELECT outcome_code FROM public.payment_chase_logs WHERE xero_invoice_id = 'legacy-invoice') IS NOT NULL THEN
    RAISE EXCEPTION 'contract: an old-style row must carry no outcome_code';
  END IF;
END $$;

-- 4. A desk row with every new column inserts.
INSERT INTO public.payment_chase_logs (
  xero_invoice_id, method, direction, outcome_code, schedule_step,
  approved_by_user_id, provider_message_id, covers_invoice_ids, draft_id,
  draft_amount, notes
) VALUES (
  'desk-invoice', 'sms', 'outbound', 'sent', 'firm_text',
  '20000000-0000-4000-8000-000000000001', 'ghl-msg-1',
  ARRAY['desk-invoice', 'desk-invoice-2'], '2026-10-01:contact:text:firm_text|420000',
  4200.00, 'the approved text'
);
INSERT INTO public.payment_chase_logs (
  xero_invoice_id, method, outcome_code, schedule_step, promised_amount,
  promised_date, amount_due_at_promise
) VALUES ('desk-invoice', 'call', 'promised', 'call', 1000, '2026-10-03', 4200);
INSERT INTO public.payment_chase_logs (xero_invoice_id, method, schedule_step, outcome_code)
VALUES ('desk-invoice', 'visit', 'jan_visit', 'no_answer'),
       ('desk-invoice', 'statement', 'statement', 'sent'),
       ('desk-invoice', 'letter', NULL, NULL);

-- 5. The closed lists refuse anything else.
DO $$
DECLARE
  v_case record;
BEGIN
  FOR v_case IN
    SELECT * FROM (VALUES
      ('outcome_code', $q$INSERT INTO public.payment_chase_logs (method, outcome_code) VALUES ('call', 'paid')$q$),
      ('schedule_step', $q$INSERT INTO public.payment_chase_logs (method, schedule_step) VALUES ('sms', 'day_9_text')$q$),
      ('direction', $q$INSERT INTO public.payment_chase_logs (method, direction) VALUES ('sms', 'sideways')$q$),
      ('method', $q$INSERT INTO public.payment_chase_logs (method) VALUES ('fax')$q$),
      ('promise without an amount', $q$INSERT INTO public.payment_chase_logs (method, outcome_code, promised_date) VALUES ('call', 'promised', '2026-10-03')$q$),
      ('promise without a date', $q$INSERT INTO public.payment_chase_logs (method, outcome_code, promised_amount) VALUES ('call', 'promised', 100)$q$),
      ('a zero promise', $q$INSERT INTO public.payment_chase_logs (method, outcome_code, promised_amount, promised_date) VALUES ('call', 'promised', 0, '2026-10-03')$q$)
    ) AS t(label, stmt)
  LOOP
    BEGIN
      EXECUTE v_case.stmt;
      RAISE EXCEPTION 'contract: % was accepted', v_case.label;
    EXCEPTION WHEN check_violation THEN
      NULL;
    END;
  END LOOP;
END $$;

-- 6. Row-level security is on, and only the service role has a policy.
DO $$
BEGIN
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.payment_chase_logs'::regclass) THEN
    RAISE EXCEPTION 'contract: payment_chase_logs requires row-level security';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policies
              WHERE schemaname = 'public' AND tablename = 'payment_chase_logs'
                AND NOT (roles = ARRAY['service_role']::name[])) THEN
    RAISE EXCEPTION 'contract: a policy reaches a role other than service_role';
  END IF;
END $$;

-- 7. The service role (ops-api, daily-digest, reporting-api) keeps every
--    operation the existing readers and writers use: select, insert, update
--    (follow-up resolution) and delete. The contract role is created without
--    BYPASSRLS, so this proves the policy itself, not Supabase's bypass.
SET LOCAL ROLE service_role;
DO $$
BEGIN
  IF (SELECT count(*) FROM public.payment_chase_logs) < 6 THEN
    RAISE EXCEPTION 'contract: service_role cannot read the chase log';
  END IF;
  INSERT INTO public.payment_chase_logs (xero_invoice_id, method, notes)
  VALUES ('service-invoice', 'note', 'service role write');
  UPDATE public.payment_chase_logs SET follow_up_resolved = true
   WHERE xero_invoice_id = 'service-invoice';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'contract: service_role cannot update the chase log';
  END IF;
  DELETE FROM public.payment_chase_logs WHERE xero_invoice_id = 'service-invoice';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'contract: service_role cannot delete from the chase log';
  END IF;
END $$;
RESET ROLE;

-- 8. The browser's anon key and a signed-in session see and change nothing.
SET LOCAL ROLE anon;
DO $$
BEGIN
  IF (SELECT count(*) FROM public.payment_chase_logs) <> 0 THEN
    RAISE EXCEPTION 'contract: anon can read the chase log';
  END IF;
  BEGIN
    INSERT INTO public.payment_chase_logs (xero_invoice_id, method) VALUES ('anon-invoice', 'note');
    RAISE EXCEPTION 'contract: anon can write the chase log';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
  UPDATE public.payment_chase_logs SET notes = 'changed' WHERE true;
  IF FOUND THEN
    RAISE EXCEPTION 'contract: anon can update the chase log';
  END IF;
END $$;
RESET ROLE;

SET LOCAL ROLE authenticated;
DO $$
BEGIN
  IF (SELECT count(*) FROM public.payment_chase_logs) <> 0 THEN
    RAISE EXCEPTION 'contract: a signed-in session can read the chase log';
  END IF;
  BEGIN
    INSERT INTO public.payment_chase_logs (xero_invoice_id, method) VALUES ('user-invoice', 'note');
    RAISE EXCEPTION 'contract: a signed-in session can write the chase log';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
  DELETE FROM public.payment_chase_logs WHERE true;
  IF FOUND THEN
    RAISE EXCEPTION 'contract: a signed-in session can delete from the chase log';
  END IF;
END $$;
RESET ROLE;

-- 9. Re-applying is a no-op that keeps the rows and the policy.
\ir ../../../migrations/20261001100000_debt_desk_chase_log.sql
DO $$
BEGIN
  IF (SELECT count(*) FROM public.payment_chase_logs WHERE xero_invoice_id IN ('legacy-invoice', 'desk-invoice')) <> 6 THEN
    RAISE EXCEPTION 'contract: re-apply changed the rows';
  END IF;
  IF (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'payment_chase_logs') <> 1 THEN
    RAISE EXCEPTION 'contract: re-apply duplicated the policy';
  END IF;
END $$;

ROLLBACK;
