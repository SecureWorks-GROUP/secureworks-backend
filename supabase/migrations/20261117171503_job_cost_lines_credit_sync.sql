-- P2-01.5: negative credit allocations follow bill allocations in this transaction.
CREATE OR REPLACE FUNCTION public.job_cost_lines_sync_credit_notes(p_credit_note_ids text[])
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE note public.xero_supplier_credit_notes%ROWTYPE; a record; lines jsonb; bills jsonb := '[]';
  touched record; d jsonb; results jsonb := '[]'; is_live boolean; amount numeric;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.feature_flags WHERE flag_name='job_cost_lines_sync_v1' AND enabled) THEN
    RETURN jsonb_build_object('ran',false,'reason','flag_off'); END IF;
  FOR note IN SELECT * FROM public.xero_supplier_credit_notes
    WHERE xero_credit_note_id=ANY(p_credit_note_ids) ORDER BY org_id,xero_credit_note_id COLLATE "C" FOR UPDATE
  LOOP
    lines := '[]';
    is_live := coalesce(note.status IN ('AUTHORISED','PAID'),false);
    FOR a IN SELECT * FROM public.xero_supplier_credit_note_allocations
      WHERE org_id=note.org_id AND xero_credit_note_id=note.xero_credit_note_id
        AND NOT is_deleted AND xero_invoice_id IS NOT NULL ORDER BY n
    LOOP
      -- Same credit-note own subtotal/total ratio as job_cost_credit_ex. A missing
      -- note ratio falls back to the bill's, scoped to this organisation.
      SELECT -round(coalesce(
        CASE WHEN note.total>0 AND note.sub_total IS NOT NULL THEN a.amount*note.sub_total/note.total END,
        (SELECT a.amount*x.sub_total/x.total FROM public.xero_invoices x
          WHERE x.org_id=note.org_id AND x.xero_invoice_id=a.xero_invoice_id
            AND x.invoice_type='ACCPAY' AND x.total>0 AND x.sub_total IS NOT NULL)),2) INTO amount;
      lines := lines || jsonb_build_array(jsonb_build_object('kind','supplier_credit','line_key','alloc:'||a.n,
        'line_no',a.n,'amount_ex',amount,'lane','materials','event_lane_detail','materials',
        'event_source','supplier_credit','event_match_method','xero_credit_note',
        'event_source_id',note.xero_credit_note_id||':alloc:'||a.n,
        'follows_document_kind','xero_bill','follows_document_id',a.xero_invoice_id));
      bills := bills || jsonb_build_array(jsonb_build_object('id',a.xero_invoice_id,'org_id',note.org_id));
    END LOOP;
    IF note.remaining_credit>0 THEN
      lines := lines || jsonb_build_array(jsonb_build_object('kind','supplier_credit','line_key','unallocated',
        'amount_ex',CASE WHEN note.total>0 THEN -round(note.remaining_credit*note.sub_total/note.total,2) END,
        'lane','materials','event_lane_detail','materials','event_source','supplier_credit',
        'event_source_id',note.xero_credit_note_id||':unallocated','event_match_method','xero_credit_note'));
    END IF;
    d := jsonb_build_object('org_id',note.org_id,'document_kind','xero_credit_note',
      'document_id',note.xero_credit_note_id,'document_number',note.credit_note_number,
      'document_date',note.credit_note_date,'document_status',note.status,'live',is_live,
      'party_kind','supplier','party_id',note.xero_contact_id,'party_name',note.contact_name,'lines',lines);
    results := results || jsonb_build_array(public.job_cost_lines_upsert_documents(jsonb_build_array(d)));
    IF is_live THEN
      FOR touched IN SELECT id FROM public.job_cost_lines WHERE org_id=note.org_id
        AND document_kind='xero_credit_note' AND document_id=note.xero_credit_note_id AND line_key='unallocated'
        AND state IS NOT NULL AND decided_by_kind IS DISTINCT FROM 'person'
      LOOP
        PERFORM public.job_cost_lines_set_state(touched.id,'needs_person','[]','source',NULL,'credit_not_allocated');
      END LOOP;
    END IF;
  END LOOP;
  FOR touched IN SELECT DISTINCT b->>'id' AS id FROM jsonb_array_elements(bills) v(b) LOOP
    PERFORM public.job_cost_lines_refollow('xero_bill',touched.id);
  END LOOP;
  RETURN jsonb_build_object('ran',true,'results',results);
END;
$$;
REVOKE ALL ON FUNCTION public.job_cost_lines_sync_credit_notes(text[]) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.job_cost_lines_sync_credit_notes(text[]) TO service_role;
