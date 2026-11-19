-- A bad state must be refused. The break proof drops that check and this raises.
DO $$ BEGIN
  BEGIN
    INSERT INTO public.xero_bill_attachment_reads (
      org_id, xero_invoice_id, attachment_id, source, state
    ) VALUES (
      '00000000-0000-4000-8000-000000000091', 'ZZTEST-bill', 'ZZTEST-bad-state', 'xero', 'stored_text'
    );
    RAISE EXCEPTION 'xero bill attachment reads: invalid state was accepted';
  EXCEPTION
    WHEN check_violation THEN
      NULL;
  END;
END $$;

DO $$ BEGIN
  BEGIN
    INSERT INTO public.xero_bill_attachment_reads (
      org_id, xero_invoice_id, attachment_id, source, state
    ) VALUES (
      '00000000-0000-4000-8000-000000000091', 'ZZTEST-bill', 'ZZTEST-bad-source', 'disk', 'listed'
    );
    RAISE EXCEPTION 'xero bill attachment reads: invalid source was accepted';
  EXCEPTION
    WHEN check_violation THEN
      NULL;
  END;
END $$;

DO $$ BEGIN
  IF to_regclass('public.xero_bill_attachment_reads') IS NULL THEN
    RAISE EXCEPTION 'xero bill attachment reads: table missing';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.xero_bill_attachment_reads'::regclass) THEN
    RAISE EXCEPTION 'xero bill attachment reads: rls off';
  END IF;
  IF to_regclass('public.xero_bill_attachment_reads_invoice_idx') IS NULL THEN
    RAISE EXCEPTION 'xero bill attachment reads: invoice index missing';
  END IF;
  IF has_table_privilege('anon', 'public.xero_bill_attachment_reads', 'SELECT')
    OR has_table_privilege('anon', 'public.xero_bill_attachment_reads', 'INSERT')
    OR has_table_privilege('authenticated', 'public.xero_bill_attachment_reads', 'SELECT')
    OR has_table_privilege('authenticated', 'public.xero_bill_attachment_reads', 'INSERT')
    OR NOT has_table_privilege('service_role', 'public.xero_bill_attachment_reads', 'SELECT')
    OR NOT has_table_privilege('service_role', 'public.xero_bill_attachment_reads', 'INSERT')
    OR NOT has_table_privilege('service_role', 'public.xero_bill_attachment_reads', 'UPDATE')
    OR NOT has_table_privilege('service_role', 'public.xero_bill_attachment_reads', 'DELETE') THEN
    RAISE EXCEPTION 'xero bill attachment reads: grants';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'xero_bill_attachment_reads'
      AND policyname = 'xero_bill_attachment_reads_service'
  ) THEN
    RAISE EXCEPTION 'xero bill attachment reads: service policy missing';
  END IF;
  IF (SELECT count(*) FROM public.feature_flags WHERE flag_name = 'xero_bill_attachment_read_v1') <> 1 THEN
    RAISE EXCEPTION 'xero bill attachment reads: expected one switch row';
  END IF;
  IF (SELECT enabled FROM public.feature_flags WHERE flag_name = 'xero_bill_attachment_read_v1') IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'xero bill attachment reads: switch not off';
  END IF;
END $$;

INSERT INTO public.xero_bill_attachment_reads (
  org_id, xero_invoice_id, attachment_id, source, state
) VALUES (
  '00000000-0000-4000-8000-000000000091', 'ZZTEST-bill', 'ZZTEST-ok', 'email', 'text_read'
);
DO $$ BEGIN
  IF (SELECT job_numbers FROM public.xero_bill_attachment_reads
      WHERE attachment_id = 'ZZTEST-ok') IS DISTINCT FROM '{}' THEN
    RAISE EXCEPTION 'xero bill attachment reads: job numbers default';
  END IF;
  IF (SELECT po_numbers FROM public.xero_bill_attachment_reads
      WHERE attachment_id = 'ZZTEST-ok') IS DISTINCT FROM '{}' THEN
    RAISE EXCEPTION 'xero bill attachment reads: po numbers default';
  END IF;
END $$;

-- A switch that is already on is left on by a re-apply.
BEGIN;
UPDATE public.feature_flags SET enabled = true WHERE flag_name = 'xero_bill_attachment_read_v1';
\ir ../../../migrations/20261119091400_xero_bill_attachment_reads.sql
DO $$ BEGIN
  IF (SELECT enabled FROM public.feature_flags WHERE flag_name = 'xero_bill_attachment_read_v1') IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'xero bill attachment reads: a re-apply changed an existing on switch';
  END IF;
END $$;
ROLLBACK;
