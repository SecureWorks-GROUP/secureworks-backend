-- P1-05.9, follow-up 39 item 16. Definitions only.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';
DO $pins$ DECLARE r record; BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('public.job_backed_room(uuid)', 'cafd90c10061b3b48d0b92b7973abaac'),
    ('public.trade_invoice_lines_job_amount_guard()', 'a11ae376a46410120762d127b82ba372'),
    ('public.trade_invoices_job_amount_guard()', '1c031640482f7b43bbf60f3f0b3d6c7e'),
    ('public.install_trade_line_job_amount_guard()', '1f456e343673a01b9c945e1770f71d36')
  ) AS expected(signature, body_hash) LOOP
    IF (SELECT md5(p.prosrc) FROM pg_proc p WHERE p.oid=to_regprocedure(r.signature))
         IS DISTINCT FROM r.body_hash THEN
      RAISE EXCEPTION 'work_order_cap_body_drift' USING DETAIL=r.signature;
    END IF;
  END LOOP;
END $pins$;

-- These predicates apply to the saved lines and to the prospective row of each trigger.
CREATE FUNCTION public.work_order_backed_invoice(p_status text, p_kind text)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $invoice$
  SELECT (p_status = ANY(public.job_work_order_billed_invoice_statuses())
    AND p_kind IN ('standard','follow_on')) IS TRUE;
$invoice$;

CREATE FUNCTION public.work_order_backed_line(p_type text, p_review text)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $line$
  SELECT lower(btrim(coalesce(p_type,''))) NOT IN ('commission','reimbursement')
    AND (p_review IS NULL OR p_review='approved');
$line$;

-- One total per requested job, including an explicit zero for an empty set.
-- An eligible row without money leaves the total unknown. Exclusions let a
-- proposed adjustment replace its old line without counting the line twice.
CREATE FUNCTION public.work_order_backed_billed(p_job_ids uuid[], p_exclude_line_ids uuid[] DEFAULT '{}')
RETURNS TABLE(job_id uuid, billed_ex numeric) LANGUAGE sql STABLE SECURITY INVOKER AS $billed$
  SELECT j.id, (
    SELECT CASE WHEN count(*)=count(coalesce(l.override_amount,l.line_total_ex))
      THEN coalesce(sum(coalesce(l.override_amount,l.line_total_ex)),0) END
    FROM public.trade_invoice_lines l
    JOIN public.trade_invoices i ON i.id=l.trade_invoice_id
    WHERE l.job_id=j.id AND NOT (l.id=ANY(array_remove(coalesce(p_exclude_line_ids,'{}'),NULL)))
      AND public.work_order_backed_line(l.line_type,l.office_review_status)
      AND public.work_order_backed_invoice(i.status,i.invoice_kind)
  )
  FROM unnest(p_job_ids) requested(id)
  JOIN public.jobs j ON j.id=requested.id;
$billed$;

REVOKE ALL ON FUNCTION public.work_order_backed_invoice(text,text),
  public.work_order_backed_line(text,text), public.work_order_backed_billed(uuid[],uuid[])
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.work_order_backed_invoice(text,text),
  public.work_order_backed_line(text,text), public.work_order_backed_billed(uuid[],uuid[])
  TO service_role;

CREATE OR REPLACE FUNCTION public.job_backed_room(p_job_id uuid)
RETURNS numeric LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp AS $room$
 SELECT w.agreed_labour_ex
   + coalesce((SELECT sum(v.trade_allocation_ex)
       FROM public.work_order_customer_variations v
       WHERE v.work_order_id=w.id AND v.status='approved'),0)
   + public.work_order_amount_change_total(w.id)
   - (SELECT b.billed_ex FROM public.work_order_backed_billed(ARRAY[p_job_id]) b)
 FROM public.work_orders w
 WHERE w.job_id=p_job_id AND w.kind='job' AND w.status='approved'
   AND w.agreed_labour_ex IS NOT NULL;
$room$;

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

CREATE OR REPLACE FUNCTION public.install_trade_line_job_amount_guard()
RETURNS void LANGUAGE plpgsql SET search_path = public, pg_temp AS $install$ BEGIN
 SET LOCAL lock_timeout = '5s';
 IF NOT EXISTS(SELECT 1 FROM pg_trigger
   WHERE tgrelid='public.trade_invoice_lines'::regclass
     AND tgname='trade_invoice_lines_job_amount_guard' AND NOT tgisinternal
     AND (SELECT attnum FROM pg_attribute WHERE attrelid=tgrelid AND attname='override_amount')=ANY(tgattr)) THEN
   CREATE OR REPLACE TRIGGER trade_invoice_lines_job_amount_guard
     BEFORE INSERT OR UPDATE OF line_total_ex,override_amount,job_id,office_review_status,trade_invoice_id,line_type
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
