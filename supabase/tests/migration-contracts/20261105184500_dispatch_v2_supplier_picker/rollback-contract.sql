-- Rollback contract for 20261105184500_dispatch_v2_supplier_picker: after
-- supabase/rollbacks/20261105184500_dispatch_v2_supplier_picker_down.sql the view and the pin columns are gone,
-- the two approved names are back, Ampelite has its warwick@ CC again, and every entry and link still exists.

\set ON_ERROR_STOP on

DO $$
DECLARE r record;
BEGIN
  IF to_regclass('public.dispatch_approved_supplier_contact_bills') IS NOT NULL THEN
    RAISE EXCEPTION 'Tweak 4 rollback: the bill count view is still there';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = 'dispatch_approved_supplier_emails'
               AND column_name IN ('pinned_supplier_id', 'pinned_by', 'pinned_at')) THEN
    RAISE EXCEPTION 'Tweak 4 rollback: a pin column is still there';
  END IF;
  IF (SELECT name FROM public.dispatch_approved_supplier_emails WHERE id = '7e4a0000-0000-4000-8000-000000000011')
     IS DISTINCT FROM 'B&D Metals Group' THEN
    RAISE EXCEPTION 'Tweak 4 rollback: BD Metals was not renamed back';
  END IF;
  IF (SELECT name FROM public.dispatch_approved_supplier_emails WHERE id = '7e4a0000-0000-4000-8000-000000000012')
     IS DISTINCT FROM 'R&R Fencing' THEN
    RAISE EXCEPTION 'Tweak 4 rollback: RnR Fencing was not renamed back';
  END IF;
  SELECT to_emails, cc_emails INTO r FROM public.dispatch_approved_supplier_emails
  WHERE id = '7e4a0000-0000-4000-8000-000000000013';
  IF r.to_emails IS DISTINCT FROM ARRAY['waorders@ampelite.com.au']::text[]
     OR NOT ('warwick@ampelite.com.au' = ANY (r.cc_emails))
     OR NOT ('tw4-keep@ampelite.example.test' = ANY (r.cc_emails)) THEN
    RAISE EXCEPTION 'Tweak 4 rollback: Ampelite emails not restored (to %, cc %)', r.to_emails, r.cc_emails;
  END IF;
  IF (SELECT count(*) FROM public.dispatch_approved_supplier_email_links
      WHERE approved_id IN ('7e4a0000-0000-4000-8000-000000000011', '7e4a0000-0000-4000-8000-000000000012',
                            '7e4a0000-0000-4000-8000-000000000013', '7e4a0000-0000-4000-8000-000000000014')) <> 5 THEN
    RAISE EXCEPTION 'Tweak 4 rollback: a supplier link was lost';
  END IF;
END $$;
