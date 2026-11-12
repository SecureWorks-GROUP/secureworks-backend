-- Down for 20261111160000_dispatch_v2_solarspan_as_bondor. Roll ops-api, outlook-mail-capture and
-- context-capture-census back first: their approved list reads select also_known_emails.
-- Puts the Solarspan entry back on the approved order list, puts context_not_job_sender back to reading To and CC
-- only, then drops also_known_emails (Bondor's wasales@solarspan.com.au goes with it). Bondor's To and CC never
-- changed, so nothing else is restored. Orders already recorded to Bondor from an email to Solarspan keep Bondor.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- 1. The Solarspan entry is active again.
UPDATE public.dispatch_approved_supplier_emails
SET active = true,
    updated_at = now()
WHERE org_id = '00000000-0000-0000-0000-000000000001'::uuid
  AND name = 'Solarspan'
  AND NOT active;

-- 2. context_not_job_sender reads To and CC only (the exact reverse edit, or already done).
DO $down$
DECLARE
  v_fn regprocedure := to_regprocedure('public.context_not_job_sender(public.business_events)');
  v_def text;
  v_note text;
  v_old text := $n$unnest(s.to_emails || coalesce(s.cc_emails, ARRAY[]::text[]) || coalesce(s.also_known_emails, ARRAY[]::text[])) a(x)$n$;
  v_new text := $o$unnest(s.to_emails || coalesce(s.cc_emails, ARRAY[]::text[])) a(x)$o$;
  v_tag text := ' (20261111160000) Dispatch''s approved order addresses include each entry''s recognise-only '
    || 'also_known_emails (Solarspan on Bondor''s entry, Shaun 11 Nov 2026).';
BEGIN
  IF v_fn IS NULL THEN
    RETURN;
  END IF;
  SELECT pg_get_functiondef(v_fn) INTO v_def;
  IF position(v_old IN v_def) > 0 THEN
    EXECUTE replace(v_def, v_old, v_new);
  END IF;
  v_note := obj_description(v_fn, 'pg_proc');
  IF v_note IS NOT NULL AND position(v_tag IN v_note) > 0 THEN
    EXECUTE format('COMMENT ON FUNCTION public.context_not_job_sender(public.business_events) IS %L',
      replace(v_note, v_tag, ''));
  END IF;
END
$down$;

-- 3. The recognise-only addresses go.
ALTER TABLE public.dispatch_approved_supplier_emails
  DROP COLUMN IF EXISTS also_known_emails;
