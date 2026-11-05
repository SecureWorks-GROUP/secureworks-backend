-- Dispatch v2, Tweak 2 piece 1 (Shaun, 5 Nov 2026): an order Shaun sent from
-- Outlook becomes a Dispatch order by itself.
--
-- Shaun often orders straight from Outlook (admin@secureworkswa.com.au), for
-- example "Material Order Ref SWF-261586" to R&R Fencing on 3 Nov 2026. The
-- supplier's reply was matched to the job by its number only, with no order
-- to tie it to, so nothing moved on the board. Now, when a supplier reply is
-- matched only by the job number and the job has no Dispatch order for that
-- supplier, the reply scan finds our sent email in the capture (business_events,
-- folder 'sent') and records it here as a SENT order: its real sent time, the
-- mailbox, the Outlook message and conversation ids, the subject and body,
-- and the order lines read from "Materials Needed". The reply is then tied to
-- it, so the normal steps run (the box moves by the payment rules, a date
-- suggestion waits for Shaun's Accept, Tweak 1 when confirmed).
--
-- This migration adds:
--   * dispatch_supplier_order_emails.origin: 'dispatch' (made and sent from
--     the Dispatch screen, every row before this) or 'outlook' (recorded from
--     an email Shaun sent from Outlook). An Outlook row is always 'sent', so
--     it can never be edited as a draft, sent again or sent twice.
--   * dispatch_supplier_order_emails.source_business_event_id: the captured
--     sent email it was recorded from. Unique: one order per sent email,
--     however many replies or scans see it.
--   * dispatch_v2_record_outlook_order(p jsonb): the one write, in one
--     transaction. It makes the supplier box if the job has none for that
--     supplier, inserts the sent order row and a job_events row, and returns
--     the order id. It never sends anything, never adds material lines, never
--     writes the suppliers table (Xero-synced, read only here) and never moves
--     a job's stage or status.
--
-- Rules and caller: supabase/functions/ops-api/dispatch_v2_outlook_order.ts.
-- Contract: docs/dispatch-v2-board-contract.md section 3f.1. Only ops-api
-- (service role) may call the function.
--
-- No existing row changes (every row reads origin 'dispatch'). No backfill.
--
-- Rollback: supabase/rollbacks/20261105130000_dispatch_v2_outlook_orders_down.sql.

ALTER TABLE public.dispatch_supplier_order_emails
  ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT 'dispatch',
  ADD COLUMN IF NOT EXISTS source_business_event_id uuid NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'dispatch_supplier_order_emails_origin_valid'
      AND conrelid = 'public.dispatch_supplier_order_emails'::regclass
  ) THEN
    ALTER TABLE public.dispatch_supplier_order_emails
      ADD CONSTRAINT dispatch_supplier_order_emails_origin_valid
      CHECK (origin IN ('dispatch', 'outlook'));
  END IF;
  -- An Outlook order is a record of an email that already went: always sent,
  -- with its sent time and the captured email it came from.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'dispatch_supplier_order_emails_outlook_shape'
      AND conrelid = 'public.dispatch_supplier_order_emails'::regclass
  ) THEN
    ALTER TABLE public.dispatch_supplier_order_emails
      ADD CONSTRAINT dispatch_supplier_order_emails_outlook_shape
      CHECK (
        origin <> 'outlook'
        OR (status = 'sent' AND sent_at IS NOT NULL AND source_business_event_id IS NOT NULL)
      );
  END IF;
END $$;

-- One order per captured sent email.
CREATE UNIQUE INDEX IF NOT EXISTS dispatch_supplier_order_emails_source_event_idx
  ON public.dispatch_supplier_order_emails (source_business_event_id)
  WHERE source_business_event_id IS NOT NULL;

COMMENT ON COLUMN public.dispatch_supplier_order_emails.origin IS
  'dispatch = made and sent from the Dispatch screen. outlook = recorded by the reply scan from an order email Shaun sent from Outlook (Tweak 2, contract section 3f.1); always sent, never a draft, never sent again.';
COMMENT ON COLUMN public.dispatch_supplier_order_emails.source_business_event_id IS
  'For an outlook order: the business_events row (outlook-mail-capture, folder sent) it was recorded from. Unique.';

-- The one write. p (jsonb):
--   org_id, job_id, supplier_id                       uuids
--   related_supplier_ids                              uuid[]: every Xero
--     contact that is the same supplier (the approved entry's links). Any
--     order on the job to one of them, other than this sent email's own,
--     means the job already has a Dispatch order: nothing is recorded.
--   work_type, team_cc_email, subject, body_text      text
--   to_emails, cc_emails                              text[]
--   delivery_date                                     date or null
--   order_lines                                       jsonb array
--   standing_lines_included                           boolean
--   sent_at                                           timestamptz
--   sent_by_email, sent_from_mailbox                  text
--   sent_internet_message_id, sent_conversation_id    text
--   source_business_event_id                          uuid
-- Returns { recorded, order_id, box_created, reason }. reason is
-- 'already_recorded' (this sent email is already an order: its id comes back),
-- 'dispatch_order_exists', 'job_not_found', 'supplier_not_found' or
-- 'supplier_inactive' (nothing written), or null when recorded.
CREATE OR REPLACE FUNCTION public.dispatch_v2_record_outlook_order(p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_org uuid := (p->>'org_id')::uuid;
  v_job uuid := (p->>'job_id')::uuid;
  v_supplier uuid := (p->>'supplier_id')::uuid;
  v_event uuid := (p->>'source_business_event_id')::uuid;
  v_related uuid[];
  v_existing uuid;
  v_supplier_name text;
  v_supplier_active boolean;
  v_box uuid;
  v_order uuid;
BEGIN
  IF v_org IS NULL OR v_job IS NULL OR v_supplier IS NULL OR v_event IS NULL THEN
    RAISE EXCEPTION 'outlook_order_missing_ids';
  END IF;
  SELECT coalesce(array_agg(x::uuid), ARRAY[]::uuid[])
    INTO v_related
    FROM jsonb_array_elements_text(coalesce(p->'related_supplier_ids', '[]'::jsonb)) AS x;
  v_related := array_append(v_related, v_supplier);

  -- One run at a time per job, so two scans can never both record.
  PERFORM pg_advisory_xact_lock(hashtextextended('dispatch_v2_outlook_order:' || v_job::text, 0));

  SELECT id INTO v_existing
    FROM public.dispatch_supplier_order_emails
   WHERE source_business_event_id = v_event;
  IF v_existing IS NOT NULL THEN
    RETURN jsonb_build_object('recorded', false, 'order_id', v_existing,
      'box_created', false, 'reason', 'already_recorded');
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.dispatch_supplier_order_emails
     WHERE job_id = v_job
       AND supplier_id = ANY (v_related)
       AND status <> 'discarded'
  ) THEN
    RETURN jsonb_build_object('recorded', false, 'order_id', NULL,
      'box_created', false, 'reason', 'dispatch_order_exists');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.jobs WHERE id = v_job AND org_id = v_org) THEN
    RETURN jsonb_build_object('recorded', false, 'order_id', NULL,
      'box_created', false, 'reason', 'job_not_found');
  END IF;

  -- The supplier's name as Xero has it. Read only: suppliers is never written.
  SELECT name, coalesce(is_active, true) INTO v_supplier_name, v_supplier_active
    FROM public.suppliers WHERE id = v_supplier;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('recorded', false, 'order_id', NULL,
      'box_created', false, 'reason', 'supplier_not_found');
  END IF;
  IF NOT v_supplier_active THEN
    RETURN jsonb_build_object('recorded', false, 'order_id', NULL,
      'box_created', false, 'reason', 'supplier_inactive');
  END IF;

  -- The supplier box, only when the job has none for this supplier. Last in
  -- the job's order, never ticked as the main supplier.
  INSERT INTO public.job_material_suppliers
    (org_id, job_id, supplier_id, supplier_name, position, is_main_supplier)
  SELECT v_org, v_job, v_supplier, v_supplier_name,
         coalesce((SELECT max(position) FROM public.job_material_suppliers WHERE job_id = v_job), 0) + 1,
         false
  ON CONFLICT (job_id, supplier_id) DO NOTHING
  RETURNING id INTO v_box;

  INSERT INTO public.dispatch_supplier_order_emails (
    org_id, job_id, supplier_id, supplier_name, approved_email_id, work_type,
    is_main_supplier, standing_lines_included, status, team_cc_email,
    to_emails, cc_emails, subject, body_text, built_body_text, delivery_date,
    order_lines, sent_at, sent_by_email, sent_from_mailbox, sent_to_emails,
    sent_cc_emails, sent_internet_message_id, sent_conversation_id,
    origin, source_business_event_id
  ) VALUES (
    v_org, v_job, v_supplier, v_supplier_name, NULL,
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
    nullif(p->>'sent_internet_message_id', ''),
    nullif(p->>'sent_conversation_id', ''),
    'outlook', v_event
  ) RETURNING id INTO v_order;

  INSERT INTO public.job_events (job_id, user_id, event_type, detail_json)
  VALUES (v_job, NULL, 'dispatch_v2_outlook_order_recorded', jsonb_build_object(
    'order_id', v_order,
    'supplier_id', v_supplier,
    'supplier_name', v_supplier_name,
    'box_created', v_box IS NOT NULL,
    'sent_at', p->>'sent_at',
    'subject', p->>'subject',
    'source_business_event_id', v_event,
    'reply_email_id', p->>'reply_email_id',
    'line_count', jsonb_array_length(coalesce(p->'order_lines', '[]'::jsonb))
  ));

  RETURN jsonb_build_object('recorded', true, 'order_id', v_order,
    'box_created', v_box IS NOT NULL, 'reason', NULL);
END $$;

COMMENT ON FUNCTION public.dispatch_v2_record_outlook_order(jsonb) IS
  'Dispatch v2 Tweak 2 (contract section 3f.1): record an order email Shaun sent from Outlook as a sent Dispatch order (box if missing, order row, job_events row). Idempotent per captured sent email. Never sends, never writes suppliers. Called only by ops-api.';
REVOKE ALL ON FUNCTION public.dispatch_v2_record_outlook_order(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.dispatch_v2_record_outlook_order(jsonb) TO service_role;
