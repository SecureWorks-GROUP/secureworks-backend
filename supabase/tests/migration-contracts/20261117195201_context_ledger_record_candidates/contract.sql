BEGIN;
\set record_fixture_seed true
\ir setup.sql
DO $c$
DECLARE c record; n integer;
BEGIN
 SELECT * INTO c FROM public.context_ledger_record_candidates('00000000-0000-4000-8000-000000000401','quote_sent',NULL,'2026-11-03T09:00:00+08');
 IF c.record_id IS DISTINCT FROM '00000000-0000-4000-8000-000000000401' OR c.closes_at IS DISTINCT FROM '2026-11-04T10:00:00+08'::timestamptz
  OR c.key IS DISTINCT FROM 'quote:q-9001' THEN RAISE EXCEPTION 'record candidates: T1 quote'; END IF;
 SELECT count(*) INTO n FROM public.context_ledger_record_candidates('00000000-0000-4000-8000-000000000401','quote_sent',NULL,'2026-11-05T00:00:00+08');
 IF n<>0 THEN RAISE EXCEPTION 'record candidates: T5 older quote'; END IF;
 SELECT * INTO c FROM public.context_ledger_record_candidates('00000000-0000-4000-8000-000000000402','payment','invoice:inv-9002','2026-11-03T09:00:00+08','customer');
 -- Ticket step 5 gives the store priority over the example's next midnight.
 IF c.closes_at IS DISTINCT FROM '2026-11-05T23:59:59+08'::timestamptz THEN RAISE EXCEPTION 'record candidates: T2 paid day'; END IF;
 SELECT count(*) INTO n FROM public.context_ledger_record_candidates('00000000-0000-4000-8000-000000000403','payment',NULL,'2026-11-03T09:00:00+08','us','supplier');
 IF n<>1 THEN RAISE EXCEPTION 'record candidates: T3 supplier'; END IF;
 IF EXISTS(SELECT 1 FROM public.context_ledger_record_candidates('00000000-0000-4000-8000-000000000403','payment','invoice:inv-9002','2026-11-03T09:00:00+08','customer'))
 OR EXISTS(SELECT 1 FROM public.context_ledger_record_candidates('00000000-0000-4000-8000-000000000407','booking_made',NULL,'2026-11-03T09:00:00+08'))
 OR EXISTS(SELECT 1 FROM public.context_ledger_record_candidates('00000000-0000-4000-8000-000000000401','reply',NULL,'2026-11-03T09:00:00+08')) THEN RAISE EXCEPTION 'record candidates: refusal cases'; END IF;
END $c$;
-- A failed document email with no job link still prevents a manufactured send.
INSERT INTO public.email_events(email_type,status,metadata,recipient) VALUES('quote','failed','{"document_id":"00000000-0000-4000-8000-000000000401"}','role@example.test');
DO $c$ BEGIN
 IF EXISTS(SELECT 1 FROM public.context_ledger_record_candidates('00000000-0000-4000-8000-000000000401','quote_sent',NULL,'2026-11-03T09:00:00+08')) THEN
 RAISE EXCEPTION 'record candidates: failed email closed quote'; END IF;
END $c$;
INSERT INTO public.email_events(email_type,status,sent_at,metadata,recipient) VALUES('quote','sent','2026-11-04T11:00:00+08','{"document_id":"00000000-0000-4000-8000-000000000401"}','role@example.test');
DO $c$ BEGIN
 IF (SELECT closes_at FROM public.context_ledger_record_candidates('00000000-0000-4000-8000-000000000401','quote_sent',NULL,'2026-11-03T09:00:00+08'))
 IS DISTINCT FROM '2026-11-04T11:00:00+08'::timestamptz THEN RAISE EXCEPTION 'record candidates: delivery time'; END IF;
 IF has_function_privilege('anon','public.context_ledger_record_candidates(uuid,text,text,timestamptz,text)','EXECUTE')
 OR NOT has_function_privilege('service_role','public.context_ledger_record_candidates(uuid,text,text,timestamptz,text)','EXECUTE') THEN RAISE EXCEPTION 'record candidates: access'; END IF;
END $c$;
SELECT 'PASS: P4-02.1 six requested cases, store delivery rule and private access' AS result;
ROLLBACK;
