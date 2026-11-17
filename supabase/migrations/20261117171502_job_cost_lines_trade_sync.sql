-- P2-01.4: source events and allocations commit together, shadow switch off by default.
CREATE OR REPLACE FUNCTION public.job_cost_lines_sync_trade_invoice(p_trade_invoice_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE ti public.trade_invoices%ROWTYPE; rows jsonb; lines jsonb := '[]'; j jsonb;
  parent public.job_cost_lines%ROWTYPE; result jsonb; live boolean; employer numeric;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.feature_flags WHERE flag_name='job_cost_lines_sync_v1' AND enabled) THEN
    RETURN jsonb_build_object('ran',false,'reason','flag_off'); END IF;
  SELECT * INTO ti FROM public.trade_invoices WHERE id=p_trade_invoice_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ran',false,'reason','invoice_missing'); END IF;
  live := ti.status IS DISTINCT FROM 'ops-reject' AND upper(coalesce(ti.xero_bill_status,'')) NOT IN ('DELETED','VOIDED');
  -- Port of trade_bill_xline/tline/p1/line in the legacy cost view: exact tracking association.
  WITH trade_bill_xline AS (
         SELECT tinv.id AS trade_invoice_id,
            li.n,
            round(
                CASE
                    WHEN (x.raw_json ->> 'LineAmountTypes'::text) = 'Inclusive'::text THEN COALESCE(public.job_profit_num(li.value -> 'LineAmount'::text), 0::numeric) - COALESCE(public.job_profit_num(li.value -> 'TaxAmount'::text), 0::numeric)
                    ELSE COALESCE(public.job_profit_num(li.value -> 'LineAmount'::text), 0::numeric)
                END, 2) AS amount_ex,
            public.job_cost_crew_bill_line_job_number(li.value ->> 'Description'::text) AS job_number,
            public.job_cost_line_business_unit(li.value) AS business_unit
           FROM public.trade_invoices tinv
             JOIN public.xero_invoices x ON x.xero_invoice_id = tinv.xero_bill_id AND x.invoice_type = 'ACCPAY'::text AND (x.status = ANY (ARRAY['AUTHORISED'::text, 'PAID'::text]))
             CROSS JOIN LATERAL jsonb_array_elements(
                CASE
                    WHEN jsonb_typeof(x.line_items) = 'array'::text THEN x.line_items
                    ELSE '[]'::jsonb
                END) WITH ORDINALITY li(value, n)
          WHERE tinv.id = p_trade_invoice_id AND NOT public.job_cost_super_withheld_line(li.value)
        ), trade_bill_tline AS (
         SELECT l.id AS line_id,
            l.trade_invoice_id,
            l.created_at,
            round(l.line_total_ex, 2) AS amount_ex,
            upper(NULLIF(btrim(l.job_number), ''::text)) AS job_number
           FROM public.trade_invoice_lines l
          WHERE l.trade_invoice_id = p_trade_invoice_id AND (EXISTS ( SELECT 1
                   FROM public.trade_invoices tinv
                  WHERE tinv.id = l.trade_invoice_id AND tinv.xero_bill_id IS NOT NULL))
        ), trade_bill_p1 AS (
         SELECT t.line_id,
            x.trade_invoice_id,
            x.n,
            x.business_unit
           FROM ( SELECT tl.line_id,
                    tl.trade_invoice_id,
                    tl.amount_ex,
                    tl.job_number,
                    row_number() OVER (PARTITION BY tl.trade_invoice_id, tl.amount_ex, tl.job_number ORDER BY tl.created_at, tl.line_id) AS k
                   FROM trade_bill_tline tl
                  WHERE tl.job_number IS NOT NULL) t
             JOIN ( SELECT xl.trade_invoice_id,
                    xl.n,
                    xl.amount_ex,
                    xl.job_number,
                    xl.business_unit,
                    row_number() OVER (PARTITION BY xl.trade_invoice_id, xl.amount_ex, xl.job_number ORDER BY xl.n) AS k
                   FROM trade_bill_xline xl
                  WHERE xl.job_number IS NOT NULL) x ON x.trade_invoice_id = t.trade_invoice_id AND x.amount_ex = t.amount_ex AND x.job_number = t.job_number AND x.k = t.k
        ), trade_bill_line AS (
         SELECT p1.line_id,
            p1.business_unit
           FROM trade_bill_p1 p1
        UNION ALL
         SELECT t.line_id,
            x.business_unit
           FROM ( SELECT tl.line_id,
                    tl.trade_invoice_id,
                    tl.amount_ex,
                    row_number() OVER (PARTITION BY tl.trade_invoice_id, tl.amount_ex ORDER BY tl.created_at, tl.line_id) AS k
                   FROM trade_bill_tline tl
                  WHERE NOT (EXISTS ( SELECT 1
                           FROM trade_bill_p1 p
                          WHERE p.line_id = tl.line_id))) t
             JOIN ( SELECT xl.trade_invoice_id,
                    xl.n,
                    xl.amount_ex,
                    xl.business_unit,
                    row_number() OVER (PARTITION BY xl.trade_invoice_id, xl.amount_ex ORDER BY xl.n) AS k
                   FROM trade_bill_xline xl
                  WHERE NOT (EXISTS ( SELECT 1
                           FROM trade_bill_p1 p
                          WHERE p.trade_invoice_id = xl.trade_invoice_id AND p.n = xl.n))) x ON x.trade_invoice_id = t.trade_invoice_id AND x.amount_ex = t.amount_ex AND x.k = t.k
        ), source_rows AS (
    SELECT r.*, tbl.business_unit, coalesce(c.zero_line OR c.mismatch,false) AS incomplete_invoice
    FROM public.v_trade_charge_resolved r
    LEFT JOIN trade_bill_line tbl ON tbl.line_id=r.line_id
    LEFT JOIN public.v_invoice_line_completeness c ON c.trade_invoice_id=r.trade_invoice_id
    WHERE r.trade_invoice_id=p_trade_invoice_id AND NOT r.is_probable_test_line
  ) SELECT coalesce(jsonb_agg(to_jsonb(source_rows) ORDER BY line_id),'[]') INTO rows FROM source_rows;
  FOR j IN SELECT value FROM jsonb_array_elements(rows) LOOP
    lines := lines || jsonb_build_array(jsonb_build_object(
      'line_key',j->>'line_id','line_no',jsonb_array_length(lines)+1,
      'kind',CASE WHEN j->>'line_type'='group share' THEN 'group_share'
        WHEN j->>'cost_lane'='commission' THEN 'commission'
        WHEN j->>'line_type'='reimbursement' THEN 'reimbursement' ELSE 'trade_line' END,
      'amount_ex',j->'line_total_ex','lane',CASE WHEN j->>'cost_lane'='unclassified' THEN 'other' ELSE j->>'cost_lane' END,
      'description',j->>'description','event_lane_detail',j->>'cost_lane',
      'event_source','trade_line','event_source_id',j->>'line_id','event_match_method',j->>'match_method',
      'event_confidence',CASE j->>'match_method' WHEN 'job_id' THEN 'high' WHEN 'line_job_number' THEN 'medium' ELSE 'low' END,
      'is_actual',j->>'cost_lane'<>'advance' AND ti.status<>'draft','hours',j->'total_hours',
      'paid',ti.status='paid' OR upper(coalesce(ti.xero_bill_status,''))='PAID','paid_on',ti.paid_at::date,
      'business_unit',j->>'business_unit','incomplete_invoice',j->'incomplete_invoice'));
    employer := ti.super_amount - (ti.subtotal_ex-ti.net_pay);
    IF employer>0.005 AND ti.subtotal_ex>0 AND (j->>'line_total_ex')::numeric<>0
      AND EXISTS (SELECT 1 FROM public.feature_flags WHERE flag_name='job_cost_employer_super_v1' AND enabled) THEN
      lines := lines || jsonb_build_array((lines->(jsonb_array_length(lines)-1)) || jsonb_build_object(
        'kind','employer_super','line_key',(j->>'line_id')||':employer_super',
        'follows_line_key',j->>'line_id','amount_ex',round((j->>'line_total_ex')::numeric*employer/ti.subtotal_ex,2),
        'event_source','trade_employer_super','event_source_id',(j->>'line_id')||':employer_super',
        'event_lane_detail','employer_super','paid',false,'paid_on',NULL,'hours',NULL,
        'description','Employer super on: '||coalesce(j->>'description','')));
    END IF;
  END LOOP;
  result := public.job_cost_lines_upsert_documents(jsonb_build_array(jsonb_build_object(
    'org_id',ti.org_id,'document_kind','trade_invoice','document_id',ti.id::text,
    'document_number',ti.invoice_number,'document_date',ti.week_start,'document_status',ti.status,
    'live',live,'party_kind','trade','party_id',ti.user_id::text,'lines',lines)));
  FOR j IN SELECT value FROM jsonb_array_elements(rows) LOOP
    SELECT * INTO parent FROM public.job_cost_lines WHERE org_id=ti.org_id
      AND document_kind='trade_invoice' AND document_id=ti.id::text AND line_key=j->>'line_id' FOR UPDATE;
    -- Do not revive a rejection or an excluded duplicate, or disturb a person's decision.
    IF parent.state IS NULL OR parent.decided_by_kind='person' THEN CONTINUE; END IF;
    IF j->>'resolved_job_id' IS NOT NULL THEN
      PERFORM public.job_cost_lines_set_state(parent.id,'on_job',jsonb_build_array(jsonb_build_object(
        'target','job','job_id',j->>'resolved_job_id','amount_ex',parent.amount_ex)),'source',NULL,NULL);
    ELSE
      PERFORM public.job_cost_lines_set_state(parent.id,'needs_person','[]','source',NULL,'trade_line_no_job');
    END IF;
  END LOOP;
  PERFORM public.job_cost_lines_refollow('trade_invoice',ti.id::text);
  RETURN result;
END;
$$;
REVOKE ALL ON FUNCTION public.job_cost_lines_sync_trade_invoice(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.job_cost_lines_sync_trade_invoice(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.job_cost_lines_trade_statement()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE invoice_id uuid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.feature_flags WHERE flag_name='job_cost_lines_sync_v1' AND enabled) THEN RETURN NULL; END IF;
  IF TG_OP='INSERT' THEN
    FOR invoice_id IN SELECT DISTINCT trade_invoice_id FROM new_lines ORDER BY trade_invoice_id LOOP
      PERFORM public.job_cost_lines_sync_trade_invoice(invoice_id); END LOOP;
  ELSIF TG_OP='DELETE' THEN
    FOR invoice_id IN SELECT DISTINCT trade_invoice_id FROM old_lines ORDER BY trade_invoice_id LOOP
      PERFORM public.job_cost_lines_sync_trade_invoice(invoice_id); END LOOP;
  ELSE
    FOR invoice_id IN SELECT trade_invoice_id FROM new_lines UNION SELECT trade_invoice_id FROM old_lines ORDER BY trade_invoice_id LOOP
      PERFORM public.job_cost_lines_sync_trade_invoice(invoice_id); END LOOP;
  END IF;
  RETURN NULL;
END;
$$;
CREATE OR REPLACE FUNCTION public.job_cost_lines_trade_invoice_row()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM public.job_cost_lines_sync_trade_invoice(NEW.id);
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.job_cost_lines_trade_statement(),public.job_cost_lines_trade_invoice_row() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.job_cost_lines_trade_statement(),public.job_cost_lines_trade_invoice_row() TO service_role;
DROP TRIGGER IF EXISTS job_cost_lines_trade_insert ON public.trade_invoice_lines;
CREATE TRIGGER job_cost_lines_trade_insert AFTER INSERT ON public.trade_invoice_lines
  REFERENCING NEW TABLE AS new_lines FOR EACH STATEMENT EXECUTE FUNCTION public.job_cost_lines_trade_statement();
DROP TRIGGER IF EXISTS job_cost_lines_trade_update ON public.trade_invoice_lines;
CREATE TRIGGER job_cost_lines_trade_update AFTER UPDATE ON public.trade_invoice_lines
  REFERENCING OLD TABLE AS old_lines NEW TABLE AS new_lines FOR EACH STATEMENT EXECUTE FUNCTION public.job_cost_lines_trade_statement();
DROP TRIGGER IF EXISTS job_cost_lines_trade_delete ON public.trade_invoice_lines;
CREATE TRIGGER job_cost_lines_trade_delete AFTER DELETE ON public.trade_invoice_lines
  REFERENCING OLD TABLE AS old_lines FOR EACH STATEMENT EXECUTE FUNCTION public.job_cost_lines_trade_statement();
DROP TRIGGER IF EXISTS job_cost_lines_trade_invoice_update ON public.trade_invoices;
CREATE TRIGGER job_cost_lines_trade_invoice_update AFTER UPDATE OF status,xero_bill_status,xero_bill_id,super_amount,net_pay,subtotal_ex
  ON public.trade_invoices FOR EACH ROW EXECUTE FUNCTION public.job_cost_lines_trade_invoice_row();
