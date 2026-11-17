-- P1-05.8 (Follow-up 27 item 2): a held line of a commission with no figure
-- is saved at 0 on the holding invoice. The cap skips a commission line only
-- when its invoice is invoice_kind = 'held' AND the line amount is 0. Every
-- other line, including a non-zero commission line on a held invoice, runs the
-- full check as before. Moving a line onto a payable invoice, or giving it an
-- amount, fires the line trigger (UPDATE OF trade_invoice_id, line_total_ex),
-- so the cap runs in full when the line can start to count. Changing a
-- header's invoice_kind alone does not re-run it: a held line is released by
-- moving it, never by relabelling its invoice.
-- Rule 15: assert_job_commission_cap is patched only from main's body
-- (md5(prosrc) c2aea6de53237a5c3ae7d166d153cac5); a re-run at this
-- migration's body returns; any other body refuses.
-- No table write, no schedule, no switch change.
-- Rollback: supabase/rollbacks/20261118073800_trade_line_hold_commission_cap_down.sql.
DO $patch$ DECLARE d text; old_text text; new_text text; body_md5 text; BEGIN
  d := pg_get_functiondef('public.assert_job_commission_cap(uuid,uuid)'::regprocedure);
  SELECT md5(prosrc) INTO body_md5 FROM pg_proc
    WHERE oid = 'public.assert_job_commission_cap(uuid,uuid)'::regprocedure;
  IF body_md5 = '404ca316dac46d6c8b93f7d79755919f' THEN RETURN; END IF;
  IF body_md5 IS DISTINCT FROM 'c2aea6de53237a5c3ae7d166d153cac5' THEN
    RAISE EXCEPTION 'P1-05.8 commission cap md5 preimage changed: %', body_md5;
  END IF;
  old_text := $old$       AND l.office_review_status IS DISTINCT FROM 'rejected'
  ) THEN$old$;
  new_text := $new$       AND l.office_review_status IS DISTINCT FROM 'rejected'
       -- P1-05.8: a zero line on a holding invoice claims nothing.
       AND NOT (v_invoice.invoice_kind = 'held' AND COALESCE(l.line_total_ex, 0) = 0)
  ) THEN$new$;
  IF (length(d) - length(replace(d, old_text, ''))) / length(old_text) <> 1 THEN
    RAISE EXCEPTION 'P1-05.8 commission cap preimage anchor changed';
  END IF;
  EXECUTE replace(d, old_text, new_text);
END $patch$;

