-- P1-05.9. Functions only at merge; installation is an explicit director step.
-- The existing trade_line_hold_v1 flag is not written or enabled here.
-- All five functions are new: none exists on main or in the live read of 18 Nov, so plain
-- CREATE FUNCTION refuses rather than overwrites a body this migration did not write.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';
CREATE FUNCTION public.job_backed_room(p_job_id uuid)
RETURNS numeric LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp AS $room$
 SELECT w.agreed_labour_ex
   + coalesce((SELECT sum(v.trade_allocation_ex)
       FROM public.work_order_customer_variations v
       WHERE v.work_order_id=w.id AND v.status='approved'),0)
   + public.work_order_amount_change_total(w.id)
   - coalesce((SELECT sum(l.line_total_ex)
       FROM public.trade_invoice_lines l
       JOIN public.trade_invoices i ON i.id=l.trade_invoice_id
       WHERE l.job_id=p_job_id
         AND lower(btrim(coalesce(l.line_type,''))) NOT IN ('commission','reimbursement')
         AND (l.office_review_status IS NULL OR l.office_review_status='approved')
         AND i.status NOT IN ('draft','ops-reject')
         AND i.invoice_kind IN ('standard','follow_on')),0)
 FROM public.work_orders w
 WHERE w.job_id=p_job_id AND w.kind='job' AND w.status='approved'
   AND w.agreed_labour_ex IS NOT NULL;
$room$;
-- Existing indexes: uq_work_orders_job_current, idx_work_order_customer_variations_wo,
-- work_order_amount_changes_wo_idx (through the total helper), idx_inv_lines_job,
-- and trade_invoices_pkey. Every read is for one job or one invoice.
REVOKE ALL ON FUNCTION public.job_backed_room(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.job_backed_room(uuid) TO service_role;

CREATE FUNCTION public.trade_invoice_lines_job_amount_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $guard$
DECLARE v_room numeric; v_invoice public.trade_invoices%ROWTYPE; BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.feature_flags
   WHERE flag_name='trade_line_hold_v1' AND enabled) THEN RETURN NEW; END IF;
 IF NEW.job_id IS NULL
   OR lower(btrim(coalesce(NEW.line_type,''))) IN ('commission','reimbursement')
   OR (NEW.office_review_status IS NOT NULL AND NEW.office_review_status<>'approved')
 THEN RETURN NEW; END IF;
 -- FOR SHARE waits for a header change in flight and reads the status it commits, so a
 -- line cannot slip into a draft that another session is turning counted.
 SELECT * INTO v_invoice FROM public.trade_invoices WHERE id=NEW.trade_invoice_id FOR SHARE;
 IF NOT FOUND THEN RETURN NEW; END IF;
 IF v_invoice.invoice_kind NOT IN ('standard','follow_on')
   OR v_invoice.status IS NULL OR v_invoice.status IN ('draft','ops-reject')
 THEN RETURN NEW; END IF;
 -- Multi-job callers must insert in job-id order (P1-05.8), avoiding opposing locks.
 -- A separate SQL statement after the lock gets a fresh READ COMMITTED snapshot.
 PERFORM pg_advisory_xact_lock(hashtextextended('job-amount:'||NEW.job_id::text,0));
 SELECT public.job_backed_room(NEW.job_id) INTO v_room;
 IF TG_OP='UPDATE' THEN
   IF OLD.job_id=NEW.job_id
     AND lower(btrim(coalesce(OLD.line_type,''))) NOT IN ('commission','reimbursement')
     AND (OLD.office_review_status IS NULL OR OLD.office_review_status='approved')
     AND EXISTS(SELECT 1 FROM public.trade_invoices i WHERE i.id=OLD.trade_invoice_id
       AND i.invoice_kind IN ('standard','follow_on') AND i.status NOT IN ('draft','ops-reject'))
   THEN v_room:=v_room+coalesce(OLD.line_total_ex,0); END IF;
 END IF;
 -- Director ruling: compare whole cents, without a one-cent tolerance.
 IF v_room IS NULL OR round(NEW.line_total_ex*100)>round(v_room*100) THEN
   RAISE EXCEPTION 'job_amount_guard' USING ERRCODE='23514',DETAIL=NEW.job_id::text;
 END IF;
 RETURN NEW;
END $guard$;
REVOKE ALL ON FUNCTION public.trade_invoice_lines_job_amount_guard()
 FROM PUBLIC,anon,authenticated,service_role;

-- A header moving into a counted status or kind spends every counted line it holds at once.
-- Its row is locked before this runs, then each job is locked in job-id order (as the line
-- guard and P1-05.8 do) and the room is read again after the locks.
CREATE FUNCTION public.trade_invoices_job_amount_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $header$
DECLARE v_job uuid; v_spend numeric; v_room numeric; BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.feature_flags
   WHERE flag_name='trade_line_hold_v1' AND enabled) THEN RETURN NEW; END IF;
 IF NEW.status IS NULL OR NEW.status IN ('draft','ops-reject')
   OR NEW.invoice_kind IS NULL OR NEW.invoice_kind NOT IN ('standard','follow_on')
 THEN RETURN NEW; END IF;
 IF OLD.status IS NOT NULL AND OLD.status NOT IN ('draft','ops-reject')
   AND OLD.invoice_kind IN ('standard','follow_on')
 THEN RETURN NEW; END IF;
 -- Lines by invoice: idx_inv_lines_invoice.
 FOR v_job IN SELECT DISTINCT l.job_id FROM public.trade_invoice_lines l
   WHERE l.trade_invoice_id=NEW.id AND l.job_id IS NOT NULL
     AND lower(btrim(coalesce(l.line_type,''))) NOT IN ('commission','reimbursement')
     AND (l.office_review_status IS NULL OR l.office_review_status='approved')
   ORDER BY l.job_id
 LOOP
   PERFORM pg_advisory_xact_lock(hashtextextended('job-amount:'||v_job::text,0));
 END LOOP;
 FOR v_job,v_spend IN SELECT l.job_id,sum(l.line_total_ex) FROM public.trade_invoice_lines l
   WHERE l.trade_invoice_id=NEW.id AND l.job_id IS NOT NULL
     AND lower(btrim(coalesce(l.line_type,''))) NOT IN ('commission','reimbursement')
     AND (l.office_review_status IS NULL OR l.office_review_status='approved')
   GROUP BY l.job_id ORDER BY l.job_id
 LOOP
   -- This header still reads as not counted here, so its own lines are not in the room.
   v_room:=public.job_backed_room(v_job);
   IF v_room IS NULL OR round(v_spend*100)>round(v_room*100) THEN
     RAISE EXCEPTION 'job_amount_guard' USING ERRCODE='23514',DETAIL=v_job::text;
   END IF;
 END LOOP;
 RETURN NEW;
END $header$;
REVOKE ALL ON FUNCTION public.trade_invoices_job_amount_guard()
 FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.install_trade_line_job_amount_guard()
RETURNS void LANGUAGE plpgsql SET search_path = public, pg_temp AS $install$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_trigger
   WHERE tgrelid='public.trade_invoice_lines'::regclass
     AND tgname='trade_invoice_lines_job_amount_guard' AND NOT tgisinternal) THEN
   CREATE TRIGGER trade_invoice_lines_job_amount_guard
     BEFORE INSERT OR UPDATE OF line_total_ex,job_id,office_review_status,trade_invoice_id,line_type
     ON public.trade_invoice_lines FOR EACH ROW
     EXECUTE FUNCTION public.trade_invoice_lines_job_amount_guard();
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger
   WHERE tgrelid='public.trade_invoices'::regclass
     AND tgname='trade_invoices_job_amount_guard' AND NOT tgisinternal) THEN
   CREATE TRIGGER trade_invoices_job_amount_guard
     BEFORE UPDATE OF status,invoice_kind
     ON public.trade_invoices FOR EACH ROW
     EXECUTE FUNCTION public.trade_invoices_job_amount_guard();
 END IF;
END $install$;
CREATE FUNCTION public.remove_trade_line_job_amount_guard()
RETURNS void LANGUAGE plpgsql SET search_path = public, pg_temp AS $remove$ BEGIN
 DROP TRIGGER IF EXISTS trade_invoice_lines_job_amount_guard ON public.trade_invoice_lines;
 DROP TRIGGER IF EXISTS trade_invoices_job_amount_guard ON public.trade_invoices;
END $remove$;
REVOKE ALL ON FUNCTION public.install_trade_line_job_amount_guard(),public.remove_trade_line_job_amount_guard()
 FROM PUBLIC,anon,authenticated,service_role;
