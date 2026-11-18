-- P2-06.2: a company card, cash or unknown receipt is a shadow cost line; own-money
-- and supplier-account receipts never are. Creates one retry table and functions only:
-- no trigger or schedule is installed and no switch changes on apply. The director runs
-- job_cost_lines_install_receipt_trigger() after the shadow proof on a ZZTEST receipt.
-- CREATE TABLE and CREATE FUNCTION, not IF NOT EXISTS or CREATE OR REPLACE: a same-named
-- object already on live stops this migration before anything is overwritten.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- A receipt whose shadow write failed (a locked cost line, a refused check) waits here
-- for the one-item drain. No foreign key or receipt-unique key: an append never waits on
-- the drain or on another request for the same receipt. The drain deletes a row once
-- the receipt syncs and folds older rows for the same receipt, at most 100 per run.
CREATE TABLE public.job_cost_lines_receipt_retries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  expense_receipt_id uuid NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  attempts integer NOT NULL DEFAULT 0,
  last_sqlstate text NOT NULL CHECK (last_sqlstate ~ '^[0-9A-Z]{5}$')
);
CREATE INDEX job_cost_lines_receipt_retries_due_idx
  ON public.job_cost_lines_receipt_retries(next_attempt_at,id);
CREATE INDEX job_cost_lines_receipt_retries_receipt_idx
  ON public.job_cost_lines_receipt_retries(expense_receipt_id,requested_at,id);
ALTER TABLE public.job_cost_lines_receipt_retries ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.job_cost_lines_receipt_retries FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.job_cost_lines_receipt_retries TO service_role;
CREATE POLICY job_cost_lines_receipt_retries_service ON public.job_cost_lines_receipt_retries
  FOR ALL TO service_role USING(true) WITH CHECK(true);

CREATE FUNCTION public.job_cost_lines_sync_receipt(p_receipt_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.expense_receipts%ROWTYPE; line public.job_cost_lines%ROWTYPE; doc jsonb;
  live boolean; result jsonb; doc_id text; repaid boolean; BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.feature_flags WHERE flag_name='job_cost_lines_sync_v1' AND enabled) THEN
    RETURN jsonb_build_object('ran',false,'reason','flag_off'); END IF;
  -- A plain read: the receipt row lock belongs to the business write that fired this.
  SELECT * INTO r FROM public.expense_receipts WHERE id=p_receipt_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('ran',false,'reason','receipt_missing'); END IF;
  doc_id := r.id::text;
  live := lower(coalesce(r.status,'')) NOT IN ('queried','rejected');
  doc := jsonb_build_object('org_id',r.org_id,'document_kind','expense_receipt','document_id',doc_id,
    'document_date',r.receipt_date,'document_status',r.status,'party_kind','supplier',
    'party_name',r.vendor_name,'lines',jsonb_build_array(jsonb_build_object(
      -- Party and date are repeated on the line so the writer's line hash sees a
      -- vendor-only or date-only edit; the document-level values overlay them unchanged.
      'kind','receipt','line_key','whole','line_no',1,'party_kind','supplier',
      'party_name',r.vendor_name,'document_date',r.receipt_date,
      'amount_ex',r.total_amount - coalesce(r.gst_amount,0),'gst',r.gst_amount,
      'lane',CASE WHEN r.category IN ('materials','tools','consumables') THEN 'materials' ELSE 'other' END,
      'event_source','receipt')));
  -- job_cost_lines (org_id, document_kind, document_id, line_key) unique key.
  SELECT * INTO line FROM public.job_cost_lines WHERE org_id=r.org_id
    AND document_kind='expense_receipt' AND document_id=doc_id AND line_key='whole' FOR UPDATE;

  -- A live trade invoice line that pays this receipt back is its cost, whatever the
  -- receipt now says it was paid with. Checked before any line is created or counts
  -- again. Live is the trade invoice sync's rule (20261117173001): not ops-reject and
  -- its Xero bill neither DELETED nor VOIDED. Reads a partial index on
  -- trade_invoice_lines.expense_receipt_id (P1-03.1, P2-06.1), then trade_invoices_pkey.
  repaid := r.payment_method IS DISTINCT FROM 'supplier_invoice' AND EXISTS (
    SELECT 1 FROM public.trade_invoice_lines til JOIN public.trade_invoices ti ON ti.id=til.trade_invoice_id
    WHERE til.expense_receipt_id=r.id AND ti.status IS DISTINCT FROM 'ops-reject'
      AND upper(coalesce(ti.xero_bill_status,'')) NOT IN ('DELETED','VOIDED'));

  IF r.payment_method='personal_card' OR repaid THEN
    -- The trade's reimbursement line is the cost; the receipt never counts.
    IF line.id IS NOT NULL AND coalesce(line.not_counted_reason,'') NOT IN ('counted_by_bank_line',
      'duplicate_document','duplicate_of_trade_invoice','counted_by_trade_invoice') THEN
      DELETE FROM public.job_cost_line_parts WHERE line_id=line.id;
      UPDATE public.job_cost_lines SET state=NULL, needs_reason=NULL,
        not_counted_reason='counted_by_trade_invoice', state_changed_at=now(), updated_at=now()
        WHERE id=line.id;
      PERFORM public.job_cost_lines_refollow('expense_receipt',doc_id);
      RETURN jsonb_build_object('ran',true,'outcome','marked_counted_by_trade_invoice');
    END IF;
    RETURN jsonb_build_object('ran',true,'outcome','no_line');
  END IF;

  IF r.payment_method='supplier_invoice' THEN
    -- The supplier will bill. An earlier line stops counting through the one writer,
    -- which keeps a bank-line or other protected line as it is but for source fields.
    IF line.id IS NULL THEN RETURN jsonb_build_object('ran',true,'outcome','no_line'); END IF;
    result := public.job_cost_lines_upsert_documents(jsonb_build_array(doc || jsonb_build_object('live',false)));
    RETURN jsonb_build_object('ran',true,'outcome','document_not_live','result',result);
  END IF;

  -- company_card, cash, unknown (and any value the check does not name yet).
  result := public.job_cost_lines_upsert_documents(jsonb_build_array(doc || jsonb_build_object('live',live)));
  SELECT * INTO line FROM public.job_cost_lines WHERE org_id=r.org_id
    AND document_kind='expense_receipt' AND document_id=doc_id AND line_key='whole' FOR UPDATE;
  -- A line this receipt marked when it was own money counts again once it is company
  -- money; no live trade invoice line pays it back (checked above).
  IF live AND line.not_counted_reason='counted_by_trade_invoice' THEN
    UPDATE public.job_cost_lines SET state='needs_person', needs_reason='new', not_counted_reason=NULL,
      state_changed_at=now(), updated_at=now() WHERE id=line.id;
    line.state := 'needs_person';
  END IF;
  -- The matcher decides the state; this only asks it to look.
  IF line.state IS NOT NULL THEN
    INSERT INTO public.match_queue(subject_kind,subject_id,reason)
      VALUES('cost_document','expense_receipt:'||doc_id,'receipt_saved') ON CONFLICT DO NOTHING;
  END IF;
  RETURN jsonb_build_object('ran',true,'outcome','line','result',result);
END;
$$;

-- Never fails the business write: every shadow write and the deferred conservation
-- checks run in one subtransaction. A failed sync is queued for the drain and warned
-- with its SQLSTATE only.
CREATE FUNCTION public.job_cost_lines_try_receipt(p_receipt_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET lock_timeout='1ms' AS $$
DECLARE result jsonb; failure text; BEGIN
  <<guarded_shadow>> BEGIN
    IF NOT EXISTS(SELECT 1 FROM public.feature_flags WHERE flag_name='job_cost_lines_sync_v1' AND enabled) THEN
      RETURN false; END IF;
    SET CONSTRAINTS public.job_cost_lines_parts_conserve, public.job_cost_line_parts_conserve DEFERRED;
    result := public.job_cost_lines_sync_receipt(p_receipt_id);
    SET CONSTRAINTS public.job_cost_lines_parts_conserve, public.job_cost_line_parts_conserve IMMEDIATE;
    SET CONSTRAINTS public.job_cost_lines_parts_conserve, public.job_cost_line_parts_conserve DEFERRED;
    RETURN coalesce((result->>'ran')::boolean,true);
  EXCEPTION WHEN OTHERS THEN
    failure := SQLSTATE;
  END;
  INSERT INTO public.job_cost_lines_receipt_retries(expense_receipt_id,last_sqlstate)
    VALUES(p_receipt_id,failure);
  RAISE WARNING 'cost line receipt sync queued: SQLSTATE %',failure;
  RETURN false;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'cost line receipt retry unavailable: SQLSTATE %',SQLSTATE;
  RETURN false;
END;
$$;

-- A cron invocation is one transaction and attempts ONE receipt, never a batch.
CREATE FUNCTION public.job_cost_lines_retry_receipt_one()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET lock_timeout='1ms' AS $$
DECLARE item public.job_cost_lines_receipt_retries%ROWTYPE; started timestamptz := clock_timestamp();
  failure text; result jsonb; BEGIN
  IF NOT EXISTS(SELECT 1 FROM public.feature_flags WHERE flag_name='job_cost_lines_sync_v1' AND enabled) THEN
    RETURN jsonb_build_object('ran',false,'reason','flag_off'); END IF;
  IF NOT pg_try_advisory_xact_lock(hashtextextended('job_cost_lines_retry_receipt_one',0)) THEN
    RETURN jsonb_build_object('ran',false,'reason','busy'); END IF;
  -- job_cost_lines_receipt_retries_due_idx: bounded oldest due request.
  SELECT * INTO item FROM public.job_cost_lines_receipt_retries
    WHERE next_attempt_at<=started ORDER BY next_attempt_at,id LIMIT 1;
  IF NOT FOUND THEN RETURN jsonb_build_object('ran',false,'reason','empty'); END IF; BEGIN
    SET CONSTRAINTS public.job_cost_lines_parts_conserve, public.job_cost_line_parts_conserve DEFERRED;
    result := public.job_cost_lines_sync_receipt(item.expense_receipt_id);
    SET CONSTRAINTS public.job_cost_lines_parts_conserve, public.job_cost_line_parts_conserve IMMEDIATE;
    SET CONSTRAINTS public.job_cost_lines_parts_conserve, public.job_cost_line_parts_conserve DEFERRED;
  EXCEPTION WHEN OTHERS THEN
    failure := SQLSTATE;
  END;
  IF failure IS NOT NULL THEN
    UPDATE public.job_cost_lines_receipt_retries SET attempts=attempts+1,last_sqlstate=failure,
      next_attempt_at=started+make_interval(secs=>least(3600,60*power(2,least(attempts,6)))::int)
      WHERE id=item.id;
  ELSE
    DELETE FROM public.job_cost_lines_receipt_retries WHERE id=item.id;
  END IF;
  -- Fold redundant requests for the same receipt after the attempt, at most 100 rows,
  -- on job_cost_lines_receipt_retries_receipt_idx. Requests made during it stay queued.
  DELETE FROM public.job_cost_lines_receipt_retries WHERE id IN (
    SELECT id FROM public.job_cost_lines_receipt_retries WHERE expense_receipt_id=item.expense_receipt_id
      AND requested_at<started AND id<>item.id ORDER BY requested_at,id LIMIT 100);
  RETURN jsonb_build_object('ran',true,'success',failure IS NULL,'sqlstate',failure);
END;
$$;

CREATE FUNCTION public.job_cost_lines_receipt_row()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$ BEGIN
  PERFORM public.job_cost_lines_try_receipt(NEW.id);
  RETURN NULL;
END;
$$;

-- A reimbursement line linked, unlinked or moved: re-sync the receipts on both sides.
-- Each trigger's WHEN clause means a line with no receipt never calls this.
CREATE FUNCTION public.job_cost_lines_receipt_link_row()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$ BEGIN
  IF TG_OP IN ('UPDATE','DELETE') AND OLD.expense_receipt_id IS NOT NULL THEN
    PERFORM public.job_cost_lines_try_receipt(OLD.expense_receipt_id);
  END IF;
  IF TG_OP='INSERT' THEN
    PERFORM public.job_cost_lines_try_receipt(NEW.expense_receipt_id);
  ELSIF TG_OP='UPDATE' AND NEW.expense_receipt_id IS NOT NULL
    AND NEW.expense_receipt_id IS DISTINCT FROM OLD.expense_receipt_id THEN
    PERFORM public.job_cost_lines_try_receipt(NEW.expense_receipt_id);
  END IF;
  RETURN NULL;
END;
$$;

-- A trade invoice's status or Xero bill status changed: whether it pays a receipt back
-- may have changed, so re-sync every receipt its lines pay back. The lookup reads
-- idx_inv_lines_invoice (trade_invoice_id); a failed lookup is warned, never raised.
CREATE FUNCTION public.job_cost_lines_receipt_invoice_row()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE receipt_id uuid; BEGIN
  <<linked_receipts>> BEGIN
    FOR receipt_id IN SELECT DISTINCT l.expense_receipt_id FROM public.trade_invoice_lines l
      WHERE l.trade_invoice_id=NEW.id AND l.expense_receipt_id IS NOT NULL ORDER BY 1 LOOP
      PERFORM public.job_cost_lines_try_receipt(receipt_id);
    END LOOP;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'cost line receipt re-sync skipped: SQLSTATE %',SQLSTATE;
  END;
  RETURN NULL;
END;
$$;

-- Installed only by the director after the shadow proof. A merge installs no business
-- trigger and no schedule.
CREATE FUNCTION public.job_cost_lines_install_receipt_trigger()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$ BEGIN
  IF to_regclass('cron.job') IS NOT NULL THEN
    PERFORM cron.schedule('job-cost-lines-receipt-retry','* * * * *',
      'SELECT public.job_cost_lines_retry_receipt_one()');
  ELSE
    RAISE WARNING 'cost line receipt retry requires pg_cron before live installation';
  END IF;
  DROP TRIGGER IF EXISTS job_cost_lines_receipt_sync ON public.expense_receipts;
  CREATE TRIGGER job_cost_lines_receipt_sync AFTER INSERT OR UPDATE OF job_id, stock_division,
    payment_method, total_amount, gst_amount, status, receipt_date, vendor_name
    ON public.expense_receipts FOR EACH ROW EXECUTE FUNCTION public.job_cost_lines_receipt_row();
  DROP TRIGGER IF EXISTS job_cost_lines_receipt_link_insert ON public.trade_invoice_lines;
  CREATE TRIGGER job_cost_lines_receipt_link_insert AFTER INSERT ON public.trade_invoice_lines
    FOR EACH ROW WHEN (NEW.expense_receipt_id IS NOT NULL)
    EXECUTE FUNCTION public.job_cost_lines_receipt_link_row();
  DROP TRIGGER IF EXISTS job_cost_lines_receipt_link_update ON public.trade_invoice_lines;
  CREATE TRIGGER job_cost_lines_receipt_link_update AFTER UPDATE OF expense_receipt_id, trade_invoice_id
    ON public.trade_invoice_lines FOR EACH ROW
    WHEN (OLD.expense_receipt_id IS DISTINCT FROM NEW.expense_receipt_id
      OR (NEW.expense_receipt_id IS NOT NULL AND OLD.trade_invoice_id IS DISTINCT FROM NEW.trade_invoice_id))
    EXECUTE FUNCTION public.job_cost_lines_receipt_link_row();
  DROP TRIGGER IF EXISTS job_cost_lines_receipt_link_delete ON public.trade_invoice_lines;
  CREATE TRIGGER job_cost_lines_receipt_link_delete AFTER DELETE ON public.trade_invoice_lines
    FOR EACH ROW WHEN (OLD.expense_receipt_id IS NOT NULL)
    EXECUTE FUNCTION public.job_cost_lines_receipt_link_row();
  DROP TRIGGER IF EXISTS job_cost_lines_receipt_invoice_update ON public.trade_invoices;
  CREATE TRIGGER job_cost_lines_receipt_invoice_update AFTER UPDATE OF status, xero_bill_status
    ON public.trade_invoices FOR EACH ROW
    WHEN (OLD.status IS DISTINCT FROM NEW.status OR OLD.xero_bill_status IS DISTINCT FROM NEW.xero_bill_status)
    EXECUTE FUNCTION public.job_cost_lines_receipt_invoice_row();
END;
$$;
CREATE FUNCTION public.job_cost_lines_remove_receipt_trigger()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE job bigint; BEGIN
  IF to_regclass('cron.job') IS NOT NULL THEN
    FOR job IN SELECT jobid FROM cron.job WHERE jobname='job-cost-lines-receipt-retry' LOOP
      PERFORM cron.unschedule(job); END LOOP;
  END IF;
  DROP TRIGGER IF EXISTS job_cost_lines_receipt_sync ON public.expense_receipts;
  DROP TRIGGER IF EXISTS job_cost_lines_receipt_link_insert ON public.trade_invoice_lines;
  DROP TRIGGER IF EXISTS job_cost_lines_receipt_link_update ON public.trade_invoice_lines;
  DROP TRIGGER IF EXISTS job_cost_lines_receipt_link_delete ON public.trade_invoice_lines;
  DROP TRIGGER IF EXISTS job_cost_lines_receipt_invoice_update ON public.trade_invoices;
END;
$$;

REVOKE ALL ON FUNCTION public.job_cost_lines_sync_receipt(uuid), public.job_cost_lines_try_receipt(uuid),
  public.job_cost_lines_retry_receipt_one(), public.job_cost_lines_receipt_row(),
  public.job_cost_lines_receipt_link_row(), public.job_cost_lines_receipt_invoice_row(),
  public.job_cost_lines_install_receipt_trigger(),
  public.job_cost_lines_remove_receipt_trigger() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.job_cost_lines_sync_receipt(uuid), public.job_cost_lines_try_receipt(uuid),
  public.job_cost_lines_retry_receipt_one(), public.job_cost_lines_receipt_row(),
  public.job_cost_lines_receipt_link_row(), public.job_cost_lines_receipt_invoice_row(),
  public.job_cost_lines_install_receipt_trigger(),
  public.job_cost_lines_remove_receipt_trigger() TO service_role;
