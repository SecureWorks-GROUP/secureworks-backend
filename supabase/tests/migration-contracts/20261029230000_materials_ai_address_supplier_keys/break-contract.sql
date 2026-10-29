-- Deliberately break it: a loose address match (street number and name, no
-- type word) counts as the site address key. The contract must catch it.
\set ON_ERROR_STOP on
CREATE OR REPLACE FUNCTION public.materials_ai_hard_keys(p_bill text, p_job_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT jsonb_build_object('keys', CASE WHEN EXISTS (
           SELECT 1 FROM public.xero_invoices x, public.jobs j, public.context_address_mentions(x.reference) m
            WHERE x.xero_invoice_id = p_bill AND j.id = p_job_id
              AND m.loose_keys && public.context_address_loose_keys(j.site_address))
           THEN '["site_address"]'::jsonb ELSE '[]'::jsonb END, 'evidence', '{}'::jsonb)
$$;
