-- TP-07 / TP-16: supplier-credit corrections invalidate existing readers/stories.
-- No credit application, allocation, netting, flag activation or financial policy change.
-- Supports the original slice-1 placement and later slice-2 extra columns. A credit
-- removed or moved off a job removes its witness, invalidating the former job too.
DO $guard$ BEGIN
 IF to_regprocedure('public.context_job_story_credit_sig(uuid)') IS NOT NULL AND
    (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('public.context_job_story_credit_sig(uuid)')) IS DISTINCT FROM 'a5d0f9f74c14ab88cc502f2d2ad98f27' THEN
  RAISE EXCEPTION 'story_credit_refresh_helper_preimage_mismatch';
 END IF;
 IF to_regclass('public.v_supplier_credit_placement') IS NULL OR
    to_regclass('public.xero_supplier_credit_notes') IS NULL THEN
  RAISE EXCEPTION 'story_credit_refresh_missing_source';
 END IF;
 IF COALESCE((SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('public.context_job_story_money_sig(uuid)')), '')
    NOT IN ('62392d8aab2f38362be4b2ddcfab1fbc','b2f762db966bf9f3417e759827705be2','1e135fd8352f408237dc37f91e866ba8','9632fde0aa3621c876d4b21bc8e7a55d') THEN
  RAISE EXCEPTION 'story_credit_refresh_preimage_mismatch';
 END IF;
END $guard$;

CREATE OR REPLACE FUNCTION public.context_job_story_credit_sig(p_job_id uuid)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
 SELECT md5(jsonb_agg(w.witness ORDER BY w.witness::text)::text)
 FROM (
  SELECT jsonb_build_array(to_jsonb(p), n.credit_note_type, n.reference,
    n.line_amount_types, n.currency_code, n.sub_total, n.total_tax, n.total,
    n.remaining_credit, n.fully_paid_on, n.allocations_returned,
    n.raw_json->'Payments') AS witness
  FROM public.v_supplier_credit_placement p
  JOIN public.jobs j ON j.id=p.job_id AND j.org_id=p.org_id
  JOIN public.xero_supplier_credit_notes n
    ON n.org_id=p.org_id AND n.xero_credit_note_id=p.xero_credit_note_id
  WHERE p.job_id=p_job_id
 ) w
$function$;
COMMENT ON FUNCTION public.context_job_story_credit_sig(uuid) IS
 'TP-07/TP-16 (20261031010000): stable supplier-credit source/placement witness for one job. No rows returns NULL, preserving the previous money signature. Includes allocation, held/counting state, source date and financial fields, excludes copy clocks. Does not apply credits, infer job allocation or establish cost completeness. Service role only.';
REVOKE ALL ON FUNCTION public.context_job_story_credit_sig(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.context_job_story_credit_sig(uuid) TO service_role;

DO $patch$ DECLARE f text; h text; expected text; BEGIN
 PERFORM set_config('lock_timeout','5s',true);
 PERFORM set_config('statement_timeout','60s',true);
 SELECT pg_get_functiondef(oid),md5(prosrc) INTO f,h FROM pg_proc
 WHERE oid=to_regprocedure('public.context_job_story_money_sig(uuid)');
 IF h IN ('1e135fd8352f408237dc37f91e866ba8','9632fde0aa3621c876d4b21bc8e7a55d') THEN RETURN; END IF;
 expected:=CASE h WHEN '62392d8aab2f38362be4b2ddcfab1fbc' THEN '1e135fd8352f408237dc37f91e866ba8'
                  WHEN 'b2f762db966bf9f3417e759827705be2' THEN '9632fde0aa3621c876d4b21bc8e7a55d' END;
 IF expected IS NULL THEN RAISE EXCEPTION 'story_credit_refresh_preimage_mismatch'; END IF;
 EXECUTE replace(f,$before$'money-sig-v1',$before$,$after$'money-sig-v1',
  public.context_job_story_credit_sig(p_job_id),$after$);
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.context_job_story_money_sig(uuid)'::regprocedure)
    IS DISTINCT FROM expected THEN RAISE EXCEPTION 'story_credit_refresh_postimage_mismatch'; END IF;
END $patch$;
