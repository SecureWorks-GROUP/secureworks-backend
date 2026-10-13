-- Quote builder: pricing settings, and one filed scope of works per issued
-- version.
--
-- Contract: docs/quote-builder-contract.md. Reader and writer: ops-api
-- (supabase/functions/ops-api/quote_builder.ts). Two additive changes:
--
--   1. quote_builder_settings holds the insurance labour rate (ex GST, per
--      hour), the insurance materials multiplier and, once the owner gives one,
--      the target margin percent. One row per number. The first two are seeded
--      here with the owner's starting values of 13 Oct 2026; the target has no
--      row until he names one. ops-api returns them in `settings` on
--      quote_builder_get_job and nothing in code carries a pricing number.
--
--      They are a goal the app shows the scoper, not a rule: the scoper sets
--      his own markups, and nothing in the database or in ops-api refuses,
--      clamps or rewrites a quote line for differing from them. The bounds
--      below guard the setting itself against a mistyped value, nothing more.
--
--      Why its own table and not org_config: org_config is readable by every
--      signed-in user of the organisation, trades included (live policy "Users
--      view own org config", read 13 Oct 2026), and what we charge a builder per
--      hour is not a trade's to read. This table follows quote_builder_versions:
--      RLS on with no policy and revoked from anon and authenticated, so only
--      ops-api reaches it.
--
--   2. One partial unique index on job_documents: the scope of works PDF filed
--      beside the client quote at issue is a row of type 'other' whose
--      metadata names the version and the document, and a version holds at
--      most one of each document. Built-in operators only. The material order
--      list prints our costs and is not filed: job-pdfs is a public bucket.
--
-- Nothing here touches work orders or purchase orders, approves, sends or
-- prices anything. Making a draft crew work order and draft purchase orders
-- from an issued quote is not built yet (docs/quote-builder-contract.md,
-- "Not built yet").
--
-- Rollback: supabase/rollbacks/20261013160000_quote_builder_pricing_and_documents_down.sql.

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
  'Quote builder pricing settings (docs/quote-builder-contract.md), one row per number: a goal shown to the scoper, never a rule applied to a quote. Read only by ops-api; a missing row means not set.';
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

-- A double-submitted issue files the scope of works once: the second insert is
-- refused and ops-api reads back the first.
CREATE UNIQUE INDEX IF NOT EXISTS ux_job_docs_quote_builder_extra
  ON public.job_documents (job_id, (metadata ->> 'quote_builder_version_id'), (metadata ->> 'quote_builder_document'))
  WHERE type = 'other' AND (metadata ->> 'quote_builder_document') IS NOT NULL;
