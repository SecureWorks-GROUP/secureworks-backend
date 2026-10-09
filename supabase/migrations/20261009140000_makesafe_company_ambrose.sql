-- Ambrose Construct Group as an intake builder (slug 'acg').
--
-- Ambrose sends us insurance make-safe and repair purchase orders from staff
-- addresses on ambroseconstruct.com.au. Each email names itself in the subject
-- ("Ambrose Construct Group Purchase Order Make Safe: <job>-<seq> - <address>
-- is attached", or "Purchase Order:" for a repair) and attaches one
-- "Purchase Order.pdf" in a fixed template. The deterministic intake reads it
-- through its own adapter (makesafe_deterministic_intake.ts, adapter
-- 'ambrose'); this row is what lets that adapter resolve the company, and the
-- identity grammar scopes Ambrose instructions as ACG:PO-<job><seq>.
--
-- Deliberately NOT set here, because nobody has ruled on them yet:
--   * billing_rules: an Ambrose PO carries its own fixed price; no hourly
--     schedule exists, and the SES builder-family matrix has no Ambrose row,
--     so pack and invoice preparation stay refused for these cards until a
--     captain-sealed row is added.
--   * report_recipient / invoice_email: Ambrose takes reports through its
--     Tradies Web portal and invoices through Tradies Admin, not by email, so
--     no outbound address is recorded.
--
-- Additive and idempotent: inserts the row once and never rewrites a row an
-- operator has since tuned. Rollback: supabase/rollbacks/20261009140000_
-- makesafe_company_ambrose_down.sql deactivates it.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

INSERT INTO public.makesafe_companies (
  org_id,
  slug,
  name,
  sender_patterns,
  invoice_email,
  report_recipient,
  safety_requirements,
  special_instructions,
  external_links,
  parsing_rules,
  billing_rules,
  active
)
VALUES (
  '00000000-0000-0000-0000-000000000001',
  'acg',
  'Ambrose Construct Group',
  ARRAY['ambroseconstruct.com.au'],
  NULL,
  NULL,
  'Per the Ambrose purchase order safety alert: no work on wet roofs; harness on every two-storey roof; SWMS before any work with a fall risk over 2 metres; confined-space controls before entering a roof or ceiling cavity.',
  'Accept each purchase order in the Ambrose portal before attending. Make-safe reports and photos go through Tradies Web (QnA). Invoices go through Tradies Admin, addressed to Ambrose Construct Group Pty Ltd, quoting the job number and site address with a labour and materials breakdown. Do not email invoices to the supervisor.',
  '[]'::jsonb,
  jsonb_build_object(
    'version', 1,
    'template_first', false,
    'confidence', 'high',
    'required', jsonb_build_array('external_ref', 'client_name', 'site_address'),
    'ref_prefixes', jsonb_build_array('ACG'),
    'fields', jsonb_build_object(
      'external_ref', jsonb_build_object(
        'regex', '(?:P\.?\s*O\.?\s*(?:No\.?)?|Purchase\s+Order(?:\s+Make\s+Safe)?)\s*[:#]?\s*#?\s*(\d{8}-\d{2})\b',
        'source', 'all', 'group', 1, 'transform', 'upper'),
      'client_name', jsonb_build_object(
        'regex', 'Insured\s+Owner\s*:[ \t]*([A-Za-z][A-Za-z''\-\. ]{1,60})',
        'source', 'pdf', 'group', 1, 'transform', 'collapse_ws'),
      'site_address', jsonb_build_object(
        'regex', 'Site\s+Address\s*:[ \t]*([0-9][^\n\r]{4,120})',
        'source', 'all', 'group', 1, 'transform', 'collapse_ws')
    )
  ),
  '{}'::jsonb,
  true
)
ON CONFLICT (slug) DO NOTHING;
