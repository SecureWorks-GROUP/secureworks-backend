-- Undo 20261118193817: restore 20261118153101's two guard bodies, then drop the scope
-- helper and its settings table. An installed guard stays installed and caps every job
-- again, as before this change.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';
DO $pins$ DECLARE r record; BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('public.trade_invoice_lines_job_amount_guard()', '88c7f010e3fba6d234dded789ff1ce97'),
    ('public.trade_invoices_job_amount_guard()', '316f205bcd517ee3e5b0d5b4dcfc3e7c')
  ) AS expected(signature, body_hash) LOOP
    IF (SELECT md5(p.prosrc) FROM pg_proc p WHERE p.oid=to_regprocedure(r.signature))
         IS DISTINCT FROM r.body_hash THEN
      RAISE EXCEPTION 'work_order_cap_scope_body_drift' USING DETAIL=r.signature;
    END IF;
  END LOOP;
END $pins$;

CREATE OR REPLACE FUNCTION public.trade_invoice_lines_job_amount_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $guard$
DECLARE v_room numeric; v_invoice public.trade_invoices%ROWTYPE; BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.feature_flags
   WHERE flag_name='trade_line_hold_v1' AND enabled) THEN RETURN NEW; END IF;
 IF NEW.job_id IS NULL
   OR NOT public.work_order_backed_line(NEW.line_type,NEW.office_review_status)
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
   -- This header still reads as not counted here, so its own lines are not in the room.
   v_room:=public.job_backed_room(v_job);
   IF v_room IS NULL OR v_spend IS NULL OR round(v_spend*100)>round(v_room*100) THEN
     RAISE EXCEPTION 'job_amount_guard' USING ERRCODE='23514',DETAIL=v_job::text;
   END IF;
 END LOOP;
 RETURN NEW;
END $header$;

DROP FUNCTION public.work_order_cap_scope(uuid[]);
DROP TABLE public.work_order_cap_settings;
