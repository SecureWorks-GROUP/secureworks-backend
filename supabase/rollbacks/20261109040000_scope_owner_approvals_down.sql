-- Down for 20261109040000_scope_owner_approvals.sql.
--
-- Restores the seal, the manual approval, the automatic issue, release on
-- acceptance and the draft read exactly as they stood before, and removes the
-- owner approval functions and the crew status gate.
--
-- Kept on purpose: the recorded decisions (scope_owner_approvals, append
-- only), the decision ids stamped on work orders, the owner list, the
-- retained acceptances, the unapproved-send records
-- (quote_send_price_unapproved_sends, no writer after this down) and the
-- unapproved work order records (job_work_order_owner_unapproved, append
-- only, no writer after this down).
--
-- Pair this down with the application code from before 20261109040000: the
-- send and approval handlers of this change call functions this down removes. A draft set whose acceptance was retained while an
-- approval was missing stays unreleased; release it again through the
-- existing acceptance path after this down if the owner wants it issued.

CREATE OR REPLACE FUNCTION public.approve_job_work_order(p_work_order_id uuid, p_approver uuid, p_via text, p_expected_updated_at timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_wo public.work_orders%ROWTYPE;
  v_out public.work_orders%ROWTYPE;
BEGIN
  SELECT * INTO v_wo FROM public.work_orders WHERE id = p_work_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'work order not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_wo.kind <> 'job' THEN
    RAISE EXCEPTION 'only a job work order is approved' USING ERRCODE = '23514';
  END IF;
  IF v_wo.status <> 'draft' THEN
    RAISE EXCEPTION 'work order is %, not draft', v_wo.status USING ERRCODE = '23514';
  END IF;
  IF p_expected_updated_at IS NULL OR v_wo.updated_at IS DISTINCT FROM p_expected_updated_at THEN
    RAISE EXCEPTION 'The draft changed after it was read. Read it again before approving.'
      USING ERRCODE = 'WO409';
  END IF;

  UPDATE public.work_orders
    SET status = 'approved', approved_by = p_approver, approved_at = now(), approved_via = p_via
    WHERE id = v_wo.id
    RETURNING * INTO v_out;

  UPDATE public.jobs SET work_order_id = v_out.id WHERE id = v_out.job_id;

  UPDATE public.trade_invoice_lines til
    SET job_work_order_id = v_out.id
    FROM public.trade_invoices ti
    WHERE ti.id = til.trade_invoice_id
      AND til.job_id = v_out.job_id
      AND til.job_work_order_id IS NULL
      AND ti.status = ANY (public.job_work_order_billed_invoice_statuses());

  UPDATE public.work_order_variations
    SET work_order_id = v_out.id
    WHERE job_id = v_out.job_id AND work_order_id IS NULL;

  RETURN to_jsonb(v_out);
END;
$function$
;

CREATE OR REPLACE FUNCTION public.auto_issue_job_work_order(p_work_order_id uuid, p_expected_updated_at timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_wo public.work_orders%ROWTYPE;
  v_out public.work_orders%ROWTYPE;
BEGIN
  IF NOT COALESCE((SELECT f.enabled FROM public.feature_flags f
                   WHERE f.flag_name = 'job_work_order_auto_issue_v1' LIMIT 1), false) THEN
    RAISE EXCEPTION 'automatic issue of job work orders is switched off (feature flag job_work_order_auto_issue_v1)'
      USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_wo FROM public.work_orders WHERE id = p_work_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'work order not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_wo.kind <> 'job' THEN
    RAISE EXCEPTION 'only a job work order is issued' USING ERRCODE = '23514';
  END IF;
  IF v_wo.status <> 'draft' THEN
    RAISE EXCEPTION 'work order is %, not draft', v_wo.status USING ERRCODE = '23514';
  END IF;
  IF p_expected_updated_at IS NULL OR v_wo.updated_at IS DISTINCT FROM p_expected_updated_at THEN
    RAISE EXCEPTION 'The draft changed after it was read. Read it again.'
      USING ERRCODE = 'WO409';
  END IF;
  IF v_wo.quote_filled_at IS NULL OR v_wo.hand_edited_at IS NOT NULL THEN
    RAISE EXCEPTION 'only a draft filled from the quote and not edited by hand is issued automatically'
      USING ERRCODE = 'WO423';
  END IF;

  PERFORM set_config('secureworks.job_work_order_auto_issue', 'on', true);
  UPDATE public.work_orders
    SET status = 'approved', approved_by = NULL, approved_at = now(), approved_via = 'auto'
    WHERE id = v_wo.id
    RETURNING * INTO v_out;
  PERFORM set_config('secureworks.job_work_order_auto_issue', 'off', true);

  UPDATE public.jobs SET work_order_id = v_out.id WHERE id = v_out.job_id;

  UPDATE public.trade_invoice_lines til
    SET job_work_order_id = v_out.id
    FROM public.trade_invoices ti
    WHERE ti.id = til.trade_invoice_id
      AND til.job_id = v_out.job_id
      AND til.job_work_order_id IS NULL
      AND ti.status = ANY (public.job_work_order_billed_invoice_statuses());

  UPDATE public.work_order_variations
    SET work_order_id = v_out.id
    WHERE job_id = v_out.job_id AND work_order_id IS NULL;

  RETURN to_jsonb(v_out);
END;
$function$
;

CREATE OR REPLACE FUNCTION public.read_scope_job_drafts(p_job_id uuid, p_scope_revision_id uuid, p_org_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE s public.scope_job_draft_sets%ROWTYPE; v_invoices jsonb;
BEGIN
  PERFORM 1 FROM public.jobs j WHERE j.id = p_job_id AND j.org_id = p_org_id FOR SHARE;
  IF NOT FOUND OR p_org_id IS NULL THEN
    RAISE EXCEPTION 'scope_drafts_job_forbidden' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO s FROM public.scope_job_draft_sets d WHERE d.job_id = p_job_id AND d.org_id = p_org_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'scope_drafts_not_found' USING ERRCODE = 'P0002'; END IF;
  IF s.scope_revision_id IS DISTINCT FROM p_scope_revision_id OR NOT EXISTS (
    SELECT 1 FROM public.scope_revisions r WHERE r.id = p_scope_revision_id AND r.job_id = p_job_id
      AND (s.released_at IS NOT NULL AND r.status IN ('frozen', 'superseded') OR r.status = 'frozen' AND NOT EXISTS (
        SELECT 1 FROM public.scope_revisions n WHERE n.job_id = p_job_id AND n.revision_number > r.revision_number
      ))
  ) THEN RAISE EXCEPTION 'scope_drafts_revision_stale' USING ERRCODE = '23514'; END IF;
  SELECT jsonb_agg(jsonb_build_object('id', i.id, 'payer_id', i.payer_id, 'status', 'draft',
      'ex_gst', i.ex_cents / 100.0, 'gst', i.gst_cents / 100.0, 'inc_gst', i.inc_cents / 100.0)
      ORDER BY i.payer_id COLLATE "C") INTO v_invoices
    FROM public.scope_job_draft_invoices i WHERE i.job_id = p_job_id AND i.scope_revision_id = s.scope_revision_id;
  RETURN jsonb_build_object('job_id', s.job_id, 'scope_revision_id', s.scope_revision_id,
    'work_order', jsonb_build_object('id', s.work_order_id,
      'status', CASE WHEN s.released_at IS NULL THEN 'draft' ELSE 'released' END,
      'labour_total_ex_gst', s.labour_total_cents / 100.0),
    'invoices', coalesce(v_invoices, '[]'::jsonb), 'amounts_confirmed', s.amounts_confirmed,
    'xero_writes', false, 'sent', false, 'payment_links', false);
END $function$
;

CREATE OR REPLACE FUNCTION public.release_scope_job_drafts(p_job_id uuid, p_scope_revision_id uuid, p_legacy boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE s public.scope_job_draft_sets%ROWTYPE; j public.jobs%ROWTYPE;
BEGIN
  SELECT * INTO j FROM public.jobs WHERE id = p_job_id FOR UPDATE;
  IF NOT FOUND OR j.status IS DISTINCT FROM 'accepted' THEN
    RAISE EXCEPTION 'scope_drafts_acceptance_required' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO s FROM public.scope_job_draft_sets WHERE job_id = j.id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('released', false, 'reason', 'no_drafts'); END IF;
  IF s.scope_revision_id IS DISTINCT FROM p_scope_revision_id THEN
    RAISE EXCEPTION 'scope_drafts_accepted_revision_mismatch' USING ERRCODE = '23514';
  END IF;
  IF s.released_at IS NOT NULL THEN RETURN jsonb_build_object('released', true, 'replayed', true); END IF;
  IF NOT EXISTS (SELECT 1 FROM public.scope_revisions r JOIN public.work_orders w ON w.id = s.work_order_id
    WHERE r.id = s.scope_revision_id AND r.job_id = j.id AND r.status IN ('frozen', 'superseded')
      AND w.scope_revision_id = r.id AND w.scope_items = s.labour_lines
      AND w.agreed_labour_ex IS NOT DISTINCT FROM s.labour_total_cents / 100.0
      AND (NOT p_legacy OR r.status = 'frozen' AND NOT EXISTS (
        SELECT 1 FROM public.scope_revisions n WHERE n.job_id = j.id AND n.revision_number > r.revision_number))) THEN
    RAISE EXCEPTION 'scope_drafts_source_changed' USING ERRCODE = '23514';
  END IF;
  UPDATE public.scope_job_draft_sets SET released_at = now() WHERE job_id = j.id AND released_at IS NULL;
  INSERT INTO public.job_events(job_id, event_type, detail_json) VALUES
    (j.id, 'scope_job_draft_work_order_released', jsonb_build_object('work_order_id', s.work_order_id, 'scope_revision_id', s.scope_revision_id));
  RETURN jsonb_build_object('released', true, 'replayed', false);
END $function$
;

CREATE OR REPLACE FUNCTION public.work_orders_job_kind_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_mutable text[] := ARRAY['viewed_at', 'updated_at'];
  v_approvers uuid[];
  v_backup uuid[];
  v_content_changed boolean;
  v_old_untouched boolean;
  v_job_type text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.kind = 'job' AND OLD.status = 'approved' THEN
      RAISE EXCEPTION 'an approved job work order is sealed and cannot be deleted'
        USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.kind = 'job' AND NEW.status = 'approved' THEN
      RAISE EXCEPTION 'a job work order is created as a draft and approved afterwards'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.kind = 'job' THEN
      NEW.quote_filled_at := NULL;
      NEW.hand_edited_at := CASE
        WHEN COALESCE(jsonb_array_length(CASE WHEN jsonb_typeof(NEW.scope_items) = 'array' THEN NEW.scope_items END), 0) > 0
          OR NEW.agreed_labour_ex IS NOT NULL
          OR COALESCE(btrim(NEW.special_instructions), '') <> ''
        THEN clock_timestamp()
      END;
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.kind IS DISTINCT FROM OLD.kind THEN
    RAISE EXCEPTION 'work_orders.kind cannot change' USING ERRCODE = '23514';
  END IF;

  IF OLD.kind = 'job' AND OLD.status = 'approved' THEN
    IF (to_jsonb(NEW) - v_mutable) IS DISTINCT FROM (to_jsonb(OLD) - v_mutable) THEN
      RAISE EXCEPTION 'an approved job work order is sealed: later change is recorded as a variation'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.kind = 'job' THEN
    NEW.updated_at := clock_timestamp();

    NEW.hand_edited_at := OLD.hand_edited_at;
    v_content_changed :=
      NEW.scope_items IS DISTINCT FROM OLD.scope_items
      OR NEW.agreed_labour_ex IS DISTINCT FROM OLD.agreed_labour_ex
      OR NEW.special_instructions IS DISTINCT FROM OLD.special_instructions
      OR NEW.scheduled_date IS DISTINCT FROM OLD.scheduled_date
      OR NEW.site_address IS DISTINCT FROM OLD.site_address;
    v_old_untouched :=
      COALESCE(jsonb_array_length(CASE WHEN jsonb_typeof(OLD.scope_items) = 'array' THEN OLD.scope_items END), 0) = 0
      AND OLD.agreed_labour_ex IS NULL;
    IF NEW.quote_filled_at IS DISTINCT FROM OLD.quote_filled_at THEN
      IF OLD.quote_filled_at IS NOT NULL OR NEW.quote_filled_at IS NULL
         OR OLD.status IS DISTINCT FROM 'draft' OR OLD.hand_edited_at IS NOT NULL
         OR NOT (
           v_old_untouched
           OR (NOT v_content_changed
               AND current_setting('secureworks.job_work_order_fill_stamp', true) = 'prior_fill')
         ) THEN
        RAISE EXCEPTION 'quote_filled_at is stamped only by the quote fill of an untouched draft'
          USING ERRCODE = '23514';
      END IF;
    ELSIF v_content_changed THEN
      NEW.hand_edited_at := clock_timestamp();
    END IF;
  END IF;

  IF NEW.kind = 'job' AND NEW.status = 'approved' THEN
    IF OLD.status IS DISTINCT FROM 'draft' THEN
      RAISE EXCEPTION 'only a draft job work order can be approved' USING ERRCODE = '23514';
    END IF;
    IF NEW.approved_via = 'auto' THEN
      IF current_setting('secureworks.job_work_order_auto_issue', true) IS DISTINCT FROM 'on'
         OR NOT COALESCE((SELECT f.enabled FROM public.feature_flags f
                          WHERE f.flag_name = 'job_work_order_auto_issue_v1' LIMIT 1), false) THEN
        RAISE EXCEPTION 'a job work order is issued automatically only by auto_issue_job_work_order while job_work_order_auto_issue_v1 is on'
          USING ERRCODE = '42501';
      END IF;
      IF NEW.approved_by IS NOT NULL THEN
        RAISE EXCEPTION 'an automatic issue names no approver' USING ERRCODE = '23514';
      END IF;
      IF OLD.quote_filled_at IS NULL OR OLD.hand_edited_at IS NOT NULL THEN
        RAISE EXCEPTION 'only a draft filled from the quote and not edited by hand is issued automatically'
          USING ERRCODE = '23514';
      END IF;
    ELSE
      -- (added) Backup approvers join the list only while the office switch is on.
      SELECT s.approver_user_ids, s.backup_approver_user_ids
        INTO v_approvers, v_backup
        FROM public.work_order_settings s WHERE s.id = 1;
      IF COALESCE((SELECT f.enabled FROM public.feature_flags f
                   WHERE f.flag_name = 'job_work_order_office_fill_v1' LIMIT 1), false) THEN
        v_approvers := COALESCE(v_approvers, '{}'::uuid[]) || COALESCE(v_backup, '{}'::uuid[]);
      END IF;
      IF NEW.approved_by IS NULL OR v_approvers IS NULL OR NOT (NEW.approved_by = ANY (v_approvers)) THEN
        RAISE EXCEPTION 'only an approver named in work_order_settings can approve a job work order'
          USING ERRCODE = '42501';
      END IF;
    END IF;
    IF NEW.job_id IS NULL THEN
      RAISE EXCEPTION 'a job work order needs its job' USING ERRCODE = '23514';
    END IF;
    IF NEW.agreed_labour_ex IS NULL THEN
      RAISE EXCEPTION 'set the agreed labour amount before approving' USING ERRCODE = '23514';
    END IF;
    IF COALESCE(jsonb_array_length(CASE WHEN jsonb_typeof(NEW.scope_items) = 'array' THEN NEW.scope_items END), 0) = 0
       AND COALESCE(btrim(NEW.special_instructions), '') = '' THEN
      -- (added) Fencing, patio, and a job with no type still need a scope.
      -- Any other type may be approved on the labour allowance alone.
      SELECT j.type INTO v_job_type FROM public.jobs j WHERE j.id = NEW.job_id;
      IF COALESCE(btrim(v_job_type), '') IN ('fencing', 'patio', '') THEN
        RAISE EXCEPTION 'add the scope before approving' USING ERRCODE = '23514';
      END IF;
    END IF;
    NEW.approved_at := COALESCE(NEW.approved_at, now());
    NEW.sealed_content_hash := encode(sha256(convert_to(jsonb_build_object(
      'work_order_id', NEW.id,
      'job_id', NEW.job_id,
      'wo_number', NEW.wo_number,
      'scope_items', COALESCE(NEW.scope_items, '[]'::jsonb),
      'special_instructions', NEW.special_instructions,
      'site_address', NEW.site_address,
      'scheduled_date', NEW.scheduled_date,
      'agreed_labour_ex', NEW.agreed_labour_ex
    )::text, 'UTF8')), 'hex');
  END IF;
  RETURN NEW;
END;
$function$
;

REVOKE ALL ON FUNCTION
  public.approve_job_work_order(uuid, uuid, text, timestamptz),
  public.auto_issue_job_work_order(uuid, timestamptz),
  public.release_scope_job_drafts(uuid, uuid, boolean),
  public.read_scope_job_drafts(uuid, uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION
  public.approve_job_work_order(uuid, uuid, text, timestamptz),
  public.auto_issue_job_work_order(uuid, timestamptz),
  public.release_scope_job_drafts(uuid, uuid, boolean),
  public.read_scope_job_drafts(uuid, uuid, uuid)
  TO service_role;

-- The local deposit's acceptance time, as 20261106044806 wrote it.
CREATE OR REPLACE FUNCTION public.scope_payment_acceptance_event()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE signal record;
BEGIN
  IF OLD.released_at IS NULL AND NEW.released_at IS NOT NULL THEN
    BEGIN
      PERFORM public.record_scope_payment_signal(NEW.job_id,'quote_accepted',
        jsonb_build_object('kind','quote_accepted','scope_revision_id',NEW.scope_revision_id),NEW.released_at);
      FOR signal IN SELECT * FROM public.scope_payment_signals WHERE job_id=NEW.job_id AND scope_revision_id=NEW.scope_revision_id
        AND kind IN ('install_scheduled','council_step_completed') ORDER BY happened_at,id LOOP
        PERFORM public.apply_scope_payment_event(NEW.job_id,signal.kind,signal.coordinate,signal.happened_at);
      END LOOP;
    EXCEPTION
      WHEN query_canceled THEN RAISE WARNING 'local payment stages held after timeout; acceptance retained';
      WHEN OTHERS THEN RAISE WARNING 'local payment stages held; acceptance retained: %',SQLSTATE;
    END;
  END IF;
  RETURN NULL;
END $$;

DROP FUNCTION IF EXISTS public.approve_job_work_order(uuid, uuid, text, timestamptz, uuid);
DROP FUNCTION IF EXISTS public.record_quote_send_price_unapproved(text, uuid, text, uuid, text, uuid);
DROP FUNCTION IF EXISTS public.record_work_order_owner_unapproved(uuid, uuid, text, text, text, uuid, text[]);
DROP TRIGGER IF EXISTS trg_work_orders_crew_owner_gate ON public.work_orders;
DROP FUNCTION IF EXISTS public.work_orders_crew_owner_gate();
DROP FUNCTION IF EXISTS public.work_orders_crew_owner_hold(public.work_orders);
DROP TRIGGER IF EXISTS trg_work_orders_owner_unapproved_flush ON public.work_orders;
DROP FUNCTION IF EXISTS public.work_orders_owner_unapproved_flush();
DROP FUNCTION IF EXISTS public.flush_owner_unapproved();
DROP FUNCTION IF EXISTS public.owner_unapproved_queue(jsonb);
DROP FUNCTION IF EXISTS public.approve_job_work_order_switch_off(uuid, uuid, text, timestamptz, uuid);
DROP FUNCTION IF EXISTS public.owner_approved_job_work_order_drafts(integer);
DROP FUNCTION IF EXISTS public.scope_price_owner_approval(uuid, uuid);
DROP FUNCTION IF EXISTS public.read_job_owner_approval_state(uuid, uuid);
DROP FUNCTION IF EXISTS public.scope_job_draft_issue_state(uuid);
DROP FUNCTION IF EXISTS public.record_job_work_order_approval(uuid, uuid, text, timestamptz, uuid, uuid, boolean);
DROP FUNCTION IF EXISTS public.record_scope_price_approval(uuid, uuid, uuid, text, uuid, text[]);
DROP FUNCTION IF EXISTS public.scope_revision_quote_documents(uuid);
DROP FUNCTION IF EXISTS public.issue_owner_approved_job_work_order(uuid);
DROP FUNCTION IF EXISTS public.link_issued_job_work_order(uuid);
DROP FUNCTION IF EXISTS public.job_work_order_issue_check(public.work_orders);
DROP FUNCTION IF EXISTS public.job_work_order_owner_gate(public.work_orders, text);
DROP FUNCTION IF EXISTS public.scope_owner_approval_json(public.scope_owner_approvals);
DROP FUNCTION IF EXISTS public.job_work_order_not_ready(public.work_orders);
DROP FUNCTION IF EXISTS public.job_work_order_content_hash(public.work_orders);
DROP FUNCTION IF EXISTS public.owner_approval_authority(uuid);
DROP FUNCTION IF EXISTS public.owner_approval_company_ok(uuid, uuid, uuid);
DROP FUNCTION IF EXISTS public.owner_approval_required();

DELETE FROM public.feature_flags WHERE flag_name = 'owner_approval_saved_revision_required_v1';
