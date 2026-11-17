-- Rollback for 20261118073800_trade_line_hold_commission_cap.sql: restore
-- main's assert_job_commission_cap body.
DO $patch$ DECLARE d text; old_text text; new_text text; body_md5 text; BEGIN
  d := pg_get_functiondef('public.assert_job_commission_cap(uuid,uuid)'::regprocedure);
  SELECT md5(prosrc) INTO body_md5 FROM pg_proc
    WHERE oid = 'public.assert_job_commission_cap(uuid,uuid)'::regprocedure;
  IF body_md5 = 'c2aea6de53237a5c3ae7d166d153cac5' THEN RETURN; END IF;
  IF body_md5 IS DISTINCT FROM '404ca316dac46d6c8b93f7d79755919f' THEN
    RAISE EXCEPTION 'P1-05.8 commission cap rollback md5 preimage changed: %', body_md5;
  END IF;
  old_text := $old$       AND l.office_review_status IS DISTINCT FROM 'rejected'
       -- P1-05.8: a zero line on a holding invoice claims nothing.
       AND NOT (v_invoice.invoice_kind = 'held' AND COALESCE(l.line_total_ex, 0) = 0)
  ) THEN$old$;
  new_text := $new$       AND l.office_review_status IS DISTINCT FROM 'rejected'
  ) THEN$new$;
  IF (length(d) - length(replace(d, old_text, ''))) / length(old_text) <> 1 THEN
    RAISE EXCEPTION 'P1-05.8 commission cap rollback anchor changed';
  END IF;
  EXECUTE replace(d, old_text, new_text);
END $patch$;

