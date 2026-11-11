-- Dispatch v2 (Shaun, 6 Nov 2026): an order sent from Outlook becomes a
-- Dispatch order the moment it is sent, not when the supplier replies.
--
-- The rule, in business words (contract docs/dispatch-v2-board-contract.md,
-- section 3g): an email sent from admin@secureworkswa.com.au whose subject
-- starts "Material Order Ref <job number>", addressed to a supplier on the
-- approved order list (or at that supplier's company domain), is that
-- supplier's order on that job. Re: and Fw: are never orders, nor is a
-- "Material Order Quote Ref", nor an email Dispatch sent itself. The job comes
-- only from the subject, and only a job on the Dispatch board gets an order.
-- One email to two suppliers makes two orders. A second order to the same
-- supplier on the same job reuses the box as its newest order.
--
-- This replaces the 5 Nov rule (migration 20261105170000), where an Outlook
-- order was recorded only when the supplier's reply came in.
--
-- This migration adds:
--   * One order per sent email AND supplier. The 5 Nov index kept one order
--     per sent email; one email to two suppliers now makes two orders, so the
--     unique key becomes (source_business_event_id, supplier_id).
--   * dispatch_v2_reply_scan_state.sent_orders_since: the moment the send
--     rule first ran. The five-minute scan reads only sent emails from then
--     on, so switching the rule on never records older orders by itself
--     (those are for the one-off catch-up, which Shaun checks first).
--   * dispatch_v2_record_outlook_order_on_send(p jsonb): the one write, in
--     one transaction. Makes the supplier box if the job has none for that
--     supplier, inserts the sent order row and a job_events row. Unlike the
--     5 Nov function it records a second order to a supplier that already has
--     one on the job (the box is reused), and it refuses an email that is one
--     of Dispatch's own sends.
--
-- It never sends anything, never adds material lines to the job's list, never
-- writes the suppliers table (Xero-synced, read only here), and never moves a
-- job's stage or status. The 5 Nov function is left in place, unused.
--
-- Rules and caller: supabase/functions/ops-api/dispatch_v2_outlook_on_send.ts.
-- Only ops-api (service role) may call the function. No existing row changes.
--
-- Rollback: supabase/rollbacks/20261106120000_dispatch_v2_outlook_order_on_send_down.sql.

-- One order per captured sent email and supplier.
CREATE UNIQUE INDEX IF NOT EXISTS dispatch_supplier_order_emails_source_event_supplier_idx
  ON public.dispatch_supplier_order_emails (source_business_event_id, supplier_id)
  WHERE source_business_event_id IS NOT NULL;
DROP INDEX IF EXISTS public.dispatch_supplier_order_emails_source_event_idx;

ALTER TABLE public.dispatch_v2_reply_scan_state
  ADD COLUMN IF NOT EXISTS sent_orders_since timestamptz NULL;

COMMENT ON COLUMN public.dispatch_v2_reply_scan_state.sent_orders_since IS
  'Dispatch v2 send rule (contract section 3g): the scan records orders only from admin@ sent emails captured from this moment on. Set by the first run. Older orders are for the one-off catch-up.';

-- The one write. p (jsonb):
--   org_id, job_id, supplier_id                       uuids
--   related_supplier_ids                              uuid[]: every Xero
--     contact that is the same supplier (the approved entry's links)
--   approved_email_id                                 uuid or null: the
--     approved entry the email was addressed to
--   trigger                                           'send' (the scan) or
--     'catch_up' (the one-off catch-up)
--   work_type, team_cc_email, subject, body_text      text
--   to_emails, cc_emails                              text[]
--   delivery_date                                     date or null
--   order_lines                                       jsonb array (may be
--     empty: an email with no readable list keeps its words as the order)
--   standing_lines_included                           boolean
--   sent_at                                           timestamptz
--   sent_by_email, sent_from_mailbox                  text
--   sent_internet_message_id, sent_conversation_id    text
--   source_business_event_id                          uuid
-- Returns { recorded, order_id, box_id, box_created, reason }. reason is
-- 'already_recorded' (this sent email is already this supplier's order: its
-- ids come back), 'dispatch_own_send', 'job_not_found', 'supplier_not_found'
-- or 'supplier_inactive' (nothing written), or null when recorded.
CREATE OR REPLACE FUNCTION public.dispatch_v2_record_outlook_order_on_send(p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_org uuid := (p->>'org_id')::uuid;
  v_job uuid := (p->>'job_id')::uuid;
  v_supplier uuid := (p->>'supplier_id')::uuid;
  v_event uuid := (p->>'source_business_event_id')::uuid;
  v_message text := nullif(p->>'sent_internet_message_id', '');
  v_conversation text := nullif(p->>'sent_conversation_id', '');
  v_trigger text := coalesce(nullif(p->>'trigger', ''), 'send');
  v_related uuid[];
  v_existing record;
  v_supplier_name text;
  v_supplier_active boolean;
  v_box uuid;
  v_box_created boolean := false;
  v_order uuid;
BEGIN
  IF v_org IS NULL OR v_job IS NULL OR v_supplier IS NULL OR v_event IS NULL THEN
    RAISE EXCEPTION 'outlook_order_missing_ids';
  END IF;
  IF v_trigger NOT IN ('send', 'catch_up') THEN
    RAISE EXCEPTION 'outlook_order_bad_trigger';
  END IF;
  SELECT coalesce(array_agg(x::uuid), ARRAY[]::uuid[])
    INTO v_related
    FROM jsonb_array_elements_text(coalesce(p->'related_supplier_ids', '[]'::jsonb)) AS x;
  v_related := array_append(v_related, v_supplier);

  -- One run at a time per job, so two scans (or a scan and the catch-up) can
  -- never both record the same email.
  PERFORM pg_advisory_xact_lock(hashtextextended('dispatch_v2_outlook_order:' || v_job::text, 0));

  -- Already this supplier's order (any of its Xero contacts): hand it back.
  SELECT o.id, b.id AS box_id INTO v_existing
    FROM public.dispatch_supplier_order_emails o
    LEFT JOIN public.job_material_suppliers b
      ON b.job_id = o.job_id AND b.supplier_id = o.supplier_id
   WHERE o.source_business_event_id = v_event
     AND o.supplier_id = ANY (v_related)
   LIMIT 1;
  IF v_existing.id IS NOT NULL THEN
    RETURN jsonb_build_object('recorded', false, 'order_id', v_existing.id,
      'box_id', v_existing.box_id, 'box_created', false, 'reason', 'already_recorded');
  END IF;

  -- An email Dispatch sent itself is already its order (its copy also lands
  -- in admin@ Sent). Matched on the Outlook message id or conversation.
  IF EXISTS (
    SELECT 1 FROM public.dispatch_supplier_order_emails
     WHERE origin = 'dispatch'
       AND status IN ('sent', 'send_unknown')
       AND ((v_message IS NOT NULL AND lower(trim(both '<>' from sent_internet_message_id)) = lower(trim(both '<>' from v_message)))
         OR (v_conversation IS NOT NULL AND sent_conversation_id = v_conversation))
  ) THEN
    RETURN jsonb_build_object('recorded', false, 'order_id', NULL, 'box_id', NULL,
      'box_created', false, 'reason', 'dispatch_own_send');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.jobs WHERE id = v_job AND org_id = v_org) THEN
    RETURN jsonb_build_object('recorded', false, 'order_id', NULL, 'box_id', NULL,
      'box_created', false, 'reason', 'job_not_found');
  END IF;

  -- The supplier's name as Xero has it. Read only: suppliers is never written.
  SELECT name, coalesce(is_active, true) INTO v_supplier_name, v_supplier_active
    FROM public.suppliers WHERE id = v_supplier;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('recorded', false, 'order_id', NULL, 'box_id', NULL,
      'box_created', false, 'reason', 'supplier_not_found');
  END IF;
  IF NOT v_supplier_active THEN
    RETURN jsonb_build_object('recorded', false, 'order_id', NULL, 'box_id', NULL,
      'box_created', false, 'reason', 'supplier_inactive');
  END IF;

  -- The supplier box: reused when the job has one for this contact (a second
  -- order is the box's newest order), else made last in the job's order and
  -- never ticked as the main supplier.
  SELECT id INTO v_box FROM public.job_material_suppliers
   WHERE job_id = v_job AND supplier_id = v_supplier;
  IF v_box IS NULL THEN
    INSERT INTO public.job_material_suppliers
      (org_id, job_id, supplier_id, supplier_name, position, is_main_supplier)
    SELECT v_org, v_job, v_supplier, v_supplier_name,
           coalesce((SELECT max(position) FROM public.job_material_suppliers WHERE job_id = v_job), 0) + 1,
           false
    ON CONFLICT (job_id, supplier_id) DO NOTHING
    RETURNING id INTO v_box;
    v_box_created := v_box IS NOT NULL;
    IF v_box IS NULL THEN
      SELECT id INTO v_box FROM public.job_material_suppliers
       WHERE job_id = v_job AND supplier_id = v_supplier;
    END IF;
  END IF;

  INSERT INTO public.dispatch_supplier_order_emails (
    org_id, job_id, supplier_id, supplier_name, approved_email_id, work_type,
    is_main_supplier, standing_lines_included, status, team_cc_email,
    to_emails, cc_emails, subject, body_text, built_body_text, delivery_date,
    order_lines, sent_at, sent_by_email, sent_from_mailbox, sent_to_emails,
    sent_cc_emails, sent_internet_message_id, sent_conversation_id,
    origin, source_business_event_id
  ) VALUES (
    v_org, v_job, v_supplier, v_supplier_name,
    nullif(p->>'approved_email_id', '')::uuid,
    coalesce(nullif(p->>'work_type', ''), 'other'),
    false, coalesce((p->>'standing_lines_included')::boolean, false), 'sent',
    nullif(p->>'team_cc_email', ''),
    ARRAY(SELECT jsonb_array_elements_text(coalesce(p->'to_emails', '[]'::jsonb))),
    ARRAY(SELECT jsonb_array_elements_text(coalesce(p->'cc_emails', '[]'::jsonb))),
    p->>'subject', p->>'body_text', p->>'body_text',
    nullif(p->>'delivery_date', '')::date,
    coalesce(p->'order_lines', '[]'::jsonb),
    (p->>'sent_at')::timestamptz,
    nullif(p->>'sent_by_email', ''),
    nullif(p->>'sent_from_mailbox', ''),
    ARRAY(SELECT jsonb_array_elements_text(coalesce(p->'to_emails', '[]'::jsonb))),
    ARRAY(SELECT jsonb_array_elements_text(coalesce(p->'cc_emails', '[]'::jsonb))),
    v_message, v_conversation,
    'outlook', v_event
  ) RETURNING id INTO v_order;

  INSERT INTO public.job_events (job_id, user_id, event_type, detail_json)
  VALUES (v_job, NULL, 'dispatch_v2_outlook_order_recorded', jsonb_build_object(
    'order_id', v_order,
    'box_id', v_box,
    'supplier_id', v_supplier,
    'supplier_name', v_supplier_name,
    'box_created', v_box_created,
    'sent_at', p->>'sent_at',
    'subject', p->>'subject',
    'source_business_event_id', v_event,
    'trigger', v_trigger,
    'line_count', jsonb_array_length(coalesce(p->'order_lines', '[]'::jsonb))
  ));

  RETURN jsonb_build_object('recorded', true, 'order_id', v_order,
    'box_id', v_box, 'box_created', v_box_created, 'reason', NULL);
END $$;

COMMENT ON FUNCTION public.dispatch_v2_record_outlook_order_on_send(jsonb) IS
  'Dispatch v2 send rule (contract section 3g, Shaun 6 Nov 2026): record an order email sent from admin@ in Outlook as a sent Dispatch order (box if missing, else the box is reused; order row; job_events row). Idempotent per captured sent email and supplier. Refuses Dispatch''s own sends. Never sends, never writes suppliers. Called only by ops-api.';
REVOKE ALL ON FUNCTION public.dispatch_v2_record_outlook_order_on_send(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.dispatch_v2_record_outlook_order_on_send(jsonb) TO service_role;
