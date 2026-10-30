-- TP-13/TP-16: the same native employer-super inputs used by the existing producer
-- Supports both the original book and existing TP-13 signature, preserving variations.
-- must invalidate the reader and saved story. No money calculation or source writes.
DO $patch$ DECLARE f text; h text; expected text; BEGIN
 PERFORM set_config('lock_timeout','5s',true);
 PERFORM set_config('statement_timeout','60s',true);
 SELECT pg_get_functiondef(oid),md5(prosrc) INTO f,h FROM pg_proc WHERE oid=to_regprocedure('public.context_job_story_money_sig(uuid)');
 IF h IN ('62392d8aab2f38362be4b2ddcfab1fbc', 'b2f762db966bf9f3417e759827705be2') THEN RETURN; END IF;
 expected := CASE h WHEN 'dea95169f891563e26f40b1c340897b9' THEN '62392d8aab2f38362be4b2ddcfab1fbc' WHEN '4524fbe4a06a9b3eed8d51fb17c67c21' THEN 'b2f762db966bf9f3417e759827705be2' END;
 IF expected IS NULL THEN RAISE EXCEPTION 'story_oncost_refresh_preimage_mismatch'; END IF;
 EXECUTE replace(f,$before$l.line_type, ti.status, ti.xero_bill_status)$before$,$after$l.line_type, ti.status, ti.xero_bill_status,
          ti.subtotal_ex::text, ti.super_amount::text, ti.net_pay::text)$after$);
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.context_job_story_money_sig(uuid)'::regprocedure) IS DISTINCT FROM expected THEN RAISE EXCEPTION 'story_oncost_refresh_postimage_mismatch'; END IF;
END $patch$;
