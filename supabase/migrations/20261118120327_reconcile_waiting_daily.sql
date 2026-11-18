-- P2-13.8: Reconcile waiting summary, daily snapshot table, 14-day trend read,
-- bounded retention trim and explicit director-only schedule helpers.
-- Creates one table and six functions only: no trigger, no schedule installed
-- on merge, no switch turned on, no gateway call and no person's name stored.
--
-- Index use:
--   * public.reconcile_items: reconcile_items_list_idx (status, kind,
--     amount_ex DESC NULLS LAST, raised_at) from 20261118060051_reconcile_tables.sql
--     serves status = 'open' AND kind = ANY(...), carrying amount_ex and raised_at;
--   * public.reconcile_item_kinds: reconcile_item_kinds_pkey (kind);
--   * public.reconcile_waiting_daily: reconcile_waiting_daily_pkey (day, kind)
--     serves per-day replacement and bounded trim; partial index
--     reconcile_waiting_daily_all_days_idx (day DESC) WHERE kind = 'all'
--     serves reconcile_waiting_days(p_days).
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $prereq$
/* block */ BEGIN
  IF pg_catalog.to_regclass('public.reconcile_items') IS NULL
     OR pg_catalog.to_regclass('public.reconcile_item_kinds') IS NULL THEN
    RAISE EXCEPTION 'reconcile_waiting_prereq_missing';
  END IF;
END $prereq$;

-- Install guard: these functions are new. Refuse to overwrite any other body
-- or any other signature of the same names; this file's own bodies re-apply.
DO $guard$
DECLARE r record;
/* block */ BEGIN
  FOR r IN SELECT p.oid::regprocedure::text AS sig, pg_catalog.md5(p.prosrc) AS body
    FROM pg_catalog.pg_proc p
    WHERE p.pronamespace = 'public'::regnamespace
      AND p.proname IN (
        'reconcile_waiting_summary',
        'reconcile_waiting_snapshot',
        'reconcile_waiting_days',
        'reconcile_waiting_daily_trim',
        'reconcile_waiting_daily_install',
        'reconcile_waiting_daily_remove'
      )
  LOOP
    IF (r.sig, r.body) NOT IN (
         ('reconcile_waiting_daily_install()', '380c5fa28cfd913cf8874edac57420b3'),
         ('reconcile_waiting_daily_remove()', '79d5bc76eb0f621d3fce5a47d975863e'),
         ('reconcile_waiting_daily_trim(date,integer)', '12923db0c5aa8df082170d6b09bfd7c9'),
         ('reconcile_waiting_days(integer)', '4e5638b35ef4ec601d2bcb0a750788c6'),
         ('reconcile_waiting_snapshot(date)', '24ebf7eec6262da912d9e9d454ff17c7'),
         ('reconcile_waiting_summary()', 'ca9b70bf17dfd66bde53c5caca3643ea')
       ) THEN
      RAISE EXCEPTION 'P2-13.8: % already exists with another body; refusing to replace it', r.sig;
    END IF;
  END LOOP;
END $guard$;

CREATE TABLE IF NOT EXISTS public.reconcile_waiting_daily (
  day date NOT NULL,
  kind text NOT NULL,
  waiting int NOT NULL,
  oldest_days int,
  dollars_ex numeric(12,2),
  PRIMARY KEY (day, kind),
  CONSTRAINT reconcile_waiting_daily_kind_nonempty CHECK (pg_catalog.btrim(kind) <> ''),
  CONSTRAINT reconcile_waiting_daily_waiting_nonneg CHECK (waiting >= 0),
  CONSTRAINT reconcile_waiting_daily_oldest_nonneg CHECK (oldest_days IS NULL OR oldest_days >= 0)
);

CREATE INDEX IF NOT EXISTS reconcile_waiting_daily_all_days_idx
  ON public.reconcile_waiting_daily (day DESC)
  WHERE kind = 'all';

COMMENT ON TABLE public.reconcile_waiting_daily IS
  'P2-13.8: daily waiting counts, oldest age in days and known ex GST totals on the Reconcile list. Row kind = all holds the day totals; one row per open non-weekly kind holds the split. Trimmed only through reconcile_waiting_daily_trim.';

ALTER TABLE public.reconcile_waiting_daily ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.reconcile_waiting_daily FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.reconcile_waiting_daily TO service_role;
DROP POLICY IF EXISTS reconcile_waiting_daily_service ON public.reconcile_waiting_daily;
CREATE POLICY reconcile_waiting_daily_service ON public.reconcile_waiting_daily
  TO service_role USING (true) WITH CHECK (true);

CREATE OR REPLACE FUNCTION public.reconcile_waiting_summary()
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $fn$
DECLARE
  v_now timestamptz := pg_catalog.now();
  v_kinds text[];
  v_result jsonb;
/* block */ BEGIN
  SELECT coalesce(pg_catalog.array_agg(k.kind ORDER BY k.kind COLLATE "C"), '{}'::text[])
    INTO v_kinds
  FROM public.reconcile_item_kinds k
  WHERE k.tab <> 'weekly' AND k.kind <> 'all';

  WITH open_items AS MATERIALIZED (
    SELECT
      i.kind,
      i.amount_ex,
      i.raised_at,
      GREATEST(
        0,
        pg_catalog.floor(EXTRACT(epoch FROM (v_now - i.raised_at)) / 86400)::int
      ) AS age_days
    FROM public.reconcile_items i
    WHERE i.status = 'open'
      AND i.kind = ANY(v_kinds)
  ),
  by_kind_rows AS (
    SELECT
      o.kind,
      k.words,
      pg_catalog.count(*)::int AS waiting,
      pg_catalog.max(o.age_days)::int AS oldest_days
    FROM open_items o
    JOIN public.reconcile_item_kinds k ON k.kind = o.kind
    GROUP BY o.kind, k.words
  ),
  oldest_one AS (
    SELECT
      k.words AS kind_words,
      o.raised_at,
      o.age_days AS days
    FROM open_items o
    JOIN public.reconcile_item_kinds k ON k.kind = o.kind
    ORDER BY o.raised_at ASC, o.kind COLLATE "C" ASC
    LIMIT 1
  ),
  totals AS (
    SELECT
      pg_catalog.count(*)::int AS waiting,
      CASE
        WHEN pg_catalog.count(*) = 0 THEN 0::numeric(12,2)
        ELSE pg_catalog.sum(o.amount_ex)::numeric(12,2)
      END AS dollars_ex,
      (pg_catalog.count(*) FILTER (WHERE o.age_days > 7))::int AS over_7_days
    FROM open_items o
  )
  SELECT pg_catalog.jsonb_build_object(
    'as_at', v_now,
    'waiting', t.waiting,
    'dollars_ex', t.dollars_ex,
    'oldest', CASE
      WHEN t.waiting = 0 THEN NULL::jsonb
      ELSE (
        SELECT pg_catalog.jsonb_build_object(
          'kind_words', ol.kind_words,
          'raised_at', ol.raised_at,
          'days', ol.days
        )
        FROM oldest_one ol
      )
    END,
    'over_7_days', t.over_7_days,
    'by_kind', coalesce(
      (
        SELECT pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object(
            'kind', b.kind,
            'words', b.words,
            'waiting', b.waiting,
            'oldest_days', b.oldest_days
          )
          ORDER BY b.waiting DESC, b.oldest_days DESC, b.kind COLLATE "C" ASC
        )
        FROM by_kind_rows b
      ),
      '[]'::jsonb
    )
  )
  INTO v_result
  FROM totals t;

  RETURN v_result;
END $fn$;

CREATE OR REPLACE FUNCTION public.reconcile_waiting_snapshot(p_day date DEFAULT NULL)
RETURNS int
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $fn$
DECLARE
  v_now timestamptz := pg_catalog.now();
  v_day date := coalesce(p_day, (v_now AT TIME ZONE 'Australia/Perth')::date);
  v_kinds text[];
  v_written int;
/* block */ BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('reconcile_waiting_snapshot' || pg_catalog.chr(31) || v_day::text, 0)
  );

  SELECT coalesce(pg_catalog.array_agg(k.kind ORDER BY k.kind COLLATE "C"), '{}'::text[])
    INTO v_kinds
  FROM public.reconcile_item_kinds k
  WHERE k.tab <> 'weekly' AND k.kind <> 'all';

  DELETE FROM public.reconcile_waiting_daily d
  WHERE d.day = v_day;

  WITH open_items AS MATERIALIZED (
    SELECT
      i.kind,
      i.amount_ex,
      GREATEST(
        0,
        pg_catalog.floor(EXTRACT(epoch FROM (v_now - i.raised_at)) / 86400)::int
      ) AS age_days
    FROM public.reconcile_items i
    WHERE i.status = 'open'
      AND i.kind = ANY(v_kinds)
  ),
  rows_to_write AS (
    SELECT
      v_day AS day,
      'all'::text AS kind,
      pg_catalog.count(*)::int AS waiting,
      CASE
        WHEN pg_catalog.count(*) = 0 THEN NULL::int
        ELSE pg_catalog.max(o.age_days)::int
      END AS oldest_days,
      CASE
        WHEN pg_catalog.count(*) = 0 THEN 0::numeric(12,2)
        ELSE pg_catalog.sum(o.amount_ex)::numeric(12,2)
      END AS dollars_ex
    FROM open_items o
    UNION ALL
    SELECT
      v_day AS day,
      o.kind,
      pg_catalog.count(*)::int AS waiting,
      pg_catalog.max(o.age_days)::int AS oldest_days,
      pg_catalog.sum(o.amount_ex)::numeric(12,2) AS dollars_ex
    FROM open_items o
    GROUP BY o.kind
  )
  INSERT INTO public.reconcile_waiting_daily (day, kind, waiting, oldest_days, dollars_ex)
  SELECT r.day, r.kind, r.waiting, r.oldest_days, r.dollars_ex
  FROM rows_to_write r
  ORDER BY CASE WHEN r.kind = 'all' THEN 0 ELSE 1 END, r.kind COLLATE "C";

  GET DIAGNOSTICS v_written = ROW_COUNT;
  RETURN v_written;
END $fn$;

CREATE OR REPLACE FUNCTION public.reconcile_waiting_days(p_days int DEFAULT 14)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $fn$
DECLARE
  v_today date := (pg_catalog.now() AT TIME ZONE 'Australia/Perth')::date;
  v_result jsonb;
/* block */ BEGIN
  IF p_days IS NULL OR p_days < 1 OR p_days > 3660 THEN
    RAISE EXCEPTION 'reconcile_waiting_days_invalid'
      USING DETAIL = coalesce(p_days::text, '(null)');
  END IF;

  SELECT coalesce(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'day', d.day,
        'kind', d.kind,
        'waiting', d.waiting,
        'oldest_days', d.oldest_days,
        'dollars_ex', d.dollars_ex
      )
      ORDER BY d.day DESC
    ),
    '[]'::jsonb
  )
  INTO v_result
  FROM public.reconcile_waiting_daily d
  WHERE d.kind = 'all'
    AND d.day >= v_today - p_days
    AND d.day <= v_today;

  RETURN v_result;
END $fn$;

CREATE OR REPLACE FUNCTION public.reconcile_waiting_daily_trim(
  p_before date,
  p_limit integer DEFAULT 500
)
RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $fn$
DECLARE
  v_limit integer := LEAST(coalesce(p_limit, 500), 500);
  v_deleted integer;
/* block */ BEGIN
  IF p_before IS NULL OR v_limit < 1 THEN
    RAISE EXCEPTION 'reconcile_waiting_trim_invalid'
      USING DETAIL = coalesce(p_before::text, '(null)');
  END IF;

  WITH oldest AS (
    SELECT d.day, d.kind
    FROM public.reconcile_waiting_daily d
    WHERE d.day < p_before
    ORDER BY d.day ASC, d.kind ASC
    LIMIT v_limit
    FOR UPDATE SKIP LOCKED
  )
  DELETE FROM public.reconcile_waiting_daily t
  USING oldest o
  WHERE t.day = o.day AND t.kind = o.kind;

  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END $fn$;

-- Director-only timer install outside office hours (09:05 UTC = 17:05 Perth).
-- Merge installs no schedule; no edge gateway call is made.
CREATE OR REPLACE FUNCTION public.reconcile_waiting_daily_install()
RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $fn$
DECLARE v_job bigint;
/* block */ BEGIN
  IF pg_catalog.to_regclass('cron.job') IS NULL THEN
    RAISE EXCEPTION 'reconcile_waiting_cron_unavailable';
  END IF;
  FOR v_job IN
    SELECT j.jobid FROM cron.job j WHERE j.jobname = 'reconcile-waiting-daily'
  LOOP
    PERFORM cron.unschedule(v_job);
  END LOOP;
  PERFORM cron.schedule(
    'reconcile-waiting-daily',
    '5 9 * * *',
    $cmd$SET LOCAL statement_timeout = '60s'; SELECT public.reconcile_waiting_snapshot();$cmd$
  );
END $fn$;

CREATE OR REPLACE FUNCTION public.reconcile_waiting_daily_remove()
RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $fn$
DECLARE v_job bigint;
/* block */ BEGIN
  IF pg_catalog.to_regclass('cron.job') IS NOT NULL THEN
    FOR v_job IN
      SELECT j.jobid FROM cron.job j WHERE j.jobname = 'reconcile-waiting-daily'
    LOOP
      PERFORM cron.unschedule(v_job);
    END LOOP;
  END IF;
END $fn$;

COMMENT ON FUNCTION public.reconcile_waiting_summary() IS
  'P2-13.8: live counts, known ex GST sum, oldest item and per-kind split of open non-weekly Reconcile items. Snoozed items remain open and counted; counts, days and kind words only.';
COMMENT ON FUNCTION public.reconcile_waiting_snapshot(date) IS
  'P2-13.8: writes or replaces one Perth day in reconcile_waiting_daily (row kind = all plus one row per open non-weekly kind).';
COMMENT ON FUNCTION public.reconcile_waiting_days(int) IS
  'P2-13.8: stored all rows of reconcile_waiting_daily over the last p_days Perth days, newest first.';
COMMENT ON FUNCTION public.reconcile_waiting_daily_trim(date, integer) IS
  'P2-13.8: bounded retention trim for reconcile_waiting_daily before p_before (at most 500 rows per call).';
COMMENT ON FUNCTION public.reconcile_waiting_daily_install() IS
  'P2-13.8: director-only outside-office-hours install of cron job reconcile-waiting-daily at 5 9 * * * (17:05 Perth), database-internal only.';
COMMENT ON FUNCTION public.reconcile_waiting_daily_remove() IS
  'P2-13.8: unschedules cron job reconcile-waiting-daily when present.';

REVOKE ALL ON FUNCTION
  public.reconcile_waiting_summary(),
  public.reconcile_waiting_snapshot(date),
  public.reconcile_waiting_days(int),
  public.reconcile_waiting_daily_trim(date, integer),
  public.reconcile_waiting_daily_install(),
  public.reconcile_waiting_daily_remove()
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION
  public.reconcile_waiting_summary(),
  public.reconcile_waiting_snapshot(date),
  public.reconcile_waiting_days(int),
  public.reconcile_waiting_daily_trim(date, integer),
  public.reconcile_waiting_daily_install(),
  public.reconcile_waiting_daily_remove()
  TO service_role;
