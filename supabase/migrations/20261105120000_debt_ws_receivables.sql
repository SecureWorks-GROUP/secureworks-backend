-- Debt Workshop: Debt and Other receivables, per-company terms, and the Wednesday report
-- at 2pm Perth.
--
-- Shaun (Operations Manager), 4 Nov 2026, approved the receivables build ("yes go"):
--   - Company terms are set per company: MLB (all its aliases) 10 days, Ambrose Construct
--     Group 14 days, every other company 10 days. The owner can change them on the Debt
--     tab, and they are kept in the settings.
--   - The Wednesday debt report auto-send moves from 12:00 to 14:00 (2pm) Perth.
--
-- This migration:
-- 1. Adds two columns to the one settings row, public.debt_ws_settings (id = 1):
--      company_terms          jsonb, {canonical company key: days to pay}. The key is the
--                             company's canonical Xero contact id after company_aliases
--                             (lower case), so every alias contact of a builder lands on
--                             its company. A CHECK keeps every value a whole number of
--                             days from 0 to 120 and every key lower case.
--      company_terms_default  integer, the days for any company with no entry (10).
--    Seeded with MLB (Major Loss Builders, canonical contact 96abb9b3-...) 10 days and
--    Ambrose Construct Group (eb7bc4e3-...) 14 days. A re-apply keeps a changed value and
--    only adds a seed key that is missing.
-- 2. Adds public.debt_ws_set_company_terms(company key, days, updated by): sets one
--    company's days, or removes its entry (back to the default) when days is null, in one
--    atomic UPDATE of the settings row. Security definer, service role only: the browser
--    goes through ops-api (action debt_ws_set_company_terms, owner only).
-- 3. Moves the cron job debt-ws-report-auto from Wednesday 12:00 Perth ('0 4 * * 3' UTC) to
--    Wednesday 14:00 Perth ('0 6 * * 3' UTC), and its Xero refresh debt-ws-report-refresh
--    from 11:55 to 13:55 Perth ('55 5 * * 3' UTC). 13:55 still sits clear of the 13:49 and
--    14:04 runs of the 15-minute invoice sync, and ops-api still refuses a report built on
--    a copy of the debt more than 20 minutes old. Both jobs are moved in place
--    (cron.alter_job keeps their ids and history); a missing job is scheduled fresh.
--    Their commands and triggers are unchanged.
--
-- report_auto_send is NOT changed: it stays off (the default), so nothing is sent when this
-- migration applies. The recipients (Marnin, cc Shaun) are unchanged.
--
-- The chase rules do not change: only a company invoice's due date moves when its company
-- has terms other than 10 days (Ambrose: 14). ops-api reads these columns apart from the
-- other settings, so the Debt tab keeps working, with every company on 10 days, before this
-- migration is applied or after it is rolled back.
--
-- Skipped where pg_cron is absent (the columns and the function still apply). Re-applying
-- is a no-op. Rollback: supabase/rollbacks/20261105120000_debt_ws_receivables_down.sql.

-- 1. The terms. The check function is pure, so the CHECK can use it.
CREATE OR REPLACE FUNCTION public.debt_ws_company_terms_valid(p_terms jsonb)
RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  -- CASE, not AND: jsonb_each raises on a non-object, so the type is tested first.
  SELECT CASE
    WHEN jsonb_typeof(p_terms) IS DISTINCT FROM 'object' THEN false
    ELSE NOT EXISTS (
      SELECT 1
        FROM jsonb_each(p_terms) AS e(key, value)
       WHERE e.key = '' OR e.key <> lower(btrim(e.key)) OR length(e.key) > 210
          OR CASE
               WHEN jsonb_typeof(e.value) <> 'number' THEN true
               ELSE e.value::numeric <> trunc(e.value::numeric)
                 OR e.value::numeric < 0 OR e.value::numeric > 120
             END
    )
  END
$$;
COMMENT ON FUNCTION public.debt_ws_company_terms_valid(jsonb) IS
  'Debt Workshop: true when company_terms is an object of lower-case company keys to whole days from 0 to 120. Used by the CHECK on debt_ws_settings.company_terms.';

ALTER TABLE public.debt_ws_settings
  ADD COLUMN IF NOT EXISTS company_terms jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS company_terms_default integer NOT NULL DEFAULT 10;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.debt_ws_settings'::regclass
       AND conname = 'debt_ws_settings_company_terms_valid'
  ) THEN
    ALTER TABLE public.debt_ws_settings
      ADD CONSTRAINT debt_ws_settings_company_terms_valid
      CHECK (public.debt_ws_company_terms_valid(company_terms));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.debt_ws_settings'::regclass
       AND conname = 'debt_ws_settings_company_terms_default_range'
  ) THEN
    ALTER TABLE public.debt_ws_settings
      ADD CONSTRAINT debt_ws_settings_company_terms_default_range
      CHECK (company_terms_default BETWEEN 0 AND 120);
  END IF;
END $$;

COMMENT ON COLUMN public.debt_ws_settings.company_terms IS
  'Debt Workshop: days each company has to pay from the invoice date, {canonical company key (Xero contact id after company_aliases, lower case): days}. Changed by the owner on the Debt tab (ops-api debt_ws_set_company_terms). Shaun, 4 Nov 2026: MLB 10, Ambrose Construct Group 14.';
COMMENT ON COLUMN public.debt_ws_settings.company_terms_default IS
  'Debt Workshop: days to pay for a company with no entry in company_terms (10).';

-- The seed: an existing value wins, so a re-apply never undoes a change made on the tab.
UPDATE public.debt_ws_settings
   SET company_terms = jsonb_build_object(
         '96abb9b3-89d5-4021-8880-ce9e8c4f1a91', 10,
         'eb7bc4e3-d7c1-41a6-99e1-723452c6e497', 14
       ) || company_terms
 WHERE id = 1
   AND NOT (company_terms ? '96abb9b3-89d5-4021-8880-ce9e8c4f1a91'
        AND company_terms ? 'eb7bc4e3-d7c1-41a6-99e1-723452c6e497');

-- 2. The one write path for the terms.
CREATE OR REPLACE FUNCTION public.debt_ws_set_company_terms(
  p_company_key text,
  p_days integer,
  p_user_id text DEFAULT NULL
)
RETURNS TABLE (company_terms jsonb, company_terms_default integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_key text := lower(btrim(coalesce(p_company_key, '')));
BEGIN
  IF v_key = '' OR length(v_key) > 210 THEN
    RAISE EXCEPTION 'debt_ws_set_company_terms: a company key is required'
      USING ERRCODE = '22023';
  END IF;
  IF p_days IS NOT NULL AND (p_days < 0 OR p_days > 120) THEN
    RAISE EXCEPTION 'debt_ws_set_company_terms: days must be 0 to 120, got %', p_days
      USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  WITH changed AS (
    UPDATE public.debt_ws_settings AS s
       SET company_terms = CASE
             WHEN p_days IS NULL THEN s.company_terms - v_key
             ELSE s.company_terms || jsonb_build_object(v_key, p_days)
           END,
           updated_at = now(),
           updated_by = coalesce(nullif(btrim(p_user_id), ''), s.updated_by)
     WHERE s.id = 1
    RETURNING s.company_terms AS terms, s.company_terms_default AS default_days
  )
  SELECT changed.terms, changed.default_days FROM changed;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'debt_ws_set_company_terms: the settings row is missing';
  END IF;
END $$;
COMMENT ON FUNCTION public.debt_ws_set_company_terms(text, integer, text) IS
  'Debt Workshop: sets one company''s terms (days to pay, 0 to 120) in debt_ws_settings.company_terms, or removes its entry (back to company_terms_default) when days is null. One atomic UPDATE. Called by ops-api debt_ws_set_company_terms (owner only).';
REVOKE ALL ON FUNCTION public.debt_ws_set_company_terms(text, integer, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.debt_ws_set_company_terms(text, integer, text) TO service_role, postgres;

-- 3. The words on the switch and the triggers follow the new time.
COMMENT ON COLUMN public.debt_ws_settings.report_auto_send IS
  'Debt report: the Wednesday 2pm (14:00 Perth) auto-send (and its 13:55 Xero refresh). Default off. Also needs sending_enabled.';
COMMENT ON FUNCTION public.trigger_debt_ws_report_auto() IS
  'pg_cron debt-ws-report-auto (Wed 14:00 Perth): posts ops-api debt_ws_report_auto with the service key while debt_ws_settings.report_auto_send is on. Otherwise a no-op.';
COMMENT ON FUNCTION public.trigger_debt_ws_report_refresh() IS
  'pg_cron debt-ws-report-refresh (Wed 13:55 Perth): asks xero-sync for one extra invoice sync so the Wednesday 2pm (14:00) debt report is built on a copy about five minutes old. A no-op unless debt_ws_settings.report_auto_send is on.';

-- 4. The schedules.
DO $cron$
DECLARE
  v_jobid bigint;
BEGIN
  IF to_regclass('cron.job') IS NULL THEN
    RAISE NOTICE 'debt report: pg_cron absent, the Wednesday 2pm auto-send is not scheduled';
    RETURN;
  END IF;
  IF (SELECT count(*) FROM cron.job WHERE jobname = 'debt-ws-report-auto') > 1
     OR (SELECT count(*) FROM cron.job WHERE jobname = 'debt-ws-report-refresh') > 1 THEN
    RAISE EXCEPTION 'debt report: more than one debt report cron job of one name; fix by hand first';
  END IF;

  SELECT jobid INTO v_jobid FROM cron.job WHERE jobname = 'debt-ws-report-auto';
  IF v_jobid IS NULL THEN
    PERFORM cron.schedule('debt-ws-report-auto', '0 6 * * 3',
      $cmd$SELECT public.trigger_debt_ws_report_auto()$cmd$);
  ELSE
    PERFORM cron.alter_job(v_jobid, schedule := '0 6 * * 3');
  END IF;

  v_jobid := NULL;
  SELECT jobid INTO v_jobid FROM cron.job WHERE jobname = 'debt-ws-report-refresh';
  IF v_jobid IS NULL THEN
    PERFORM cron.schedule('debt-ws-report-refresh', '55 5 * * 3',
      $cmd$SELECT public.trigger_debt_ws_report_refresh()$cmd$);
  ELSE
    PERFORM cron.alter_job(v_jobid, schedule := '55 5 * * 3');
  END IF;
END $cron$;
