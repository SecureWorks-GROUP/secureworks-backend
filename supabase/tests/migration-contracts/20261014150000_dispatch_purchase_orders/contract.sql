-- Contract: 20261014150000_dispatch_purchase_orders. The held drafts sit where no browser role can
-- reach them; the three functions run only as the service role; numbers start at PO-1000001 and are
-- unique; one open Dispatch order per job and supplier; create stamps exactly the To order lines it
-- was given and refuses a line changed elsewhere; update adds and takes off lines and refreshes the
-- draft; cancel releases every line and discards the draft; a send in flight holds the order.
\set ON_ERROR_STOP on
BEGIN;

CREATE FUNCTION pg_temp.po_assert(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'dispatch purchase orders contract: %', p_msg; END IF; END $$;

-- The message a statement raised, or null when it ran.
CREATE FUNCTION pg_temp.po_raised(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN
 EXECUTE p_sql;
 RETURN NULL;
EXCEPTION WHEN raise_exception OR check_violation OR unique_violation OR foreign_key_violation THEN
 RETURN SQLERRM;
END $$;

-- 1. Locked away from the browser, reachable by ops-api.
DO $$
DECLARE p text; f text;
BEGIN
 PERFORM pg_temp.po_assert((SELECT relrowsecurity FROM pg_class WHERE oid = 'public.job_order_emails'::regclass),
  'row level security must be on for public.job_order_emails');
 PERFORM pg_temp.po_assert(NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'job_order_emails'),
  'public.job_order_emails must carry no policy: only ops-api reaches it');
 FOREACH p IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'] LOOP
  PERFORM pg_temp.po_assert(NOT has_table_privilege('anon', 'public.job_order_emails', p)
   AND NOT has_table_privilege('authenticated', 'public.job_order_emails', p),
   'browser roles must hold no privilege on public.job_order_emails');
 END LOOP;
 FOREACH p IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE'] LOOP
  PERFORM pg_temp.po_assert(has_table_privilege('service_role', 'public.job_order_emails', p),
   format('service_role (ops-api) must be able to %s public.job_order_emails', p));
 END LOOP;
 FOREACH f IN ARRAY ARRAY['public.dispatch_next_po_number()', 'public.dispatch_commit_order(jsonb)',
                          'public.dispatch_commit_order_update(jsonb)'] LOOP
  PERFORM pg_temp.po_assert(NOT has_function_privilege('anon', f, 'EXECUTE')
   AND NOT has_function_privilege('authenticated', f, 'EXECUTE'),
   format('browser roles must not execute %s', f));
  PERFORM pg_temp.po_assert(has_function_privilege('service_role', f, 'EXECUTE'),
   format('service_role must execute %s', f));
 END LOOP;
END $$;

-- 2. The nine new columns are nullable; the two indexes exist; the sequence is at 1,000,000 or on.
SELECT pg_temp.po_assert((SELECT count(*) FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'purchase_orders' AND is_nullable = 'YES'
    AND column_name IN ('supplier_id', 'source', 'created_by_email', 'pdf_path', 'pdf_sha256', 'pdf_version',
                        'pdf_rendered_at', 'last_sent_pdf_version', 'last_sent_at')) = 9,
 'purchase_orders must carry the nine nullable slice 5 columns');
SELECT pg_temp.po_assert(to_regclass('public.purchase_orders_org_po_number_key') IS NOT NULL,
 'the (org_id, po_number) unique index must exist');
SELECT pg_temp.po_assert(to_regclass('public.job_material_lines_purchase_order_id_idx') IS NOT NULL,
 'job_material_lines.purchase_order_id must be indexed');
SELECT pg_temp.po_assert((SELECT is_called AND last_value >= 1000000 FROM public.po_number_seq),
 'po_number_seq must give 1,000,001 or more next');
SELECT pg_temp.po_assert(public.dispatch_next_po_number() ~ '^PO-[0-9]{7,}$',
 'dispatch_next_po_number must answer PO- and at least seven digits');

-- 3. Fixtures: one job, one chosen supplier, three lines (two To order, one Not reviewed).
INSERT INTO public.jobs (id, org_id, status, type)
VALUES ('9f000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000001', 'order_materials', 'fencing');
INSERT INTO public.suppliers (id, name) VALUES ('9f100000-0000-4000-8000-000000000001', 'Example Steel');
INSERT INTO public.job_material_suppliers (org_id, job_id, supplier_id, supplier_name, position)
VALUES ('00000000-0000-0000-0000-000000000001', '9f000000-0000-4000-8000-000000000001',
        '9f100000-0000-4000-8000-000000000001', 'Example Steel', 1);
INSERT INTO public.job_material_lines (id, org_id, job_id, supplier_id, description, quantity, unit, status, position)
VALUES ('9f300000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000001', '9f000000-0000-4000-8000-000000000001',
        '9f100000-0000-4000-8000-000000000001', 'Steel post 65x65 2.4 m', 16, 'posts', 'to_order', 1),
       ('9f300000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000001', '9f000000-0000-4000-8000-000000000001',
        '9f100000-0000-4000-8000-000000000001', 'Top rail 2.4 m', 36, 'rails', 'to_order', 2),
       ('9f300000-0000-4000-8000-000000000003', '00000000-0000-0000-0000-000000000001', '9f000000-0000-4000-8000-000000000001',
        '9f100000-0000-4000-8000-000000000001', 'Gate kit', 1, NULL, 'not_reviewed', 3);

CREATE TEMP TABLE po_args AS
SELECT jsonb_build_object(
  'job_id', '9f000000-0000-4000-8000-000000000001', 'org_id', '00000000-0000-0000-0000-000000000001',
  'supplier_id', '9f100000-0000-4000-8000-000000000001', 'supplier_name', 'Example Steel',
  'po_number', 'PO-9000001', 'reference', 'SWF-900001',
  'line_items', '[{"line_id":"9f300000-0000-4000-8000-000000000001"},{"line_id":"9f300000-0000-4000-8000-000000000002"}]'::jsonb,
  'pdf', jsonb_build_object('path', 'job/PO-9000001-v1.pdf', 'sha256', 'aa', 'version', 1),
  'actor', jsonb_build_object('email', 'shaun@example.com'),
  'draft', jsonb_build_object('subject', 'Purchase order PO-9000001 for SWF-900001', 'body_text', 'Hi team,', 'body_generated_sha', 'bb'),
  'lines', (SELECT jsonb_agg(jsonb_build_object('id', id, 'updated_at', updated_at) ORDER BY position)
              FROM public.job_material_lines WHERE status = 'to_order' AND job_id = '9f000000-0000-4000-8000-000000000001')
) AS p;

-- 4. A stale line stamp is refused and nothing is written.
SELECT pg_temp.po_assert(pg_temp.po_raised($q$
 SELECT public.dispatch_commit_order(jsonb_set(p, '{lines,0,updated_at}', '"2001-01-01T00:00:00Z"')) FROM po_args
$q$) = 'lines_changed', 'a line changed elsewhere must refuse lines_changed');
SELECT pg_temp.po_assert(NOT EXISTS (SELECT 1 FROM public.purchase_orders WHERE po_number = 'PO-9000001'),
 'a refused create must leave no order behind');
-- Only one of the two To order lines given: the other would be left behind.
SELECT pg_temp.po_assert(pg_temp.po_raised($q$
 SELECT public.dispatch_commit_order(jsonb_set(p, '{lines}', (p->'lines') - 1)) FROM po_args
$q$) = 'lines_changed', 'a create that leaves a To order line behind must refuse lines_changed');

-- 5. Create: the order, the two lines stamped, one draft and one po_created event.
SELECT public.dispatch_commit_order(p) FROM po_args;
SELECT pg_temp.po_assert((SELECT source = 'dispatch' AND status = 'draft' AND total = 0 AND created_by IS NULL
   AND created_by_email = 'shaun@example.com' AND pdf_version = 1
  FROM public.purchase_orders WHERE po_number = 'PO-9000001'), 'create must write one Dispatch order with no price');
SELECT pg_temp.po_assert((SELECT count(*) FROM public.job_material_lines l JOIN public.purchase_orders o ON o.id = l.purchase_order_id
  WHERE o.po_number = 'PO-9000001') = 2, 'create must stamp exactly the two To order lines');
SELECT pg_temp.po_assert((SELECT purchase_order_id IS NULL FROM public.job_material_lines WHERE id = '9f300000-0000-4000-8000-000000000003'),
 'a Not reviewed line must never go on an order');
SELECT pg_temp.po_assert((SELECT count(*) FROM public.job_order_emails e JOIN public.purchase_orders o ON o.id = e.purchase_order_id
  WHERE o.po_number = 'PO-9000001' AND e.status = 'draft' AND e.kind = 'order' AND e.line_count = 2) = 1,
 'create must hold one draft');
SELECT pg_temp.po_assert((SELECT count(*) FROM public.job_events WHERE job_id = '9f000000-0000-4000-8000-000000000001'
  AND event_type = 'po_created' AND detail_json->>'source' = 'dispatch') = 1, 'create must write one po_created event');

-- 6. A second open order for the same supplier, and a second number, are refused.
SELECT pg_temp.po_assert(pg_temp.po_raised($q$
 SELECT public.dispatch_commit_order(jsonb_set(p, '{po_number}', '"PO-9000002"')) FROM po_args
$q$) = 'order_open', 'a second open Dispatch order for one supplier must refuse order_open');
SELECT pg_temp.po_assert(pg_temp.po_raised($q$
 INSERT INTO public.purchase_orders (org_id, job_id, po_number, supplier_name)
 VALUES ('00000000-0000-0000-0000-000000000001', NULL, 'PO-9000001', 'Elsewhere')
$q$) IS NOT NULL, 'an order number must be unique in the organisation');

-- 7. Update: take one line off, add the Not reviewed line once it is To order; the draft follows.
UPDATE public.job_material_lines SET status = 'to_order', updated_at = updated_at + interval '1 second'
 WHERE id = '9f300000-0000-4000-8000-000000000003';
CREATE TEMP TABLE po_upd AS
SELECT jsonb_build_object(
  'mode', 'update', 'order_id', o.id, 'job_id', o.job_id, 'expected_order_updated_at', o.updated_at,
  'line_items', '[{"line_id":"9f300000-0000-4000-8000-000000000001"},{"line_id":"9f300000-0000-4000-8000-000000000003"}]'::jsonb,
  'pdf', jsonb_build_object('path', 'job/PO-9000001-v2.pdf', 'sha256', 'cc', 'version', 2),
  'actor', jsonb_build_object('email', 'shaun@example.com'),
  'keep', (SELECT jsonb_agg(jsonb_build_object('id', id, 'updated_at', updated_at)) FROM public.job_material_lines
            WHERE id = '9f300000-0000-4000-8000-000000000001'),
  'remove', (SELECT jsonb_agg(jsonb_build_object('id', id, 'updated_at', updated_at)) FROM public.job_material_lines
            WHERE id = '9f300000-0000-4000-8000-000000000002'),
  'add', (SELECT jsonb_agg(jsonb_build_object('id', id, 'updated_at', updated_at)) FROM public.job_material_lines
            WHERE id = '9f300000-0000-4000-8000-000000000003'),
  'draft_update', jsonb_build_object('id', e.id, 'expected_updated_at', e.updated_at,
     'fields', jsonb_build_object('body_text', 'Hi team, updated', 'body_generated_sha', 'dd'))
) AS p
FROM public.purchase_orders o JOIN public.job_order_emails e ON e.purchase_order_id = o.id AND e.status = 'draft'
WHERE o.po_number = 'PO-9000001';

SELECT pg_temp.po_assert(pg_temp.po_raised($q$
 SELECT public.dispatch_commit_order_update(jsonb_set(p, '{expected_order_updated_at}', '"2001-01-01T00:00:00Z"')) FROM po_upd
$q$) = 'order_changed', 'an update on a stale order stamp must refuse order_changed');
SELECT public.dispatch_commit_order_update(p) FROM po_upd;
SELECT pg_temp.po_assert((SELECT purchase_order_id IS NULL AND status = 'to_order' FROM public.job_material_lines
  WHERE id = '9f300000-0000-4000-8000-000000000002'), 'a line taken off goes back to To order with no order');
SELECT pg_temp.po_assert((SELECT purchase_order_id IS NOT NULL FROM public.job_material_lines
  WHERE id = '9f300000-0000-4000-8000-000000000003'), 'a new To order line joins the order');
SELECT pg_temp.po_assert((SELECT pdf_version = 2 AND line_count = 2 AND body_text = 'Hi team, updated'
  FROM public.job_order_emails WHERE status = 'draft' AND job_id = '9f000000-0000-4000-8000-000000000001'),
 'the open draft follows the new PDF and, unedited, the new message');

-- 8. A send in flight holds the order: no update and no cancel.
UPDATE public.job_order_emails SET status = 'send_unknown' WHERE job_id = '9f000000-0000-4000-8000-000000000001' AND status = 'draft';
SELECT pg_temp.po_assert(pg_temp.po_raised($q$
 SELECT public.dispatch_commit_order_update(jsonb_build_object('mode', 'cancel', 'order_id', o.id, 'job_id', o.job_id,
   'expected_order_updated_at', o.updated_at)) FROM public.purchase_orders o WHERE o.po_number = 'PO-9000001'
$q$) = 'draft_sending', 'an order whose email may have gone must not be cancelled');
UPDATE public.job_order_emails SET status = 'draft' WHERE job_id = '9f000000-0000-4000-8000-000000000001' AND status = 'send_unknown';

-- 9. Cancel, never sent: the order cancelled, every line released, the draft discarded, one event.
SELECT public.dispatch_commit_order_update(jsonb_build_object('mode', 'cancel', 'order_id', o.id, 'job_id', o.job_id,
  'expected_order_updated_at', o.updated_at, 'actor', jsonb_build_object('email', 'shaun@example.com')))
FROM public.purchase_orders o WHERE o.po_number = 'PO-9000001';
SELECT pg_temp.po_assert((SELECT status = 'cancelled' FROM public.purchase_orders WHERE po_number = 'PO-9000001'),
 'cancel must set the order cancelled');
SELECT pg_temp.po_assert(NOT EXISTS (SELECT 1 FROM public.job_material_lines
  WHERE job_id = '9f000000-0000-4000-8000-000000000001' AND (purchase_order_id IS NOT NULL OR status <> 'to_order')),
 'cancel must release every line on the order to To order');
SELECT pg_temp.po_assert(NOT EXISTS (SELECT 1 FROM public.job_order_emails
  WHERE job_id = '9f000000-0000-4000-8000-000000000001' AND status <> 'discarded'), 'cancel must discard the draft');
SELECT pg_temp.po_assert((SELECT count(*) FROM public.job_events WHERE job_id = '9f000000-0000-4000-8000-000000000001'
  AND event_type = 'po_cancelled') = 1, 'cancel must write one po_cancelled event');

-- 10. A cancelled order frees the supplier for a new one; a sent order cannot be cancelled.
SELECT public.dispatch_commit_order(jsonb_set(jsonb_set(jsonb_set(p, '{po_number}', '"PO-9000003"'), '{line_items}',
  '[{"line_id":"9f300000-0000-4000-8000-000000000001"},{"line_id":"9f300000-0000-4000-8000-000000000002"},{"line_id":"9f300000-0000-4000-8000-000000000003"}]'::jsonb),
  '{lines}', (SELECT jsonb_agg(jsonb_build_object('id', id, 'updated_at', updated_at)) FROM public.job_material_lines
              WHERE job_id = '9f000000-0000-4000-8000-000000000001')))
FROM po_args;
UPDATE public.purchase_orders SET last_sent_at = now(), status = 'sent' WHERE po_number = 'PO-9000003';
SELECT pg_temp.po_assert(pg_temp.po_raised($q$
 SELECT public.dispatch_commit_order_update(jsonb_build_object('mode', 'cancel', 'order_id', o.id, 'job_id', o.job_id,
   'expected_order_updated_at', o.updated_at)) FROM public.purchase_orders o WHERE o.po_number = 'PO-9000003'
$q$) = 'order_changed', 'a sent order must not be cancelled');

-- 11. The draft keeps its shape.
SELECT pg_temp.po_assert(pg_temp.po_raised($q$
 UPDATE public.job_order_emails SET status = 'queued' WHERE job_id = '9f000000-0000-4000-8000-000000000001'
$q$) IS NOT NULL, 'a draft status outside the five must be refused');
SELECT pg_temp.po_assert(pg_temp.po_raised($q$
 UPDATE public.job_order_emails SET subject = '' WHERE job_id = '9f000000-0000-4000-8000-000000000001'
$q$) IS NOT NULL, 'an empty subject must be refused');

ROLLBACK;
