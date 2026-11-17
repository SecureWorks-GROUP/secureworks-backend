-- P1-10.1: the weekly pay run record.
--
-- One run per organisation and pay week: who approved it, what was in it and
-- whether its super has been paid. Nothing calls approve_trade_pay_run yet
-- (P1-10.3 will, behind trade_pay_run_v1). Creates no trigger, no schedule and
-- writes no existing row. Pushes nothing to Xero.
--
-- 1. switch trade_pay_run_v1, seeded OFF.
-- 2. trade_pay_runs, trade_pay_run_invoices, trade_invoices.pay_run_id,
--    trade_invoices.reviewed_at and reviewed_by (director ruling A).
-- 3. row level security; service role only.
-- 4. approve_trade_pay_run(org, week, actor, snapshot): one transaction.
-- 4a. the office kind pay_run_stopped, only when phase 2's list exists.
--
-- Snapshot shape read by step 4 (built by P1-10.2/P1-10.3, never a client):
--   { "check_rule": text,
--     "invoices": [ { "invoice_id": uuid, "verdict": "clean"|"stopped",
--                     "pays": number, "super_amount": number,
--                     "stops": array (optional) } ] }
-- A missing or non-numeric key raises pay_run_snapshot_invalid; nothing
-- defaults to 0. invoice_count, total_pays and super_total count the clean
-- invoices only (what this run pays). A clean invoice whose stored
-- super_amount differs from the snapshot's was changed since it was shown.

-- ── 1. the switch ───────────────────────────────────────────────────────────

INSERT INTO public.feature_flags (flag_name, enabled, description)
VALUES ('trade_pay_run_v1', false, 'Trade invoices wait for the weekly pay run: nothing goes to Xero on submit; a named approver approves the clean ones in one press.')
ON CONFLICT (flag_name) DO NOTHING;

-- ── 2. the record ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.trade_pay_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  week_start date NOT NULL CHECK (EXTRACT(ISODOW FROM week_start) = 1),
  status text NOT NULL DEFAULT 'approved' CHECK (status IN ('approved','pushed','closed')),
  check_rule text NOT NULL,
  approved_by uuid NOT NULL REFERENCES public.users(id),
  approved_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  snapshot jsonb NOT NULL,
  standing jsonb NOT NULL,
  invoice_count int NOT NULL CHECK (invoice_count >= 0),
  total_pays numeric(12,2) NOT NULL,
  super_total numeric(12,2) NOT NULL,
  super_marked_paid_at timestamptz,
  super_marked_paid_by uuid REFERENCES public.users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (org_id, week_start)
);
CREATE TABLE IF NOT EXISTS public.trade_pay_run_invoices (
  run_id uuid NOT NULL REFERENCES public.trade_pay_runs(id),
  invoice_id uuid NOT NULL UNIQUE REFERENCES public.trade_invoices(id),
  verdict text NOT NULL CHECK (verdict IN ('clean','stopped')),
  stops jsonb NOT NULL DEFAULT '[]'::jsonb,
  pays numeric(12,2) NOT NULL,
  super_amount numeric(12,2) NOT NULL,
  pushed_at timestamptz,
  xero_bill_id text,
  PRIMARY KEY (run_id, invoice_id)
);
ALTER TABLE public.trade_invoices ADD COLUMN IF NOT EXISTS pay_run_id uuid REFERENCES public.trade_pay_runs(id);
CREATE INDEX IF NOT EXISTS trade_invoices_pay_run_idx ON public.trade_invoices (pay_run_id) WHERE pay_run_id IS NOT NULL;

-- Director ruling 18 Nov 06:30: the office's pay-run review is its own fact,
-- never acknowledged_*. Two new columns, null on every existing row. Guard: a
-- column of either name already present with another type refuses the apply.
DO $guard$
DECLARE
  v_bad text;
/* block */ BEGIN
  SELECT string_agg(a.attname || ' ' || format_type(a.atttypid, a.atttypmod), ', ') INTO v_bad
  FROM pg_attribute a
  WHERE a.attrelid = 'public.trade_invoices'::regclass AND a.attnum > 0 AND NOT a.attisdropped
    AND ((a.attname = 'reviewed_at' AND a.atttypid <> 'timestamp with time zone'::regtype)
      OR (a.attname = 'reviewed_by' AND a.atttypid <> 'uuid'::regtype));
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'trade_pay_runs: trade_invoices already has %, not the expected type', v_bad;
  END IF;
END;
$guard$;
ALTER TABLE public.trade_invoices
  ADD COLUMN IF NOT EXISTS reviewed_at timestamptz,
  ADD COLUMN IF NOT EXISTS reviewed_by uuid REFERENCES public.users(id);

COMMENT ON TABLE public.trade_pay_runs IS
  'P1-10.1: one weekly pay run per organisation and pay week. Written only by approve_trade_pay_run; status moves to pushed when every clean invoice is a Xero draft (P1-10.5).';
COMMENT ON TABLE public.trade_pay_run_invoices IS
  'P1-10.1: every invoice the approver was shown in a pay run, clean or stopped, with the stops and the amounts shown.';
COMMENT ON COLUMN public.trade_invoices.pay_run_id IS
  'P1-10.1: the weekly pay run that approved this invoice. Null until a run approves it.';
COMMENT ON COLUMN public.trade_invoices.reviewed_at IS
  'P1-10.1: when a weekly pay run approved this invoice. Not acknowledged_at (the trade side). Null before P1-10.1 and for invoices no run approved.';
COMMENT ON COLUMN public.trade_invoices.reviewed_by IS
  'P1-10.1: the pay run approver (a user id). Null before P1-10.1 and for invoices no run approved.';

-- ── 3. service role only ────────────────────────────────────────────────────

ALTER TABLE public.trade_pay_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trade_pay_run_invoices ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.trade_pay_runs FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.trade_pay_run_invoices FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.trade_pay_runs TO service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.trade_pay_run_invoices TO service_role;
DROP POLICY IF EXISTS trade_pay_runs_service ON public.trade_pay_runs;
CREATE POLICY trade_pay_runs_service ON public.trade_pay_runs
  FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS trade_pay_run_invoices_service ON public.trade_pay_run_invoices;
CREATE POLICY trade_pay_run_invoices_service ON public.trade_pay_run_invoices
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ── 4. approve a run ────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.approve_trade_pay_run(
  p_org_id uuid, p_week_start date, p_actor uuid, p_snapshot jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_approvers uuid[];
  v_clean uuid[];
  v_all uuid[];
  v_found int;
  v_standing jsonb;
  v_run uuid;
  v_invoice_count int;
  v_total_pays numeric;
  v_super_total numeric;
  v_rows int;
  v_approved int;
/* block */ BEGIN
  IF p_org_id IS NULL OR p_week_start IS NULL OR EXTRACT(ISODOW FROM p_week_start) <> 1 THEN
    RAISE EXCEPTION 'pay_run_week_invalid';
  END IF;

  -- trade_pay_settings_pkey. FOR UPDATE serialises approvals, so a second
  -- concurrent call sees the first run and raises pay_run_already_approved.
  SELECT s.pay_run_approver_user_ids INTO v_approvers
  FROM public.trade_pay_settings s WHERE s.id = 1 FOR UPDATE;
  IF NOT FOUND OR p_actor IS NULL OR NOT coalesce(p_actor = ANY(v_approvers), false) THEN
    RAISE EXCEPTION 'pay_run_not_approver';
  END IF;

  -- trade_pay_runs_org_id_week_start_key.
  IF EXISTS (SELECT 1 FROM public.trade_pay_runs r
             WHERE r.org_id = p_org_id AND r.week_start = p_week_start) THEN
    RAISE EXCEPTION 'pay_run_already_approved';
  END IF;

  -- The snapshot's shape. Nothing is assumed or defaulted.
  IF jsonb_typeof(p_snapshot) IS DISTINCT FROM 'object'
     OR jsonb_typeof(p_snapshot->'check_rule') IS DISTINCT FROM 'string'
     OR btrim(p_snapshot->>'check_rule') = ''
     OR jsonb_typeof(p_snapshot->'invoices') IS DISTINCT FROM 'array'
     OR EXISTS (
       SELECT 1 FROM jsonb_array_elements(p_snapshot->'invoices') e
       WHERE jsonb_typeof(e) IS DISTINCT FROM 'object'
          OR jsonb_typeof(e->'invoice_id') IS DISTINCT FROM 'string'
          OR (e->>'invoice_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          OR coalesce(e->>'verdict', '') NOT IN ('clean', 'stopped')
          OR jsonb_typeof(e->'pays') IS DISTINCT FROM 'number'
          OR jsonb_typeof(e->'super_amount') IS DISTINCT FROM 'number'
          OR (e ? 'stops' AND jsonb_typeof(e->'stops') IS DISTINCT FROM 'array'))
  THEN
    RAISE EXCEPTION 'pay_run_snapshot_invalid';
  END IF;

  SELECT coalesce(array_agg((e->>'invoice_id')::uuid), '{}'::uuid[]),
         coalesce(array_agg((e->>'invoice_id')::uuid) FILTER (WHERE e->>'verdict' = 'clean'), '{}'::uuid[]),
         count(*) FILTER (WHERE e->>'verdict' = 'clean'),
         coalesce(sum((e->>'pays')::numeric) FILTER (WHERE e->>'verdict' = 'clean'), 0),
         coalesce(sum((e->>'super_amount')::numeric) FILTER (WHERE e->>'verdict' = 'clean'), 0)
    INTO v_all, v_clean, v_invoice_count, v_total_pays, v_super_total
  FROM jsonb_array_elements(p_snapshot->'invoices') e;
  IF cardinality(v_all) <> (SELECT count(DISTINCT x) FROM unnest(v_all) x) THEN
    RAISE EXCEPTION 'pay_run_snapshot_invalid';
  END IF;

  -- trade_invoices_pkey: lock exactly the shown invoices, in id order.
  PERFORM 1 FROM public.trade_invoices i WHERE i.id = ANY(v_all) ORDER BY i.id FOR UPDATE;
  SELECT count(*) INTO v_found FROM public.trade_invoices i
  WHERE i.id = ANY(v_all) AND i.org_id = p_org_id AND i.invoice_kind IN ('standard', 'follow_on');
  IF v_found <> cardinality(v_all) THEN
    RAISE EXCEPTION 'pay_run_snapshot_invalid';
  END IF;

  -- Moved since the server built the snapshot: already in a run, sent back,
  -- back to a draft, or its super changed.
  IF EXISTS (
    SELECT 1 FROM public.trade_invoices i
    JOIN jsonb_array_elements(p_snapshot->'invoices') e ON (e->>'invoice_id')::uuid = i.id
    WHERE i.pay_run_id IS NOT NULL
       OR EXISTS (SELECT 1 FROM public.trade_pay_run_invoices ri WHERE ri.invoice_id = i.id)
       OR (e->>'verdict' = 'clean' AND (
            i.status IN ('draft', 'ops-reject')
            OR i.super_amount IS DISTINCT FROM (e->>'super_amount')::numeric)))
  THEN
    RAISE EXCEPTION 'pay_run_changed_since_shown';
  END IF;

  v_standing := public.trade_pay_run_standing_checks(p_org_id, v_clean, 'before_xero');
  IF v_standing IS NULL OR jsonb_typeof(v_standing->'run_blocked') IS DISTINCT FROM 'boolean'
     OR jsonb_typeof(v_standing->'stopped_invoices') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'pay_run_standing_check_unreadable';
  END IF;
  IF (v_standing->>'run_blocked')::boolean THEN
    RAISE EXCEPTION 'pay_run_standing_check_failed';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_standing->'stopped_invoices') s
             WHERE (s->>'invoice_id')::uuid = ANY(v_clean)) THEN
    RAISE EXCEPTION 'pay_run_changed_since_shown';
  END IF;

  /* block */ BEGIN
    INSERT INTO public.trade_pay_runs (org_id, week_start, check_rule, approved_by, snapshot,
      standing, invoice_count, total_pays, super_total)
    VALUES (p_org_id, p_week_start, p_snapshot->>'check_rule', p_actor, p_snapshot,
      v_standing, v_invoice_count, v_total_pays, v_super_total)
    RETURNING id INTO v_run;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'pay_run_already_approved';
  END;

  INSERT INTO public.trade_pay_run_invoices (run_id, invoice_id, verdict, stops, pays, super_amount)
  SELECT v_run, (e->>'invoice_id')::uuid, e->>'verdict', coalesce(e->'stops', '[]'::jsonb),
         (e->>'pays')::numeric, (e->>'super_amount')::numeric
  FROM jsonb_array_elements(p_snapshot->'invoices') e;
  GET DIAGNOSTICS v_rows = ROW_COUNT;

  -- The invoice stamp (director ruling A: own review columns).
  UPDATE public.trade_invoices i
     SET status = 'approved', reviewed_at = now(), reviewed_by = p_actor, pay_run_id = v_run
   WHERE i.id = ANY(v_clean) AND i.status IN ('pending_ops_review', 'queried');
  GET DIAGNOSTICS v_approved = ROW_COUNT;

  RETURN jsonb_build_object(
    'run_id', v_run,
    'week_start', p_week_start,
    'invoice_count', v_invoice_count,
    'stopped_count', cardinality(v_all) - v_invoice_count,
    'run_invoice_rows', v_rows,
    'approved_count', v_approved);
END;
$fn$;
REVOKE ALL ON FUNCTION public.approve_trade_pay_run(uuid, date, uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.approve_trade_pay_run(uuid, date, uuid, jsonb) TO service_role;

-- ── 4a. the one office kind (phase 2 owns the list) ─────────────────────────

DO $kind$
/* block */ BEGIN
  IF to_regclass('public.reconcile_item_kinds') IS NOT NULL THEN
    EXECUTE $sql$INSERT INTO public.reconcile_item_kinds (kind, tab, words, card)
      VALUES ('pay_run_stopped', 'pay', 'Pay run stopped', 'generic') ON CONFLICT (kind) DO NOTHING$sql$;
  END IF;
END;
$kind$;
