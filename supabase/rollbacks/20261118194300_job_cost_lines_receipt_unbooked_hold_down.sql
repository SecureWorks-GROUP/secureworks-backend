-- Rollback of cl-receipt-ownjob 2: puts back the 20261118115701 body exactly.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $guard$
/* block */ BEGIN
  IF (SELECT md5(p.prosrc) FROM pg_proc p WHERE p.oid = to_regprocedure('public.job_cost_lines_sync_receipt(uuid)'))
     IS DISTINCT FROM '3e00033f8038b71d1748aa8ef12f9753'
     AND (SELECT md5(p.prosrc) FROM pg_proc p WHERE p.oid = to_regprocedure('public.job_cost_lines_sync_receipt(uuid)'))
     IS DISTINCT FROM 'c499c1e901175e363c3ad018a4b190c8' THEN
    RAISE EXCEPTION 'job_cost_lines_sync_receipt rollback: another body is installed; refusing to replace it';
  END IF;
END;
$guard$;

CREATE OR REPLACE FUNCTION public.job_cost_lines_sync_receipt(p_receipt_id uuid)
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

REVOKE ALL ON FUNCTION public.job_cost_lines_sync_receipt(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.job_cost_lines_sync_receipt(uuid) TO service_role;
