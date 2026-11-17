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
