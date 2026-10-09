-- The Ambrose row exists once, active, resolvable by its sender domain, with
-- the ACG ref prefix the intake loads and no outbound address or billing rule.
DO $$
DECLARE c public.makesafe_companies;
BEGIN
  SELECT * INTO STRICT c FROM public.makesafe_companies WHERE slug = 'acg';
  IF c.name <> 'Ambrose Construct Group' THEN RAISE EXCEPTION 'ambrose: name %', c.name; END IF;
  IF NOT c.active THEN RAISE EXCEPTION 'ambrose: inactive'; END IF;
  IF c.sender_patterns <> ARRAY['ambroseconstruct.com.au'] THEN
    RAISE EXCEPTION 'ambrose: sender_patterns %', c.sender_patterns;
  END IF;
  IF c.org_id IS DISTINCT FROM '00000000-0000-0000-0000-000000000001'::uuid THEN
    RAISE EXCEPTION 'ambrose: org %', c.org_id;
  END IF;
  IF c.invoice_email IS NOT NULL OR c.report_recipient IS NOT NULL THEN
    RAISE EXCEPTION 'ambrose: an outbound address was recorded';
  END IF;
  IF c.billing_rules <> '{}'::jsonb THEN RAISE EXCEPTION 'ambrose: billing rules %', c.billing_rules; END IF;
  IF c.parsing_rules->'ref_prefixes' <> '["ACG"]'::jsonb THEN
    RAISE EXCEPTION 'ambrose: ref_prefixes %', c.parsing_rules->'ref_prefixes';
  END IF;
  IF NOT (c.parsing_rules->'fields' ?& ARRAY['external_ref', 'client_name', 'site_address']) THEN
    RAISE EXCEPTION 'ambrose: field rules %', c.parsing_rules->'fields';
  END IF;
  IF (c.parsing_rules->>'template_first')::boolean THEN RAISE EXCEPTION 'ambrose: template_first on'; END IF;
  -- The live makesafe_companies_active_parsing_rules_covered CHECK.
  IF NOT (NOT c.active OR COALESCE(c.parsing_rules, '{}'::jsonb) ? 'fields') THEN
    RAISE EXCEPTION 'ambrose: active row without parsing-rule coverage';
  END IF;
  -- The stored PO rule must read the 8-2 Ambrose shape and keep the sequence.
  -- The rule is JavaScript (the intake runs it); PostgreSQL spells a word
  -- boundary \y and reads \b as a backspace, so translate it here. IS DISTINCT
  -- FROM, not <>: a rule that matches nothing returns NULL, and NULL <> x
  -- never raises.
  IF substring('Purchase Order P.O. No: 20999101-02' FROM replace(c.parsing_rules->'fields'->'external_ref'->>'regex', '\b', '\y')) IS DISTINCT FROM '20999101-02' THEN
    RAISE EXCEPTION 'ambrose: external_ref rule does not read the PO';
  END IF;
  IF substring(E'Insured Owner: Alex Example\nAuthorised Contact: Jordan Example' FROM c.parsing_rules->'fields'->'client_name'->>'regex') IS DISTINCT FROM 'Alex Example' THEN
    RAISE EXCEPTION 'ambrose: client_name rule crosses the line';
  END IF;
END $$;

-- Re-applying is a no-op that never rewrites a tuned row.
BEGIN;
UPDATE public.makesafe_companies SET special_instructions = 'tuned by an operator' WHERE slug = 'acg';
\ir ../../../migrations/20261009140000_makesafe_company_ambrose.sql
DO $$
BEGIN
  IF (SELECT count(*) FROM public.makesafe_companies WHERE slug = 'acg') <> 1 THEN
    RAISE EXCEPTION 'ambrose: re-apply duplicated the row';
  END IF;
  IF (SELECT special_instructions FROM public.makesafe_companies WHERE slug = 'acg') <> 'tuned by an operator' THEN
    RAISE EXCEPTION 'ambrose: re-apply rewrote a tuned row';
  END IF;
END $$;
ROLLBACK;
