-- Contract for 20261008170000_debt_workshop.sql. Every fixture write is inside a
-- transaction that rolls back.

-- 1. Row-level security is on for all seven tables, and only the service role
--    has a policy.
DO $$
DECLARE
  v_table text;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'debt_ws_settings', 'debt_ws_log', 'debt_ws_suggestions', 'debt_ws_states',
    'debt_ws_sends', 'debt_ws_statements', 'debt_ws_jan_lists'
  ] LOOP
    IF to_regclass('public.' || v_table) IS NULL THEN
      RAISE EXCEPTION 'contract: % is missing', v_table;
    END IF;
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = ('public.' || v_table)::regclass) THEN
      RAISE EXCEPTION '% requires row-level security', v_table;
    END IF;
    IF (SELECT count(*) FROM pg_policies
         WHERE schemaname = 'public' AND tablename = v_table) <> 1 THEN
      RAISE EXCEPTION 'contract: % must carry exactly one policy', v_table;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_policies
                WHERE schemaname = 'public' AND tablename = v_table
                  AND NOT (roles = ARRAY['service_role']::name[])) THEN
      RAISE EXCEPTION 'contract: a % policy reaches a role other than service_role', v_table;
    END IF;
  END LOOP;
END $$;

-- 2. The settings row: one row, every switch off, the owner copied from the
--    debt desk (Shaun's users.id in this stack), and the seeded lists.
DO $$
DECLARE
  s record;
BEGIN
  SELECT * INTO s FROM public.debt_ws_settings WHERE id = 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'contract: the settings row was not seeded';
  END IF;
  IF s.tab_visible OR s.sending_enabled OR s.agent_enabled OR s.jan_list_auto_send THEN
    RAISE EXCEPTION 'contract: a switch is on by default';
  END IF;
  IF s.auto_send_steps <> '{}'::jsonb THEN
    RAISE EXCEPTION 'contract: auto_send_steps must start empty';
  END IF;
  IF s.owner_user_ids IS DISTINCT FROM ARRAY['9913309f-35ae-4a71-8e1f-f704ecc526ea']::uuid[] THEN
    RAISE EXCEPTION 'contract: the owner is not Shaun''s users.id: %', s.owner_user_ids;
  END IF;
  IF NOT (s.not_chased_contacts @> ARRAY['Emergency Trade Services', 'Builderwest']) THEN
    RAISE EXCEPTION 'contract: the not-chased contacts are not seeded';
  END IF;
  IF NOT (s.not_chased_contacts @> ARRAY[
      'd3d81d78-1f5e-450f-9852-ab6c2e1c9bc8', 'c3a479ce-20c4-43fe-b893-bbcacfeb417e'
    ]) THEN
    RAISE EXCEPTION 'contract: the not-chased contact ids are not seeded';
  END IF;
  -- Statement emails are keyed by the canonical Xero contact id, not the name.
  IF s.statement_emails->>'96abb9b3-89d5-4021-8880-ce9e8c4f1a91' IS DISTINCT FROM 'accounts@mlbuilders.com.au'
     OR s.statement_emails->>'71a5e645-3ef7-4946-9926-470dcd78979d' IS DISTINCT FROM 'accounts@ajs.build' THEN
    RAISE EXCEPTION 'contract: the statement emails are not seeded by contact id';
  END IF;
  IF s.statement_emails ? 'Major Loss Builders' THEN
    RAISE EXCEPTION 'contract: statement emails must be keyed by contact id, not name';
  END IF;
  -- Company aliases: the extra contact ids of MLB, Western Building and Builderwest.
  IF s.company_aliases IS DISTINCT FROM jsonb_build_object(
       '4d7121e3-b324-4566-9552-96d6add93f58', '96abb9b3-89d5-4021-8880-ce9e8c4f1a91',
       '2a34b09f-ed34-4b26-9ad0-f59bd9d3b264', '29d70cdc-8ba1-4a21-ba9a-ade6374e987b',
       'aff63429-b473-4c46-bfaa-40c2678b3ae0', 'c3a479ce-20c4-43fe-b893-bbcacfeb417e'
     ) THEN
    RAISE EXCEPTION 'contract: the company aliases are not seeded: %', s.company_aliases;
  END IF;
  BEGIN
    INSERT INTO public.debt_ws_settings (id) VALUES (2);
    RAISE EXCEPTION 'contract: a second settings row was accepted';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;
  BEGIN
    UPDATE public.debt_ws_settings SET company_aliases = '[]'::jsonb WHERE id = 1;
    RAISE EXCEPTION 'contract: company_aliases accepted a non-object';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;
END $$;

BEGIN;

-- 3. The send claim: one sending-or-sent row per share, cycle and step. A
--    refused or failed row releases it; a sent row holds it for good.
INSERT INTO public.debt_ws_sends (share_key, cycle_start, step, status)
VALUES ('inv-1', '2026-10-01', 'd1', 'sending');
DO $$
DECLARE
  v_id uuid;
BEGIN
  BEGIN
    INSERT INTO public.debt_ws_sends (share_key, cycle_start, step, status)
    VALUES ('inv-1', '2026-10-01', 'd1', 'sending');
    RAISE EXCEPTION 'contract: a second claim on one step was accepted';
  EXCEPTION WHEN unique_violation THEN
    NULL;
  END;
  UPDATE public.debt_ws_sends SET status = 'refused'
   WHERE share_key = 'inv-1' AND step = 'd1';
  INSERT INTO public.debt_ws_sends (share_key, cycle_start, step, status)
  VALUES ('inv-1', '2026-10-01', 'd1', 'sending') RETURNING id INTO v_id;
  UPDATE public.debt_ws_sends SET status = 'sent' WHERE id = v_id;
  BEGIN
    INSERT INTO public.debt_ws_sends (share_key, cycle_start, step, status)
    VALUES ('inv-1', '2026-10-01', 'd1', 'sending');
    RAISE EXCEPTION 'contract: a claim on a sent step was accepted';
  EXCEPTION WHEN unique_violation THEN
    NULL;
  END;
  -- Another step, another cycle and a failed row are all fine.
  INSERT INTO public.debt_ws_sends (share_key, cycle_start, step, status)
  VALUES ('inv-1', '2026-10-01', 'd3', 'sending'),
         ('inv-1', '2026-10-09', 'd1', 'sending'),
         ('inv-1', '2026-10-01', 'd1', 'failed');
END $$;

-- 4. One sending-or-sent statement per company per week; one Jan list per visit day.
INSERT INTO public.debt_ws_statements (company_key, week_start, status)
VALUES ('contact-1', '2026-10-06', 'sending');
DO $$
BEGIN
  BEGIN
    INSERT INTO public.debt_ws_statements (company_key, week_start, status)
    VALUES ('contact-1', '2026-10-06', 'sent');
    RAISE EXCEPTION 'contract: a second statement in one week was accepted';
  EXCEPTION WHEN unique_violation THEN
    NULL;
  END;
  INSERT INTO public.debt_ws_statements (company_key, week_start, status)
  VALUES ('contact-1', '2026-10-06', 'failed'),
         ('contact-1', '2026-10-13', 'sent');
  INSERT INTO public.debt_ws_jan_lists (visit_date) VALUES ('2026-10-13');
  IF (SELECT status FROM public.debt_ws_jan_lists WHERE visit_date = '2026-10-13') <> 'open' THEN
    RAISE EXCEPTION 'contract: a new Jan list must start open';
  END IF;
  BEGIN
    INSERT INTO public.debt_ws_jan_lists (visit_date) VALUES ('2026-10-13');
    RAISE EXCEPTION 'contract: a second Jan list for one day was accepted';
  EXCEPTION WHEN unique_violation THEN
    NULL;
  END;
END $$;

-- 5. A full log row, a suggestion and a state insert.
INSERT INTO public.debt_ws_log (share_key, xero_invoice_ids, kind, step, body, meta, created_by_name)
VALUES ('inv-1', ARRAY['inv-1'], 'text_sent', 'd1', 'Hi', '{"cycle_start":"2026-10-01"}', 'Shaun');
INSERT INTO public.debt_ws_suggestions (share_key, kind, channel, text, why, source, step, cycle_start, amount)
VALUES ('inv-1', 'draft', 'sms', 'Hi', 'Day 1', 'agent', 'd1', '2026-10-01', 100);
INSERT INTO public.debt_ws_states (share_key, says_paid_since, paused_until)
VALUES ('inv-1', '2026-10-08', '2026-10-10');
DO $$
BEGIN
  IF (SELECT status FROM public.debt_ws_suggestions WHERE share_key = 'inv-1') <> 'pending' THEN
    RAISE EXCEPTION 'contract: a suggestion must start pending';
  END IF;
END $$;

-- 6. The closed lists refuse anything else.
DO $$
DECLARE
  v_case record;
BEGIN
  FOR v_case IN
    SELECT * FROM (VALUES
      ('log kind', $q$INSERT INTO public.debt_ws_log (share_key, kind) VALUES ('x', 'letter')$q$),
      ('suggestion kind', $q$INSERT INTO public.debt_ws_suggestions (share_key, kind, source) VALUES ('x', 'nudge', 'agent')$q$),
      ('suggestion status', $q$INSERT INTO public.debt_ws_suggestions (share_key, kind, source, status) VALUES ('x', 'draft', 'agent', 'approved')$q$),
      ('suggestion source', $q$INSERT INTO public.debt_ws_suggestions (share_key, kind, source) VALUES ('x', 'draft', 'human')$q$),
      ('suggestion channel', $q$INSERT INTO public.debt_ws_suggestions (share_key, kind, source, channel) VALUES ('x', 'draft', 'agent', 'fax')$q$),
      ('proposed category', $q$INSERT INTO public.debt_ws_suggestions (share_key, kind, source, proposed_category) VALUES ('x', 'move', 'agent', 'bad_debt')$q$),
      ('send status', $q$INSERT INTO public.debt_ws_sends (share_key, cycle_start, step, status) VALUES ('x', '2026-10-01', 'd1', 'queued')$q$),
      ('statement status', $q$INSERT INTO public.debt_ws_statements (company_key, week_start, status) VALUES ('x', '2026-10-06', 'draft')$q$),
      ('jan list status', $q$INSERT INTO public.debt_ws_jan_lists (visit_date, status) VALUES ('2026-10-20', 'done')$q$),
      ('jan list items', $q$INSERT INTO public.debt_ws_jan_lists (visit_date, items) VALUES ('2026-10-27', '{}')$q$),
      ('auto send steps', $q$UPDATE public.debt_ws_settings SET auto_send_steps = '[]' WHERE id = 1$q$)
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

-- 7. The service role reads and writes; the contract role has no BYPASSRLS, so
--    this proves the policy itself.
GRANT SELECT, INSERT, UPDATE, DELETE ON
  public.debt_ws_settings, public.debt_ws_log, public.debt_ws_suggestions,
  public.debt_ws_states, public.debt_ws_sends, public.debt_ws_statements,
  public.debt_ws_jan_lists
  TO anon, authenticated, service_role;
SET LOCAL ROLE service_role;
DO $$
BEGIN
  IF (SELECT count(*) FROM public.debt_ws_sends) < 5 THEN
    RAISE EXCEPTION 'contract: service_role cannot read the sends';
  END IF;
  IF (SELECT count(*) FROM public.debt_ws_settings) <> 1 THEN
    RAISE EXCEPTION 'contract: service_role cannot read the settings';
  END IF;
  INSERT INTO public.debt_ws_log (share_key, kind, body) VALUES ('svc', 'note', 'service write');
  UPDATE public.debt_ws_states SET note = 'service' WHERE share_key = 'inv-1';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'contract: service_role cannot update a state';
  END IF;
END $$;
RESET ROLE;

-- 8. The browser's anon key and a signed-in session see and change nothing.
SET LOCAL ROLE anon;
DO $$
BEGIN
  IF (SELECT count(*) FROM public.debt_ws_settings) <> 0
     OR (SELECT count(*) FROM public.debt_ws_log) <> 0
     OR (SELECT count(*) FROM public.debt_ws_sends) <> 0 THEN
    RAISE EXCEPTION 'contract: anon can read the workshop';
  END IF;
  BEGIN
    INSERT INTO public.debt_ws_log (share_key, kind) VALUES ('anon', 'note');
    RAISE EXCEPTION 'contract: anon can write the workshop log';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
  UPDATE public.debt_ws_settings SET sending_enabled = true WHERE true;
  IF FOUND THEN
    RAISE EXCEPTION 'contract: anon can switch sending on';
  END IF;
END $$;
RESET ROLE;
SET LOCAL ROLE authenticated;
DO $$
BEGIN
  IF (SELECT count(*) FROM public.debt_ws_suggestions) <> 0
     OR (SELECT count(*) FROM public.debt_ws_states) <> 0 THEN
    RAISE EXCEPTION 'contract: a signed-in session can read the workshop';
  END IF;
  BEGIN
    INSERT INTO public.debt_ws_sends (share_key, cycle_start, step, status)
    VALUES ('user', '2026-10-01', 'd1', 'sent');
    RAISE EXCEPTION 'contract: a signed-in session can write a send';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
  UPDATE public.debt_ws_settings SET owner_user_ids = '{}' WHERE true;
  IF FOUND THEN
    RAISE EXCEPTION 'contract: a signed-in session can change the owner';
  END IF;
END $$;
RESET ROLE;

-- 9. The cron trigger is a no-op while jan_list_auto_send is off. This stack has
--    no net schema, so any attempted call would fail here.
SELECT public.trigger_debt_ws_jan_list('debt_ws_jan_list_lock');
SELECT public.trigger_debt_ws_jan_list('debt_ws_jan_list_send');
DO $$
BEGIN
  PERFORM public.trigger_debt_ws_jan_list('debt_ws_anything_else');
  RAISE EXCEPTION 'contract: the trigger accepted an unknown action';
EXCEPTION WHEN raise_exception THEN
  IF SQLERRM NOT LIKE 'trigger_debt_ws_jan_list: unknown action%' THEN
    RAISE;
  END IF;
END $$;
DO $$
BEGIN
  IF has_function_privilege('anon', 'public.trigger_debt_ws_jan_list(text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.trigger_debt_ws_jan_list(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'contract: a public role can run the Jan list trigger';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.trigger_debt_ws_jan_list(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'contract: service_role cannot run the Jan list trigger';
  END IF;
END $$;

-- 10. Re-applying is a no-op that keeps the rows, a changed settings row and the
--     policies.
UPDATE public.debt_ws_settings
   SET owner_user_ids = '{}', sending_enabled = true, not_chased_contacts = '{}',
       company_aliases = '{}'::jsonb
 WHERE id = 1;
\ir ../../../migrations/20261008170000_debt_workshop.sql
DO $$
DECLARE
  s record;
BEGIN
  SELECT * INTO s FROM public.debt_ws_settings WHERE id = 1;
  IF s.owner_user_ids <> '{}'::uuid[] OR NOT s.sending_enabled
     OR s.not_chased_contacts <> '{}'::text[] OR s.company_aliases <> '{}'::jsonb THEN
    RAISE EXCEPTION 'contract: a re-apply overwrote a changed settings row';
  END IF;
  IF (SELECT count(*) FROM public.debt_ws_sends WHERE share_key = 'inv-1') <> 5 THEN
    RAISE EXCEPTION 'contract: a re-apply changed the sends';
  END IF;
  IF (SELECT count(*) FROM pg_policies WHERE schemaname = 'public'
        AND tablename LIKE 'debt\_ws\_%') <> 7 THEN
    RAISE EXCEPTION 'contract: a re-apply duplicated a policy';
  END IF;
END $$;

ROLLBACK;
