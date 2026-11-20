-- After the down migration the five-type check is back and office_submitted is refused.
DO $test$
DECLARE refused boolean := false;
BEGIN
  IF (SELECT pg_get_constraintdef(c.oid) FROM pg_constraint c
      WHERE c.conrelid = 'public.trade_invoice_events'::regclass
        AND c.conname = 'trade_invoice_events_type_check')
     IS DISTINCT FROM 'CHECK ((event_type = ANY (ARRAY[''voided_bill_released''::text, ''stuck_invoice_resolved''::text, ''xero_bill_reused''::text, ''extra_rate_held''::text, ''receipt_released''::text])))' THEN
    RAISE EXCEPTION 'office_submitted_rollback_check_not_restored';
  END IF;
  BEGIN
    INSERT INTO public.trade_invoice_events(trade_invoice_id,event_type,actor,reason,detail)
    VALUES ('23000000-0000-4000-8000-000000000002','office_submitted','user:zztest',NULL,'{}'::jsonb);
  EXCEPTION WHEN check_violation THEN refused := true;
  END;
  IF NOT refused THEN RAISE EXCEPTION 'office_submitted_rollback_still_accepts'; END IF;
END $test$;
