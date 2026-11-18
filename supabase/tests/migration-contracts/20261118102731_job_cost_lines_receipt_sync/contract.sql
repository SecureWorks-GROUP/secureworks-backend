BEGIN;
SET LOCAL statement_timeout = '120s';
-- Re-apply this migration when an earlier contract dropped its objects. Applied
-- only when missing, so the break proof's replaced body is the one under test.
SELECT to_regprocedure('public.job_cost_lines_sync_receipt(uuid)') IS NULL
  OR to_regprocedure('public.job_cost_lines_install_receipt_trigger()') IS NULL AS zz_reapply \gset
\if :zz_reapply
\ir ../../../migrations/20261118102731_job_cost_lines_receipt_sync.sql
\endif
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname LIKE 'job_cost_lines_receipt%') THEN
   RAISE EXCEPTION 'receipt sync: migration installed a business trigger'; END IF;
END $$;
SELECT public.job_cost_lines_install_receipt_trigger();
DO $$ BEGIN
 IF (SELECT count(*) FROM pg_trigger WHERE tgname IN ('job_cost_lines_receipt_sync',
     'job_cost_lines_receipt_link_insert','job_cost_lines_receipt_link_update',
     'job_cost_lines_receipt_link_delete','job_cost_lines_receipt_invoice_update'))<>5 THEN
   RAISE EXCEPTION 'receipt sync: install missed a trigger'; END IF;
END $$;
SELECT public.job_cost_lines_remove_receipt_trigger();
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname LIKE 'job_cost_lines_receipt%') THEN
   RAISE EXCEPTION 'receipt sync: remove left a trigger'; END IF;
END $$;
SELECT public.job_cost_lines_install_receipt_trigger();
-- Lift unrelated fixture guards only in this rolled-back transaction; keep the
-- receipt triggers under test and the cost line conservation triggers enabled.
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
 IF NOT EXISTS (SELECT 1 FROM public.job_cost_lines_receipt_retries
     WHERE expense_receipt_id='60000000-0000-4000-8000-000000000003' AND last_sqlstate='23514') THEN
   RAISE EXCEPTION 'receipt sync: failed shadow was not queued for retry'; END IF;
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

-- Own money with no line, paid back on a live trade invoice, then corrected to company
-- card: no countable line and no queue row (never counted twice).
INSERT INTO public.expense_receipts(id,receipt_photo_url,total_amount,gst_amount,payment_method)
  VALUES('60000000-0000-4000-8000-000000000050','ZZTEST-own-repaid',110,10,'personal_card');
INSERT INTO public.trade_invoices(id,org_id,status) VALUES
  ('60000000-0000-4000-8000-000000000051','00000000-0000-0000-0000-000000000001','submitted');
INSERT INTO public.trade_invoice_lines(id,trade_invoice_id,expense_receipt_id) VALUES
  ('60000000-0000-4000-8000-000000000052','60000000-0000-4000-8000-000000000051','60000000-0000-4000-8000-000000000050');
UPDATE public.expense_receipts SET payment_method='company_card' WHERE id='60000000-0000-4000-8000-000000000050';
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM public.job_cost_lines WHERE document_kind='expense_receipt'
     AND document_id='60000000-0000-4000-8000-000000000050' AND state IS NOT NULL)
   OR pg_temp.zz_queued('60000000-0000-4000-8000-000000000050')<>0 THEN
   RAISE EXCEPTION 'receipt sync: a repaid own-money receipt counted on correction %',
     to_jsonb(pg_temp.zz_line('60000000-0000-4000-8000-000000000050')); END IF;
END $$;

-- A company card line later paid back on a live trade invoice stops counting at its next save.
INSERT INTO public.expense_receipts(id,receipt_photo_url,total_amount,gst_amount,payment_method)
  VALUES('60000000-0000-4000-8000-000000000060','ZZTEST-card-repaid',22,2,'company_card');
INSERT INTO public.trade_invoices(id,org_id,status) VALUES
  ('60000000-0000-4000-8000-000000000061','00000000-0000-0000-0000-000000000001','submitted');
INSERT INTO public.trade_invoice_lines(id,trade_invoice_id,expense_receipt_id) VALUES
  ('60000000-0000-4000-8000-000000000062','60000000-0000-4000-8000-000000000061','60000000-0000-4000-8000-000000000060');
-- The link alone stops it counting: no receipt save.
DO $$ DECLARE l public.job_cost_lines; BEGIN
 l := pg_temp.zz_line('60000000-0000-4000-8000-000000000060');
 IF l.state IS NOT NULL OR l.not_counted_reason IS DISTINCT FROM 'counted_by_trade_invoice'
   OR EXISTS (SELECT 1 FROM public.job_cost_line_parts WHERE line_id=l.id) THEN
   RAISE EXCEPTION 'receipt sync: a newly linked company card receipt still counted %',to_jsonb(l); END IF;
END $$;
UPDATE public.expense_receipts SET vendor_name='ZZTEST Supplier' WHERE id='60000000-0000-4000-8000-000000000060';
DO $$ DECLARE l public.job_cost_lines; BEGIN
 l := pg_temp.zz_line('60000000-0000-4000-8000-000000000060');
 IF l.state IS NOT NULL OR l.not_counted_reason IS DISTINCT FROM 'counted_by_trade_invoice'
   OR EXISTS (SELECT 1 FROM public.job_cost_line_parts WHERE line_id=l.id) THEN
   RAISE EXCEPTION 'receipt sync: a repaid company card receipt still counted %',to_jsonb(l); END IF;
END $$;
-- Removing the reimbursement line alone makes it count again: 22.00 less 2.00 GST.
DELETE FROM public.trade_invoice_lines WHERE id='60000000-0000-4000-8000-000000000062';
DO $$ DECLARE l public.job_cost_lines; BEGIN
 l := pg_temp.zz_line('60000000-0000-4000-8000-000000000060');
 IF l.state IS DISTINCT FROM 'needs_person' OR l.not_counted_reason IS NOT NULL OR l.amount_ex IS DISTINCT FROM 20.00 THEN
   RAISE EXCEPTION 'receipt sync: an unlinked receipt stayed suppressed %',to_jsonb(l); END IF;
END $$;
-- An ops-reject of the invoice that paid an own-money receipt back, alone, makes the
-- corrected company card receipt count: 110.00 less 10.00 GST, queued for the matcher.
UPDATE public.trade_invoices SET status='ops-reject' WHERE id='60000000-0000-4000-8000-000000000051';
DO $$ DECLARE l public.job_cost_lines; BEGIN
 l := pg_temp.zz_line('60000000-0000-4000-8000-000000000050');
 IF l.state IS DISTINCT FROM 'needs_person' OR l.amount_ex IS DISTINCT FROM 100.00
   OR pg_temp.zz_queued('60000000-0000-4000-8000-000000000050')<>1 THEN
   RAISE EXCEPTION 'receipt sync: an ops-rejected invoice kept the receipt suppressed %',to_jsonb(l); END IF;
END $$;

-- A VOIDED linked Xero bill pays nothing back: the corrected receipt counts.
INSERT INTO public.expense_receipts(id,receipt_photo_url,total_amount,gst_amount,payment_method)
  VALUES('60000000-0000-4000-8000-000000000070','ZZTEST-own-voided',44,4,'personal_card');
INSERT INTO public.trade_invoices(id,org_id,status,xero_bill_status) VALUES
  ('60000000-0000-4000-8000-000000000071','00000000-0000-0000-0000-000000000001','submitted','VOIDED');
INSERT INTO public.trade_invoice_lines(id,trade_invoice_id,expense_receipt_id) VALUES
  ('60000000-0000-4000-8000-000000000072','60000000-0000-4000-8000-000000000071','60000000-0000-4000-8000-000000000070');
UPDATE public.expense_receipts SET payment_method='company_card' WHERE id='60000000-0000-4000-8000-000000000070';
DO $$ DECLARE l public.job_cost_lines; BEGIN
 l := pg_temp.zz_line('60000000-0000-4000-8000-000000000070');
 IF l.state IS DISTINCT FROM 'needs_person' OR l.not_counted_reason IS NOT NULL OR l.amount_ex IS DISTINCT FROM 40.00
   OR pg_temp.zz_queued('60000000-0000-4000-8000-000000000070')<>1 THEN
   RAISE EXCEPTION 'receipt sync: a voided bill kept the receipt suppressed %',to_jsonb(l); END IF;
END $$;
-- A DELETED bill (any case), with no receipt edit, releases a line it held: the
-- earlier repaid receipt (33.00 less 3.00 GST) counts again at 30.00.
UPDATE public.trade_invoices SET xero_bill_status='deleted' WHERE id='60000000-0000-4000-8000-000000000041';
DO $$ DECLARE l public.job_cost_lines; BEGIN
 l := pg_temp.zz_line('60000000-0000-4000-8000-000000000040');
 IF l.state IS DISTINCT FROM 'needs_person' OR l.not_counted_reason IS NOT NULL
   OR l.amount_ex IS DISTINCT FROM 30.00 OR pg_temp.zz_queued('60000000-0000-4000-8000-000000000040')<>1 THEN
   RAISE EXCEPTION 'receipt sync: a deleted bill kept the receipt suppressed %',to_jsonb(l); END IF;
END $$;
-- The same bill live again, alone, suppresses it again.
UPDATE public.trade_invoices SET xero_bill_status='AUTHORISED' WHERE id='60000000-0000-4000-8000-000000000041';
DO $$ DECLARE l public.job_cost_lines; BEGIN
 l := pg_temp.zz_line('60000000-0000-4000-8000-000000000040');
 IF l.state IS NOT NULL OR l.not_counted_reason IS DISTINCT FROM 'counted_by_trade_invoice' THEN
   RAISE EXCEPTION 'receipt sync: a live bill again left the receipt counted %',to_jsonb(l); END IF;
END $$;

-- An allocated 100.00 receipt corrected to 60.00 while its cost line is locked: the
-- receipt saves, the old allocation stays, the receipt is queued, and the drain alone
-- brings the line and its one part to 60.00.
INSERT INTO public.expense_receipts(id,receipt_photo_url,total_amount,gst_amount,payment_method)
  VALUES('60000000-0000-4000-8000-000000000080','ZZTEST-locked',110,10,'company_card');
SET CONSTRAINTS public.job_cost_lines_parts_conserve, public.job_cost_line_parts_conserve DEFERRED;
SELECT public.job_cost_lines_write_state((pg_temp.zz_line('60000000-0000-4000-8000-000000000080')).id,
  'overhead','[{"target":"overhead","amount_ex":100}]'::jsonb,'matcher',NULL,NULL);
SET CONSTRAINTS public.job_cost_lines_parts_conserve, public.job_cost_line_parts_conserve IMMEDIATE;
CREATE FUNCTION public.zztest_receipt_line_locked() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN
  RAISE EXCEPTION USING ERRCODE='55P03', MESSAGE='zztest_line_locked';
END $f$;
CREATE TRIGGER zztest_receipt_line_locked BEFORE UPDATE ON public.job_cost_lines FOR EACH ROW
  WHEN (OLD.document_id='60000000-0000-4000-8000-000000000080')
  EXECUTE FUNCTION public.zztest_receipt_line_locked();
DELETE FROM public.job_cost_lines_receipt_retries;
UPDATE public.expense_receipts SET total_amount=66, gst_amount=6 WHERE id='60000000-0000-4000-8000-000000000080';
DO $$ DECLARE l public.job_cost_lines; BEGIN
 l := pg_temp.zz_line('60000000-0000-4000-8000-000000000080');
 IF (SELECT total_amount FROM public.expense_receipts WHERE id='60000000-0000-4000-8000-000000000080') IS DISTINCT FROM 66.00
   OR l.amount_ex IS DISTINCT FROM 100.00 OR l.state IS DISTINCT FROM 'overhead'
   OR (SELECT sum(amount_ex) FROM public.job_cost_line_parts WHERE line_id=l.id) IS DISTINCT FROM 100.00 THEN
   RAISE EXCEPTION 'receipt sync: locked line fixture wrong %',to_jsonb(l); END IF;
 IF (SELECT count(*) FROM public.job_cost_lines_receipt_retries
     WHERE expense_receipt_id='60000000-0000-4000-8000-000000000080' AND last_sqlstate='55P03')<>1
   OR (SELECT count(*) FROM public.job_cost_lines_receipt_retries)<>1 THEN
   RAISE EXCEPTION 'receipt sync: locked line write was not queued for retry'; END IF;
END $$;
DROP TRIGGER zztest_receipt_line_locked ON public.job_cost_lines;
DO $$ DECLARE l public.job_cost_lines; result jsonb; BEGIN
 result := public.job_cost_lines_retry_receipt_one();
 l := pg_temp.zz_line('60000000-0000-4000-8000-000000000080');
 IF result->>'success' IS DISTINCT FROM 'true' OR l.amount_ex IS DISTINCT FROM 60.00 OR l.gst IS DISTINCT FROM 6.00
   OR l.state IS DISTINCT FROM 'overhead'
   OR (SELECT count(*) FROM public.job_cost_line_parts WHERE line_id=l.id)<>1
   OR (SELECT sum(amount_ex) FROM public.job_cost_line_parts WHERE line_id=l.id) IS DISTINCT FROM 60.00
   OR EXISTS (SELECT 1 FROM public.job_cost_lines_receipt_retries) THEN
   RAISE EXCEPTION 'receipt sync: retry did not bring the allocation to 60 % %',result,to_jsonb(l); END IF;
 IF public.job_cost_lines_retry_receipt_one()->>'reason' IS DISTINCT FROM 'empty' THEN
   RAISE EXCEPTION 'receipt sync: drain found work in an empty queue'; END IF;
END $$;
-- A failing drain backs off and keeps the request; switch off keeps it untouched.
INSERT INTO public.job_cost_lines_receipt_retries(expense_receipt_id,last_sqlstate)
  VALUES('60000000-0000-4000-8000-000000000080','55P03');
CREATE TRIGGER zztest_receipt_line_locked BEFORE UPDATE ON public.job_cost_lines FOR EACH ROW
  WHEN (OLD.document_id='60000000-0000-4000-8000-000000000080')
  EXECUTE FUNCTION public.zztest_receipt_line_locked();
UPDATE public.expense_receipts SET total_amount=55, gst_amount=5 WHERE id='60000000-0000-4000-8000-000000000080';
DO $$ DECLARE result jsonb; BEGIN
 UPDATE public.job_cost_lines_receipt_retries SET next_attempt_at=clock_timestamp()-interval '1 second';
 result := public.job_cost_lines_retry_receipt_one();
 IF result->>'success' IS DISTINCT FROM 'false'
   OR NOT EXISTS (SELECT 1 FROM public.job_cost_lines_receipt_retries WHERE attempts=1 AND next_attempt_at>clock_timestamp()) THEN
   RAISE EXCEPTION 'receipt sync: failed drain did not back off %',result; END IF;
END $$;
DROP TRIGGER zztest_receipt_line_locked ON public.job_cost_lines;
UPDATE public.feature_flags SET enabled=false WHERE flag_name='job_cost_lines_sync_v1';
DO $$ BEGIN
 IF public.job_cost_lines_retry_receipt_one()->>'reason' IS DISTINCT FROM 'flag_off'
   OR NOT EXISTS (SELECT 1 FROM public.job_cost_lines_receipt_retries) THEN
   RAISE EXCEPTION 'receipt sync: switch-off drain lost a retry'; END IF;
END $$;
UPDATE public.feature_flags SET enabled=true WHERE flag_name='job_cost_lines_sync_v1';
-- Older requests for the same receipt fold on a successful drain.
UPDATE public.job_cost_lines_receipt_retries SET next_attempt_at=clock_timestamp()-interval '1 second';
DO $$ DECLARE l public.job_cost_lines; result jsonb; BEGIN
 result := public.job_cost_lines_retry_receipt_one();
 l := pg_temp.zz_line('60000000-0000-4000-8000-000000000080');
 IF result->>'success' IS DISTINCT FROM 'true' OR l.amount_ex IS DISTINCT FROM 50.00
   OR EXISTS (SELECT 1 FROM public.job_cost_lines_receipt_retries) THEN
   RAISE EXCEPTION 'receipt sync: retry did not converge and fold % %',result,to_jsonb(l); END IF;
 IF has_table_privilege('authenticated','public.job_cost_lines_receipt_retries','SELECT')
   OR has_table_privilege('anon','public.job_cost_lines_receipt_retries','INSERT')
   OR has_function_privilege('authenticated','public.job_cost_lines_retry_receipt_one()','EXECUTE')
   OR has_function_privilege('anon','public.job_cost_lines_try_receipt(uuid)','EXECUTE') THEN
   RAISE EXCEPTION 'receipt sync: retry browser access'; END IF;
END $$;

-- Fake cron (a stand-in schema) proves the drain is scheduled only by the explicit
-- install and removed by remove. All changes roll back.
SAVEPOINT schedule_proof;
CREATE SCHEMA IF NOT EXISTS cron;
CREATE TABLE IF NOT EXISTS cron.job(jobid bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,jobname text UNIQUE,schedule text,command text);
CREATE OR REPLACE FUNCTION cron.schedule(text,text,text) RETURNS bigint LANGUAGE sql AS $f$
 INSERT INTO cron.job(jobname,schedule,command) VALUES($1,$2,$3)
 ON CONFLICT(jobname) DO UPDATE SET schedule=excluded.schedule,command=excluded.command RETURNING jobid
$f$;
CREATE OR REPLACE FUNCTION cron.unschedule(bigint) RETURNS boolean LANGUAGE sql AS $f$
 DELETE FROM cron.job WHERE jobid=$1 RETURNING true
$f$;
SELECT public.job_cost_lines_remove_receipt_trigger();
DELETE FROM cron.job WHERE jobname='job-cost-lines-receipt-retry';
SELECT public.job_cost_lines_install_receipt_trigger();
DO $$ BEGIN
 IF (SELECT count(*) FROM cron.job WHERE jobname='job-cost-lines-receipt-retry'
   AND command='SELECT public.job_cost_lines_retry_receipt_one()')<>1 THEN
   RAISE EXCEPTION 'receipt sync: install missed the retry schedule'; END IF;
END $$;
SELECT public.job_cost_lines_remove_receipt_trigger();
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM cron.job WHERE jobname='job-cost-lines-receipt-retry') THEN
   RAISE EXCEPTION 'receipt sync: remove left the retry schedule'; END IF;
END $$;
ROLLBACK TO SAVEPOINT schedule_proof;

SET CONSTRAINTS ALL IMMEDIATE;
SELECT 'PASS: P2-06.2 receipts become cost lines by payment method' AS result;
ROLLBACK;
