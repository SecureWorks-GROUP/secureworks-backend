BEGIN;
SET LOCAL statement_timeout = '120s';
-- Protect this case from earlier contracts that drop objects (merge safety 17): put
-- back the mark column (20261118194000), the receipt sync (20261118115701) and this
-- file's body when any is missing or replaced. Each one is safe to re-apply.
SELECT NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public'
  AND table_name='expense_receipts' AND column_name='unbooked_job_id') AS zz_mark \gset
\if :zz_mark
\ir ../../../migrations/20261118194000_expense_unbooked_job_mark.sql
\endif
SELECT to_regprocedure('public.job_cost_lines_sync_receipt(uuid)') IS NULL
  OR to_regprocedure('public.job_cost_lines_install_receipt_trigger()') IS NULL AS zz_sync \gset
\if :zz_sync
\ir ../../../migrations/20261118115701_job_cost_lines_receipt_sync.sql
\endif
-- Re-applied only over the pre-image, so the break proof's body is the one under test.
SELECT coalesce((SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('public.job_cost_lines_sync_receipt(uuid)'))
  = 'c499c1e901175e363c3ad018a4b190c8',false) AS zz_held \gset
\if :zz_held
\ir ../../../migrations/20261118194300_job_cost_lines_receipt_unbooked_hold.sql
\endif

SELECT public.job_cost_lines_install_receipt_trigger();
-- Lift unrelated fixture guards only in this rolled-back transaction, as the
-- 20261118115701 case does; the receipt triggers and conservation checks stay on.
DO $$ DECLARE t text; c record; BEGIN
  FOREACH t IN ARRAY ARRAY['expense_receipts','trade_invoices','trade_invoice_lines'] LOOP
    FOR c IN SELECT tgname FROM pg_trigger WHERE tgrelid=format('public.%I',t)::regclass
      AND NOT tgisinternal AND tgname NOT LIKE 'job_cost_lines_receipt%' LOOP
      EXECUTE format('ALTER TABLE public.%I DISABLE TRIGGER %I',t,c.tgname);
    END LOOP;
    FOR c IN SELECT conname FROM pg_constraint WHERE conrelid=format('public.%I',t)::regclass
      AND contype IN ('f','c','u','x') LOOP
      EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT %I',t,c.conname);
    END LOOP;
    FOR c IN SELECT attname FROM pg_attribute WHERE attrelid=format('public.%I',t)::regclass
      AND attnum>0 AND NOT attisdropped AND attnotnull AND attname NOT IN ('id','org_id') LOOP
      EXECUTE format('ALTER TABLE public.%I ALTER COLUMN %I DROP NOT NULL',t,c.attname);
    END LOOP;
  END LOOP;
END $$;
UPDATE public.feature_flags SET enabled=true WHERE flag_name='job_cost_lines_sync_v1';
CREATE FUNCTION pg_temp.zz_line(p uuid) RETURNS public.job_cost_lines LANGUAGE sql AS $f$
  SELECT * FROM public.job_cost_lines WHERE document_kind='expense_receipt' AND document_id=p::text
$f$;
CREATE FUNCTION pg_temp.zz_queued(p uuid) RETURNS bigint LANGUAGE sql AS $f$
  SELECT count(*) FROM public.match_queue WHERE subject_kind='cost_document'
    AND subject_id='expense_receipt:'||p::text AND reason='receipt_saved'
$f$;

-- Unmarked company card receipt: one counted line and one queue row, as before.
INSERT INTO public.expense_receipts(id,job_id,receipt_photo_url,vendor_name,receipt_date,total_amount,gst_amount,payment_method,category)
  VALUES('61000000-0000-4000-8000-000000000001','61000000-0000-4000-8000-0000000000a1','ZZTEST-unmarked',
    'ZZTEST Supplier','2026-11-16',110,10,'company_card','materials');
DO $$ BEGIN
 IF (pg_temp.zz_line('61000000-0000-4000-8000-000000000001')).state IS DISTINCT FROM 'needs_person'
   OR pg_temp.zz_queued('61000000-0000-4000-8000-000000000001')<>1 THEN
   RAISE EXCEPTION 'unbooked hold: an unmarked receipt did not count'; END IF;
END $$;

-- Marked and unconfirmed: no line and no queue row.
INSERT INTO public.expense_receipts(id,job_id,unbooked_job_id,receipt_photo_url,vendor_name,receipt_date,total_amount,gst_amount,payment_method,category)
  VALUES('61000000-0000-4000-8000-000000000002','61000000-0000-4000-8000-0000000000a2',
    '61000000-0000-4000-8000-0000000000a2','ZZTEST-marked','ZZTEST Supplier','2026-11-16',110,10,'company_card','materials');
DO $$ BEGIN
 IF (pg_temp.zz_line('61000000-0000-4000-8000-000000000002')).id IS NOT NULL
   OR pg_temp.zz_queued('61000000-0000-4000-8000-000000000002')<>0 THEN
   RAISE EXCEPTION 'unbooked hold: a marked unconfirmed receipt made a line'; END IF;
END $$;
-- An edit while still unconfirmed changes nothing.
UPDATE public.expense_receipts SET vendor_name='ZZTEST Supplier Edited' WHERE id='61000000-0000-4000-8000-000000000002';
-- Queried or rejected while marked: still nothing.
UPDATE public.expense_receipts SET status='queried' WHERE id='61000000-0000-4000-8000-000000000002';
DO $$ BEGIN
 IF (pg_temp.zz_line('61000000-0000-4000-8000-000000000002')).id IS NOT NULL THEN
   RAISE EXCEPTION 'unbooked hold: a marked queried receipt made a line'; END IF;
END $$;
-- The office confirms at approval: the line comes in and the matcher is asked.
UPDATE public.expense_receipts SET status='approved' WHERE id='61000000-0000-4000-8000-000000000002';
DO $$ DECLARE l public.job_cost_lines; BEGIN
 l := pg_temp.zz_line('61000000-0000-4000-8000-000000000002');
 IF l.state IS DISTINCT FROM 'needs_person' OR l.not_counted_reason IS NOT NULL
   OR l.amount_ex IS DISTINCT FROM 100.00 OR l.party_name IS DISTINCT FROM 'ZZTEST Supplier Edited'
   OR pg_temp.zz_queued('61000000-0000-4000-8000-000000000002')<>1 THEN
   RAISE EXCEPTION 'unbooked hold: the confirm did not bring the line in %',to_jsonb(l); END IF;
END $$;
-- Sent to Xero after the confirm still counts.
UPDATE public.expense_receipts SET status='pushed_to_xero' WHERE id='61000000-0000-4000-8000-000000000002';
DO $$ BEGIN
 IF (pg_temp.zz_line('61000000-0000-4000-8000-000000000002')).state IS DISTINCT FROM 'needs_person' THEN
   RAISE EXCEPTION 'unbooked hold: a confirmed receipt sent to Xero stopped counting'; END IF;
END $$;

-- A counted receipt moved onto a job its sender is not booked on stops counting
-- (the one writer keeps the row, not counted), and the confirm brings it back.
UPDATE public.expense_receipts SET job_id='61000000-0000-4000-8000-0000000000a3',
  unbooked_job_id='61000000-0000-4000-8000-0000000000a3' WHERE id='61000000-0000-4000-8000-000000000001';
DO $$ DECLARE l public.job_cost_lines; BEGIN
 l := pg_temp.zz_line('61000000-0000-4000-8000-000000000001');
 IF l.state IS NOT NULL OR l.not_counted_reason IS DISTINCT FROM 'document_not_live' THEN
   RAISE EXCEPTION 'unbooked hold: a moved receipt still counted %',to_jsonb(l); END IF;
END $$;
UPDATE public.expense_receipts SET status='approved' WHERE id='61000000-0000-4000-8000-000000000001';
DO $$ DECLARE l public.job_cost_lines; BEGIN
 l := pg_temp.zz_line('61000000-0000-4000-8000-000000000001');
 IF l.state IS DISTINCT FROM 'needs_person' OR l.not_counted_reason IS NOT NULL THEN
   RAISE EXCEPTION 'unbooked hold: the confirm did not revive the line %',to_jsonb(l); END IF;
END $$;

-- The office moving a marked receipt clears the mark (ops-api): it counts again.
INSERT INTO public.expense_receipts(id,job_id,unbooked_job_id,receipt_photo_url,total_amount,gst_amount,payment_method)
  VALUES('61000000-0000-4000-8000-000000000003','61000000-0000-4000-8000-0000000000a4',
    '61000000-0000-4000-8000-0000000000a4','ZZTEST-office-move',55,5,'cash');
UPDATE public.expense_receipts SET job_id='61000000-0000-4000-8000-0000000000a5', unbooked_job_id=NULL
  WHERE id='61000000-0000-4000-8000-000000000003';
DO $$ BEGIN
 IF (pg_temp.zz_line('61000000-0000-4000-8000-000000000003')).state IS DISTINCT FROM 'needs_person' THEN
   RAISE EXCEPTION 'unbooked hold: an office move did not count'; END IF;
END $$;

-- A no-job receipt is never marked and counts as before.
INSERT INTO public.expense_receipts(id,receipt_photo_url,total_amount,gst_amount,payment_method)
  VALUES('61000000-0000-4000-8000-000000000004','ZZTEST-no-job',55,5,'company_card');
DO $$ BEGIN
 IF (pg_temp.zz_line('61000000-0000-4000-8000-000000000004')).state IS DISTINCT FROM 'needs_person' THEN
   RAISE EXCEPTION 'unbooked hold: a no-job receipt did not count'; END IF;
END $$;

-- Own money marked: no line, as for every own-money receipt.
INSERT INTO public.expense_receipts(id,job_id,unbooked_job_id,receipt_photo_url,total_amount,gst_amount,payment_method)
  VALUES('61000000-0000-4000-8000-000000000005','61000000-0000-4000-8000-0000000000a6',
    '61000000-0000-4000-8000-0000000000a6','ZZTEST-own-marked',55,5,'personal_card');
DO $$ BEGIN
 IF (pg_temp.zz_line('61000000-0000-4000-8000-000000000005')).id IS NOT NULL THEN
   RAISE EXCEPTION 'unbooked hold: a marked own-money receipt made a line'; END IF;
END $$;

SET CONSTRAINTS ALL IMMEDIATE;
SELECT 'PASS: a receipt marked not booked on its job counts only after the office confirms it' AS result;
ROLLBACK;
