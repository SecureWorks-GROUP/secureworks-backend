-- Rollback of P2-13.2 follow-up: restores 20261118124326's exact two bodies.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $guard$
/* block */ BEGIN
  IF (SELECT md5(p.prosrc) FROM pg_proc p WHERE p.oid = to_regprocedure('public.job_cost_proven_share(uuid[])'))
     NOT IN ('b7e6c59ac5be46981791590c2c206c73', '317bbcbdc920b45a9752ba25d07d413f') THEN
    RAISE EXCEPTION 'job_cost_proven_share_rules rollback: another body is installed; refusing to replace it'
      USING DETAIL = 'public.job_cost_proven_share(uuid[])';
  END IF;
  IF (SELECT md5(p.prosrc) FROM pg_proc p WHERE p.oid = to_regprocedure('public.job_profit_store_proven_share(uuid[])'))
     NOT IN ('a2eec1f3e0954992b90927f40e99e6f3', '72a8fbd89744351d172f7552d2bc7d3f') THEN
    RAISE EXCEPTION 'job_cost_proven_share_rules rollback: another body is installed; refusing to replace it'
      USING DETAIL = 'public.job_profit_store_proven_share(uuid[])';
  END IF;
END $guard$;

CREATE OR REPLACE FUNCTION public.job_cost_proven_share(p_job_ids uuid[])
RETURNS TABLE(job_id uuid,cost_proven_ex numeric,cost_on_clues_ex numeric,
              cost_unknown_ex numeric,cost_unknown_items integer,proven_share_pct numeric,
              proven_share_reason text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $f$
WITH requested AS MATERIALIZED (
  SELECT j.id,j.org_id FROM public.jobs j WHERE j.id=ANY(p_job_ids)
), parts AS MATERIALIZED (
  SELECT p.job_id,p.amount_ex,public.job_cost_part_proven(l.id,p.part_no,p.job_id) AS proven
  FROM requested r JOIN public.job_cost_line_parts p ON p.job_id=r.id
  JOIN public.job_cost_lines l ON l.id=p.line_id
  WHERE l.org_id=r.org_id AND p.target='job' AND l.state IN ('on_job','split') AND l.is_actual
), placed AS (
  SELECT p.job_id,sum(p.amount_ex) FILTER (WHERE p.proven) AS proven,
         sum(p.amount_ex) FILTER (WHERE NOT p.proven) AS clues
  FROM parts p GROUP BY p.job_id
), items AS MATERIALIZED (
  SELECT r.id AS job,i.id AS item,i.org_id,
         split_part(i.subject_id,':',1) AS kind,
         substr(i.subject_id,strpos(i.subject_id,':')+1) AS doc
  FROM requested r JOIN public.reconcile_items i ON i.job_ids @> ARRAY[r.id]
  WHERE i.org_id=r.org_id AND i.status='open' AND i.subject_table='cost_document' AND strpos(i.subject_id,':')>1
), pending AS MATERIALIZED (
  SELECT i.job,i.item,l.id,l.amount_ex
  FROM items i JOIN public.job_cost_lines l
    ON l.org_id=i.org_id AND l.document_kind=i.kind AND l.document_id=i.doc
  WHERE l.state='needs_person' AND l.is_actual
), pending_items AS (
  SELECT job,count(DISTINCT item)::integer AS n FROM pending GROUP BY job
), pending_amounts AS (
  -- Two open review kinds on the same document are two items but one cost.
  SELECT job,sum(amount_ex) AS amount,bool_and(amount_ex IS NOT NULL) AS complete
  FROM (SELECT DISTINCT job,id,amount_ex FROM pending) lines GROUP BY job
), costs AS (
  SELECT r.id,coalesce(p.proven,0) AS proven,coalesce(p.clues,0) AS clues,
         CASE WHEN i.n IS NULL THEN 0 ELSE a.amount END AS pending,coalesce(i.n,0) AS n,
         coalesce(a.complete,true) AS complete
  FROM requested r LEFT JOIN placed p ON p.job_id=r.id
  LEFT JOIN pending_items i ON i.job=r.id LEFT JOIN pending_amounts a ON a.job=r.id
), totals AS (
  SELECT c.*,c.proven+c.clues+c.pending AS total FROM costs c
)
SELECT id,proven,clues,pending,n,
       CASE WHEN complete AND total>0 AND proven BETWEEN 0 AND total
            THEN round(proven*100/total,2) END,
       CASE WHEN complete AND (total<=0 OR proven<0 OR proven>total) THEN 'share_unknown_credit_open'
            WHEN NOT complete THEN 'share_amount_unknown' END
FROM totals
$f$;

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
    SELECT s.* FROM stored s WHERE s.proven_share_reason='share_unknown_credit_open'
      OR EXISTS (SELECT FROM public.reconcile_items i WHERE i.kind='job_cost_share'
                 AND i.subject_table='jobs' AND i.subject_id=s.job_id::text AND i.status='open')
    ORDER BY s.job_id
  LOOP
    IF row_to_review.proven_share_reason='share_unknown_credit_open' THEN
      PERFORM public.reconcile_item_raise('job_cost_share','jobs',row_to_review.job_id::text,
        ARRAY[row_to_review.job_id],NULL,jsonb_build_object('reason','share_unknown_credit_open',
        'facts_hash',row_to_review.facts),'job_profit');
    ELSE
      PERFORM public.reconcile_item_withdraw('job_cost_share','jobs',row_to_review.job_id::text,'share_recomputed');
    END IF;
  END LOOP;
END $f$;

REVOKE ALL ON FUNCTION
  public.job_cost_proven_share(uuid[]),
  public.job_profit_store_proven_share(uuid[])
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.job_cost_proven_share(uuid[]) TO service_role;
