-- Prerequisites for 20261115140000_materials_ai_known_answers. Earlier registered cases supply the AI bill
-- reader's audit table, Xero's invoices, the email attachments table and the ledger's split-line parts. Fail closed, by name, if any is gone.
-- The registered stack's v_bookkeeping_line_evidence_current is a table stand-in with production's columns
-- (20261104063000's setup); the contract writes the bookkeeper's answers into it.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['public.materials_ai_placements', 'public.v_bookkeeping_line_evidence_current',
                           'public.context_email_attachments', 'public.business_events', 'public.xero_invoices',
                           'public.v_bookkeeping_line_parts_current', 'public.bookkeeping_line_evidence_parts',
                           'public.bookkeeping_evidence_revisions'] LOOP
    IF to_regclass(t) IS NULL THEN
      RAISE EXCEPTION 'materials ai known answers setup: % missing from the registered stack', t;
    END IF;
  END LOOP;
END $$;

GRANT SELECT ON public.v_bookkeeping_line_evidence_current TO service_role;
