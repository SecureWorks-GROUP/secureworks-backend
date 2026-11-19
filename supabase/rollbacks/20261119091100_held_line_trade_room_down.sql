-- Restores 20261119091000's decide_held_trade_line body and drops the per-trade
-- room. Refuses unless this migration's body is the live one.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
DO $pin$ BEGIN
  IF coalesce((SELECT md5(p.prosrc) FROM pg_proc p
       WHERE p.oid=to_regprocedure('public.decide_held_trade_line(uuid,text,uuid,uuid,jsonb,text)')),'')
     <> '04a668a9d5afa5efb85d98799334354f' THEN
    RAISE EXCEPTION 'held_line_trade_room_rollback_refused';
  END IF;
END $pin$;
CREATE OR REPLACE FUNCTION public.decide_held_trade_line(
  p_line_id uuid, p_decision text, p_actor uuid, p_org_id uuid, p_changes jsonb, p_reason text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $decide$
DECLARE
  original public.trade_invoice_lines%ROWTYPE;
  decided public.trade_invoice_lines%ROWTYPE;
  holding public.trade_invoices%ROWTYPE;
  follow_on public.trade_invoices%ROWTYPE;
  work_order public.work_orders%ROWTYPE;
  commission public.job_commissions%ROWTYPE;
  changes jsonb := coalesce(p_changes, '{}'::jsonb);
  reviewed timestamptz;
  line_kind text;
  job_now record;
  amount numeric;
  hours numeric;
  rate numeric;
  changed boolean;
  room numeric;
  shortfall numeric;
  previous_amount numeric;
  change_id uuid;
  number_base text;
  suffix integer;
  gross numeric;
  base numeric;
  super_due numeric;
  gst_due numeric;
  hours_sum numeric;
  totals jsonb;
  bad_lines boolean;
/* function body */ BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.feature_flags WHERE flag_name='trade_line_hold_v1' AND enabled) THEN
    RAISE EXCEPTION 'held_line_switch_off';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.users WHERE id=p_actor AND org_id=p_org_id
                  AND role IN ('admin','owner','ops_manager') FOR SHARE) THEN
    RAISE EXCEPTION 'held_line_staff_required';
  END IF;
  IF p_reason IS NULL OR char_length(btrim(p_reason)) NOT BETWEEN 3 AND 500 THEN
    RAISE EXCEPTION 'held_line_reason_required';
  END IF;
  IF p_decision IS NULL OR p_decision NOT IN ('approve','decline','query')
    OR jsonb_typeof(changes) <> 'object'
    OR changes - ARRAY['job_id','not_job_work_type_id','line_total_ex','total_hours'] <> '{}'
    OR (p_decision <> 'approve' AND changes <> '{}') THEN
    RAISE EXCEPTION 'held_line_invalid_decision';
  END IF;

  SELECT l.* INTO original FROM public.trade_invoice_lines l
    JOIN public.trade_invoices i ON i.id=l.trade_invoice_id
    WHERE l.id=p_line_id AND i.org_id=p_org_id FOR UPDATE OF l;
  IF NOT FOUND THEN RAISE EXCEPTION 'held_line_not_found'; END IF;
  SELECT * INTO STRICT holding FROM public.trade_invoices WHERE id=original.trade_invoice_id FOR UPDATE;
  IF original.hold_reason IS NULL OR holding.org_id IS DISTINCT FROM p_org_id OR holding.send_id IS NULL THEN
    RAISE EXCEPTION 'held_line_not_found';
  END IF;
  IF original.office_review_status IN ('approved','rejected') THEN
    RAISE EXCEPTION 'held_line_already_decided';
  END IF;
  IF holding.invoice_kind <> 'held' OR holding.status IS DISTINCT FROM 'pending_ops_review'
    OR holding.pay_run_id IS NOT NULL OR holding.xero_bill_id IS NOT NULL THEN
    RAISE EXCEPTION 'held_line_not_found';
  END IF;
  IF original.office_review_status IS NULL OR original.office_review_status NOT IN ('awaiting','queried') THEN
    RAISE EXCEPTION 'held_line_already_decided';
  END IF;
  IF holding.user_id = p_actor THEN RAISE EXCEPTION 'held_line_own_claim'; END IF;
  IF holding.user_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.users WHERE id=holding.user_id AND org_id=p_org_id)
    OR EXISTS (SELECT 1 FROM public.trade_invoices WHERE send_id=holding.send_id
       AND (org_id IS DISTINCT FROM p_org_id OR user_id IS DISTINCT FROM holding.user_id OR week_start IS DISTINCT FROM holding.week_start
       OR week_end IS DISTINCT FROM holding.week_end OR (invoice_kind='held' AND id<>holding.id))) THEN
    RAISE EXCEPTION 'held_line_invalid_send';
  END IF;
  reviewed := clock_timestamp();
  decided := original;
  IF p_decision IN ('query','decline') THEN
    UPDATE public.trade_invoice_lines SET
      office_review_status=CASE p_decision WHEN 'query' THEN 'queried' ELSE 'rejected' END,
      office_review_note=btrim(p_reason), office_reviewed_by=p_actor, office_reviewed_at=reviewed,
      office_change_reason=CASE WHEN p_decision='decline' THEN btrim(p_reason) ELSE office_change_reason END,
      decided_at=CASE WHEN p_decision='decline' THEN reviewed ELSE decided_at END
      WHERE id=p_line_id RETURNING * INTO STRICT decided;
  ELSE
    line_kind := lower(btrim(original.line_type));
    IF changes ? 'job_id' THEN decided.job_id := (changes->>'job_id')::uuid; END IF;
    IF changes ? 'not_job_work_type_id' THEN decided.not_job_work_type_id := (changes->>'not_job_work_type_id')::uuid; END IF;
    IF line_kind='reimbursement' OR original.hold_reason IN ('not_job_work','reimbursement') OR decided.job_id IS NULL THEN
      IF NOT EXISTS (SELECT 1 FROM public.trade_pay_settings WHERE id=1 AND p_actor=ANY(pay_run_approver_user_ids) FOR SHARE) THEN
        RAISE EXCEPTION 'approver_required';
      END IF;
    END IF;
    IF decided.job_id IS NULL THEN
      IF NOT EXISTS (SELECT 1 FROM public.not_job_work_types WHERE id=decided.not_job_work_type_id
          AND org_id=p_org_id AND active FOR SHARE) THEN RAISE EXCEPTION 'held_line_needs_job_or_type'; END IF;
      decided.job_number := NULL;
      decided.job_work_order_id := NULL;
    ELSE
      PERFORM pg_advisory_xact_lock(hashtextextended('job-amount:' || decided.job_id::text,0));
      SELECT j.job_number,j.client_name,j.site_address INTO job_now FROM public.jobs j WHERE j.id=decided.job_id AND j.org_id=p_org_id;
      IF NOT FOUND THEN RAISE EXCEPTION 'held_line_job_not_backed'; END IF;
      SELECT * INTO work_order FROM public.work_orders WHERE job_id=decided.job_id AND org_id=p_org_id
        AND kind='job' AND status='approved' AND agreed_labour_ex IS NOT NULL FOR UPDATE;
      IF NOT FOUND THEN RAISE EXCEPTION 'held_line_job_not_backed'; END IF;
      decided.job_number := job_now.job_number;
      decided.job_work_order_id := work_order.id;
      decided.not_job_work_type_id := NULL;
    END IF;
    hours := original.total_hours;
    amount := original.line_total_ex;
    IF original.line_total_ex IS NULL OR (original.sent_amount_ex IS NULL AND original.hold_reason<>'commission_no_figure') THEN
      RAISE EXCEPTION 'held_line_invalid_amount';
    END IF;
    IF original.override_amount IS NOT NULL AND original.override_amount IS DISTINCT FROM amount THEN
      RAISE EXCEPTION 'held_line_amount_changed';
    END IF;
    IF changes ? 'total_hours' THEN
      hours := (changes->>'total_hours')::numeric;
      IF jsonb_typeof(changes->'total_hours') <> 'number' OR hours < 0 OR hours <> round(hours,2)
        OR regexp_replace(line_kind,'[[:space:]]','','g') NOT IN ('labour','fencing','patio','makesafe','generallabour','decking') THEN
        RAISE EXCEPTION 'held_line_invalid_hours';
      END IF;
      -- The send supports hourly rows and unit-priced time rows; keep that
      -- same rate when hours change, including the quantity used on the bill.
      rate := coalesce(nullif(original.unit_rate,0),original.hourly_rate);
      IF NOT (changes ? 'line_total_ex') THEN
        IF rate IS NULL OR (rate=0 AND original.line_total_ex>0) THEN RAISE EXCEPTION 'held_line_invalid_hours'; END IF;
        amount := round(hours * rate,2);
      END IF;
      IF nullif(original.unit_rate,0) IS NOT NULL THEN decided.quantity := hours; END IF;
    END IF;
    IF original.hold_reason='commission_no_figure' THEN
      SELECT * INTO commission FROM public.job_commissions WHERE job_id=decided.job_id ORDER BY version DESC LIMIT 1 FOR UPDATE;
      IF NOT FOUND OR line_kind IS DISTINCT FROM 'commission' OR commission.state IS DISTINCT FROM 'named'
        OR commission.salesperson_user_id IS DISTINCT FROM holding.user_id OR commission.expected_amount_ex_gst IS NULL THEN
        RAISE EXCEPTION 'held_line_commission_not_known';
      END IF;
      amount := commission.expected_amount_ex_gst - public.job_commission_claimed_ex_gst(decided.job_id);
      IF amount <= 0 THEN RAISE EXCEPTION 'held_line_commission_claimed'; END IF;
      decided.sent_amount_ex := amount;
    ELSIF changes ? 'line_total_ex' THEN
      IF jsonb_typeof(changes->'line_total_ex') <> 'number' THEN RAISE EXCEPTION 'held_line_invalid_amount'; END IF;
      amount := (changes->>'line_total_ex')::numeric;
    END IF;
    IF amount IS NULL OR amount::text IN ('NaN','Infinity','-Infinity') OR amount < 0 OR amount <> round(amount,2) OR decided.sent_amount_ex IS NULL THEN
      RAISE EXCEPTION 'held_line_invalid_amount';
    END IF;
    IF amount > decided.sent_amount_ex THEN RAISE EXCEPTION 'held_line_above_sent'; END IF;
    IF decided.job_id IS NOT NULL AND public.work_order_backed_line(line_kind,'approved') THEN
      room := public.job_backed_room(decided.job_id);
      IF room IS NULL THEN RAISE EXCEPTION 'held_line_job_not_backed'; END IF;
      shortfall := (round(amount*100) - round(room*100))/100;
      IF shortfall > 0 THEN
        IF EXISTS (SELECT 1 FROM public.group_work_orders WHERE work_order_id=work_order.id AND split_frozen_at IS NOT NULL)
          THEN RAISE EXCEPTION 'work_order_split_locked'; END IF;
        previous_amount := work_order.agreed_labour_ex + public.work_order_amount_change_total(work_order.id);
        INSERT INTO public.work_order_amount_changes(org_id,job_id,work_order_id,kind,from_ex,to_ex,delta_ex,reason,changed_by)
          VALUES(p_org_id,decided.job_id,work_order.id,'amount',previous_amount,previous_amount+shortfall,shortfall,btrim(p_reason),p_actor)
          RETURNING id INTO change_id;
      END IF;
    END IF;
    IF original.hold_reason='not_on_crew' THEN
      IF holding.week_start IS NULL OR decided.job_id IS NULL THEN RAISE EXCEPTION 'held_line_crew_week_missing'; END IF;
      UPDATE public.job_assignments SET self_added_status='accepted', self_added_reviewed_by=p_actor, self_added_reviewed_at=reviewed
        WHERE job_id=decided.job_id AND user_id=holding.user_id AND scheduled_date BETWEEN holding.week_start AND holding.week_start+6
          AND added_by='self' AND status IS DISTINCT FROM 'cancelled' AND self_added_status IS DISTINCT FROM 'accepted';
    END IF;
    -- The holding header serialises decisions for this send. The follow-on row
    -- lock also serialises us against the pay run taking an existing invoice.
    IF holding.gst_on IS NULL THEN RAISE EXCEPTION 'held_line_original_gst_missing'; END IF;
    SELECT * INTO follow_on FROM public.trade_invoices WHERE send_id=holding.send_id AND invoice_kind='follow_on'
      AND pay_run_id IS NULL AND xero_bill_id IS NULL AND status='pending_ops_review' FOR UPDATE;
    IF FOUND THEN
      IF EXISTS (SELECT 1 FROM public.trade_invoices WHERE send_id=holding.send_id AND invoice_kind='follow_on'
        AND id<>follow_on.id AND pay_run_id IS NULL AND xero_bill_id IS NULL AND status='pending_ops_review') THEN
        RAISE EXCEPTION 'held_line_invalid_send';
      END IF;
      IF follow_on.gst_on IS DISTINCT FROM holding.gst_on OR follow_on.super_basis IS DISTINCT FROM 'inclusive_12_112_v1'
        THEN RAISE EXCEPTION 'held_line_follow_on_changed'; END IF;
    ELSE
      number_base := holding.invoice_number;
      IF holding.follows_invoice_id IS NOT NULL THEN
        SELECT invoice_number INTO number_base FROM public.trade_invoices
          WHERE id=holding.follows_invoice_id AND send_id=holding.send_id AND invoice_kind='standard'
            AND org_id=p_org_id AND user_id=holding.user_id;
      END IF;
      IF nullif(btrim(number_base),'') IS NULL THEN RAISE EXCEPTION 'held_line_invalid_send'; END IF;
      SELECT coalesce(max(substring(invoice_number from '-F([0-9]+)$')::integer),0)+1 INTO suffix
        FROM public.trade_invoices WHERE send_id=holding.send_id AND invoice_kind='follow_on';
      -- A weekly work-order header carries the weekly repayment. The follow-on
      -- is a separate invoice for these lines and keeps their work-order links.
      INSERT INTO public.trade_invoices(org_id,user_id,week_start,week_end,invoice_source,invoice_number,
        invoice_kind,send_id,follows_invoice_id,status,submitted_at,total_hours,subtotal_ex,gross_earned,net_pay,
        super_basis,super_rate,super_amount,gst_on,gst,total_inc)
      VALUES(p_org_id,holding.user_id,holding.week_start,holding.week_end,
        CASE holding.invoice_source WHEN 'weekly_work_order' THEN 'misc' ELSE holding.invoice_source END,number_base||'-F'||suffix,
        'follow_on',holding.send_id,coalesce(holding.follows_invoice_id,holding.id),'pending_ops_review',CASE WHEN holding.week_start IS NULL THEN coalesce(holding.submitted_at,holding.created_at) ELSE reviewed END,
        0,0,0,0,'inclusive_12_112_v1',0.12,0,holding.gst_on,0,0) RETURNING * INTO follow_on;
    END IF;
    changed := ROW(amount,hours,decided.job_id,decided.not_job_work_type_id) IS DISTINCT FROM
               ROW(original.line_total_ex,original.total_hours,original.job_id,original.not_job_work_type_id);
    -- A deliberate amount edit can differ from either saved quantity/rate pair.
    -- Preserve those original figures in sent_values. The normal Xero retry
    -- reader falls back to the saved extended amount when a rate is zero.
    IF amount IS DISTINCT FROM original.line_total_ex OR hours IS DISTINCT FROM original.total_hours THEN
      IF hours > 0 AND round(hours * original.hourly_rate,2) <> amount THEN decided.hourly_rate := 0; END IF;
      IF decided.quantity > 0 AND round(decided.quantity * original.unit_rate,2) <> amount THEN decided.unit_rate := 0; END IF;
    END IF;
    IF original.job_id IS DISTINCT FROM decided.job_id THEN
      IF decided.job_id IS NULL THEN
        decided.client_name := NULL; decided.site_address := NULL;
      ELSE
        decided.client_name := job_now.client_name; decided.site_address := job_now.site_address;
      END IF;
    END IF;
    UPDATE public.trade_invoice_lines SET trade_invoice_id=follow_on.id, job_id=decided.job_id, job_number=decided.job_number,
      job_work_order_id=decided.job_work_order_id, not_job_work_type_id=decided.not_job_work_type_id,
      client_name=decided.client_name, site_address=decided.site_address, hourly_rate=decided.hourly_rate, unit_rate=decided.unit_rate, quantity=decided.quantity,
      total_hours=hours, line_total_ex=amount, sent_amount_ex=decided.sent_amount_ex,
      override_amount=CASE WHEN original.override_amount IS NOT NULL THEN amount END,
      sent_values=CASE WHEN changed AND original.sent_values IS NULL THEN jsonb_build_object(
        'job_id',original.job_id,'job_number',original.job_number,'total_hours',original.total_hours,
        'hourly_rate',original.hourly_rate,'unit_rate',original.unit_rate,'quantity',original.quantity,'line_total_ex',original.line_total_ex,
        'day',coalesce(original.work_date,original.line_date),'not_job_work_type_id',original.not_job_work_type_id)
        ELSE original.sent_values END,
      office_change_reason=CASE WHEN changed THEN btrim(p_reason) ELSE original.office_change_reason END,
      office_review_status='approved', office_review_note=btrim(p_reason), office_reviewed_by=p_actor,
      office_reviewed_at=reviewed, decided_at=reviewed WHERE id=p_line_id RETURNING * INTO STRICT decided;
    SELECT sum(line_total_ex),coalesce(sum(line_total_ex) FILTER (WHERE lower(btrim(line_type)) <> 'reimbursement'),0),
      coalesce(sum(total_hours),0),bool_or(line_total_ex IS NULL OR line_type IS NULL OR
        office_review_status IS DISTINCT FROM 'approved' OR (override_amount IS NOT NULL AND override_amount IS DISTINCT FROM line_total_ex))
      INTO gross,base,hours_sum,bad_lines FROM public.trade_invoice_lines WHERE trade_invoice_id=follow_on.id;
    IF gross IS NULL OR bad_lines THEN RAISE EXCEPTION 'held_line_follow_on_changed'; END IF;
    super_due := round(base*12/112,2);
    gst_due := CASE WHEN holding.gst_on THEN round(base*0.10,2) ELSE 0 END;
    UPDATE public.trade_invoices SET subtotal_ex=gross,gross_earned=gross,super_base_ex=nullif(base,gross),
      super_amount=super_due,net_pay=gross-super_due,gst=gst_due,total_inc=gross+gst_due,total_hours=hours_sum
      WHERE id=follow_on.id;
    IF decided.job_id IS NOT NULL AND to_regprocedure('public.job_mark_changed(uuid,text)') IS NOT NULL THEN
      PERFORM public.job_mark_changed(decided.job_id,'trade_invoice');
    END IF;
  END IF;
  -- SUM ignores NULL. A send with an unread amount cannot prove a reconciliation.
  IF EXISTS (SELECT 1 FROM public.trade_invoices i JOIN public.trade_invoice_lines l ON l.trade_invoice_id=i.id
    WHERE i.send_id=holding.send_id AND (l.sent_amount_ex IS NULL OR l.line_total_ex IS NULL)) THEN
    RAISE EXCEPTION 'held_line_not_balanced';
  END IF;
  totals := public.trade_send_totals(holding.send_id);
  IF (totals->'balanced') IS DISTINCT FROM 'true'::jsonb THEN RAISE EXCEPTION 'held_line_not_balanced'; END IF;
  RETURN jsonb_build_object('line',jsonb_build_object(
    'id',decided.id,'trade_invoice_id',decided.trade_invoice_id,'job_id',decided.job_id,'job_number',decided.job_number,
    'total_hours',decided.total_hours,'line_total_ex',decided.line_total_ex,'sent_amount_ex',decided.sent_amount_ex,
    'sent_values',decided.sent_values,'not_job_work_type_id',decided.not_job_work_type_id,
    'office_review_status',decided.office_review_status,'office_review_note',decided.office_review_note,
    'office_reviewed_by',decided.office_reviewed_by,'office_reviewed_at',decided.office_reviewed_at,
    'decided_at',decided.decided_at,'office_change_reason',decided.office_change_reason),
    'follow_on_invoice_id',follow_on.id,'work_order_change_id',change_id,'send',totals);
EXCEPTION WHEN OTHERS THEN
  -- Never return a failing row, user input or a constraint's DETAIL from a pay RPC.
  IF SQLSTATE='P0001' AND (SQLERRM ~ '^held_line_[a-z_]+$' OR SQLERRM IN ('approver_required','work_order_split_locked')) THEN RAISE; END IF;
  RAISE EXCEPTION 'held_line_decision_failed' USING DETAIL=p_line_id::text;
END $decide$;

REVOKE ALL ON FUNCTION public.decide_held_trade_line(uuid,text,uuid,uuid,jsonb,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.decide_held_trade_line(uuid,text,uuid,uuid,jsonb,text) TO service_role;
DROP FUNCTION public.job_backed_trade_room(uuid,uuid);
