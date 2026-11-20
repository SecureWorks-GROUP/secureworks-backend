-- 20261120143000: the event store accepts 'office_submitted', still accepts
-- every earlier type, still refuses an unknown one, stays append-only, and the
-- migration applies twice without change.
BEGIN;
\ir ../../../migrations/20261120143000_trade_invoice_office_submitted_event.sql
\ir ../../../migrations/20261120143000_trade_invoice_office_submitted_event.sql
DO $test$
DECLARE
  inv constant uuid := '23000000-0000-4000-8000-000000000001';
  t text;
  refused boolean := false;
BEGIN
  FOREACH t IN ARRAY ARRAY['voided_bill_released','stuck_invoice_resolved','xero_bill_reused',
    'extra_rate_held','receipt_released','office_submitted'] LOOP
    INSERT INTO public.trade_invoice_events(trade_invoice_id,event_type,actor,reason,detail)
    VALUES (inv,t,'user:zztest','ZZTEST reason','{}'::jsonb);
  END LOOP;
  BEGIN
    INSERT INTO public.trade_invoice_events(trade_invoice_id,event_type,actor,reason,detail)
    VALUES (inv,'zztest_unknown','user:zztest',NULL,'{}'::jsonb);
  EXCEPTION WHEN check_violation THEN refused := true;
  END;
  IF NOT refused THEN RAISE EXCEPTION 'office_submitted_check_lets_unknown_type'; END IF;
  refused := false;
  BEGIN
    UPDATE public.trade_invoice_events SET reason = 'ZZTEST changed'
    WHERE trade_invoice_id = inv AND event_type = 'office_submitted';
  EXCEPTION WHEN insufficient_privilege THEN refused := true;
  END;
  IF NOT refused THEN RAISE EXCEPTION 'office_submitted_append_only_guard_lost'; END IF;
END $test$;
ROLLBACK;
