-- P2-10.1: read-only order evidence. No source writes or switch changes.
CREATE FUNCTION public.supplier_name_key(p text)
RETURNS text LANGUAGE sql IMMUTABLE STRICT SET search_path = '' AS $fn$
  SELECT regexp_replace(
    regexp_replace(lower(p), '\m(pty|ltd|limited)\M', '', 'g'),
    '[^a-z0-9]', '', 'g')
$fn$;
REVOKE ALL ON FUNCTION public.supplier_name_key(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.supplier_name_key(text) TO service_role;

CREATE VIEW public.v_job_orders WITH (security_invoker = true) AS
WITH orders AS (
  SELECT 'purchase_order'::text AS order_kind, p.id::text AS order_id,
    p.po_number AS order_number, p.job_id, p.xero_contact_id AS party_id,
    p.supplier_name AS party_name, p.created_at::date AS sent_on,
    nullif(p.subtotal, 0) AS cost_ex, false AS from_sealed_scope
  FROM public.purchase_orders p WHERE p.status NOT IN ('draft', 'deleted')
  UNION ALL
  SELECT 'dispatch_order', d.id::text, NULL::text, d.job_id,
    s.xero_contact_id, d.supplier_name, d.sent_at::date,
    CASE WHEN d.order_cost IS NOT NULL AND c.complete THEN nullif(c.total, 0) END,
    d.order_cost IS NOT NULL
  FROM public.dispatch_supplier_order_emails d
  LEFT JOIN public.suppliers s ON s.id = d.supplier_id
  CROSS JOIN LATERAL (
    SELECT count(*) > 0 AND bool_and(jsonb_typeof(l->'line_cost_ex_gst') = 'number'
      AND l->>'line_cost_ex_gst' IS NOT NULL) AS complete,
      sum(CASE WHEN jsonb_typeof(l->'line_cost_ex_gst') = 'number'
        THEN (l->>'line_cost_ex_gst')::numeric END) AS total
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(d.order_cost->'lines') = 'array'
      THEN d.order_cost->'lines' ELSE '[]'::jsonb END) a(l)
  ) c
  WHERE d.status = 'sent'
)
SELECT o.*, public.supplier_name_key(o.party_name) AS party_name_key,
  j.job_number,
  coalesce(j.status NOT IN ('cancelled', 'lost', 'draft', 'quoted'), false) AS job_live,
  EXISTS (SELECT 1 FROM public.job_cost_lines l
    WHERE l.order_kind = o.order_kind AND l.order_id = o.order_id
      AND l.state IS NOT NULL AND l.not_counted_reason IS NULL) AS matched
FROM orders o LEFT JOIN public.jobs j ON j.id = o.job_id;
REVOKE ALL ON public.v_job_orders FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.v_job_orders TO service_role;
