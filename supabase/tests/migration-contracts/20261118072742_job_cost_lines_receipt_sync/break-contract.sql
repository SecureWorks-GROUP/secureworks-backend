-- The real sync with its own-money and supplier-account branches removed.
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
      'kind','receipt','line_key','whole','line_no',1,
      'amount_ex',r.total_amount - coalesce(r.gst_amount,0),'gst',r.gst_amount,
      'lane',CASE WHEN r.category IN ('materials','tools','consumables') THEN 'materials' ELSE 'other' END,
      'event_source','receipt')));
  -- job_cost_lines (org_id, document_kind, document_id, line_key) unique key.
  SELECT * INTO line FROM public.job_cost_lines WHERE org_id=r.org_id
    AND document_kind='expense_receipt' AND document_id=doc_id AND line_key='whole' FOR UPDATE;

  -- company_card, cash, unknown (and any value the check does not name yet).
  result := public.job_cost_lines_upsert_documents(jsonb_build_array(doc || jsonb_build_object('live',live)));
  SELECT * INTO line FROM public.job_cost_lines WHERE org_id=r.org_id
    AND document_kind='expense_receipt' AND document_id=doc_id AND line_key='whole' FOR UPDATE;
  -- A line this receipt marked when it was own money counts again once it is company
  -- money, unless a trade invoice line still pays the receipt back
  -- (trade_invoice_lines_one_receipt index; trade_invoices primary key).
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
