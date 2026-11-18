-- Follow-up 49 item 9(b): the work order cap reaches only jobs whose job work order was
-- approved on or after a start date held in work_order_cap_settings, and (director ruling,
-- 18 Nov 2026) jobs created on or after it that have no approved order, whose lines still go
-- to the office. A null start date (as seeded) means no job is capped. One helper, work_order_cap_scope, decides it for
-- the database guard and for the send's sorter (ops-api reads it by RPC).
-- Definitions only: a new one-row table and a new function, and the two guard bodies from
-- 20261118153101 with one scope check each. No trigger, timer or switch is written, and no
-- existing table is altered or locked.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';
DO $pins$ DECLARE r record; BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('public.trade_invoice_lines_job_amount_guard()', 'e808582f0510c9b0b9b70881f23c4071'),
    ('public.trade_invoices_job_amount_guard()', 'b798cd0aeb5052fac9f548e9c53a2e16')
  ) AS expected(signature, body_hash) LOOP
    IF (SELECT md5(p.prosrc) FROM pg_proc p WHERE p.oid=to_regprocedure(r.signature))
         IS DISTINCT FROM r.body_hash THEN
      RAISE EXCEPTION 'work_order_cap_scope_body_drift' USING DETAIL=r.signature;
    END IF;
  END LOOP;
END $pins$;

CREATE TABLE public.work_order_cap_settings (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  cap_start_on date,
  note text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.work_order_cap_settings (id, cap_start_on, note)
VALUES (1, NULL, 'Null: no job is capped. A Perth date: jobs whose job work order was approved on or after it, and jobs created on or after it with no approved order.');
COMMENT ON TABLE public.work_order_cap_settings IS
  'One row. cap_start_on is the first Perth day under the cap (work_order_cap_scope): a job whose job work order was approved on or after it, or a job created on or after it with no approved order. Null means no job is capped. Changing it is a ruling, not a code edit.';
ALTER TABLE public.work_order_cap_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.work_order_cap_settings FROM PUBLIC, anon, authenticated;
GRANT SELECT, UPDATE ON TABLE public.work_order_cap_settings TO service_role;

-- The one scope rule. One row per distinct requested id. With no start date (null, or no
-- settings row) every job is false. With one:
--   * a job whose job work order is approved: its Perth approval day on or after the date;
--   * any other job (no order, or only a draft): its Perth creation day on or after the date,
--     so a new job with no approved order still goes to the office. A job or creation time
--     that cannot be read is true (held, as before this change), never released.
-- Reads: work_order_cap_settings_pkey, uq_work_orders_job_current and jobs_pkey per job.
CREATE FUNCTION public.work_order_cap_scope(p_job_ids uuid[])
RETURNS TABLE(job_id uuid, in_scope boolean)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp AS $scope$
  SELECT r.id, coalesce((
    SELECT CASE
      WHEN w.id IS NOT NULL
        THEN (w.approved_at AT TIME ZONE 'Australia/Perth')::date >= s.cap_start_on
      ELSE coalesce((j.created_at AT TIME ZONE 'Australia/Perth')::date >= s.cap_start_on, true)
    END
    FROM public.work_order_cap_settings s
    LEFT JOIN public.work_orders w ON w.job_id = r.id AND w.kind = 'job'
      AND w.status = 'approved' AND w.approved_at IS NOT NULL
    LEFT JOIN public.jobs j ON j.id = r.id
    WHERE s.id = 1 AND s.cap_start_on IS NOT NULL
  ), false)
  FROM (SELECT DISTINCT u.id FROM unnest(p_job_ids) AS u(id) WHERE u.id IS NOT NULL) r;
$scope$;
REVOKE ALL ON FUNCTION public.work_order_cap_scope(uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.work_order_cap_scope(uuid[]) TO service_role;

-- 20261118153101's line guard, plus: a job out of the cap's scope is not checked.
CREATE OR REPLACE FUNCTION public.trade_invoice_lines_job_amount_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $guard$
DECLARE v_room numeric; v_invoice public.trade_invoices%ROWTYPE; BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.feature_flags
   WHERE flag_name='trade_line_hold_v1' AND enabled) THEN RETURN NEW; END IF;
 IF NEW.job_id IS NULL
   OR NOT public.work_order_backed_line(NEW.line_type,NEW.office_review_status)
 THEN RETURN NEW; END IF;
 -- Follow-up 49 item 9(b): only a job in the cap's scope is held to its amount.
 IF NOT EXISTS(SELECT 1 FROM public.work_order_cap_scope(ARRAY[NEW.job_id]) s WHERE s.in_scope)
 THEN RETURN NEW; END IF;
 -- FOR SHARE waits for a header change in flight and reads the status it commits, so a
 -- line cannot slip into a draft that another session is turning counted.
 SELECT * INTO v_invoice FROM public.trade_invoices WHERE id=NEW.trade_invoice_id FOR SHARE;
 IF NOT FOUND THEN
   RAISE EXCEPTION 'job_amount_guard' USING ERRCODE='23514',DETAIL=NEW.job_id::text;
 END IF;
 IF NOT public.work_order_backed_invoice(v_invoice.status,v_invoice.invoice_kind)
 THEN RETURN NEW; END IF;
 -- Multi-job callers must insert in job-id order (P1-05.8), avoiding opposing locks.
 -- A separate SQL statement after the lock gets a fresh READ COMMITTED snapshot.
 PERFORM pg_advisory_xact_lock(hashtextextended('job-amount:'||NEW.job_id::text,0));
 SELECT public.job_backed_room(NEW.job_id) INTO v_room;
 IF TG_OP='UPDATE' THEN
   IF OLD.job_id=NEW.job_id
     AND public.work_order_backed_line(OLD.line_type,OLD.office_review_status)
     AND EXISTS(SELECT 1 FROM public.trade_invoices i WHERE i.id=OLD.trade_invoice_id
       AND public.work_order_backed_invoice(i.status,i.invoice_kind))
   THEN v_room:=v_room+coalesce(OLD.override_amount,OLD.line_total_ex); END IF;
 END IF;
 -- Director ruling: compare whole cents, without a one-cent tolerance.
 IF v_room IS NULL OR coalesce(NEW.override_amount,NEW.line_total_ex) IS NULL
    OR round(coalesce(NEW.override_amount,NEW.line_total_ex)*100)>round(v_room*100) THEN
   RAISE EXCEPTION 'job_amount_guard' USING ERRCODE='23514',DETAIL=NEW.job_id::text;
 END IF;
 RETURN NEW;
END $guard$;

-- 20261118153101's header guard, plus: a job out of the cap's scope is not checked. Every
-- job is still locked in job-id order, so lock order is unchanged.
CREATE OR REPLACE FUNCTION public.trade_invoices_job_amount_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $header$
DECLARE v_job uuid; v_spend numeric; v_room numeric; BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.feature_flags
   WHERE flag_name='trade_line_hold_v1' AND enabled) THEN RETURN NEW; END IF;
 IF NOT public.work_order_backed_invoice(NEW.status,NEW.invoice_kind)
 THEN RETURN NEW; END IF;
 IF public.work_order_backed_invoice(OLD.status,OLD.invoice_kind)
 THEN RETURN NEW; END IF;
 -- Lines by invoice: idx_inv_lines_invoice.
 FOR v_job IN SELECT DISTINCT l.job_id FROM public.trade_invoice_lines l
   WHERE l.trade_invoice_id=NEW.id AND l.job_id IS NOT NULL
     AND public.work_order_backed_line(l.line_type,l.office_review_status)
   ORDER BY l.job_id
 LOOP
   PERFORM pg_advisory_xact_lock(hashtextextended('job-amount:'||v_job::text,0));
 END LOOP;
 FOR v_job,v_spend IN SELECT l.job_id,
   CASE WHEN count(*)=count(coalesce(l.override_amount,l.line_total_ex))
     THEN sum(coalesce(l.override_amount,l.line_total_ex)) END FROM public.trade_invoice_lines l
   WHERE l.trade_invoice_id=NEW.id AND l.job_id IS NOT NULL
     AND public.work_order_backed_line(l.line_type,l.office_review_status)
   GROUP BY l.job_id ORDER BY l.job_id
 LOOP
   -- Follow-up 49 item 9(b): only a job in the cap's scope is held to its amount.
   CONTINUE WHEN NOT EXISTS(SELECT 1 FROM public.work_order_cap_scope(ARRAY[v_job]) s WHERE s.in_scope);
   -- This header still reads as not counted here, so its own lines are not in the room.
   v_room:=public.job_backed_room(v_job);
   IF v_room IS NULL OR v_spend IS NULL OR round(v_spend*100)>round(v_room*100) THEN
     RAISE EXCEPTION 'job_amount_guard' USING ERRCODE='23514',DETAIL=v_job::text;
   END IF;
 END LOOP;
 RETURN NEW;
END $header$;
