BEGIN;
SET LOCAL statement_timeout = '120s';
-- Re-apply this migration when an earlier contract dropped its objects. Applied
-- only when missing, so the break proof's replaced body is the one under test.
SELECT to_regprocedure('public.job_cost_lines_sync_receipt(uuid)') IS NULL
  OR to_regprocedure('public.job_cost_lines_install_receipt_trigger()') IS NULL AS zz_reapply \gset
\if :zz_reapply
\ir ../../../migrations/20261118073132_job_cost_lines_receipt_sync.sql
\endif
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='job_cost_lines_receipt_sync') THEN
   RAISE EXCEPTION 'receipt sync: migration installed a business trigger'; END IF;
END $$;
SELECT public.job_cost_lines_install_receipt_trigger();
SELECT public.job_cost_lines_remove_receipt_trigger();
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='job_cost_lines_receipt_sync') THEN
   RAISE EXCEPTION 'receipt sync: remove left the trigger'; END IF;
END $$;
SELECT public.job_cost_lines_install_receipt_trigger();
-- Lift unrelated fixture guards only in this rolled-back transaction; keep the
-- receipt trigger under test and the cost line conservation triggers enabled.
DO $$ DECLARE t text; c record; BEGIN
  FOREACH t IN ARRAY ARRAY['expense_receipts','trade_invoices','trade_invoice_lines'] LOOP
    FOR c IN SELECT tgname FROM pg_trigger WHERE tgrelid=format('public.%I',t)::regclass
      AND NOT tgisinternal AND tgname<>'job_cost_lines_receipt_sync' LOOP
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
CREATE FUNCTION pg_temp.zz_line(p uuid) RETURNS public.job_cost_lines LANGUAGE sql AS $f$
  SELECT * FROM public.job_cost_lines WHERE document_kind='expense_receipt' AND document_id=p::text
$f$;
CREATE FUNCTION pg_temp.zz_queued(p uuid) RETURNS bigint LANGUAGE sql AS $f$
  SELECT count(*) FROM public.match_queue WHERE subject_kind='cost_document'
    AND subject_id='expense_receipt:'||p::text AND reason='receipt_saved'
$f$;

-- Switch off: a saved company card receipt writes nothing.
UPDATE public.feature_flags SET enabled=false WHERE flag_name='job_cost_lines_sync_v1';
INSERT INTO public.expense_receipts(id,receipt_photo_url,vendor_name,receipt_date,total_amount,gst_amount,payment_method,category)
  VALUES('60000000-0000-4000-8000-000000000001','ZZTEST-off','ZZTEST Supplier','2026-11-16',110,10,'company_card','materials');
DO $$ BEGIN
 IF (SELECT count(*) FROM public.job_cost_lines WHERE document_kind='expense_receipt')<>0
   OR (SELECT count(*) FROM public.match_queue WHERE subject_id LIKE 'expense_receipt:%')<>0 THEN
   RAISE EXCEPTION 'receipt sync: switch off wrote a line'; END IF;
END $$;

UPDATE public.feature_flags SET enabled=true WHERE flag_name='job_cost_lines_sync_v1';
-- An unreadable switch never rejects the receipt write.
SAVEPOINT unreadable_switch;
ALTER TABLE public.feature_flags RENAME TO receipt_contract_flags;
INSERT INTO public.expense_receipts(id,receipt_photo_url,total_amount,payment_method)
  VALUES('60000000-0000-4000-8000-000000000002','ZZTEST-unreadable',50,'company_card');
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM public.expense_receipts WHERE id='60000000-0000-4000-8000-000000000002') THEN
   RAISE EXCEPTION 'receipt sync: unreadable switch rejected the receipt'; END IF;
 IF (pg_temp.zz_line('60000000-0000-4000-8000-000000000002')).id IS NOT NULL THEN
   RAISE EXCEPTION 'receipt sync: unreadable switch wrote a line'; END IF;
END $$;
ROLLBACK TO SAVEPOINT unreadable_switch;

-- A failing cost line write never rejects the receipt write.
SAVEPOINT failing_write;
ALTER TABLE public.job_cost_lines ADD CONSTRAINT zztest_refuse CHECK (party_name IS DISTINCT FROM 'ZZTEST-refuse') NOT VALID;
INSERT INTO public.expense_receipts(id,receipt_photo_url,vendor_name,total_amount,payment_method)
  VALUES('60000000-0000-4000-8000-000000000003','ZZTEST-refused','ZZTEST-refuse',50,'company_card');
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM public.expense_receipts WHERE id='60000000-0000-4000-8000-000000000003') THEN
   RAISE EXCEPTION 'receipt sync: failed shadow rejected the receipt'; END IF;
 IF (pg_temp.zz_line('60000000-0000-4000-8000-000000000003')).id IS NOT NULL
   OR pg_temp.zz_queued('60000000-0000-4000-8000-000000000003')<>0 THEN
   RAISE EXCEPTION 'receipt sync: failed shadow left partial writes'; END IF;
END $$;
ROLLBACK TO SAVEPOINT failing_write;

-- Company card 110.00 with GST 10.00: one needs_person line of 100.00, one queue row.
INSERT INTO public.expense_receipts(id,receipt_photo_url,vendor_name,receipt_date,total_amount,gst_amount,payment_method,category)
  VALUES('60000000-0000-4000-8000-000000000010','ZZTEST-card','ZZTEST Supplier','2026-11-16',110,10,'company_card','materials');
DO $$ DECLARE l public.job_cost_lines; BEGIN
 l := pg_temp.zz_line('60000000-0000-4000-8000-000000000010');
 IF (SELECT count(*) FROM public.job_cost_lines WHERE document_id='60000000-0000-4000-8000-000000000010')<>1
   OR l.state IS DISTINCT FROM 'needs_person' OR l.amount_ex IS DISTINCT FROM 100.00 OR l.gst IS DISTINCT FROM 10.00
   OR l.kind<>'receipt' OR l.line_key<>'whole' OR l.lane<>'materials' OR l.party_kind<>'supplier'
   OR l.party_name<>'ZZTEST Supplier' OR l.document_date<>'2026-11-16' OR l.event_source<>'receipt'
   OR l.decided_by_kind IS NOT NULL THEN
   RAISE EXCEPTION 'receipt sync: company card line wrong %',to_jsonb(l); END IF;
 IF pg_temp.zz_queued('60000000-0000-4000-8000-000000000010')<>1 THEN
   RAISE EXCEPTION 'receipt sync: company card receipt not queued'; END IF;
 IF EXISTS (SELECT 1 FROM public.job_cost_line_parts WHERE line_id=l.id) THEN
   RAISE EXCEPTION 'receipt sync: a state was set before the matcher'; END IF;
END $$;
-- Re-saving the same values is idempotent.
UPDATE public.expense_receipts SET vendor_name='ZZTEST Supplier' WHERE id='60000000-0000-4000-8000-000000000010';
DO $$ BEGIN
 IF (SELECT count(*) FROM public.job_cost_lines WHERE document_id='60000000-0000-4000-8000-000000000010')<>1
   OR pg_temp.zz_queued('60000000-0000-4000-8000-000000000010')<>1 THEN
   RAISE EXCEPTION 'receipt sync: re-save duplicated the line or queue row'; END IF;
END $$;

-- A vendor-only edit on a counted line reaches it and keeps its state.
UPDATE public.expense_receipts SET vendor_name='ZZTEST Supplier Renamed' WHERE id='60000000-0000-4000-8000-000000000010';
DO $$ DECLARE l public.job_cost_lines; BEGIN
 l := pg_temp.zz_line('60000000-0000-4000-8000-000000000010');
 IF l.party_name IS DISTINCT FROM 'ZZTEST Supplier Renamed' OR l.state IS DISTINCT FROM 'needs_person' THEN
   RAISE EXCEPTION 'receipt sync: vendor-only edit on a counted line wrong %',to_jsonb(l); END IF;
END $$;

-- Own money and supplier account receipts make no line.
INSERT INTO public.expense_receipts(id,receipt_photo_url,total_amount,gst_amount,payment_method)
  VALUES('60000000-0000-4000-8000-000000000020','ZZTEST-own',55,5,'personal_card'),
        ('60000000-0000-4000-8000-000000000021','ZZTEST-account',55,5,'supplier_invoice');
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM public.job_cost_lines WHERE document_id IN
   ('60000000-0000-4000-8000-000000000020','60000000-0000-4000-8000-000000000021'))
   OR pg_temp.zz_queued('60000000-0000-4000-8000-000000000020')<>0 THEN
   RAISE EXCEPTION 'receipt sync: own-money receipt made a line'; END IF;
END $$;

-- Company card to own money: the line stops counting, its parts go.
UPDATE public.expense_receipts SET payment_method='personal_card' WHERE id='60000000-0000-4000-8000-000000000010';
DO $$ DECLARE l public.job_cost_lines; BEGIN
 l := pg_temp.zz_line('60000000-0000-4000-8000-000000000010');
 IF l.state IS NOT NULL OR l.not_counted_reason IS DISTINCT FROM 'counted_by_trade_invoice'
   OR EXISTS (SELECT 1 FROM public.job_cost_line_parts WHERE line_id=l.id) THEN
   RAISE EXCEPTION 'receipt sync: own money still counted %',to_jsonb(l); END IF;
END $$;
-- Back to company card with no reimbursement line: it counts again.
UPDATE public.expense_receipts SET payment_method='company_card' WHERE id='60000000-0000-4000-8000-000000000010';
DO $$ DECLARE l public.job_cost_lines; BEGIN
 l := pg_temp.zz_line('60000000-0000-4000-8000-000000000010');
 IF l.state IS DISTINCT FROM 'needs_person' OR l.not_counted_reason IS NOT NULL THEN
   RAISE EXCEPTION 'receipt sync: flip back left the line uncounted %',to_jsonb(l); END IF;
END $$;

-- Company card to supplier account: not live, parts gone; and back again.
UPDATE public.expense_receipts SET payment_method='supplier_invoice' WHERE id='60000000-0000-4000-8000-000000000010';
DO $$ DECLARE l public.job_cost_lines; BEGIN
 l := pg_temp.zz_line('60000000-0000-4000-8000-000000000010');
 IF l.state IS NOT NULL OR l.not_counted_reason IS DISTINCT FROM 'document_not_live' THEN
   RAISE EXCEPTION 'receipt sync: supplier account still counted %',to_jsonb(l); END IF;
END $$;
UPDATE public.expense_receipts SET payment_method='cash' WHERE id='60000000-0000-4000-8000-000000000010';
DO $$ BEGIN
 IF (pg_temp.zz_line('60000000-0000-4000-8000-000000000010')).state IS DISTINCT FROM 'needs_person' THEN
   RAISE EXCEPTION 'receipt sync: cash did not count again'; END IF;
END $$;

-- Queried is not live; back to pending counts again.
UPDATE public.expense_receipts SET status='queried' WHERE id='60000000-0000-4000-8000-000000000010';
DO $$ BEGIN
 IF (pg_temp.zz_line('60000000-0000-4000-8000-000000000010')).not_counted_reason IS DISTINCT FROM 'document_not_live' THEN
   RAISE EXCEPTION 'receipt sync: queried receipt still counted'; END IF;
END $$;
UPDATE public.expense_receipts SET status='pending' WHERE id='60000000-0000-4000-8000-000000000010';

-- A line the card line already counts changes only its source fields.
UPDATE public.job_cost_lines SET state=NULL, needs_reason=NULL, not_counted_reason='counted_by_bank_line'
  WHERE document_id='60000000-0000-4000-8000-000000000010';
-- A vendor-only edit and a date-only edit each reach the line.
UPDATE public.expense_receipts SET vendor_name='ZZTEST Supplier Two' WHERE id='60000000-0000-4000-8000-000000000010';
DO $$ BEGIN
 IF (pg_temp.zz_line('60000000-0000-4000-8000-000000000010')).party_name IS DISTINCT FROM 'ZZTEST Supplier Two' THEN
   RAISE EXCEPTION 'receipt sync: vendor-only edit did not reach the line'; END IF;
END $$;
UPDATE public.expense_receipts SET receipt_date='2026-11-17' WHERE id='60000000-0000-4000-8000-000000000010';
DO $$ BEGIN
 IF (pg_temp.zz_line('60000000-0000-4000-8000-000000000010')).document_date IS DISTINCT FROM '2026-11-17' THEN
   RAISE EXCEPTION 'receipt sync: date-only edit did not reach the line'; END IF;
END $$;
-- Category is not a trigger column; it reaches the line with the next listed-field edit.
UPDATE public.expense_receipts SET category='fuel', vendor_name='ZZTEST Supplier Three' WHERE id='60000000-0000-4000-8000-000000000010';
UPDATE public.expense_receipts SET payment_method='personal_card' WHERE id='60000000-0000-4000-8000-000000000010';
DO $$ DECLARE l public.job_cost_lines; BEGIN
 l := pg_temp.zz_line('60000000-0000-4000-8000-000000000010');
 IF l.not_counted_reason IS DISTINCT FROM 'counted_by_bank_line' OR l.state IS NOT NULL
   OR l.party_name<>'ZZTEST Supplier Three' OR l.lane<>'other' THEN
   RAISE EXCEPTION 'receipt sync: bank line coverage disturbed %',to_jsonb(l); END IF;
END $$;

-- Total unknown: amount_ex NULL.
INSERT INTO public.expense_receipts(id,receipt_photo_url,total_amount,gst_amount,payment_method)
  VALUES('60000000-0000-4000-8000-000000000030','ZZTEST-unread',NULL,NULL,'unknown');
DO $$ DECLARE l public.job_cost_lines; BEGIN
 l := pg_temp.zz_line('60000000-0000-4000-8000-000000000030');
 IF l.id IS NULL OR l.amount_ex IS NOT NULL OR l.state IS DISTINCT FROM 'needs_person' OR l.lane<>'other' THEN
   RAISE EXCEPTION 'receipt sync: unknown total line wrong %',to_jsonb(l); END IF;
END $$;

-- A receipt still paid back on a live trade invoice stays uncounted when flipped to company card.
INSERT INTO public.expense_receipts(id,receipt_photo_url,total_amount,gst_amount,payment_method)
  VALUES('60000000-0000-4000-8000-000000000040','ZZTEST-repaid',33,3,'company_card');
UPDATE public.expense_receipts SET payment_method='personal_card' WHERE id='60000000-0000-4000-8000-000000000040';
INSERT INTO public.trade_invoices(id,org_id,status) VALUES
  ('60000000-0000-4000-8000-000000000041','00000000-0000-0000-0000-000000000001','submitted');
INSERT INTO public.trade_invoice_lines(id,trade_invoice_id,expense_receipt_id) VALUES
  ('60000000-0000-4000-8000-000000000042','60000000-0000-4000-8000-000000000041','60000000-0000-4000-8000-000000000040');
UPDATE public.expense_receipts SET payment_method='company_card' WHERE id='60000000-0000-4000-8000-000000000040';
DO $$ BEGIN
 IF (pg_temp.zz_line('60000000-0000-4000-8000-000000000040')).not_counted_reason IS DISTINCT FROM 'counted_by_trade_invoice' THEN
   RAISE EXCEPTION 'receipt sync: a repaid receipt counted twice'; END IF;
END $$;

SET CONSTRAINTS ALL IMMEDIATE;
SELECT 'PASS: P2-06.2 receipts become cost lines by payment method' AS result;
ROLLBACK;
