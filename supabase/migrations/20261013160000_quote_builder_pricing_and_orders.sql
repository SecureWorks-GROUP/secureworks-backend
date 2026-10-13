-- Quote builder: pricing settings, and the link from an issued quote to the
-- draft crew work order and draft purchase orders made from it.
--
-- Contract: docs/quote-builder-contract.md. Reader and writer: ops-api
-- (supabase/functions/ops-api/quote_builder.ts). Four additive changes:
--
--   1. quote_builder_settings holds the insurance labour rate (ex GST, per
--      hour), the insurance materials multiplier and, once the owner gives one,
--      the target margin percent. One row per number. The first two are seeded
--      here with the owner's starting values of 13 Oct 2026; the target has no
--      row until he names one. ops-api returns them in `settings` on
--      quote_builder_get_job and nothing in code carries a pricing number.
--
--      Why its own table and not org_config: org_config is readable by every
--      signed-in user of the organisation, trades included (live policy "Users
--      view own org config", read 13 Oct 2026), and what we charge a builder per
--      hour is not a trade's to read. This table follows quote_builder_versions:
--      RLS on with no policy and revoked from anon and authenticated, so only
--      ops-api reaches it.
--
--   2. work_orders.quote_builder_version_id and
--      purchase_orders.quote_builder_version_id name the issued quote builder
--      version an order was made from. Null on every existing row.
--
--   3. Two partial unique indexes hold two presses at the same moment of "make
--      work order" or "make purchase orders" to one set: one live crew work
--      order per version, and one live purchase order per version and
--      supplier. (A later press is stopped in ops-api: once any live purchase
--      order exists for the version it makes nothing.) Built-in expressions
--      only, so every role that writes these tables can maintain them.
--
--   4. One more partial unique index on job_documents: the scope of works PDF
--      filed beside the client quote at issue is a row of type 'other' whose
--      metadata names the version and the document, and a version holds at
--      most one of each document. Built-in operators only. The material order
--      list prints our costs and is not filed: job-pdfs is a public bucket.
--
-- Nothing here touches job work orders (kind = 'job'), approves, sends or
-- prices anything.
--
-- Rollback: supabase/rollbacks/20261013160000_quote_builder_pricing_and_orders_down.sql.

CREATE TABLE IF NOT EXISTS public.quote_builder_settings (
  org_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001'::uuid,
  setting_key text NOT NULL,
  amount numeric NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  CONSTRAINT quote_builder_settings_pkey PRIMARY KEY (org_id, setting_key),
  CONSTRAINT quote_builder_settings_key_valid CHECK (
    setting_key IN ('insurance_labour_rate_ex_gst', 'insurance_materials_multiplier', 'target_margin_pct')
  ),
  CONSTRAINT quote_builder_settings_amount_valid CHECK (
    (setting_key = 'insurance_labour_rate_ex_gst' AND amount > 0 AND amount <= 1000)
    OR (setting_key = 'insurance_materials_multiplier' AND amount >= 1 AND amount <= 10)
    OR (setting_key = 'target_margin_pct' AND amount > 0 AND amount <= 95)
  )
);

COMMENT ON TABLE public.quote_builder_settings IS
  'Quote builder pricing settings (docs/quote-builder-contract.md), one row per number. Read only by ops-api; a missing row means not set.';
COMMENT ON COLUMN public.quote_builder_settings.amount IS
  'insurance_labour_rate_ex_gst: dollars per hour charged, ex GST. insurance_materials_multiplier: client price = our cost x this. target_margin_pct: percent.';

ALTER TABLE public.quote_builder_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.quote_builder_settings FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.quote_builder_settings TO service_role;

-- Starting positions, 13 Oct 2026. No target margin row: unset on purpose.
INSERT INTO public.quote_builder_settings (org_id, setting_key, amount)
VALUES
  ('00000000-0000-0000-0000-000000000001', 'insurance_labour_rate_ex_gst', 120),
  ('00000000-0000-0000-0000-000000000001', 'insurance_materials_multiplier', 1.6)
ON CONFLICT (org_id, setting_key) DO NOTHING;

ALTER TABLE public.work_orders
  ADD COLUMN IF NOT EXISTS quote_builder_version_id uuid REFERENCES public.quote_builder_versions(id);
COMMENT ON COLUMN public.work_orders.quote_builder_version_id IS
  'The issued quote builder version this crew work order was made from (quote_builder_make_work_order). Null otherwise.';
CREATE UNIQUE INDEX IF NOT EXISTS ux_work_orders_quote_builder_version
  ON public.work_orders (quote_builder_version_id)
  WHERE quote_builder_version_id IS NOT NULL AND status <> 'cancelled';

ALTER TABLE public.purchase_orders
  ADD COLUMN IF NOT EXISTS quote_builder_version_id uuid REFERENCES public.quote_builder_versions(id);
COMMENT ON COLUMN public.purchase_orders.quote_builder_version_id IS
  'The issued quote builder version this purchase order was made from (quote_builder_make_purchase_orders). Null otherwise.';
CREATE UNIQUE INDEX IF NOT EXISTS ux_purchase_orders_quote_builder_version_supplier
  ON public.purchase_orders (quote_builder_version_id, lower(coalesce(supplier_name, '')))
  WHERE quote_builder_version_id IS NOT NULL AND status NOT IN ('cancelled', 'deleted');

-- A double-submitted issue files the scope of works once: the second insert is
-- refused and ops-api reads back the first.
CREATE UNIQUE INDEX IF NOT EXISTS ux_job_docs_quote_builder_extra
  ON public.job_documents (job_id, (metadata ->> 'quote_builder_version_id'), (metadata ->> 'quote_builder_document'))
  WHERE type = 'other' AND (metadata ->> 'quote_builder_document') IS NOT NULL;
