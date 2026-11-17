-- CI uses registered prerequisites. Isolated local proof uses main's actual
-- cost schema and line reader. No function stand-ins. Its legacy fixture view
-- contains only main's PO arm, sufficient for the declared off-parity fixture.
SELECT to_regclass('public.v_job_cost_events_lines') IS NULL AS isolated_reconcile_setup \gset
\if :isolated_reconcile_setup
DO $roles$ BEGIN
 IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF;
 IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF;
 IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role; END IF;
END $roles$;
CREATE TABLE public.jobs(id uuid PRIMARY KEY,org_id uuid,job_number text,type text,status text);
CREATE TABLE public.feature_flags(flag_name text PRIMARY KEY,enabled boolean,description text);
CREATE TABLE public.purchase_orders(id uuid PRIMARY KEY,job_id uuid,po_number text,supplier_name text,
 status text,notes text,delivery_date date,created_at timestamptz,invoice_received_at timestamptz,
 subtotal numeric,total numeric,last_sent_at timestamptz,xero_bill_id text);
CREATE TABLE public.job_order_emails(purchase_order_id uuid,sent_at timestamptz,status text);
\ir ../../../migrations/20261117160400_job_cost_lines.sql
\ir main_lines_reader.sql
CREATE VIEW public.v_job_cost_events_legacy AS
 WITH po_base AS (
         SELECT p.id,
            p.job_id,
            p.po_number,
            p.supplier_name,
            p.status,
            p.notes,
            p.delivery_date,
            p.created_at,
            p.invoice_received_at,
                CASE
                    WHEN p.subtotal > 0::numeric THEN p.subtotal
                    WHEN p.total > 0::numeric THEN p.total / 1.1
                    ELSE NULL::numeric
                END AS po_amount_ex,
            NOT (COALESCE(p.subtotal, 0::numeric) > 0::numeric OR COALESCE(p.total, 0::numeric) > 0::numeric) AS unpriced,
            COALESCE(( SELECT min(oe.sent_at) AS min
                   FROM job_order_emails oe
                  WHERE oe.purchase_order_id = p.id AND oe.status = 'sent'::text AND oe.sent_at IS NOT NULL), p.last_sent_at, p.created_at) AS ordered_at
           FROM purchase_orders p
          WHERE p.job_id IS NOT NULL AND p.xero_bill_id IS NULL AND NOT (EXISTS ( SELECT 1
                   FROM public.job_cost_lines f
                  WHERE f.order_kind = 'purchase_order'::text AND f.order_id = p.id::text AND f.state IS NOT NULL)) AND (lower(COALESCE(p.status, ''::text)) <> ALL (ARRAY['draft'::text, 'billed'::text, 'cancelled'::text, 'canceled'::text, 'void'::text, 'voided'::text, 'deleted'::text]))
        ), po_state AS (
         SELECT b.id,
            b.job_id,
            b.po_number,
            b.supplier_name,
            b.status,
            b.notes,
            b.delivery_date,
            b.created_at,
            b.invoice_received_at,
            b.po_amount_ex,
            b.unpriced,
            b.ordered_at,
                CASE
                    WHEN b.invoice_received_at IS NOT NULL THEN 'po_invoice_emailed'::text
                    WHEN b.unpriced THEN 'po_ordered'::text
                    ELSE 'po_committed'::text
                END AS state
           FROM po_base b
        ), po AS (
         SELECT s.job_id,
                CASE s.state
                    WHEN 'po_invoice_emailed'::text THEN (s.invoice_received_at AT TIME ZONE 'Australia/Perth'::text)::date
                    WHEN 'po_ordered'::text THEN (s.ordered_at AT TIME ZONE 'Australia/Perth'::text)::date
                    ELSE COALESCE(s.delivery_date, s.created_at::date)
                END AS event_date,
            'materials'::text AS lane,
            'purchase_order'::text AS lane_detail,
            'supplier'::text AS party_kind,
            NULL::text AS party_id,
            COALESCE(NULLIF(btrim(s.supplier_name), ''::text), 'Unnamed supplier'::text) AS party,
                CASE
                    WHEN s.unpriced THEN NULL::numeric
                    ELSE s.po_amount_ex
                END AS amount_ex,
            s.state AS source,
            s.id::text AS source_id,
            s.id::text AS document_id,
            s.po_number AS document_number,
            s.status AS document_status,
            false AS paid,
            NULL::date AS paid_on,
                CASE s.state
                    WHEN 'po_invoice_emailed'::text THEN 'invoice_emailed'::text
                    WHEN 'po_ordered'::text THEN 'ordered_not_billed'::text
                    ELSE 'committed'::text
                END AS confidence,
            false AS is_actual,
            s.notes AS description,
            NULL::numeric AS hours,
            NULL::text AS account_code,
            NULL::text AS business_unit,
            'purchase_orders.job_id'::text AS match_method,
            false AS incomplete_invoice
           FROM po_state s
        )
 SELECT po.* FROM po;
CREATE TABLE public.job_cost_events_cutover(singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 bills_backfilled_at timestamptz,credits_backfilled_at timestamptz,trade_backfilled_at timestamptz,
 trade_triggers_installed_at timestamptz,completed_at timestamptz);
INSERT INTO public.job_cost_events_cutover(singleton) VALUES(true);
CREATE OR REPLACE VIEW public.v_job_cost_events AS
 WITH cutover AS MATERIALIZED (
  SELECT EXISTS(SELECT 1 FROM public.feature_flags ff
   WHERE ff.flag_name='job_cost_events_from_cost_lines_v1' AND ff.enabled)
   AND EXISTS(SELECT 1 FROM public.job_cost_events_cutover c
    WHERE c.singleton AND c.completed_at IS NOT NULL) AS ready
 )
 SELECT l.* FROM public.v_job_cost_events_lines l WHERE (SELECT ready FROM cutover)
 UNION ALL
 SELECT g.*,NULL::uuid cost_line_id,NULL::text cost_kind FROM public.v_job_cost_events_legacy g
 WHERE NOT (SELECT ready FROM cutover);

\endif
-- Registered P2-01 prerequisites only. No function stand-ins.
DO $setup$ BEGIN
 IF to_regclass('public.job_cost_lines') IS NULL
 OR to_regclass('public.v_job_cost_events_lines') IS NULL THEN
  RAISE EXCEPTION 'P2-03.1 prerequisites missing';
 END IF;
END $setup$;
