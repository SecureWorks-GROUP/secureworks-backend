-- Dispatch v2: an order emailed to Solarspan is a Bondor order (approved by Shaun, 11 Nov 2026: "link solarspan to
-- bondor").
--
-- Why. Solarspan is Bondor's brand. Shaun emails Bondor's patio orders to wasales@solarspan.com.au, and Bondor's
-- staff reply from @bondor.com.au addresses ("RE: Material Order Ref SWP-26100 // Bondor #1465465"). The approved
-- order list held two separate entries: "Bondor" (To wa@bondor.com.au, linked to the Bondor Xero contact) and
-- "Solarspan" (To wasales@solarspan.com.au, no Xero contact linked). So an order Shaun sent from Outlook to Solarspan
-- could not become a Bondor order: it waited under Emails to sort ("no Xero supplier contact linked"), and Bondor's
-- replies never tied to it.
--
-- Changed:
--  1. A new column, dispatch_approved_supplier_emails.also_known_emails (text[], default empty): addresses an entry
--     is RECOGNISED by but never SENT to. The Outlook send rule (who an order went to, section 3g.1 rule 4), the
--     reply scan (who a reply came from) and the email reader's supplier domains read To, CC and these addresses.
--     Dispatch's own order emails still go To to_emails and CC cc_emails only, so Dispatch sends and copies nothing
--     new: Bondor's orders from Dispatch still go To wa@bondor.com.au, nobody else on CC.
--  2. Bondor's entry gets wasales@solarspan.com.au as a recognise-only address. Its To and CC do not change.
--  3. The Solarspan entry is retired (active false): it is folded into Bondor on Shaun's 11 Nov 2026 ruling. Its row
--     and addresses are kept for the record. While it stayed active the same address would sit on two entries, and
--     an address two suppliers share names neither. It is retired only when Bondor's entry carries the address.
--  4. context_not_job_sender (finish line C2, which marks a message from an approved supplier as supplier_no_ref)
--     reads the recognise-only addresses too, so retiring the Solarspan entry does not stop solarspan.com.au being a
--     supplier there. One exact edit of the live definition; nothing else in it changes.
--
-- Orders already sent: SWP-26100 (Rose), ordered from Solarspan on 10 Nov 2026, was sent before the on-send clock
-- started (12:23 Perth, 11 Nov 2026), so it is not picked up by itself. The existing one-off catch-up
-- (dispatch_v2_outlook_catch_up, dry run first) lists it as a Bondor order once this is live.
--
-- Contract: docs/dispatch-v2-board-contract.md, section 3g.4.
-- Nothing here touches suppliers (the 06:55 Xero sync owns it), jobs, orders, Xero, GHL, SMS or email. Running it
-- again changes nothing.
--
-- Rollback: supabase/rollbacks/20261111160000_dispatch_v2_solarspan_as_bondor_down.sql.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- 1. The recognise-only addresses.
ALTER TABLE public.dispatch_approved_supplier_emails
  ADD COLUMN IF NOT EXISTS also_known_emails text[] NOT NULL DEFAULT ARRAY[]::text[];
COMMENT ON COLUMN public.dispatch_approved_supplier_emails.also_known_emails IS
 '(20261111160000) Addresses this supplier is recognised by but never sent to, lower case. Matching only: who an '
 'order sent from Outlook went to, who a supplier reply came from, and the email reader''s supplier domains. '
 'Dispatch''s own order emails go To to_emails and CC cc_emails only. Shaun, 11 Nov 2026: Bondor carries '
 'wasales@solarspan.com.au (Solarspan is Bondor''s brand).';

-- 2. Bondor is also known as Solarspan's order address.
UPDATE public.dispatch_approved_supplier_emails
SET also_known_emails = also_known_emails || ARRAY['wasales@solarspan.com.au']::text[],
    updated_at = now()
WHERE org_id = '00000000-0000-0000-0000-000000000001'::uuid
  AND name = 'Bondor'
  AND NOT ('wasales@solarspan.com.au' = ANY (also_known_emails));

-- 3. The Solarspan entry is folded into Bondor (Shaun, 11 Nov 2026): retired, kept for the record. Only once
-- Bondor's active entry carries its address, so its orders are never left unrecognised.
UPDATE public.dispatch_approved_supplier_emails s
SET active = false,
    updated_at = now()
WHERE s.org_id = '00000000-0000-0000-0000-000000000001'::uuid
  AND s.name = 'Solarspan'
  AND s.active
  AND EXISTS (
    SELECT 1 FROM public.dispatch_approved_supplier_emails b
    WHERE b.org_id = s.org_id
      AND b.name = 'Bondor'
      AND b.active
      AND 'wasales@solarspan.com.au' = ANY (b.also_known_emails)
  );

-- 4. context_not_job_sender reads the recognise-only addresses too (one exact edit, or already done).
DO $mig$
DECLARE
  v_fn regprocedure := to_regprocedure('public.context_not_job_sender(public.business_events)');
  v_def text;
  v_note text;
  v_old text := $o$unnest(s.to_emails || coalesce(s.cc_emails, ARRAY[]::text[])) a(x)$o$;
  v_new text := $n$unnest(s.to_emails || coalesce(s.cc_emails, ARRAY[]::text[]) || coalesce(s.also_known_emails, ARRAY[]::text[])) a(x)$n$;
BEGIN
  IF v_fn IS NULL THEN
    RAISE EXCEPTION 'dispatch_v2_solarspan_as_bondor: public.context_not_job_sender(public.business_events) is missing';
  END IF;
  SELECT pg_get_functiondef(v_fn) INTO v_def;
  IF position(v_new IN v_def) > 0 THEN
    RAISE NOTICE 'context_not_job_sender already reads also_known_emails';
  ELSE
    IF (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old) <> 1 THEN
      RAISE EXCEPTION 'context_not_job_sender: the approved address read does not match exactly once';
    END IF;
    EXECUTE replace(v_def, v_old, v_new);
  END IF;
  v_note := obj_description(v_fn, 'pg_proc');
  IF v_note IS NOT NULL AND position('(20261111160000)' IN v_note) = 0 THEN
    EXECUTE format('COMMENT ON FUNCTION public.context_not_job_sender(public.business_events) IS %L',
      v_note || ' (20261111160000) Dispatch''s approved order addresses include each entry''s recognise-only '
        || 'also_known_emails (Solarspan on Bondor''s entry, Shaun 11 Nov 2026).');
  END IF;
END
$mig$;
