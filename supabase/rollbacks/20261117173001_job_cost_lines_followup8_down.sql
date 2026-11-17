DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM public.job_cost_lines_shadow_retries LIMIT 1) THEN
   RAISE EXCEPTION 'cost_line_shadow_retries_not_empty'; END IF;
END $$;
SELECT public.job_cost_lines_remove_trade_triggers();
-- P2-01.2: one transactional writer for shadow cost lines and their parts.
CREATE OR REPLACE FUNCTION public.job_cost_lines_set_state(
  p_line_id uuid, p_state text, p_parts jsonb, p_decided_by_kind text,
  p_decision_id bigint, p_needs_reason text
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE l public.job_cost_lines%ROWTYPE;
BEGIN
  SELECT * INTO STRICT l FROM public.job_cost_lines WHERE id = p_line_id FOR UPDATE;
  IF l.decided_by_kind = 'person' AND p_decided_by_kind IS DISTINCT FROM 'person' THEN
    RAISE EXCEPTION 'cost_line_person_decided';
  END IF;
  DELETE FROM public.job_cost_line_parts WHERE line_id = p_line_id;
  INSERT INTO public.job_cost_line_parts(line_id, part_no, target, job_id, division, lane, amount_ex)
    SELECT p_line_id, n::int, p->>'target', (p->>'job_id')::uuid,
      p->>'division', coalesce(p->>'lane', l.lane), (p->>'amount_ex')::numeric
    FROM jsonb_array_elements(coalesce(p_parts, '[]')) WITH ORDINALITY a(p,n);
  UPDATE public.job_cost_lines SET state = p_state, needs_reason = p_needs_reason,
    not_counted_reason = CASE WHEN p_state IS NULL THEN not_counted_reason ELSE NULL END,
    decided_by_kind = p_decided_by_kind, decision_id = p_decision_id,
    state_changed_at = now(), updated_at = now() WHERE id = p_line_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.job_cost_lines_upsert_documents(p_docs jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  d jsonb; j jsonb; h text; live boolean; old public.job_cost_lines%ROWTYPE;
  source public.job_cost_lines%ROWTYPE; line_id uuid; n int := 0; written int := 0;
  changed jsonb := '[]'; doc_changed boolean; protected boolean; part_count int;
BEGIN
  FOR d IN SELECT value FROM jsonb_array_elements(p_docs) LOOP
    -- Serialize whole-document replacement, including documents not stored yet.
    PERFORM pg_advisory_xact_lock(hashtextextended(
      (d->>'org_id') || ':' || (d->>'document_kind') || ':' || (d->>'document_id'), 0));
    n := n + 1; doc_changed := false; live := (d->>'live')::boolean;
    FOR j IN SELECT value FROM jsonb_array_elements(d->'lines') LOOP
      h := md5(j::text || coalesce(d->>'document_status','') || live::text);
      SELECT * INTO old FROM public.job_cost_lines l WHERE l.org_id = (d->>'org_id')::uuid
        AND l.document_kind = d->>'document_kind' AND l.document_id = d->>'document_id'
        AND l.line_key = j->>'line_key' FOR UPDATE;
      IF FOUND AND old.source_hash = h THEN CONTINUE; END IF;
      -- Populate only the source-owned columns. Decision and coverage fields are never inputs.
      source := jsonb_populate_record(NULL::public.job_cost_lines, j || jsonb_build_object(
        'org_id', d->>'org_id', 'document_kind', d->>'document_kind', 'document_id', d->>'document_id',
        'document_number', d->>'document_number', 'document_date', d->>'document_date',
        'document_status', d->>'document_status', 'party_kind', d->>'party_kind',
        'party_id', d->>'party_id', 'party_name', d->>'party_name', 'source_hash', h));
      IF old.id IS NULL THEN
        INSERT INTO public.job_cost_lines(org_id, document_kind, document_id, line_key,
          document_number, document_date, document_status, party_kind, party_id, party_name,
          line_no, kind, description, account_code, xero_tracking_option, lane, amount_ex, gst,
          paid, paid_on, is_actual, hours, business_unit, incomplete_invoice, event_source,
          event_source_id, event_match_method, event_confidence, event_lane_detail,
          follows_document_kind, follows_document_id, source_hash, state, needs_reason, not_counted_reason)
        VALUES (source.org_id, source.document_kind, source.document_id, source.line_key,
          source.document_number, source.document_date, source.document_status, source.party_kind,
          source.party_id, source.party_name, source.line_no, source.kind, source.description,
          source.account_code, source.xero_tracking_option, source.lane, source.amount_ex, source.gst,
          source.paid, source.paid_on, coalesce(source.is_actual,true), source.hours, source.business_unit,
          coalesce(source.incomplete_invoice,false), source.event_source, source.event_source_id,
          source.event_match_method, source.event_confidence, source.event_lane_detail,
          source.follows_document_kind, source.follows_document_id, h,
          CASE WHEN live THEN 'needs_person' END, CASE WHEN live THEN 'new' END,
          CASE WHEN NOT live THEN 'document_not_live' END) RETURNING id INTO line_id;
      ELSE
        line_id := old.id;
        UPDATE public.job_cost_lines SET document_number = source.document_number,
          document_date = source.document_date, document_status = source.document_status,
          party_kind = source.party_kind, party_id = source.party_id, party_name = source.party_name,
          line_no = source.line_no, kind = source.kind, description = source.description,
          account_code = source.account_code, xero_tracking_option = source.xero_tracking_option,
          lane = source.lane, amount_ex = source.amount_ex, gst = source.gst, paid = source.paid,
          paid_on = source.paid_on, is_actual = coalesce(source.is_actual,true), hours = source.hours,
          business_unit = source.business_unit, incomplete_invoice = coalesce(source.incomplete_invoice,false),
          event_source = source.event_source, event_source_id = source.event_source_id,
          event_match_method = source.event_match_method, event_confidence = source.event_confidence,
          event_lane_detail = source.event_lane_detail, follows_document_kind = source.follows_document_kind,
          follows_document_id = source.follows_document_id, source_hash = h, updated_at = now()
          WHERE id = line_id;
        protected := old.not_counted_reason IN ('duplicate_document','duplicate_of_trade_invoice',
          'counted_by_bank_line','counted_by_trade_invoice');
        IF coalesce(protected,false) THEN
          NULL;
        ELSIF NOT live THEN
          DELETE FROM public.job_cost_line_parts WHERE job_cost_line_parts.line_id = old.id;
          UPDATE public.job_cost_lines SET state = NULL, needs_reason = NULL,
            not_counted_reason = 'document_not_live', state_changed_at = now() WHERE id = old.id;
        ELSIF old.not_counted_reason = 'document_not_live' THEN
          UPDATE public.job_cost_lines SET state = 'needs_person', needs_reason = 'new',
            not_counted_reason = NULL, state_changed_at = now() WHERE id = old.id;
        ELSIF old.amount_ex IS DISTINCT FROM source.amount_ex THEN
          IF old.decided_by_kind = 'person' OR old.state = 'split' THEN
            DELETE FROM public.job_cost_line_parts WHERE job_cost_line_parts.line_id = old.id;
            UPDATE public.job_cost_lines SET state = 'needs_person',
              needs_reason = 'document_changed_after_decision', not_counted_reason = NULL,
              state_changed_at = now() WHERE id = old.id;
          ELSE
            SELECT count(*) INTO part_count FROM public.job_cost_line_parts p WHERE p.line_id = old.id;
            IF part_count = 1 THEN
              UPDATE public.job_cost_line_parts SET amount_ex = source.amount_ex WHERE job_cost_line_parts.line_id = old.id;
            END IF;
          END IF;
        END IF;
      END IF;
      written := written + 1; doc_changed := true;
    END LOOP;
    -- Resolve same-document parent keys after all inserts, irrespective of input order.
    UPDATE public.job_cost_lines l SET follows_line_id = parent.id
      FROM jsonb_array_elements(d->'lines') a(j)
      LEFT JOIN public.job_cost_lines parent ON parent.org_id = (d->>'org_id')::uuid
        AND parent.document_kind = d->>'document_kind' AND parent.document_id = d->>'document_id'
        AND parent.line_key = a.j->>'follows_line_key'
      WHERE l.org_id = (d->>'org_id')::uuid AND l.document_kind = d->>'document_kind'
        AND l.document_id = d->>'document_id' AND l.line_key = a.j->>'line_key'
        AND l.follows_line_id IS DISTINCT FROM parent.id;
    FOR old IN SELECT * FROM public.job_cost_lines l WHERE l.org_id = (d->>'org_id')::uuid
      AND l.document_kind = d->>'document_kind' AND l.document_id = d->>'document_id'
      AND coalesce(l.not_counted_reason,'') NOT IN ('line_removed','duplicate_document',
        'duplicate_of_trade_invoice','counted_by_bank_line','counted_by_trade_invoice')
      AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(d->'lines') a(j) WHERE a.j->>'line_key' = l.line_key)
      FOR UPDATE
    LOOP
      DELETE FROM public.job_cost_line_parts WHERE job_cost_line_parts.line_id = old.id;
      UPDATE public.job_cost_lines SET state = NULL, not_counted_reason = 'line_removed',
        needs_reason = NULL, state_changed_at = now(), updated_at = now() WHERE id = old.id;
      written := written + 1; doc_changed := true;
    END LOOP;
    IF doc_changed THEN changed := changed || jsonb_build_array((d->>'document_kind') || ':' || (d->>'document_id')); END IF;
  END LOOP;
  RETURN jsonb_build_object('documents', n, 'lines_written', written, 'changed', changed);
END;
$$;

CREATE OR REPLACE FUNCTION public.job_cost_lines_refollow(p_document_kind text, p_document_id text)
RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE f public.job_cost_lines%ROWTYPE; ids uuid[]; parts jsonb; total numeric;
  count_parts int; bad boolean; state text; rewritten int := 0;
BEGIN
  FOR f IN SELECT l.* FROM public.job_cost_lines l WHERE l.decided_by_kind IS DISTINCT FROM 'person'
    AND l.state IS NOT NULL AND (
      EXISTS (SELECT 1 FROM public.job_cost_lines p WHERE p.id = l.follows_line_id
        AND p.document_kind = p_document_kind AND p.document_id = p_document_id AND p.org_id = l.org_id)
      OR (l.follows_document_kind = p_document_kind AND l.follows_document_id = p_document_id))
    ORDER BY l.id FOR UPDATE
  LOOP
    SELECT array_agg(l.id ORDER BY l.line_no, l.line_key COLLATE "C"),
      bool_or(l.state IS NULL OR l.state = 'needs_person' OR l.amount_ex IS NULL)
      INTO ids, bad FROM public.job_cost_lines l WHERE l.org_id = f.org_id
        AND (CASE WHEN f.follows_line_id IS NOT NULL THEN l.id = f.follows_line_id
          ELSE l.document_kind = f.follows_document_kind AND l.document_id = f.follows_document_id END);
    SELECT sum(p.amount_ex) INTO total FROM public.job_cost_line_parts p WHERE p.line_id = ANY(ids);
    IF coalesce(bad,true) OR coalesce(total,0) = 0 OR f.amount_ex IS NULL THEN
      PERFORM public.job_cost_lines_set_state(f.id, 'needs_person', '[]', 'source', NULL, 'follows_undecided');
    ELSE
      -- Keep source order and put the rounding remainder on the last part.
      WITH ordered AS (
        SELECT p.*, row_number() OVER (ORDER BY array_position(ids,p.line_id),p.part_no) AS n,
          count(*) OVER () AS cnt FROM public.job_cost_line_parts p WHERE p.line_id = ANY(ids)
      ), rounded AS (
        SELECT *, round(f.amount_ex * amount_ex / total,2) AS share FROM ordered
      ), apportioned AS (
        SELECT *, CASE WHEN n = cnt THEN f.amount_ex - coalesce(sum(share) OVER (
          ORDER BY n ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),0) ELSE share END AS amount
          FROM rounded
      ) SELECT count(*), jsonb_agg(jsonb_build_object('target',target,'job_id',job_id,
        'division',division,'lane',lane,'amount_ex',amount) ORDER BY n),
        CASE WHEN count(*) > 1 THEN 'split' WHEN min(target) = 'job' THEN 'on_job' ELSE min(target) END
        INTO count_parts, parts, state FROM apportioned;
      IF count_parts = 0 THEN
        PERFORM public.job_cost_lines_set_state(f.id,'needs_person','[]','source',NULL,'follows_undecided');
      ELSE
        PERFORM public.job_cost_lines_set_state(f.id,state,parts,'source',NULL,NULL);
      END IF;
    END IF;
    rewritten := rewritten + 1;
  END LOOP;
  RETURN rewritten;
END;
$$;

REVOKE ALL ON FUNCTION public.job_cost_lines_set_state(uuid,text,jsonb,text,bigint,text),
  public.job_cost_lines_upsert_documents(jsonb), public.job_cost_lines_refollow(text,text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.job_cost_lines_set_state(uuid,text,jsonb,text,bigint,text),
  public.job_cost_lines_upsert_documents(jsonb), public.job_cost_lines_refollow(text,text) TO service_role;

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
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'cost line shadow sync skipped: SQLSTATE %', SQLSTATE;
  RETURN NULL;
END;
$$;
CREATE OR REPLACE FUNCTION public.job_cost_lines_trade_invoice_row()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM public.job_cost_lines_sync_trade_invoice(NEW.id);
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'cost line shadow sync skipped: SQLSTATE %', SQLSTATE;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.job_cost_lines_trade_statement(),public.job_cost_lines_trade_invoice_row() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.job_cost_lines_trade_statement(),public.job_cost_lines_trade_invoice_row() TO service_role;

-- Installed only by the director after the shadow proof. A merge installs no business trigger.
CREATE OR REPLACE FUNCTION public.job_cost_lines_install_trade_triggers()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
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
END;
$$;
CREATE OR REPLACE FUNCTION public.job_cost_lines_remove_trade_triggers()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  DROP TRIGGER IF EXISTS job_cost_lines_trade_insert ON public.trade_invoice_lines;
  DROP TRIGGER IF EXISTS job_cost_lines_trade_update ON public.trade_invoice_lines;
  DROP TRIGGER IF EXISTS job_cost_lines_trade_delete ON public.trade_invoice_lines;
  DROP TRIGGER IF EXISTS job_cost_lines_trade_invoice_update ON public.trade_invoices;
END;
$$;
REVOKE ALL ON FUNCTION public.job_cost_lines_install_trade_triggers(),public.job_cost_lines_remove_trade_triggers()
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.job_cost_lines_install_trade_triggers(),public.job_cost_lines_remove_trade_triggers()
  TO service_role;

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

DROP FUNCTION public.job_cost_lines_retry_one();
DROP FUNCTION public.job_cost_lines_try_trade(uuid);
DROP FUNCTION public.job_cost_lines_write_state(uuid,text,jsonb,text,bigint,text);
DROP TABLE public.job_cost_lines_shadow_retries;
