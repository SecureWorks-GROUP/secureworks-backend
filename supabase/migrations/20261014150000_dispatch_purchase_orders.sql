-- Dispatch slice 5: a purchase order and its email, one supplier at a time.
--
-- Contract: docs/dispatch-slice-5-contract.md. Rules:
-- supabase/functions/ops-api/dispatch_orders.ts. Reads and writes:
-- supabase/functions/ops-api/dispatch_orders_store.ts, through the eleven ops-api
-- `dispatch_order*` / `dispatch_email_link_po` actions and nothing else.
--
-- What this adds:
--   1. Nine nullable columns on purchase_orders, so the 22 live orders, create_po
--      and list_pos (select *) are untouched, and one unique index on
--      (org_id, po_number). A Dispatch order is `source = 'dispatch'` with a
--      `supplier_id`; at most one is open per job and supplier (a partial unique
--      index) until it is cancelled or pushed to Xero.
--   2. po_number_seq moved to 1,000,000, and dispatch_next_po_number(), so
--      Dispatch numbers read PO-1000001 on. Live clock numbers have six digits;
--      the two ranges never meet.
--   3. job_order_emails: one held draft per order email, until it is sent or
--      discarded. Row security on with no policy, revoked from the browser roles,
--      as quote_builder_versions is: only ops-api reaches it.
--   4. dispatch_commit_order and dispatch_commit_order_update: each multi-table
--      write in one transaction, refusing `lines_changed`, `order_changed`,
--      `order_open`, `draft_changed` or `draft_sending` (raised as the message of
--      a P0001) rather than ordering a line edited in another tab; and
--      dispatch_release_unknown_send, which releases a send that was not
--      confirmed to draft together with its job_events row.
--   5. An index on job_material_lines.purchase_order_id, which this slice is
--      the first to write.
--   6. The private bucket dispatch-order-pdfs (skipped where Supabase storage is
--      absent, as in the contract runner). Old versions are kept: a sent email
--      keeps pointing at the bytes it carried.
--
-- Nothing here sends, pushes to Xero, or writes jobs, job status, the Dispatch
-- stage or business_events.
--
-- Rollback: supabase/rollbacks/20261014150000_dispatch_purchase_orders_down.sql.

-- 1. purchase_orders ─────────────────────────────────────────────────────────

ALTER TABLE public.purchase_orders
  ADD COLUMN IF NOT EXISTS supplier_id uuid NULL REFERENCES public.suppliers(id),
  ADD COLUMN IF NOT EXISTS source text NULL,
  ADD COLUMN IF NOT EXISTS created_by_email text NULL,
  ADD COLUMN IF NOT EXISTS pdf_path text NULL,
  ADD COLUMN IF NOT EXISTS pdf_sha256 text NULL,
  ADD COLUMN IF NOT EXISTS pdf_version integer NULL,
  ADD COLUMN IF NOT EXISTS pdf_rendered_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS last_sent_pdf_version integer NULL,
  ADD COLUMN IF NOT EXISTS last_sent_at timestamptz NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'purchase_orders_source_valid'
                 AND conrelid = 'public.purchase_orders'::regclass) THEN
    ALTER TABLE public.purchase_orders
      ADD CONSTRAINT purchase_orders_source_valid CHECK (source IS NULL OR source = 'dispatch');
  END IF;
END $$;

-- Fail closed: an index over duplicate numbers would not build. Zero live on
-- 14 Oct 2026; if that changed, say which number rather than half-apply.
DO $$
DECLARE dup text;
BEGIN
  SELECT po_number INTO dup FROM public.purchase_orders
   GROUP BY org_id, po_number HAVING count(*) > 1 LIMIT 1;
  IF dup IS NOT NULL THEN
    RAISE EXCEPTION 'dispatch purchase orders: duplicate po_number % must be resolved first', dup;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS purchase_orders_org_po_number_key
  ON public.purchase_orders (org_id, po_number);

-- One open Dispatch order per job and supplier (ruling O5): later lines join it.
CREATE UNIQUE INDEX IF NOT EXISTS purchase_orders_open_dispatch_supplier_key
  ON public.purchase_orders (job_id, supplier_id)
  WHERE source = 'dispatch' AND status NOT IN ('cancelled', 'deleted') AND xero_po_id IS NULL;

-- Slice 5 is the first writer of job_material_lines.purchase_order_id, and the
-- commit functions, the read and the purchase_orders ON DELETE SET NULL all look
-- lines up by it.
CREATE INDEX IF NOT EXISTS job_material_lines_purchase_order_id_idx
  ON public.job_material_lines (purchase_order_id)
  WHERE purchase_order_id IS NOT NULL;

COMMENT ON COLUMN public.purchase_orders.source IS
  'dispatch when made by the Dispatch tab (docs/dispatch-slice-5-contract.md); null for every other order.';
COMMENT ON COLUMN public.purchase_orders.created_by_email IS
  'The person who made the order. created_by holds a users.id or null, never an email.';

-- 2. The order number ───────────────────────────────────────────────────────

CREATE SEQUENCE IF NOT EXISTS public.po_number_seq;

-- Never moves the sequence backwards, so a re-apply is a no-op.
DO $$
DECLARE cur bigint; called boolean;
BEGIN
  SELECT last_value, is_called INTO cur, called FROM public.po_number_seq;
  IF NOT called OR cur < 1000000 THEN
    PERFORM setval('public.po_number_seq', 1000000, true);
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.dispatch_next_po_number() RETURNS text
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT 'PO-' || nextval('public.po_number_seq')::text
$$;
COMMENT ON FUNCTION public.dispatch_next_po_number() IS
  'Dispatch slice 5: the next purchase order number, PO-1000001 on. A number once taken is never reused.';
REVOKE ALL ON FUNCTION public.dispatch_next_po_number() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.dispatch_next_po_number() TO service_role;

-- 3. The held draft ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.job_order_emails (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
  purchase_order_id uuid NOT NULL REFERENCES public.purchase_orders(id),
  supplier_id uuid NOT NULL REFERENCES public.suppliers(id),
  kind text NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  subject text NOT NULL,
  body_text text NOT NULL,
  -- sha256 hex of the message as the server last wrote it; a different hash of
  -- body_text means a person edited it.
  body_generated_sha text NOT NULL,
  pdf_version integer NOT NULL,
  pdf_path text NOT NULL,
  pdf_sha256 text NOT NULL,
  line_count integer NOT NULL,
  -- The order lines this draft's PDF holds, so an update email can say which
  -- lines were added or taken off since the last one sent.
  order_lines jsonb NOT NULL DEFAULT '[]'::jsonb,
  to_email_sent text NULL,
  -- What the current send attempt carries, fixed when it is first claimed, so a
  -- person's retry after an unknown result is the same request under the same
  -- idempotency key even if the contact or the thread moved since.
  attempt_to_email text NULL,
  attempt_in_reply_to text NULL,
  -- Raised only after Resend refused an attempt (nothing went), so a corrected
  -- send gets a new idempotency key instead of clashing with the refused one.
  send_attempt integer NOT NULL DEFAULT 1,
  last_error text NULL,
  communication_id uuid NULL REFERENCES public.po_communications(id),
  resend_id text NULL,
  sent_at timestamptz NULL,
  sent_by uuid NULL REFERENCES public.users(id),
  sent_by_email text NULL,
  -- screen: a signed-in person pressed Send; terminal: the ops key, naming the
  -- person who gave the yes in operator_email.
  sent_via text NULL,
  discarded_at timestamptz NULL,
  discarded_by_email text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NULL,
  created_by_email text NULL,
  CONSTRAINT job_order_emails_kind_valid CHECK (kind IN ('order', 'update')),
  CONSTRAINT job_order_emails_status_valid CHECK (status IN ('draft', 'sending', 'sent', 'send_unknown', 'discarded')),
  CONSTRAINT job_order_emails_subject_length CHECK (char_length(subject) BETWEEN 1 AND 300),
  CONSTRAINT job_order_emails_body_length CHECK (char_length(body_text) BETWEEN 1 AND 20000),
  CONSTRAINT job_order_emails_sent_via_valid CHECK (sent_via IS NULL OR sent_via IN ('screen', 'terminal')),
  CONSTRAINT job_order_emails_order_lines_array CHECK (jsonb_typeof(order_lines) = 'array')
);

-- One open draft per order: Update refreshes it rather than adding a second.
CREATE UNIQUE INDEX IF NOT EXISTS job_order_emails_open_per_order_key
  ON public.job_order_emails (purchase_order_id)
  WHERE status IN ('draft', 'sending', 'send_unknown');
CREATE INDEX IF NOT EXISTS job_order_emails_job_id_idx ON public.job_order_emails (job_id);

COMMENT ON TABLE public.job_order_emails IS
  'Dispatch tab (docs/dispatch-slice-5-contract.md): one held purchase order email per row until a person sends or discards it. Written only by ops-api dispatch_order_* actions and the two dispatch_commit_* functions.';

ALTER TABLE public.job_order_emails ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.job_order_emails FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.job_order_emails TO service_role;

-- 4. The three transactions ───────────────────────────────────────────────────

-- Create: the order, its lines stamped, its draft and one job_events row.
-- p: { job_id, org_id, supplier_id, supplier_name, po_number, line_items,
--      lines:[{id,updated_at}], pdf:{path,sha256,version}, actor:{user_id,email},
--      draft:{subject, body_text, body_generated_sha} }
CREATE OR REPLACE FUNCTION public.dispatch_commit_order(p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_job uuid := (p->>'job_id')::uuid;
  v_supplier uuid := (p->>'supplier_id')::uuid;
  v_user uuid := nullif(p#>>'{actor,user_id}', '')::uuid;
  v_email text := nullif(p#>>'{actor,email}', '');
  v_order public.purchase_orders;
  v_draft public.job_order_emails;
  v_expected integer := coalesce(jsonb_array_length(p->'lines'), 0);
  v_count integer;
BEGIN
  IF v_expected = 0 THEN
    RAISE EXCEPTION 'no_lines_to_order';
  END IF;
  IF EXISTS (SELECT 1 FROM public.purchase_orders o
              WHERE o.job_id = v_job AND o.supplier_id = v_supplier AND o.source = 'dispatch'
                AND o.status NOT IN ('cancelled', 'deleted') AND o.xero_po_id IS NULL) THEN
    RAISE EXCEPTION 'order_open';
  END IF;

  INSERT INTO public.purchase_orders (
    org_id, job_id, po_number, supplier_name, supplier_id, source, status, po_type,
    line_items, subtotal, tax, total, reference, created_by, created_by_email,
    pdf_path, pdf_sha256, pdf_version, pdf_rendered_at
  ) VALUES (
    (p->>'org_id')::uuid, v_job, p->>'po_number', p->>'supplier_name', v_supplier, 'dispatch', 'draft', 'material',
    p->'line_items', 0, 0, 0, p->>'reference', v_user, v_email,
    p#>>'{pdf,path}', p#>>'{pdf,sha256}', (p#>>'{pdf,version}')::integer, now()
  ) RETURNING * INTO v_order;

  UPDATE public.job_material_lines l
     SET purchase_order_id = v_order.id, updated_at = now(), updated_by = v_user, updated_by_email = v_email
    FROM jsonb_to_recordset(p->'lines') AS x(id uuid, updated_at timestamptz)
   WHERE l.id = x.id AND l.updated_at = x.updated_at AND l.job_id = v_job
     AND l.supplier_id = v_supplier AND l.status = 'to_order' AND l.purchase_order_id IS NULL;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count <> v_expected THEN
    RAISE EXCEPTION 'lines_changed';
  END IF;
  -- A To order line added in another tab after the read is not left behind.
  IF EXISTS (SELECT 1 FROM public.job_material_lines l
              WHERE l.job_id = v_job AND l.supplier_id = v_supplier
                AND l.status = 'to_order' AND l.purchase_order_id IS NULL) THEN
    RAISE EXCEPTION 'lines_changed';
  END IF;

  INSERT INTO public.job_order_emails (
    org_id, job_id, purchase_order_id, supplier_id, kind, status, subject, body_text,
    body_generated_sha, pdf_version, pdf_path, pdf_sha256, line_count, order_lines,
    created_by, created_by_email
  ) VALUES (
    v_order.org_id, v_job, v_order.id, v_supplier, 'order', 'draft', p#>>'{draft,subject}', p#>>'{draft,body_text}',
    p#>>'{draft,body_generated_sha}', v_order.pdf_version, v_order.pdf_path, v_order.pdf_sha256,
    v_expected, p->'line_items', v_user, v_email
  ) RETURNING * INTO v_draft;

  INSERT INTO public.job_events (job_id, user_id, event_type, detail_json)
  VALUES (v_job, v_user, 'po_created', jsonb_build_object(
    'po_number', v_order.po_number, 'supplier', v_order.supplier_name, 'total', 0,
    'source', 'dispatch', 'operator_email', v_email));

  RETURN jsonb_build_object('order', to_jsonb(v_order), 'draft', to_jsonb(v_draft));
END $$;
COMMENT ON FUNCTION public.dispatch_commit_order(jsonb) IS
  'Dispatch slice 5 create, one transaction: the order, its lines stamped (guarded on each line''s updated_at), the held draft and one po_created job event. Raises lines_changed, order_open or no_lines_to_order.';
REVOKE ALL ON FUNCTION public.dispatch_commit_order(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.dispatch_commit_order(jsonb) TO service_role;

-- Update and cancel. p.mode is 'update' or 'cancel'.
-- update: { order_id, job_id, supplier_id, expected_order_updated_at, line_items,
--           pdf:{path,sha256,version}, keep:[{id,updated_at}], add:[...], remove:[...],
--           actor, draft_update:{id, expected_updated_at, fields:{...}} | draft_insert:{...} }
-- cancel: { order_id, job_id, expected_order_updated_at, actor }
CREATE OR REPLACE FUNCTION public.dispatch_commit_order_update(p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_mode text := p->>'mode';
  v_order_id uuid := (p->>'order_id')::uuid;
  v_job uuid := (p->>'job_id')::uuid;
  v_user uuid := nullif(p#>>'{actor,user_id}', '')::uuid;
  v_email text := nullif(p#>>'{actor,email}', '');
  v_order public.purchase_orders;
  v_draft public.job_order_emails;
  v_count integer;
  v_want integer;
  v_fields jsonb;
BEGIN
  IF v_mode NOT IN ('update', 'cancel') THEN
    RAISE EXCEPTION 'invalid_mode';
  END IF;
  -- Lock the order, then its emails, so a send claim cannot slip in between
  -- this check and the writes below.
  PERFORM 1 FROM public.purchase_orders o WHERE o.id = v_order_id FOR UPDATE;
  PERFORM 1 FROM public.job_order_emails e WHERE e.purchase_order_id = v_order_id FOR UPDATE;
  -- A send in flight or not confirmed holds the order still: its email may have gone.
  IF EXISTS (SELECT 1 FROM public.job_order_emails e
              WHERE e.purchase_order_id = v_order_id AND e.status IN ('sending', 'send_unknown')) THEN
    RAISE EXCEPTION 'draft_sending';
  END IF;

  IF v_mode = 'cancel' THEN
    -- An order whose email went is never cancelled here, even when its sent stamp did not land.
    IF EXISTS (SELECT 1 FROM public.job_order_emails e
                WHERE e.purchase_order_id = v_order_id AND e.status = 'sent') THEN
      RAISE EXCEPTION 'order_sent';
    END IF;
    UPDATE public.purchase_orders o SET status = 'cancelled'
     WHERE o.id = v_order_id AND o.job_id = v_job AND o.source = 'dispatch'
       AND o.updated_at = (p->>'expected_order_updated_at')::timestamptz
       AND o.last_sent_at IS NULL AND o.xero_po_id IS NULL
       AND o.status NOT IN ('cancelled', 'deleted')
     RETURNING * INTO v_order;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'order_changed';
    END IF;
    UPDATE public.job_material_lines l
       SET purchase_order_id = NULL, status = 'to_order', updated_at = now(),
           updated_by = v_user, updated_by_email = v_email
     WHERE l.purchase_order_id = v_order_id;
    UPDATE public.job_order_emails e
       SET status = 'discarded', discarded_at = now(), discarded_by_email = v_email, updated_at = now()
     WHERE e.purchase_order_id = v_order_id AND e.status = 'draft';
    INSERT INTO public.job_events (job_id, user_id, event_type, detail_json)
    VALUES (v_job, v_user, 'po_cancelled', jsonb_build_object(
      'po_number', v_order.po_number, 'supplier', v_order.supplier_name, 'operator_email', v_email));
    RETURN jsonb_build_object('order', to_jsonb(v_order));
  END IF;

  UPDATE public.purchase_orders o
     SET line_items = p->'line_items', pdf_path = p#>>'{pdf,path}', pdf_sha256 = p#>>'{pdf,sha256}',
         pdf_version = (p#>>'{pdf,version}')::integer, pdf_rendered_at = now()
   WHERE o.id = v_order_id AND o.job_id = v_job AND o.source = 'dispatch'
     AND o.updated_at = (p->>'expected_order_updated_at')::timestamptz
     AND o.xero_po_id IS NULL AND o.status NOT IN ('cancelled', 'deleted')
   RETURNING * INTO v_order;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'order_changed';
  END IF;

  -- Lines that stay must be on the order exactly as read.
  SELECT count(*) INTO v_count
    FROM public.job_material_lines l
    JOIN jsonb_to_recordset(coalesce(p->'keep', '[]'::jsonb)) AS x(id uuid, updated_at timestamptz)
      ON l.id = x.id AND l.updated_at = x.updated_at
   WHERE l.purchase_order_id = v_order_id;
  IF v_count <> jsonb_array_length(coalesce(p->'keep', '[]'::jsonb)) THEN
    RAISE EXCEPTION 'lines_changed';
  END IF;

  UPDATE public.job_material_lines l
     SET purchase_order_id = NULL, status = 'to_order', updated_at = now(),
         updated_by = v_user, updated_by_email = v_email
    FROM jsonb_to_recordset(coalesce(p->'remove', '[]'::jsonb)) AS x(id uuid, updated_at timestamptz)
   WHERE l.id = x.id AND l.updated_at = x.updated_at AND l.purchase_order_id = v_order_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count <> jsonb_array_length(coalesce(p->'remove', '[]'::jsonb)) THEN
    RAISE EXCEPTION 'lines_changed';
  END IF;

  UPDATE public.job_material_lines l
     SET purchase_order_id = v_order_id, updated_at = now(), updated_by = v_user, updated_by_email = v_email
    FROM jsonb_to_recordset(coalesce(p->'add', '[]'::jsonb)) AS x(id uuid, updated_at timestamptz)
   WHERE l.id = x.id AND l.updated_at = x.updated_at AND l.job_id = v_job
     AND l.supplier_id = v_order.supplier_id AND l.status = 'to_order' AND l.purchase_order_id IS NULL;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count <> jsonb_array_length(coalesce(p->'add', '[]'::jsonb)) THEN
    RAISE EXCEPTION 'lines_changed';
  END IF;

  -- The order holds exactly keep + add, and no To order line is left behind.
  v_want := jsonb_array_length(coalesce(p->'keep', '[]'::jsonb)) + jsonb_array_length(coalesce(p->'add', '[]'::jsonb));
  SELECT count(*) INTO v_count FROM public.job_material_lines l WHERE l.purchase_order_id = v_order_id;
  IF v_count <> v_want OR v_want = 0 THEN
    RAISE EXCEPTION 'lines_changed';
  END IF;
  IF EXISTS (SELECT 1 FROM public.job_material_lines l
              WHERE l.job_id = v_job AND l.supplier_id = v_order.supplier_id
                AND l.status = 'to_order' AND l.purchase_order_id IS NULL
                AND NOT EXISTS (SELECT 1 FROM jsonb_to_recordset(coalesce(p->'remove', '[]'::jsonb)) AS r(id uuid)
                                 WHERE r.id = l.id)) THEN
    RAISE EXCEPTION 'lines_changed';
  END IF;

  IF p ? 'draft_update' THEN
    v_fields := p#>'{draft_update,fields}';
    UPDATE public.job_order_emails e
       SET pdf_version = v_order.pdf_version, pdf_path = v_order.pdf_path, pdf_sha256 = v_order.pdf_sha256,
           line_count = v_want, order_lines = p->'line_items',
           subject = coalesce(v_fields->>'subject', e.subject),
           body_text = coalesce(v_fields->>'body_text', e.body_text),
           body_generated_sha = coalesce(v_fields->>'body_generated_sha', e.body_generated_sha),
           last_error = NULL, updated_at = now()
     WHERE e.id = (p#>>'{draft_update,id}')::uuid AND e.purchase_order_id = v_order_id
       AND e.status = 'draft' AND e.updated_at = (p#>>'{draft_update,expected_updated_at}')::timestamptz
     RETURNING * INTO v_draft;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'draft_changed';
    END IF;
  ELSE
    IF EXISTS (SELECT 1 FROM public.job_order_emails e
                WHERE e.purchase_order_id = v_order_id AND e.status = 'draft') THEN
      RAISE EXCEPTION 'draft_changed';
    END IF;
    INSERT INTO public.job_order_emails (
      org_id, job_id, purchase_order_id, supplier_id, kind, status, subject, body_text,
      body_generated_sha, pdf_version, pdf_path, pdf_sha256, line_count, order_lines,
      created_by, created_by_email
    ) VALUES (
      v_order.org_id, v_job, v_order_id, v_order.supplier_id, p#>>'{draft_insert,kind}', 'draft',
      p#>>'{draft_insert,subject}', p#>>'{draft_insert,body_text}', p#>>'{draft_insert,body_generated_sha}',
      v_order.pdf_version, v_order.pdf_path, v_order.pdf_sha256, v_want, p->'line_items', v_user, v_email
    ) RETURNING * INTO v_draft;
  END IF;

  RETURN jsonb_build_object('order', to_jsonb(v_order), 'draft', to_jsonb(v_draft));
END $$;
COMMENT ON FUNCTION public.dispatch_commit_order_update(jsonb) IS
  'Dispatch slice 5 update and cancel, one transaction each: guarded on the order''s and every touched line''s updated_at. Raises order_changed, lines_changed, draft_changed or draft_sending.';
REVOKE ALL ON FUNCTION public.dispatch_commit_order_update(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.dispatch_commit_order_update(jsonb) TO service_role;

-- Release a send that was not confirmed back to draft, on a person's press, and record who and
-- when in the same transaction: the draft is never unlocked without its job_events row.
-- p: { draft_id, job_id, prior_status, prior_updated_at, actor:{user_id,email}, via }
CREATE OR REPLACE FUNCTION public.dispatch_release_unknown_send(p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_user uuid := nullif(p#>>'{actor,user_id}', '')::uuid;
  v_email text := nullif(p#>>'{actor,email}', '');
  v_prior public.job_order_emails;
  v_draft public.job_order_emails;
  v_order public.purchase_orders;
  v_now timestamptz := now();
BEGIN
  IF v_email IS NULL THEN
    RAISE EXCEPTION 'operator_required';
  END IF;
  SELECT * INTO v_prior FROM public.job_order_emails e
   WHERE e.id = (p->>'draft_id')::uuid AND e.job_id = (p->>'job_id')::uuid
   FOR UPDATE;
  IF NOT FOUND OR v_prior.status NOT IN ('sending', 'send_unknown') THEN
    RAISE EXCEPTION 'draft_not_unknown';
  END IF;
  IF v_prior.status <> p->>'prior_status' OR v_prior.updated_at <> (p->>'prior_updated_at')::timestamptz THEN
    RAISE EXCEPTION 'draft_changed';
  END IF;
  UPDATE public.job_order_emails e
     SET status = 'draft', attempt_to_email = NULL, attempt_in_reply_to = NULL,
         send_attempt = v_prior.send_attempt + 1,
         last_error = left('Released as not sent by ' || v_email, 1000), updated_at = v_now
   WHERE e.id = v_prior.id
   RETURNING * INTO v_draft;
  SELECT * INTO v_order FROM public.purchase_orders o WHERE o.id = v_prior.purchase_order_id;
  INSERT INTO public.job_events (job_id, user_id, event_type, detail_json)
  VALUES (v_prior.job_id, v_user, 'po_email_send_released', jsonb_build_object(
    'po_id', v_prior.purchase_order_id, 'po_number', v_order.po_number, 'draft_id', v_prior.id,
    'prior_status', v_prior.status, 'prior_attempt', v_prior.send_attempt, 'released_at', v_now,
    'operator_email', v_email, 'via', p->>'via', 'source', 'dispatch'));
  RETURN jsonb_build_object('draft', to_jsonb(v_draft));
END $$;
COMMENT ON FUNCTION public.dispatch_release_unknown_send(jsonb) IS
  'Dispatch slice 5: a person releases a sending or send_unknown draft to draft under the next attempt, with its po_email_send_released job_events row, in one transaction. Raises operator_required, draft_not_unknown or draft_changed. Sends nothing.';
REVOKE ALL ON FUNCTION public.dispatch_release_unknown_send(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.dispatch_release_unknown_send(jsonb) TO service_role;

-- 5. The private bucket. Skipped where Supabase storage is absent (contract runner).
DO $bucket$
BEGIN
  IF to_regclass('storage.buckets') IS NULL THEN
    RAISE NOTICE 'dispatch-order-pdfs: storage absent, bucket not created';
    RETURN;
  END IF;
  EXECUTE $q$INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    VALUES ('dispatch-order-pdfs', 'dispatch-order-pdfs', false, 10485760, ARRAY['application/pdf'])
    ON CONFLICT (id) DO NOTHING$q$;
  IF EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'dispatch-order-pdfs' AND public) THEN
    RAISE EXCEPTION 'dispatch_order_pdfs_bucket_public: bucket dispatch-order-pdfs exists and is public';
  END IF;
END $bucket$;
