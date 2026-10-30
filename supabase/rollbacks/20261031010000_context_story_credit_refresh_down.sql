-- Undo the freshness witness only; preserve all credit copies and money views.
DO $patch$ DECLARE f text; h text; expected text; BEGIN
 IF to_regprocedure('public.context_job_story_credit_sig(uuid)') IS NOT NULL AND
    (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('public.context_job_story_credit_sig(uuid)')) IS DISTINCT FROM 'a5d0f9f74c14ab88cc502f2d2ad98f27' THEN
  RAISE EXCEPTION 'story_credit_refresh_down_helper_preimage_mismatch';
 END IF;
 PERFORM set_config('lock_timeout','5s',true);
 PERFORM set_config('statement_timeout','60s',true);
 SELECT pg_get_functiondef(oid),md5(prosrc) INTO f,h FROM pg_proc
 WHERE oid=to_regprocedure('public.context_job_story_money_sig(uuid)');
 IF h IN ('62392d8aab2f38362be4b2ddcfab1fbc','b2f762db966bf9f3417e759827705be2') THEN RETURN; END IF;
 expected:=CASE h WHEN '1e135fd8352f408237dc37f91e866ba8' THEN '62392d8aab2f38362be4b2ddcfab1fbc'
                  WHEN '9632fde0aa3621c876d4b21bc8e7a55d' THEN 'b2f762db966bf9f3417e759827705be2' END;
 IF expected IS NULL THEN RAISE EXCEPTION 'story_credit_refresh_down_preimage_mismatch'; END IF;
 EXECUTE replace(f,$before$'money-sig-v1',
  public.context_job_story_credit_sig(p_job_id),$before$,$after$'money-sig-v1',$after$);
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.context_job_story_money_sig(uuid)'::regprocedure)
    IS DISTINCT FROM expected THEN RAISE EXCEPTION 'story_credit_refresh_down_postimage_mismatch'; END IF;
END $patch$;
DROP FUNCTION IF EXISTS public.context_job_story_credit_sig(uuid);
