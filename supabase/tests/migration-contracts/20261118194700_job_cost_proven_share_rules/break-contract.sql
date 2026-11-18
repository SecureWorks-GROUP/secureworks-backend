-- Deliberate break: treat share_no_cost as a human review reason again, so the
-- contract must fail on the share_no_cost no-review assertion.
CREATE OR REPLACE FUNCTION public.job_profit_store_proven_share(p_job_ids uuid[])
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $f$
DECLARE row_to_review record;
/* block */ BEGIN
  FOR row_to_review IN
    WITH stored AS (
      UPDATE public.job_profit_stored s SET
        (cost_proven_ex,cost_on_clues_ex,cost_unknown_ex,cost_unknown_items,proven_share_pct,proven_share_reason)=
        (p.cost_proven_ex,p.cost_on_clues_ex,p.cost_unknown_ex,p.cost_unknown_items,p.proven_share_pct,p.proven_share_reason)
      FROM public.job_cost_proven_share(p_job_ids) p WHERE s.job_id=p.job_id
      RETURNING s.job_id,s.proven_share_reason,
        md5(ROW(s.cost_proven_ex,s.cost_on_clues_ex,s.cost_unknown_ex,s.cost_unknown_items)::text) AS facts
    )
    SELECT s.* FROM stored s WHERE s.proven_share_reason IN ('share_unknown_credit_open','share_out_of_range','share_no_cost')
      OR EXISTS (SELECT FROM public.reconcile_items i WHERE i.kind='job_cost_share'
                 AND i.subject_table='jobs' AND i.subject_id=s.job_id::text AND i.status='open')
    ORDER BY s.job_id
  LOOP
    IF row_to_review.proven_share_reason IN ('share_unknown_credit_open','share_out_of_range','share_no_cost') THEN
      PERFORM public.reconcile_item_raise('job_cost_share','jobs',row_to_review.job_id::text,
        ARRAY[row_to_review.job_id],NULL,jsonb_build_object('reason',row_to_review.proven_share_reason,
        'facts_hash',row_to_review.facts),'job_profit');
    ELSE
      PERFORM public.reconcile_item_withdraw('job_cost_share','jobs',row_to_review.job_id::text,'share_recomputed');
    END IF;
  END LOOP;
END $f$;
