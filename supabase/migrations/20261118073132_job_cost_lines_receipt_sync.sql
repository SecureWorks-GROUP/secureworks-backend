-- P2-06.2: a company card, cash or unknown receipt is a shadow cost line; own-money
-- and supplier-account receipts never are. Creates functions only: no trigger is
-- installed and no switch changes on apply. The director runs
-- job_cost_lines_install_receipt_trigger() after the shadow proof on a ZZTEST receipt.

CREATE OR REPLACE FUNCTION public.job_cost_lines_sync_receipt(p_receipt_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.expense_receipts%ROWTYPE; line public.job_cost_lines%ROWTYPE; doc jsonb;
  live boolean; result jsonb; doc_id text; BEGIN
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

  IF r.payment_method='personal_card' THEN
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
  -- money, unless a trade invoice line still pays the receipt back
  -- (the unique partial index on trade_invoice_lines.expense_receipt_id from P2-06.1;
  -- trade_invoices primary key).
  IF live AND line.not_counted_reason='counted_by_trade_invoice' AND NOT EXISTS (
    SELECT 1 FROM public.trade_invoice_lines til JOIN public.trade_invoices ti ON ti.id=til.trade_invoice_id
    WHERE til.expense_receipt_id=r.id AND ti.status IS DISTINCT FROM 'ops-reject') THEN
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

-- Never fails the receipt write: every shadow write and the deferred conservation
-- checks run in this one subtransaction. A failed sync is warned and not retried.
CREATE OR REPLACE FUNCTION public.job_cost_lines_try_receipt(p_receipt_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET lock_timeout='1ms' AS $$
DECLARE result jsonb; BEGIN
  <<guarded_shadow>> BEGIN
    IF NOT EXISTS(SELECT 1 FROM public.feature_flags WHERE flag_name='job_cost_lines_sync_v1' AND enabled) THEN
      RETURN false; END IF;
    SET CONSTRAINTS public.job_cost_lines_parts_conserve, public.job_cost_line_parts_conserve DEFERRED;
    result := public.job_cost_lines_sync_receipt(p_receipt_id);
    SET CONSTRAINTS public.job_cost_lines_parts_conserve, public.job_cost_line_parts_conserve IMMEDIATE;
    SET CONSTRAINTS public.job_cost_lines_parts_conserve, public.job_cost_line_parts_conserve DEFERRED;
    RETURN coalesce((result->>'ran')::boolean,true);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'cost line receipt sync skipped: SQLSTATE %',SQLSTATE;
    RETURN false;
  END;
END;
$$;

CREATE OR REPLACE FUNCTION public.job_cost_lines_receipt_row()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$ BEGIN
  PERFORM public.job_cost_lines_try_receipt(NEW.id);
  RETURN NULL;
END;
$$;

-- Installed only by the director after the shadow proof. A merge installs no business trigger.
CREATE OR REPLACE FUNCTION public.job_cost_lines_install_receipt_trigger()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$ BEGIN
  DROP TRIGGER IF EXISTS job_cost_lines_receipt_sync ON public.expense_receipts;
  CREATE TRIGGER job_cost_lines_receipt_sync AFTER INSERT OR UPDATE OF job_id, stock_division,
    payment_method, total_amount, gst_amount, status, receipt_date, vendor_name
    ON public.expense_receipts FOR EACH ROW EXECUTE FUNCTION public.job_cost_lines_receipt_row();
END;
$$;
CREATE OR REPLACE FUNCTION public.job_cost_lines_remove_receipt_trigger()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$ BEGIN
  DROP TRIGGER IF EXISTS job_cost_lines_receipt_sync ON public.expense_receipts;
END;
$$;

REVOKE ALL ON FUNCTION public.job_cost_lines_sync_receipt(uuid), public.job_cost_lines_try_receipt(uuid),
  public.job_cost_lines_receipt_row(), public.job_cost_lines_install_receipt_trigger(),
  public.job_cost_lines_remove_receipt_trigger() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.job_cost_lines_sync_receipt(uuid), public.job_cost_lines_try_receipt(uuid),
  public.job_cost_lines_receipt_row(), public.job_cost_lines_install_receipt_trigger(),
  public.job_cost_lines_remove_receipt_trigger() TO service_role;
